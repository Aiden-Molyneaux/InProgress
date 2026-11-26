import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { landingVerdict, riskGlobsOf, type LandingAction, type LandingVerdict } from '../../core/landing';
import type { Ctx } from '../db/tx';
import { badRequest, conflict, notFound } from '../errors';
import { findNode } from '../repo/nodes';
import { resolveProject } from '../repo/projects';
import { switchLine } from '../repo/switches';
import { runGit, type GitResult } from './git';

const GH_TIMEOUT_MS = 10_000;
/** How long a read of a remote's visibility is kept: a repository can be made public, so it is not kept for the server's life. */
export const VISIBILITY_TTL_MS = 10 * 60 * 1000;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA = /^[0-9a-f]{7,64}$/;
/** The most output git is given for a diff: a bigger change does not finish, and the check answers could not tell. */
const DIFF_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Every diff here: a rename is a delete and an add (so the old path is seen), no external diff or textconv program runs,
 * and paths are the repo's whole, whatever diff.relative says (a folder below the root would otherwise hide the rest).
 */
const DIFF = ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative'];

export type { GitResult };

export interface LandingDeps {
  /** Runs `git -C <folder> <args>` with no shell; `input` goes to its stdin. A non-zero exit is an answer, not a throw. */
  git: (folder: string, args: string[], input?: string) => Promise<GitResult>;
  /** Whether the remote at this URL is public: null when that could not be read. */
  visibility: (remoteUrl: string) => Promise<boolean | null>;
}

export interface LandingAsk {
  /** The project, as its slug or name. */
  ref: string;
  stepId: number;
  action: LandingAction;
  /** The session's working folder: a git checkout. */
  folder: string;
  /** The branch the change is on; the folder's current one when absent. */
  branch?: string;
  /** For a publish, the held command itself: where it goes (publishDestination) is part of its key. */
  segment?: string;
}

export interface LandingAnswer extends LandingVerdict {
  action: LandingAction;
  /** The range the change was read over, as git was given it. */
  range: string;
  /** How many files the change touches. */
  files: number;
  /** What a yes is keyed on: the change's patch id, or for a publish what goes out (publishKey). */
  patchId: string | null;
}

/** The real git: `git -C <folder>` through the shared runner, with room for a big diff. */
export const realGit: LandingDeps['git'] = (folder, args, input) => runGit(folder, args, { input, maxBuffer: DIFF_MAX_BYTES });

/**
 * `owner/name` of a github.com remote in any of its spellings (https, git://, ssh://, scp-style; the host with or without
 * www, in any case; an ssh config alias `github.com-<x>` in the ssh and scp forms); null for anything else.
 */
export function githubRepoOf(url: string): string | null {
  const host = String.raw`(?:www\.)?github\.com`;
  const alias = String.raw`(?:www\.)?github\.com(?:-[a-z0-9._-]+)?`;
  const name = String.raw`([a-z0-9._-]+)\/([a-z0-9._-]+?)(?:\.git)?\/?`;
  const forms = [
    String.raw`(?:https?:\/\/(?:[^@\/]+@)?${host}(?::\d+)?\/)`,
    String.raw`(?:git:\/\/${host}(?::\d+)?\/)`,
    String.raw`(?:ssh:\/\/(?:[^@\/]+@)?${alias}(?::\d+)?\/)`,
    String.raw`(?:(?:[^@\/:]+@)?${alias}:)`,
  ];
  const m = new RegExp(`^(?:${forms.join('|')})${name}$`, 'i').exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A remote as the verdict says it: without any user name or token in front of the host. */
export function remoteLabel(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

/**
 * The real visibility reader: `gh repo view` for a github.com remote. Any other remote, and any failure (gh not installed or
 * not logged in, offline, a timeout), is null: a place that could not be read is held, never assumed private.
 */
export function ghVisibility(remoteUrl: string): Promise<boolean | null> {
  const repo = githubRepoOf(remoteUrl);
  if (repo === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    // The full URL pins the host: `owner/name` alone is read on gh's default host, which may not be github.com.
    execFile('gh', ['repo', 'view', `https://github.com/${repo}`, '--json', 'visibility', '-q', '.visibility'], { timeout: GH_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const v = stdout.trim().toUpperCase();
      resolve(v === 'PUBLIC' ? true : v === 'PRIVATE' || v === 'INTERNAL' ? false : null);
    });
  });
}

const REAL_DEPS: LandingDeps = { git: realGit, visibility: ghVisibility };

/** One in-memory cache per reader: a read is kept for VISIBILITY_TTL_MS, a failure never. */
const visibilityCaches = new WeakMap<LandingDeps['visibility'], Map<string, { value: boolean; at: number }>>();

async function publicRemote(deps: LandingDeps, url: string): Promise<boolean | null> {
  let cache = visibilityCaches.get(deps.visibility);
  if (cache === undefined) visibilityCaches.set(deps.visibility, (cache = new Map()));
  const known = cache.get(url);
  if (known !== undefined && Date.now() - known.at < VISIBILITY_TTL_MS) return known.value;
  const seen = await deps.visibility(url).catch(() => null);
  if (seen === null) cache.delete(url);
  else cache.set(url, { value: seen, at: Date.now() });
  return seen;
}

const couldNotTell = (what: string, r: GitResult): string => `Could not tell ${what}: git said ${r.stderr.trim() || `exit ${r.code}`}`;

/** Whether `refs/heads/<name>` exists, spelled exactly (NTFS finds `Feature/X` for `feature/x`). */
async function hasBranch(deps: LandingDeps, folder: string, name: string): Promise<boolean> {
  const r = await deps.git(folder, ['for-each-ref', '--format=%(refname)', `refs/heads/${name}`]);
  if (r.code !== 0) throw conflict(couldNotTell(`whether branch ${name} exists`, r));
  return r.stdout.split('\n').some((l) => l.trim() === `refs/heads/${name}`);
}

/** The live build, from dist/build.json in the repository's main checkout. */
async function liveBuild(deps: LandingDeps, folder: string): Promise<{ sha: string; dirty: boolean }> {
  const r = await deps.git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code !== 0) throw conflict(couldNotTell('where the main checkout is', r));
  const file = join(dirname(r.stdout.trim()), 'dist', 'build.json');
  let info: { sha?: unknown; dirty?: unknown };
  try {
    info = JSON.parse(readFileSync(file, 'utf8')) as { sha?: unknown; dirty?: unknown };
  } catch (err) {
    throw conflict(`No live build to compare with: could not read ${file} (${(err as Error).message}).`);
  }
  const sha = info.sha;
  if (typeof sha !== 'string' || !SHA.test(sha)) throw conflict(`No live build to compare with: ${file} holds no sha.`);
  const known = await deps.git(folder, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (known.code !== 0) throw conflict(`The live build ${sha} is not a commit in this repository.`);
  return { sha, dirty: info.dirty === true };
}

/** Aiden's yeses on the project: `<action> <patch id>` on each kind 'yes' line of its log, with the step it was given on. */
function yesesOf(ctx: Ctx, projectId: number): { action: string; patchId: string; stepId: number | null }[] {
  // A yes withdrawn by the undo of the answer that carried it (a `yes_withdrawn` line naming its id, `e11`) is not one: the
  // line names the yes itself, so the undo of one answer never takes back another's yes on the same change.
  const rows = ctx.db
    .prepare(
      `SELECT y.text, y.node_id FROM lead_events y WHERE y.project_id = ? AND y.kind = 'yes'
         AND NOT EXISTS (SELECT 1 FROM lead_events w WHERE w.project_id = y.project_id AND w.kind = 'yes_withdrawn' AND w.text = 'e' || y.id)`,
    )
    .all(projectId) as { text: string; node_id: number | null }[];
  return rows.flatMap((r) => {
    const i = r.text.indexOf(' ');
    return i > 0 ? [{ action: r.text.slice(0, i), patchId: r.text.slice(i + 1), stepId: r.node_id }] : [];
  });
}

/**
 * Aiden's yes to an action on a change: stored as a log line with the action and the change's patch id (for a publish, what
 * goes out: publishKey) and the step, so a later check of the same action on the same change clears. `said` is when he said it (now
 * when absent). Task 11 writes these from his "ship it"; the tests write them here.
 */
export function recordYes(ctx: Ctx, projectId: number, y: { action: LandingAction; patchId: string; stepId: number; aidenWords: string; said?: string }): number {
  const lead = (ctx.db.prepare('SELECT lead FROM projects WHERE id = ?').pluck().get(projectId) as string | null) ?? '';
  const info = ctx.db
    .prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind, node_id, text, aiden_words) VALUES (?, ?, ?, ?, 'yes', ?, ?, ?)")
    .run(projectId, y.said ?? ctx.now(), lead, LEAD_INSTRUCTIONS_VERSION, y.stepId, `${y.action} ${y.patchId}`, y.aidenWords);
  return Number(info.lastInsertRowid);
}

/** Why a publish takes no yes: it does not send its folder's package as committed (the route and the card say it). */
export const PUBLISH_NO_YES = 'this publish names another package, or the folder has changes not committed: run it yourself';

/** Flags of a publish that take a value (the next word, or the part after "="), as publishesFolderPackage reads them. */
const PUBLISH_VALUE_FLAGS = new Set(['--tag', '--access', '--otp', '--registry', '--publish-branch']);

/** A flag's value as the shell gives it: one pair of quotes around it taken off. */
const unquote = (v: string): string => (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v);

/**
 * Where a publish goes, read from its flags: `--dry-run` when given, and `--registry`, `--tag`, `--access` and
 * `--publish-branch` as `<flag>=<value>` whichever way they are written (`=` or a space, the flag in any case), sorted.
 * `--otp` is left out: it changes nothing of where the package goes. Empty for a plain publish, or no publish at all.
 */
export function publishDestination(segment: string | undefined): string[] {
  const m = segment === undefined ? null : /\b(?:npm|pnpm|yarn)\s+publish\b(.*)$/i.exec(segment);
  if (m === null) return [];
  const words = m[1]!.trim().split(/\s+/).filter((w) => w !== '');
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const eq = w.indexOf('=');
    const name = (eq < 0 ? w : w.slice(0, eq)).toLowerCase();
    // --ignore-scripts changes what the package's own scripts do on the way out (prepack, prepublishOnly).
    if ((name === '--dry-run' || name === '--ignore-scripts') && eq < 0) out.push(name);
    else if (PUBLISH_VALUE_FLAGS.has(name)) {
      const value = eq < 0 ? (words[++i] ?? '') : w.slice(eq + 1);
      if (name !== '--otp') out.push(`${name}=${unquote(value)}`);
    }
  }
  return out.sort();
}

/**
 * What a yes for a publish in `folder` is keyed on, what goes out and where: the tree of HEAD, the folder's path inside the
 * repository (`git rev-parse --show-prefix`) and the name and version in its package.json, as
 * `<tree>:<prefix>:<name>@<version>`, then where the held command `segment` sends it (publishDestination), space-separated,
 * when it names anywhere. No key (`why`) when the folder has changes not committed or files not tracked (not ignored), or its
 * package.json names no package: what would go out is not what is committed. A git that fails is a 409.
 */
export async function publishKey(deps: LandingDeps, folder: string, segment?: string): Promise<{ key: string } | { why: string }> {
  // No optional locks: a read must not take the index lock a session's own git may be waiting on.
  const status = await deps.git(folder, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--', '.']);
  if (status.code !== 0) throw conflict(couldNotTell(`whether ${folder} has changes not committed`, status));
  if (status.stdout.trim() !== '') return { why: PUBLISH_NO_YES };
  const tree = await deps.git(folder, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (tree.code !== 0) throw conflict(couldNotTell('the tree of HEAD', tree));
  const prefix = await deps.git(folder, ['rev-parse', '--show-prefix']);
  if (prefix.code !== 0) throw conflict(couldNotTell(`where ${folder} is in its repository`, prefix));
  let pkg: { name?: unknown; version?: unknown };
  try {
    // Read without blocking the server: the folder may be on a slow share.
    pkg = (JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) ?? {}) as { name?: unknown; version?: unknown };
  } catch {
    // No package.json, or one that is not JSON: there is no package of this folder for a yes to cover.
    return { why: PUBLISH_NO_YES };
  }
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || pkg.name.trim() === '' || pkg.version.trim() === '') return { why: PUBLISH_NO_YES };
  const to = publishDestination(segment);
  return { key: `${tree.stdout.trim()}:${prefix.stdout.trim()}:${pkg.name}@${pkg.version}${to.length === 0 ? '' : ` ${to.join(' ')}`}` };
}

/** What a landing check reads of the change for one action: the range, the files, and the key a yes is recorded on. */
interface ChangeRead {
  range: string;
  files: string[];
  /** What a yes is keyed on (LandingAnswer.patchId); null when there is none. */
  patchId: string | null;
  /** A push with no commits to send: clear, and it needs no yes. */
  nothingToPush: boolean;
  holdBecause: string | null;
}

/**
 * The landing check's key for one action, read from git in `folder` (the check's own read, without judging it): a merge on
 * main...branch, a push on what it would push (origin/branch..branch once pushed, else main...branch), a deploy on
 * live..main, each as the patch id of that range's diff; a publish on what goes out and where (publishKey, with the held
 * command `segment`). The carried yes for a held command reads it here too (landingKey), so his yes is keyed as the check
 * keys it.
 */
async function readChange(deps: LandingDeps, folder: string, action: LandingAction, askBranch: string | undefined, segment?: string): Promise<ChangeRead> {
  const git = (args: string[], input?: string) => deps.git(folder, args, input);
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw badRequest(`${folder} is not a git checkout.`);

  let branch = askBranch;
  if (branch === undefined && action !== 'deploy') {
    const head = await git(['symbolic-ref', '-q', '--short', 'HEAD']);
    // Exit 1 with no output is a detached HEAD; anything else that fails is a real failure.
    if (head.code === 1 && head.stderr.trim() === '') throw conflict('This checkout is on no branch: say which with --branch.');
    if (head.code !== 0) throw conflict(couldNotTell('which branch this is', head));
    branch = head.stdout.trim();
    if (!BRANCH.test(branch)) throw conflict('This checkout is on no branch: say which with --branch.');
  }
  if (action === 'merge' && branch === 'main') throw conflict('Name the branch being merged: --branch <name>');
  if (branch !== undefined && !(await hasBranch(deps, folder, branch))) throw conflict(`There is no branch ${branch} in ${folder}.`);

  let range: string;
  let holdBecause: string | null = null;
  if (action === 'merge') range = `refs/heads/main...refs/heads/${branch}`;
  else if (action === 'deploy') {
    const live = await liveBuild(deps, folder);
    range = `${live.sha}..refs/heads/main`;
    const behind = await git(['merge-base', '--is-ancestor', live.sha, 'refs/heads/main']);
    if (behind.code === 1) holdBecause = 'the live build is not behind main';
    else if (behind.code !== 0) throw conflict(couldNotTell('whether the live build is behind main', behind));
    else if (live.dirty) holdBecause = 'the live build was made from uncommitted work';
  } else {
    // push, push-public and publish: what the remote's branch lacks; a branch never pushed is read against main.
    const pushed = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`]);
    if (pushed.code === 0) range = `refs/remotes/origin/${branch}..refs/heads/${branch}`;
    else if (pushed.code !== 1) throw conflict(couldNotTell(`where origin/${branch} is`, pushed));
    else if (branch === 'main') throw conflict('Could not tell what a push of main adds: origin/main is not known in this repository.');
    else range = `refs/heads/main...refs/heads/${branch}`;
  }

  const names = await git([...DIFF, '--name-only', '-z', range, '--']);
  if (names.code !== 0) throw conflict(couldNotTell(`what ${range} changes`, names));
  const files = names.stdout.split('\0').filter((f) => f !== '');
  const diff = await git([...DIFF, '--binary', range, '--']);
  if (diff.code !== 0) throw conflict(couldNotTell(`what ${range} changes`, diff));
  const empty = files.length === 0 && diff.stdout === '';
  if (empty && action === 'merge') throw conflict(`Nothing to compare: ${branch} has no change against main.`);
  if (action === 'push') {
    // Nothing to push means no commits, not no change: a commit and its revert change nothing and still go out.
    const commits = await git(['rev-list', '--count', range.replace('...', '..'), '--']);
    if (commits.code !== 0) throw conflict(couldNotTell(`what ${range} adds`, commits));
    if (Number(commits.stdout.trim()) === 0) return { range, files: [], patchId: null, nothingToPush: true, holdBecause };
  }

  let patchId: string | null = null;
  if (action === 'publish') {
    // A publish is keyed on what goes out, so a yes on a head that is already pushed (an empty range) still counts.
    const key = await publishKey(deps, folder, segment);
    patchId = 'key' in key ? key.key : null;
  } else if (diff.stdout !== '') {
    // --verbatim: whitespace counts, so a yes does not survive an indentation-only change.
    const pid = await git(['patch-id', '--verbatim'], diff.stdout);
    if (pid.code !== 0) throw conflict(couldNotTell('the patch id of the change', pid));
    patchId = pid.stdout.trim().split(/\s+/)[0] || null;
  }
  return { range, files, patchId, nothingToPush: false, holdBecause };
}

/**
 * The key a landing check of `action` in `folder` reads now (readChange), with the range it read, or that a push has nothing
 * to send. Nothing logged, nothing judged: a held command's yes is read through it.
 */
export async function landingKey(
  folder: string,
  action: 'merge' | 'deploy' | 'push' | 'publish',
  branch: string | undefined,
  segment: string | undefined,
  deps: LandingDeps = REAL_DEPS,
): Promise<{ range: string; patchId: string | null; nothingToPush: boolean }> {
  if (!isAbsolute(folder)) throw badRequest(`${folder} is not a full path to a folder.`);
  if (branch !== undefined && !BRANCH.test(branch)) throw badRequest(`${branch} is not a branch name.`);
  const read = await readChange(deps, folder, action, branch, segment);
  return { range: read.range, patchId: read.patchId, nothingToPush: read.nothingToPush };
}

/**
 * Whether the change may land without Aiden, read from git itself in the session's folder and judged in plain code with no
 * model. A held answer is written as a `landing_check` line in the project's log, so the morning list can show what was held;
 * with `opts.record` false nothing is written (the carried "ship it" reads the change's patch id this way).
 */
export async function checkLanding(ctx: Ctx, ask: LandingAsk, deps: LandingDeps = REAL_DEPS, opts: { record?: boolean } = {}): Promise<LandingAnswer> {
  const project = resolveProject(ctx, ask.ref);
  const node = findNode(ctx, ask.stepId);
  if (!node) throw notFound(`#${ask.stepId} not found.`, `Run "outline ${project.slug}" to see this project's steps.`);
  if (node.projectId !== project.id) throw conflict(`#${ask.stepId} is not in this project.`);
  if (!isAbsolute(ask.folder)) throw badRequest(`${ask.folder} is not a full path to a folder.`);
  if (ask.branch !== undefined && !BRANCH.test(ask.branch)) throw badRequest(`${ask.branch} is not a branch name.`);

  const folder = ask.folder;
  const git = (args: string[], input?: string) => deps.git(folder, args, input);
  const { range, files, patchId, nothingToPush, holdBecause } = await readChange(deps, folder, ask.action, ask.branch, ask.segment);
  if (nothingToPush) return { clear: true, text: 'Clear to land', why: 'nothing to push', action: ask.action, range, files: 0, patchId: null };

  // Only a push is judged by where it goes: a publish is Aiden's whatever the remote. Where it goes is the push URL.
  let remotePublic: boolean | null = null;
  let remote: string | undefined;
  if (ask.action === 'push') {
    // --all: a push goes to every push URL, so each is read; any public one makes it public, any unread one could not tell.
    const url = await git(['remote', 'get-url', '--push', '--all', 'origin']);
    const urls = url.code === 0 ? url.stdout.split(/\r?\n/).map((u) => u.trim()).filter((u) => u !== '') : [];
    if (urls.length > 0) {
      remote = remoteLabel(urls[0]);
      // Only a github.com remote can be read; any other place is held as could not tell.
      const reads = await Promise.all(urls.map((u) => (githubRepoOf(u) === null ? Promise.resolve(null) : publicRemote(deps, u))));
      remotePublic = reads.some((r) => r === true) ? true : reads.some((r) => r === null) ? null : false;
    } else remote = 'origin';
  }

  const verdict = landingVerdict({
    action: ask.action,
    files,
    patchId,
    riskGlobs: riskGlobsOf(project.playbook),
    publicRemote: remotePublic,
    remote,
    landingOn: switchLine(ctx.db, project.id, 'landing')?.kind === 'allow',
    stepId: ask.stepId,
    yeses: yesesOf(ctx, project.id),
    holdBecause,
  });
  if (!verdict.clear && opts.record !== false) {
    ctx.db
      .prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind, node_id, text) VALUES (?, ?, ?, ?, 'landing_check', ?, ?)")
      .run(project.id, ctx.now(), project.lead ?? '', LEAD_INSTRUCTIONS_VERSION, ask.stepId, `${ask.action}: ${verdict.text}`);
  }
  return { ...verdict, action: ask.action, range, files: files.length, patchId };
}
