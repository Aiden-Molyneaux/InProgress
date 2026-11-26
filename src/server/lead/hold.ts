import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CHECKED_ACTIONS, HELD_ACTIONS, heldActions, isUpstreamOfMain, mergeTargets, playbookHeldLines, pushTarget, type HeldMatch } from '../../core/hold';
import { ID_MAX } from '../../core/notices';
import { LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { clipLine } from '../../core/step-ref';
import { heldFile } from '../../hooks/hold';
import { deskOnly, flushDesk, type Ctx } from '../db/tx';
import { getDeskItem, moveDeskItem } from '../repo/desk';
import { DESK_ASK_DUE_MS, plusMs, produceDeskItem } from '../repo/deskProducers';
import { insertLeadEvent } from '../repo/leadEvents';
import { findNode } from '../repo/nodes';
import type { Project } from '../../core/types';
import { getProjectById, listBindings, resolveBinding } from '../repo/projects';
import { findSession } from '../repo/sessions';
import { isLiveWithRound } from '../repo/switches';
import { isLeadFolder } from './folder';
import { checkLanding, ghVisibility, realGit, type LandingDeps } from './landing';
import { intendHeldLine } from './voice';

/** What the hold and stuck routes answer when the lead has nothing to say: the hook prints nothing. */
export const SAY_NOTHING = { say: 'nothing' } as const;
export type SayNothing = typeof SAY_NOTHING;

/** How long the stuck route waits for the lead's verdict, and how often it looks. The hook waits 175 s, its timeout is 180 s. */
export const STUCK_WAIT_MS = 170_000;
export const STUCK_POLL_MS = 1000;
/** How much of a tool's input the stuck item's log line keeps. */
const STUCK_INPUT_MAX = 4000;
/** How much of a tool's input a permission decision's line keeps. */
const DECISION_INPUT_CUT = 80;

const REAL_DEPS: LandingDeps = { git: realGit, visibility: ghVisibility };

/** The session's project and its focus step, when the project has a lead and its round is on; else undefined. */
export interface LeadScope {
  project: Project;
  lead: string;
  sessionId: string | null;
  /** The session's focus step, when it is a step of this project. */
  stepId: number | null;
}

/**
 * The project a hook's call belongs to: the session's, else the one the folder is bound to. Undefined (the lead says
 * nothing) when there is none, it has no lead, or its round is off or it is not active.
 */
export function leadScopeOf(ctx: Ctx, sessionId: string | null | undefined, cwd: string): LeadScope | undefined {
  const session = sessionId ? findSession(ctx, sessionId) : undefined;
  // The lead's own folder is the lead's: the hooks say nothing there (task 12), unless a tracked session is asking.
  if (session === undefined && isLeadFolder(ctx, cwd)) return undefined;
  const project = session?.projectId != null ? getProjectById(ctx, session.projectId) : cwd ? resolveBinding(ctx, cwd, session?.branch ?? null) : undefined;
  if (project === undefined || project.lead === null || project.lead.trim() === '') return undefined;
  if (!isLiveWithRound(ctx.db, project.id)) return undefined;
  const focus = session?.focusNodeId ?? null;
  const stepId = focus !== null && findNode(ctx, focus)?.projectId === project.id ? focus : null;
  return { project, lead: project.lead, sessionId: sessionId || null, stepId };
}

/** The desk item's ref for a held command: the same command retried by the same session is one item while it is not done. */
export const heldRef = (sessionId: string | null, command: string): string => createHash('sha1').update(`${sessionId ?? ''}\n${command}`).digest('hex');

/** The desk item's ref for a stuck permission request: its session, tool and input. */
export const stuckRef = (sessionId: string | null, toolName: string, toolInput: unknown): string =>
  createHash('sha1').update(`${sessionId ?? ''}\n${toolName}\n${JSON.stringify(toolInput ?? null)}`).digest('hex');

/**
 * The hold hook's call: the session (when the hook knew it), its folder, the whole command, and the command of it the hook
 * asks about: its place in the line, its text, the folder it runs in, and the action the hook named. The server reads the
 * line again itself and judges the command at that place.
 */
export const holdBody = z
  .object({
    sessionId: z.string().max(ID_MAX).nullable().optional(),
    cwd: z.string().max(1_000),
    command: z.string().min(1).max(100_000),
    action: z.enum(HELD_ACTIONS),
    index: z.number().int().min(0).max(10_000),
    segment: z.string().max(100_000).optional(),
    folder: z.string().max(1_000).nullable().optional(),
  })
  .strict();
export type HoldAsk = z.infer<typeof holdBody>;

export type HoldAnswer = SayNothing | { held: true; text: string };

/** The checkout's branch, or null when it is on none or git could not tell. */
async function currentBranch(deps: LandingDeps, folder: string): Promise<string | null> {
  try {
    const r = await deps.git(folder, ['symbolic-ref', '-q', '--short', 'HEAD']);
    return r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  } catch {
    // git did not finish: the caller holds what it cannot read.
    return null;
  }
}

/** Flags of a publish that take a value: the next word, or the part after "=", is that value. */
const SAFE_VALUE_FLAGS = new Set(['--tag', '--access', '--otp', '--registry', '--publish-branch']);
/** Flags of a publish that change neither which package goes out nor its version. */
const SAFE_FLAGS = new Set(['--dry-run', '--provenance', '--no-git-checks', '--ignore-scripts', '--force']);

/**
 * Whether the publish sends the folder's own package.json as it stands: an npm, pnpm or yarn publish whose flags are all
 * known not to change the package or its version. A path or tarball after it, a workspace or prefix flag, a version bump
 * (yarn's --minor, --new-version) or any flag not known: false, and the publish is named as before, by its branch.
 */
export function publishesFolderPackage(segment: string): boolean {
  const m = /\b(?:npm|pnpm|yarn)\s+publish\b(.*)$/i.exec(segment);
  if (m === null) return false;
  const words = m[1]!.trim().split(/\s+/).filter((w) => w !== '');
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase();
    const eq = w.indexOf('=');
    const name = eq < 0 ? w : w.slice(0, eq);
    if (SAFE_VALUE_FLAGS.has(name)) {
      if (eq < 0) i++;
      continue;
    }
    if (eq < 0 && SAFE_FLAGS.has(name)) continue;
    return false;
  }
  return true;
}

/** The name and version in `<folder>/package.json`, both strings; undefined when it cannot be read or lacks either. */
async function packageOf(folder: string): Promise<{ name: string; version: string } | undefined> {
  let pkg: unknown;
  try {
    // Read without blocking the server: the folder may be on a slow share.
    pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  } catch {
    // No package.json, or one that is not JSON: the publish is named as before, by its branch.
    return undefined;
  }
  const { name, version } = (pkg ?? {}) as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || typeof version !== 'string' || name.trim() === '' || version.trim() === '') return undefined;
  return { name: clipLine(name, 120), version: clipLine(version, 40) };
}

/**
 * A held item's outcome: why it is held, then what the command does on a line of its own (`what` is one line, so the last
 * `\nwhat: ` is always its own). heldWhatOf reads it back.
 */
const HELD_WHAT = '\nwhat: ';
export const heldOutcome = (why: string, what: string): string => `held: ${why}${HELD_WHAT}${clipLine(what, 1_000)}`;

/** What a held item's command does, from its outcome (heldOutcome); undefined for an item held before it was stored. */
export function heldWhatOf(outcome: string | null): string | undefined {
  if (outcome === null || !outcome.startsWith('held: ')) return undefined;
  const at = outcome.lastIndexOf(HELD_WHAT);
  if (at < 0) return undefined;
  const what = outcome.slice(at + HELD_WHAT.length).trim();
  return what === '' ? undefined : what;
}

/** A held answer, as the route works it out: what the command does, and why it is held (for the log). */
type Judged = { clear: true } | { clear: false; what: string; why: string };

/** Runs the landing check for a held command, read from its words, in the folder it runs in; any refusal of the check holds it. */
async function judge(ctx: Ctx, scope: LeadScope, match: HeldMatch, deps: LandingDeps): Promise<Judged> {
  if (!CHECKED_ACTIONS.includes(match.action)) {
    // A playbook line names its command in its what already; any other action names the command here.
    const what = match.action === 'playbook' ? match.what : `${match.what} (${clipLine(match.segment, 120)})`;
    return { clear: false, what, why: "this is Aiden's without a check" };
  }
  const folder = match.folder;
  if (folder === null) return { clear: false, what: match.what, why: 'could not tell which folder it runs in' };
  let branch: string | undefined;
  let what = match.what;
  if (match.action === 'merge') {
    // Only a merge into main is on the list: a merge in a checkout on another branch goes into that branch.
    const on = await currentBranch(deps, folder);
    if (on !== null && on !== 'main') return { clear: true };
    if (on === null) return { clear: false, what: 'a merge', why: 'could not tell which branch this checkout is on' };
    const targets = mergeTargets(match.segment);
    // Updating main from its remote is not a landing.
    if (targets.length === 1 && isUpstreamOfMain(targets[0])) return { clear: true };
    if (targets.length !== 1) return { clear: false, what: 'a merge into main', why: targets.length === 0 ? 'could not tell what is being merged' : 'a merge of several branches at once' };
    branch = targets[0];
    what = `a merge of ${branch} into main`;
  } else if (match.action === 'push') {
    const target = pushTarget(match.segment);
    if (!target.ok) return { clear: false, what: match.what, why: target.why };
    if (target.remote !== 'origin') return { clear: false, what: `a push to ${target.remote}`, why: `could not tell where ${target.remote} is: the check reads origin` };
    branch = target.branch;
    const pushed = branch ?? (await currentBranch(deps, folder));
    what = pushed === null ? 'a push to origin' : `a push of ${pushed} to origin`;
  } else if (match.action === 'deploy') {
    what = 'a deploy of main to the live build';
  } else if (match.action === 'publish') {
    const pkg = publishesFolderPackage(match.segment) ? await packageOf(folder) : undefined;
    if (pkg !== undefined) {
      what = `a publish of ${pkg.name} ${pkg.version} to npm`;
    } else {
      const on = await currentBranch(deps, folder);
      what = on === null ? match.what : `a publish of ${on}`;
    }
  }
  if (scope.stepId === null) return { clear: false, what, why: 'could not tell which step this is for' };
  try {
    const answer = await checkLanding(
      ctx,
      { ref: scope.project.slug, stepId: scope.stepId, action: match.action as 'merge' | 'deploy' | 'push' | 'publish', folder, ...(branch === undefined ? {} : { branch }) },
      deps,
    );
    return answer.clear ? { clear: true } : { clear: false, what, why: answer.text };
  } catch (err) {
    // A check that refuses (a 4xx: no such branch, a range it cannot read) or fails holds the command.
    return { clear: false, what, why: `the landing check could not answer: ${(err as Error).message}` };
  }
}

/**
 * POST /api/lead/hold: a command on the hold list, from the hold or permission hook. Says nothing when the session's
 * project has no lead or its round is off, or the command at the place the hook names is not on this project's list (its
 * Held lines first); else names the action and runs the landing check for a merge, deploy, push or publish in the folder
 * that command runs in (the rest are Aiden's without one). A command that reads differently here than the hook sent it is
 * held. Clear: nothing. Held: a `held`
 * desk item waiting on Aiden (one per session and command while it is not done) and a `held` line in the lead's log, and
 * what the command does, in plain words.
 */
export async function holdCheck(ctx: Ctx, ask: HoldAsk, deps: LandingDeps = REAL_DEPS): Promise<HoldAnswer> {
  const scope = leadScopeOf(ctx, ask.sessionId, ask.cwd);
  if (scope === undefined) return SAY_NOTHING;
  const match = heldActions(ask.command, playbookHeldLines(scope.project.playbook), ask.cwd || null).find((m) => m.index === ask.index);
  if (match === undefined) return SAY_NOTHING;
  const judged: Judged =
    ask.segment !== undefined && ask.segment !== match.segment
      ? { clear: false, what: match.what, why: 'the hook and InProgress read the command differently' }
      : await judge(ctx, scope, match, deps);
  if (judged.clear) return SAY_NOTHING;
  const now = ctx.now();
  ctx.db
    .transaction(() => {
      const { item, created } = produceDeskItem(ctx.db, { projectId: scope.project.id, kind: 'held', ref: heldRef(scope.sessionId, ask.command), nodeId: scope.stepId }, now);
      if (!created) return;
      // Aiden's by the check: the runner never leases it; the Voice and the morning list bring it.
      moveDeskItem(ctx.db, item.id, ['open'], 'waiting_aiden', { outcome: heldOutcome(judged.why, judged.what), now });
      insertLeadEvent(
        ctx.db,
        {
          projectId: scope.project.id,
          lead: scope.lead,
          instructions: LEAD_INSTRUCTIONS_VERSION,
          kind: 'held',
          ...(scope.stepId === null ? {} : { nodeId: scope.stepId }),
          ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
          text: `${ask.command} -> ${judged.why}`,
        },
        now,
      );
      // A new held item reaches the Voice as one line (task 11).
      intendHeldLine(ctx.db, { projectId: scope.project.id, itemId: item.id, projectName: scope.project.name, stepId: scope.stepId, what: judged.what }, now);
    })
    .immediate();
  // Made in a transaction of its own: the window hears of the new held item now.
  flushDesk(ctx.db);
  return { held: true, text: judged.what };
}

export interface StuckAsk {
  sessionId?: string | null;
  cwd: string;
  toolName: string;
  toolInput?: unknown;
}

export type StuckAnswer = SayNothing | { behavior: 'allow' | 'deny'; message: string };

/** What a stuck item's log line holds: the tool and its input, after the item's ref so the item finds it. */
const stuckLine = (ref: string, toolName: string, input: string): string => `${ref} ${toolName} ${input}`;

/** The tool and input of a stuck item, from its `stuck` line in the lead's log; undefined when the line is gone. */
export function stuckRequestOf(ctx: Ctx, item: { projectId: number; ref: string }): { toolName: string; input: string; sessionId: string | null } | undefined {
  const row = ctx.db
    .prepare("SELECT text, session_id FROM lead_events WHERE project_id = ? AND kind = 'stuck' AND substr(text, 1, ?) = ? ORDER BY id DESC LIMIT 1")
    .get(item.projectId, item.ref.length + 1, `${item.ref} `) as { text: string; session_id: string | null } | undefined;
  if (row === undefined) return undefined;
  const rest = row.text.slice(item.ref.length + 1);
  const space = rest.indexOf(' ');
  return space < 0 ? { toolName: rest, input: '', sessionId: row.session_id } : { toolName: rest.slice(0, space), input: rest.slice(space + 1), sessionId: row.session_id };
}

/** A tool's input as one line of the log: its JSON, clipped. */
export const inputText = (toolInput: unknown, max = STUCK_INPUT_MAX): string => clipLine(JSON.stringify(toolInput ?? null), max);

/** A permission decision's line: `<tool> <input clipped to 80> -> allow|deny`. */
export const permissionLine = (toolName: string, input: string, behavior: 'allow' | 'deny'): string => `${toolName} ${clipLine(input, DECISION_INPUT_CUT)} -> ${behavior}`;

/** What the lead's verdict on a stuck item says, read from its outcome: allow or deny with the reason, else undefined. */
export function stuckVerdict(outcome: string | null): { behavior: 'allow' | 'deny'; message: string } | undefined {
  const m = /^(ALLOW|DENY)(?: (.*))?$/s.exec(outcome ?? '');
  if (!m) return undefined;
  return { behavior: m[1] === 'ALLOW' ? 'allow' : 'deny', message: (m[2] ?? '').trim() };
}

export interface StuckWaitOptions {
  waitMs?: number;
  pollMs?: number;
  /** Resolves after `ms`; a timer unless a test gives another. */
  sleep?: (ms: number) => Promise<void>;
  /** Whether the hook has gone (its connection closed): the wait stops, and the item stays. */
  gone?: () => boolean;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /api/lead/stuck: a permission request no hold covers, from the permission hook. Says nothing at once when the
 * project has no lead or its round is off. Else a `stuck` item (one per session, tool and input while it is not done),
 * due in 3 minutes, wakes the runner, and the request waits, reading the item every second for up to 170 seconds. A
 * DECIDE the lead applied answers allow or deny with his reason; anything else (AIDEN, CARD, an unclear answer, no verdict
 * in time) says nothing, so the prompt shows as it does today, and the item stays.
 */
export async function stuckWait(ctx: Ctx, ask: StuckAsk, opts: StuckWaitOptions = {}): Promise<StuckAnswer> {
  const scope = leadScopeOf(ctx, ask.sessionId, ask.cwd);
  if (scope === undefined) return SAY_NOTHING;
  const ref = stuckRef(scope.sessionId, ask.toolName, ask.toolInput);
  const now = ctx.now();
  const itemId = ctx.db
    .transaction(() => {
      const { item, created } = produceDeskItem(ctx.db, { projectId: scope.project.id, kind: 'stuck', ref, nodeId: scope.stepId, dueAt: plusMs(now, DESK_ASK_DUE_MS) }, now);
      if (created) {
        insertLeadEvent(
          ctx.db,
          {
            projectId: scope.project.id,
            lead: scope.lead,
            instructions: LEAD_INSTRUCTIONS_VERSION,
            kind: 'stuck',
            ...(scope.stepId === null ? {} : { nodeId: scope.stepId }),
            ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
            text: stuckLine(ref, ask.toolName, inputText(ask.toolInput)),
          },
          now,
        );
      }
      return item.id;
    })
    .immediate();
  const waitMs = opts.waitMs ?? STUCK_WAIT_MS;
  const pollMs = opts.pollMs ?? STUCK_POLL_MS;
  const sleep = opts.sleep ?? sleepFor;
  // Measured on the clock, not by counting sleeps: a slow event loop must not stretch the wait past the hook's timeout.
  const deadline = Date.now() + waitMs;
  for (;;) {
    const item = getDeskItem(ctx.db, itemId);
    if (item === undefined || item.state === 'waiting_aiden') return SAY_NOTHING;
    if (item.state === 'done') return stuckVerdict(item.outcome) ?? SAY_NOTHING;
    if (Date.now() >= deadline || opts.gone?.()) return SAY_NOTHING;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** The Held lines of every live project with a lead, merged: what the hold hook adds to P3's list. */
export function allHeldLines(ctx: Ctx): string[] {
  const rows = ctx.db.prepare("SELECT playbook FROM projects WHERE lead IS NOT NULL AND trim(lead) <> '' AND deleted_at IS NULL ORDER BY id").pluck().all() as string[];
  return [...new Set(rows.flatMap((p) => playbookHeldLines(p)))];
}

/** The bound folders of every project with a lead and its round on: where the hook holds a command InProgress does not answer about. */
export function watchedFolders(ctx: Ctx): string[] {
  const live = new Map<number, boolean>();
  const watched = (projectId: number): boolean => {
    if (!live.has(projectId)) {
      const lead = ctx.db.prepare('SELECT lead FROM projects WHERE id = ?').pluck().get(projectId) as string | null | undefined;
      live.set(projectId, typeof lead === 'string' && lead.trim() !== '' && isLiveWithRound(ctx.db, projectId));
    }
    return live.get(projectId)!;
  };
  return [...new Set(listBindings(ctx).filter((b) => watched(b.projectId)).map((b) => b.path.replace(/\\/g, '/')))];
}

/** How often a rename over held.json is tried when Windows has the file open (EPERM, EBUSY), and how long apart. */
const RENAME_TRIES = 3;
const RENAME_WAIT_MS = 100;

function renameWithRetry(from: string, to: string, rename: (from: string, to: string) => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= RENAME_TRIES) throw err;
      // A hook reading the file holds it open for a moment. A synchronous wait: this runs inside an event listener.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS);
    }
  }
}

/**
 * Writes `<home>/lead/held.json`: `{ lines, folders }`, the playbooks' Held lines and the folders where a command on the
 * list is held while InProgress does not answer. A temporary file is renamed over it, so the hook never reads half of one;
 * a failed write removes the temporary file and throws.
 */
export function writeHeldLines(ctx: Ctx, home: string, rename: (from: string, to: string) => void = renameSync): { lines: string[]; folders: string[] } {
  const content = { lines: allHeldLines(ctx), folders: watchedFolders(ctx) };
  const file = heldFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`);
    renameWithRetry(tmp, file, rename);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return content;
}

/** The events after which held.json may say something else: a playbook, a lead, a switch, a project's state, a binding. */
const HELD_EVENTS = new Set(['project.updated', 'project.deleted', 'project.restored', 'project.purged', 'binding.created', 'binding.deleted']);

/**
 * Writes held.json now and again after each event that can change it. A failed write is logged and the next event tries
 * again. Answers the unsubscribe.
 */
export function watchHeldLines(ctx: Ctx, home: string, log: { error: (message: string) => void }): () => void {
  const rewrite = () => {
    try {
      writeHeldLines(ctx, home);
    } catch (err) {
      log.error(`Could not write the Held lines and watched folders to ${heldFile(home)}: ${(err as Error).message}`);
    }
  };
  rewrite();
  const listener = (e: { type: string; data?: unknown }) => {
    // A desk-only change (tx.ts) changes nothing held.json says.
    if (HELD_EVENTS.has(e.type) && !deskOnly(e)) rewrite();
  };
  ctx.bus.on('event', listener);
  return () => {
    ctx.bus.off('event', listener);
  };
}
