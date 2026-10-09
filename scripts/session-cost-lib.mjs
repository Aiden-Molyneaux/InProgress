// The logic behind `node scripts/session-cost.mjs`, kept apart from the file system, git and printing so
// test/scripts/session-cost-lib.test.ts can feed it text: list prices, which branch each request belongs to, cold
// re-writes, and the parsing of git's output. Types are in session-cost-lib.d.mts.
import { win32 } from 'node:path';

// USD per million tokens, list price (claude-api skill, cached 2026-10-06, checked 2026-10-09).
// Cache writes are priced from input: 5-minute at 1.25x, 1-hour at 2x. Cache reads vary by model
// (Opus 5.5 0.05x, Fable 5.1 0.025x, most others 0.1x). A model with `long` switches to those
// rates when the prompt is over `over`.
export const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { input: 0.5, output: 2.5, cacheRead: 0.05, over: 100_000 } },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};
export const modelKey = (m) => m.replace(/-\d{8}$/, '');

// A main-session request that writes at least half its prompt to cache, on a prompt this big,
// is a cold re-write: the cache expired (an idle gap) or was invalidated, and the whole context
// was paid for again at the write rate.
export const COLD_MIN = 50_000;

// ---- Attribution -------------------------------------------------------------------------------
// Sessions here edit worktrees by path from the main checkout, so `gitBranch` on a transcript
// line says `main` for nearly all work. Each request is attributed to the branch the session was
// last working on: walking the transcript in order, a line switches the current branch when its
// `gitBranch` is a feature branch, when a tool call touches `.claude/worktrees/<name>`, or when a
// command creates a branch. A `git merge` run in the main checkout ends the branch: what follows
// is `(main)` (planning, landing, chat) until the next marker. A worktree that `git worktree remove`
// or `prune` names is not one the session works in, so the cleanup after a merge is not a marker.

export const MAIN = '(main)';
const MAIN_BRANCHES = new Set(['main', 'master', 'HEAD', '']);
const WT_RE = /\.claude[\\/]+worktrees[\\/]+([A-Za-z0-9._-]+)(\*)?/g;
const NEW_BRANCH_RE = /\bgit\b[^\n;&|]*?\b(?:checkout\s+-[bB]|switch\s+-[cC]|worktree\s+add\b[^\n;&|]*?\s-[bB])\s+([A-Za-z0-9._/-]+)/g;
const WT_ADD_RE = /\bworktree\s+add\b[^\n;&|]*/g;

// A merge or a cleanup is recognised per simple command, not anywhere in the text: `git merge-base`, a grep for
// "git merge" and a commit message that mentions one are not merges. A command is split on `&&`, `||`, `;`, `|` and
// newlines (quotes are not understood, which is close enough here), and `git -C <dir>` may precede the subcommand.
const SEGMENT_SPLIT_RE = /&&|\|\|?|;|\r?\n/;
const MERGE_RE = /^git(?:\s+-C\s+\S+)?\s+merge(?=\s|$)/;
const WT_CLEANUP_RE = /^git(?:\s+-C\s+\S+)?\s+worktree\s+(?:remove|prune)(?=\s|$)/;

// A heredoc body is text, not commands, so it goes; inside quotes a separator is text too, so it becomes a space
// (the quoted text stays, for the worktree paths it may hold). `git commit -m "x; git merge y"` is then one segment.
const HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;
const QUOTED_RE = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
const unquoted = (command) => command.replace(HEREDOC_RE, ' ').replace(QUOTED_RE, (q) => q.replace(/[;&|\r\n]/g, ' '));
const segmentsOf = (command) => unquoted(command).split(SEGMENT_SPLIT_RE).map((s) => s.trim());
const isMerge = (segment) => MERGE_RE.test(segment) && !segment.includes(' --abort') && !segment.includes(' --quit');
// A merge runs in the main checkout unless it names a worktree itself (`git -C .claude/worktrees/x merge main`) or an
// earlier segment moved into one (`cd .claude/worktrees/x && git merge main`). A worktree path in a later segment, such
// as the cleanup in `git merge --no-ff x && git worktree remove .claude/worktrees/x`, does not change where it ran.
const mergesIntoMainCheckout = (segments) => segments.some((s, i) =>
  isMerge(s) && !s.match(WT_RE) && !segments.slice(0, i).some((p) => /^(?:cd|pushd)\s/.test(p) && p.match(WT_RE)));

// Worktree directory name -> branch: the live worktree list, plus `git worktree add` commands
// seen in transcripts for worktrees removed since.

/** The nested worktrees that have a branch, from `git worktree list --porcelain`: directory name -> branch. */
export function parseWorktreeList(porcelain) {
  const worktrees = new Map();
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const name = block.match(/^worktree .*[\\/]\.claude[\\/]worktrees[\\/]([^\\/\r\n]+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (name && branch) worktrees.set(name, branch.trim());
  }
  return worktrees;
}

// A subagent dispatched with worktree isolation works in `.claude/worktrees/agent-<id>`, removed
// afterwards; its meta file names the worktree, and its description (which starts with the
// step id) is a far better label than the generated branch name.

/** The worktree name and label for one subagent meta file (`metaFile` is its file name). */
export function agentWorktreeEntry(metaFile, meta) {
  // Some isolated agents' meta files omit the path; their worktree is still agent-<id>. The paths are Windows ones,
  // so win32.basename, which splits on both separators on any host.
  const name = meta.worktreePath ? win32.basename(meta.worktreePath.replace(/[\\/]+$/, '')) : metaFile.replace('.meta.json', '');
  return [name, meta.description ?? meta.worktreeBranch ?? name];
}

// `git worktree add <path> <branch>` (no -b or -B) checks out a branch that exists: the first word after the path that
// is not an option. A detached worktree has no branch, and `git worktree add <path>` alone is named after its path.
function existingBranchOf(add, pathMatch) {
  if (!pathMatch || /\s--detach\b/.test(add)) return null;
  const ref = add.slice(pathMatch.index + pathMatch[0].length).match(/^\S*\s+(?:-\S*\s+)*([A-Za-z0-9._/][A-Za-z0-9._/-]*)/)?.[1] ?? null;
  // HEAD, a commit id or a remote ref checks out a detached worktree: there is no branch to learn.
  return ref && !/^(HEAD|[0-9a-f]{7,40}|origin\/.*)$/.test(ref) ? ref : null;
}

function learnWorktrees(command, worktrees) {
  for (const add of command.match(WT_ADD_RE) ?? []) {
    const pathMatch = [...add.matchAll(WT_RE)][0];
    const name = pathMatch?.[1];
    const branch = add.match(/\s-[bB]\s+([A-Za-z0-9._/-]+)/)?.[1] ?? existingBranchOf(add, pathMatch);
    if (name && branch && !worktrees.has(name)) worktrees.set(name, branch);
  }
}

// A worktree name as written in a command or path: trailing dots are sentence punctuation, and
// a glob like `agent-ae03*` stands for the one worktree it prefixes.
export function branchOfWorktree(written, worktrees, glob = false) {
  const name = written.replace(/\.+$/, '');
  if (worktrees.has(name)) return worktrees.get(name);
  if (!glob) return name;
  const prefixed = [...worktrees.keys()].filter((n) => n.startsWith(name));
  return prefixed.length === 1 ? worktrees.get(prefixed[0]) : name;
}

// The branch a line points at, or null. `merged` is true for a merge run in the main checkout.
// Learns the worktrees that `git worktree add` commands create into `worktrees`.
export function markersOf(j, worktrees) {
  if (j.gitBranch && !MAIN_BRANCHES.has(j.gitBranch)) return { branch: j.gitBranch, merged: false };
  const content = Array.isArray(j.message?.content) ? j.message.content : [];
  const hits = new Map();
  let created = null;
  let merged = false;
  for (const block of content) {
    if (block?.type !== 'tool_use' || !block.input) continue;
    const command = typeof block.input.command === 'string' ? block.input.command : '';
    const segments = segmentsOf(command);
    if (command) learnWorktrees(command, worktrees);
    // Removing a worktree is not working in it: its path in a cleanup command is no marker, or the cleanup after a
    // merge would send the session back to the branch it just merged.
    if (!segments.some((s) => WT_CLEANUP_RE.test(s))) {
      for (const m of JSON.stringify(block.input).matchAll(WT_RE)) {
        const branch = branchOfWorktree(m[1], worktrees, m[2] === '*');
        hits.set(branch, (hits.get(branch) ?? 0) + 1);
      }
    }
    for (const m of command.matchAll(NEW_BRANCH_RE)) created = m[1];
    if (mergesIntoMainCheckout(segments)) merged = true;
  }
  if (created) return { branch: created, merged };
  const top = [...hits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { branch: top, merged };
}

// One assistant message can be written as several transcript lines; the last carries the
// final usage, so key by message id and keep the last. `spawns` maps each tool_use id to the
// branch current when it was issued, so a subagent can inherit its dispatcher's branch.
// `seen`, when given, holds the message ids already priced from other transcripts: a forked or resumed session's file
// starts with copies of the messages it was forked from, and each must be priced once. This text's own ids join it
// only at the end, so a message written as several lines here still keeps its last one.
export function readCallsFromText(raw, start, worktrees, seen) {
  const byId = new Map();
  const spawns = new Map();
  let current = start;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      // A partially written last line (session still open) is expected; skip it.
      continue;
    }
    const { branch, merged } = markersOf(j, worktrees);
    if (branch) current = branch;
    const m = j.message;
    if (Array.isArray(m?.content)) {
      for (const block of m.content) if (block?.type === 'tool_use' && block.id) spawns.set(block.id, current);
    }
    if (m?.usage && m.id && m.model && m.model !== '<synthetic>' && !seen?.has(m.id)) {
      const u = m.usage;
      byId.set(m.id, {
        branch: current,
        at: j.timestamp ?? '',
        model: m.model,
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cw5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
        cw1h: u.cache_creation?.ephemeral_1h_input_tokens ?? (u.cache_creation ? 0 : u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens ?? 0,
      });
    }
    if (merged) current = MAIN;
  }
  if (seen) for (const id of byId.keys()) seen.add(id);
  return { calls: [...byId.values()], spawns };
}

// ---- Pricing -----------------------------------------------------------------------------------

export function priceOf(model, u) {
  const p = PRICES[modelKey(model)];
  if (!p) return null;
  const prompt = u.input + u.cacheRead + u.cw5m + u.cw1h;
  const r = p.long && prompt > p.long.over ? { ...p, ...p.long } : p;
  return {
    input: (u.input * r.input) / 1e6,
    write: ((u.cw5m * 1.25 + u.cw1h * 2) * r.input) / 1e6,
    read: (u.cacheRead * r.cacheRead) / 1e6,
    output: (u.output * r.output) / 1e6,
  };
}

/**
 * True when a request is a cold re-write (see COLD_MIN). The caller decides whether it came from the main session.
 * Known false positive: one large tool result written onto a small cached context also makes a prompt of 50k or more
 * that is mostly cache writes, though the cache was warm. The count is an upper bound.
 */
export function isCold(u) {
  const context = u.input + u.cacheRead + u.cw5m + u.cw1h;
  return context >= COLD_MIN && u.cw5m + u.cw1h >= context / 2;
}

// ---- Lines changed -----------------------------------------------------------------------------
// Every commit on main's first-parent line, with its lines added + deleted against its first
// parent (so a merge counts what its branch brought in). Lockfiles are left out. A merge's
// branch comes from its second parent when a live branch still points there, else from a
// "Merge branch 'x'" subject; its step from a "(#id" in the subject.

const SKIP_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

/**
 * Parses `git log --first-parent --diff-merges=first-parent --numstat --format=%x00%H%x09%P%x09%cI%x09%s`. Each record
 * starts with a NUL, which a subject cannot contain. A merge's `branch` is null until nameMerges.
 */
export function parseMainLog(log) {
  const commits = [];
  for (const chunk of log.split('\0').slice(1)) {
    const [head, ...rest] = chunk.split('\n');
    const [sha, parents, at, subject] = head.split('\t');
    let lines = 0;
    for (const row of rest) {
      const m = row.match(/^(\d+)\t(\d+)\t(.+)$/);
      if (m && !SKIP_FILES.test(m[3].trim())) lines += Number(m[1]) + Number(m[2]);
    }
    const ps = parents.split(' ').filter(Boolean);
    // A direct commit on main (spec, plan, ruling) belongs to (main).
    commits.push({ sha, second: ps[1] ?? null, at: Date.parse(at), subject: subject ?? '', lines, branch: ps[1] ? null : MAIN });
  }
  return commits;
}

/** Names the merges in `commits`: `names[i]` is what `git name-rev` said for the second parent of the i-th merge. */
export function nameMerges(commits, names) {
  commits.filter((c) => c.second).forEach((c, i) => {
    const name = names[i]?.trim();
    c.branch = name && !/[~^]/.test(name) && name !== 'undefined' ? name : c.subject.match(/^Merge branch '([^']+)'/)?.[1] ?? null;
  });
}

/** The commits that landed between a session's first and last counted request. */
export function committedWithin(commits, span) {
  return commits.filter((c) => c.at >= Date.parse(span.first) && c.at <= Date.parse(span.last));
}
