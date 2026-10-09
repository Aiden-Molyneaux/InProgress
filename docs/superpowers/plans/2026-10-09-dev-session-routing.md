# Dev-session routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the routing setup Aiden approved: four pinned agents, a root CLAUDE.md, a 300k compaction window, a context-size nudge hook, and a tested session-cost script, as a PR on a new private GitHub repo.

**Architecture:** Config and prose files carry the routing rules (`CLAUDE.md`, `.claude/agents/*.md`, `.claude/settings.json`). Two Node scripts carry the mechanics: `scripts/context-nudge.mjs` (a `PostToolBatch` hook) and `scripts/session-cost.mjs` (a read-only report), whose pure logic moves to `scripts/session-cost-lib.mjs` for tests, following `scripts/deploy-lib.mjs`.

**Tech Stack:** Node 20 ESM scripts, vitest (node environment), TypeScript only for tests and `.d.mts` declarations, Claude Code hooks and subagents, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-10-09-dev-session-routing-design.md`

## Global Constraints

- Work only in the worktree `C:/personal/InProgress/.claude/worktrees/dev-routing` (branch `dev-routing`). Never edit the main checkout.
- No em dashes (U+2014) or their HTML entities in any file: `test/repo/no-em-dash.test.ts` scans every tracked and untracked file.
- Agent frontmatter pins full model ids: `claude-haiku-5-5`, `claude-sonnet-5-5`. Overrides at dispatch use aliases.
- `.claude/settings.json` sets `"autoCompactWindow": 300000`; the nudge thresholds are 120000 and 160000.
- Implementers never commit, merge, push, deploy, stash, reset or check out, and never run `claude:install` or `claude:uninstall`. The main session commits, staging explicit paths only.
- Never read or write `~/.inprogress` or the live server; tests run with `INPROGRESS_HOME=.test-home` (vitest config).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Checks for the ops label: `npm run typecheck` and `npm test` (from the worktree; `node_modules` resolves from the parent checkout).

## File structure

| Path | Change | Responsibility |
|---|---|---|
| `scripts/session-cost-lib.mjs` | create | Pure logic: prices, attribution, cold re-writes, git log parsing |
| `scripts/session-cost-lib.d.mts` | create | Types for the tests' typecheck |
| `scripts/session-cost.mjs` | modify | CLI only: arguments, file system, git, aggregation, printing |
| `test/scripts/session-cost-lib.test.ts` | create | Unit tests for the lib |
| `scripts/context-nudge.mjs` | create | `PostToolBatch` hook: tells the main session its context size at 120k and 160k |
| `test/scripts/context-nudge.test.ts` | create | Runs the hook as a child process on fixture transcripts |
| `.claude/agents/explorer.md`, `implementer.md`, `code-reviewer.md`, `screen-reviewer.md` | create | The four routed agents |
| `.claude/agents/design-reviewer.md` | delete | Retired |
| `test/repo/agents.test.ts` | create | Every agent pins a full model id and sets effort; the set is exact |
| `CLAUDE.md` | create | Routing rules for the main session |
| `.claude/settings.json` | create | Compaction window and the nudge hook |

Tasks 1 and 2 go to implementers (Sonnet) in parallel: they touch disjoint files. Tasks 3 and 4 are prose and config the main session writes from the spec. Tasks 5 to 7 are the main session's.

---

### Task 1: Split session-cost into a tested lib

**Files:**
- Create: `scripts/session-cost-lib.mjs`, `scripts/session-cost-lib.d.mts`, `test/scripts/session-cost-lib.test.ts`
- Modify: `scripts/session-cost.mjs`

**Interfaces:**
- Produces (exported from `scripts/session-cost-lib.mjs`, declared in the `.d.mts` exactly as below):

```ts
export const MAIN: string; // '(main)'
export const COLD_MIN: number; // 50_000
export type Usage = { input: number; cacheRead: number; cw5m: number; cw1h: number; output: number };
export type Call = Usage & { branch: string; at: string; model: string };
export type Cost = { input: number; write: number; read: number; output: number };
export type Commit = { sha: string; second: string | null; at: number; subject: string; lines: number; branch: string | null };
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; long?: { input: number; output: number; cacheRead: number; over: number } }>;
export function modelKey(model: string): string;
export function priceOf(model: string, u: Usage): Cost | null;
export function isCold(u: Usage): boolean;
export function parseWorktreeList(porcelain: string): Map<string, string>;
export function agentWorktreeEntry(metaFile: string, meta: { worktreePath?: string; worktreeBranch?: string; description?: string }): [string, string];
export function branchOfWorktree(written: string, worktrees: Map<string, string>, glob?: boolean): string;
export function markersOf(line: unknown, worktrees: Map<string, string>): { branch: string | null; merged: boolean };
export function readCallsFromText(raw: string, start: string, worktrees: Map<string, string>): { calls: Call[]; spawns: Map<string, string> };
export function parseMainLog(log: string): Commit[];
export function nameMerges(commits: Commit[], names: string[]): void;
export function committedWithin(commits: Commit[], span: { first: string; last: string }): Commit[];
```

- [ ] **Step 1: Write the failing tests** in `test/scripts/session-cost-lib.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  MAIN, agentWorktreeEntry, branchOfWorktree, committedWithin, isCold, nameMerges, parseMainLog,
  parseWorktreeList, priceOf, readCallsFromText,
} from '../../scripts/session-cost-lib.mjs';

const usage = (o: Partial<{ input: number; cacheRead: number; cw5m: number; cw1h: number; output: number }> = {}) =>
  ({ input: 0, cacheRead: 0, cw5m: 0, cw1h: 0, output: 0, ...o });

/** One assistant request as Claude Code writes it to a transcript. */
function assistant(id: string, o: { model?: string; branch?: string; tools?: object[]; out?: number } = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-09T10:00:00.000Z',
    gitBranch: o.branch ?? 'main',
    message: {
      id,
      model: o.model ?? 'claude-opus-5-5',
      content: o.tools ?? [],
      usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: o.out ?? 1 },
    },
  });
}
const tool = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const worktrees = () => new Map([
  ['goto', 'goto'],
  ['quiet-t1', 'quiet/t1-tokens'],
  ['agent-ae03e131a99d47df8', '#98 P4 session identity implementer'],
]);
const branches = (lines: string[], map = worktrees()) => readCallsFromText(lines.join('\n'), MAIN, map).calls.map((c) => c.branch);

describe('priceOf', () => {
  it('prices every bucket at Opus 5.5 list rates', () => {
    const m = 1_000_000;
    expect(priceOf('claude-opus-5-5', usage({ input: m, cacheRead: m, cw5m: m, cw1h: m, output: m }))).toEqual({ input: 4, write: 13, read: 0.2, output: 20 });
  });
  it('moves Haiku 5.5 to its long card on prompts over 100K', () => {
    expect(priceOf('claude-haiku-5-5', usage({ input: 100_000 }))!.input).toBeCloseTo(0.01, 10);
    expect(priceOf('claude-haiku-5-5', usage({ input: 100_001 }))!.input).toBeCloseTo(0.0500005, 10);
  });
  it('ignores a dated suffix and returns null for an unknown model', () => {
    expect(priceOf('claude-haiku-4-5-20251001', usage({ output: 1_000_000 }))!.output).toBe(5);
    expect(priceOf('claude-mystery-9', usage({ input: 1 }))).toBeNull();
  });
});

describe('readCallsFromText', () => {
  it('keeps the last usage line written for a message id', () => {
    const { calls } = readCallsFromText([assistant('m1', { out: 5 }), assistant('m1', { out: 9 })].join('\n'), MAIN, new Map());
    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBe(9);
  });
  it('skips synthetic messages and a partial last line', () => {
    const raw = [assistant('m1'), assistant('m2', { model: '<synthetic>' }), '{"type":"assist'].join('\n');
    expect(readCallsFromText(raw, MAIN, new Map()).calls).toHaveLength(1);
  });
});

describe('attribution', () => {
  it('follows a feature gitBranch and carries it forward', () => {
    expect(branches([assistant('a', { branch: 'feat/x' }), assistant('b')])).toEqual(['feat/x', 'feat/x']);
  });
  it('follows a worktree path in a tool call, with Windows separators', () => {
    const read = tool('t1', 'Read', { file_path: 'C:\\personal\\InProgress\\.claude\\worktrees\\quiet-t1\\src\\a.ts' });
    expect(branches([assistant('a'), assistant('b', { tools: [read] })])).toEqual([MAIN, 'quiet/t1-tokens']);
  });
  it('follows a created branch and learns its worktree', () => {
    const map = worktrees();
    const add = tool('t1', 'Bash', { command: 'git worktree add .claude/worktrees/new-thing -b feat/new-thing main' });
    const edit = tool('t2', 'Edit', { file_path: 'C:/personal/InProgress/.claude/worktrees/new-thing/x.ts' });
    expect(branches([assistant('a', { tools: [add] }), assistant('b'), assistant('c', { tools: [edit] })], map))
      .toEqual(['feat/new-thing', 'feat/new-thing', 'feat/new-thing']);
    expect(map.get('new-thing')).toBe('feat/new-thing');
  });
  it('ends a branch after a merge in the main checkout, not after one inside a worktree', () => {
    const mergeMain = tool('t1', 'Bash', { command: 'git merge --no-ff goto -m "Merge"' });
    const mergeInWorktree = tool('t2', 'Bash', { command: 'git -C .claude/worktrees/goto merge main' });
    expect(branches([assistant('a', { branch: 'feat/x' }), assistant('b', { tools: [mergeMain] }), assistant('c')])).toEqual(['feat/x', 'feat/x', MAIN]);
    expect(branches([assistant('a', { tools: [mergeInWorktree] }), assistant('b')])).toEqual(['goto', 'goto']);
  });
  it('resolves a trailing dot always, and a prefix only for a glob', () => {
    expect(branchOfWorktree('goto.', worktrees())).toBe('goto');
    expect(branchOfWorktree('agent-ae03', worktrees(), true)).toBe('#98 P4 session identity implementer');
    expect(branchOfWorktree('agent-ae03', worktrees())).toBe('agent-ae03');
    expect(branchOfWorktree('unknown-wt', worktrees())).toBe('unknown-wt');
  });
  it('treats a worktree glob in a command as that worktree', () => {
    const ls = tool('t1', 'Bash', { command: 'ls -d /c/personal/InProgress/.claude/worktrees/agent-ae03* 2>&1' });
    expect(branches([assistant('a', { tools: [ls] })])).toEqual(['#98 P4 session identity implementer']);
  });
  it('records the branch current when each tool call was issued, for subagents to start from', () => {
    const dispatch = tool('toolu_1', 'Agent', { description: '#1 build', prompt: 'Work in .claude/worktrees/goto only.' });
    expect(readCallsFromText(assistant('a', { tools: [dispatch] }), MAIN, worktrees()).spawns.get('toolu_1')).toBe('goto');
  });
});

describe('agentWorktreeEntry', () => {
  it('labels an isolated agent worktree with its dispatch description', () => {
    expect(agentWorktreeEntry('agent-a1.meta.json', { worktreePath: 'C:\\personal\\InProgress\\.claude\\worktrees\\agent-a1', description: '#102 P8 implementer' }))
      .toEqual(['agent-a1', '#102 P8 implementer']);
    expect(agentWorktreeEntry('agent-a2.meta.json', { description: '#98 P4 implementer' })).toEqual(['agent-a2', '#98 P4 implementer']);
    expect(agentWorktreeEntry('agent-a3.meta.json', { worktreeBranch: 'worktree-agent-a3' })).toEqual(['agent-a3', 'worktree-agent-a3']);
  });
});

describe('parseWorktreeList', () => {
  it('maps each nested worktree with a branch', () => {
    const porcelain = [
      'worktree C:/personal/InProgress', 'HEAD d080341', 'branch refs/heads/main', '',
      'worktree C:/personal/InProgress/.claude/worktrees/quiet-t1', 'HEAD 9e309b7', 'branch refs/heads/quiet/t1-tokens', '',
      'worktree C:/personal/InProgress/.claude/worktrees/loose', 'HEAD 1234567', 'detached', '',
    ].join('\n');
    expect([...parseWorktreeList(porcelain)]).toEqual([['quiet-t1', 'quiet/t1-tokens']]);
  });
});

describe('isCold', () => {
  it('flags a prompt of 50k or more that is at least half cache writes', () => {
    expect(isCold(usage({ cacheRead: 20_000, cw1h: 40_000 }))).toBe(true);
    expect(isCold(usage({ cacheRead: 40_000, cw1h: 20_000 }))).toBe(false);
    expect(isCold(usage({ cw1h: 40_000 }))).toBe(false);
  });
});

describe('lines landed', () => {
  const log = [
    '@@aaa\tp1 p2\t2026-10-09T12:00:00+00:00\tMerge: Go to a step (#227)',
    '10\t2\tweb/src/chrome/GoTo.tsx',
    '500\t0\tpackage-lock.json',
    '',
    '@@bbb\tp0\t2026-10-08T12:00:00+00:00\tSpec: something (#228)',
    '30\t0\tdocs/superpowers/specs/x.md',
    '-\t-\tdocs/image.png',
    '',
  ].join('\n');

  it('counts added plus deleted lines per first-parent commit, without lockfiles or binaries', () => {
    expect(parseMainLog(log).map((c) => [c.sha, c.second, c.lines, c.branch])).toEqual([['aaa', 'p2', 12, null], ['bbb', null, 30, MAIN]]);
  });
  it('names a merge by a clean name-rev result, else by a "Merge branch" subject', () => {
    const commits = parseMainLog(log);
    nameMerges(commits, ['goto']);
    expect(commits[0].branch).toBe('goto');
    const renamed = parseMainLog(log.replace('Merge: Go to a step (#227)', "Merge branch 'feat/x'"));
    nameMerges(renamed, ['quiet/t1-tokens~7^2']);
    expect(renamed[0].branch).toBe('feat/x');
  });
  it('credits a span with the commits that landed inside it', () => {
    expect(committedWithin(parseMainLog(log), { first: '2026-10-09T11:00:00.000Z', last: '2026-10-09T13:00:00.000Z' }).map((c) => c.sha)).toEqual(['aaa']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/scripts/session-cost-lib.test.ts`
Expected: FAIL, cannot resolve `../../scripts/session-cost-lib.mjs`.

- [ ] **Step 3: Create the lib by moving code out of `scripts/session-cost.mjs`.** Move, keeping comments, and change only what is listed:
  - `PRICES`, `modelKey`, `MAIN`, `COLD_MIN`, `MAIN_BRANCHES`, `WT_RE`, `NEW_BRANCH_RE`, `WT_ADD_RE`, `MERGE_RE`: move as they are, exporting `PRICES`, `modelKey`, `MAIN`, `COLD_MIN`. Change `WT_RE` to `/\.claude[\\/]+worktrees[\\/]+([A-Za-z0-9._-]+)(\*)?/g` so a glob is visible.
  - `priceOf(model, u)`: move unchanged.
  - `isCold(u)`: new, the condition now inline in `add`: `const context = u.input + u.cacheRead + u.cw5m + u.cw1h; return context >= COLD_MIN && u.cw5m + u.cw1h >= context / 2;`.
  - `parseWorktreeList(porcelain)`: the loop now at the top of the script that fills `WORKTREES` from `git worktree list --porcelain`, returning a new Map.
  - `agentWorktreeEntry(metaFile, meta)`: the body of the inner loop of `learnAgentWorktrees`: `name` is the basename of `meta.worktreePath` (trailing separators stripped) when present, else `metaFile` without `.meta.json`; returns `[name, meta.description ?? meta.worktreeBranch ?? name]`.
  - `learnWorktrees(command, worktrees)`: takes the map as a parameter (not exported).
  - `branchOfWorktree(written, worktrees, glob = false)`: strip trailing dots; exact lookup; only when `glob` is true, a unique prefix match among the map's keys; else the stripped name.
  - `markersOf(j, worktrees)`: takes the map; for each `WT_RE` match call `branchOfWorktree(m[1], worktrees, m[2] === '*')`.
  - `readCallsFromText(raw, start, worktrees)`: the body of `readCalls` after the file read, taking the text and the map.
  - `parseMainLog(log)`: the parsing half of `commitsOnMain` (no git call); merges get `branch: null`, direct commits `branch: MAIN`.
  - `nameMerges(commits, names)`: the naming half of `commitsOnMain`: `names[i]` belongs to the i-th commit with a `second` parent; a name containing `~` or `^`, empty, or `undefined` falls back to the `Merge branch '<x>'` subject, else `null`.
  - `committedWithin(commits, span)`: `commits.filter((c) => c.at >= Date.parse(span.first) && c.at <= Date.parse(span.last))`.

  Write `scripts/session-cost-lib.d.mts` with exactly the declarations in **Interfaces** above.

- [ ] **Step 4: Rewire `scripts/session-cost.mjs`** to import those names from `./session-cost-lib.mjs`. It keeps: argument parsing, `git()`, building the worktree map (`parseWorktreeList(git(['worktree', 'list', '--porcelain']))`, then every subagent meta file through `agentWorktreeEntry`, adding entries the map lacks), the scan loop (now `readCallsFromText(fs.readFileSync(file, 'utf8'), start, worktrees)`, keeping the `Cannot read transcript` error), `emptyAgg`, `add` (using `isCold`), `commitsOnMain()` (now: run the git log, `parseMainLog`, run `git name-rev` for the merges' second parents, `nameMerges`), the `within` helper (now `committedWithin`), and all printing. The output format does not change.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/scripts/session-cost-lib.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 6: Check the report did not move**

Run: `node scripts/session-cost.mjs --by=session --sessions=1541ab7a,da1b465d`
Expected, exactly these two rows (the split column may differ only in order of equal entries):
```
da1b465d  10-04 18:55  10-05 13:21  1788  $147.93     38%      492k  3, $11.17         7366      $20.08  sub:opus-5-5 61%, main:opus-5-5 38%
1541ab7a  10-05 13:29  10-09 00:07   822  $142.36     85%      590k  14, $67.63       21104       $6.75  main:opus-5-5 85%, sub:opus-5-5 15%
```
Run: `node scripts/session-cost.mjs --sessions=1541ab7a,da1b465d | head -5`
Expected: the branch table prints, with `(main)` first and no row named `agent-ae03`.

- [ ] **Step 7: Typecheck and the full unit suite**

Run: `npm run typecheck && npm test`
Expected: both pass.

---

### Task 2: The context nudge hook

**Files:**
- Create: `scripts/context-nudge.mjs`, `test/scripts/context-nudge.test.ts`

**Interfaces:**
- Consumes: hook input on stdin (`hook_event_name`, `transcript_path`, `agent_id` when inside a subagent).
- Produces: on a threshold crossing, one JSON object on stdout: `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"<line>"}}`; otherwise nothing. Exit code 0 always. Task 4 registers it.

- [ ] **Step 1: Write the failing tests** in `test/scripts/context-nudge.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/context-nudge.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nudge-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An assistant transcript line whose prompt totals `context` tokens. */
const line = (id: string, context: number) => JSON.stringify({
  type: 'assistant',
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: context - 1010, cache_creation_input_tokens: 1000, output_tokens: 5 } },
});
let n = 0;
function transcript(...lines: string[]): string {
  const file = join(dir, `t${n++}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
function run(input: unknown) {
  const r = spawnSync(process.execPath, [script], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim() };
}
const hook = (file: string, extra: object = {}) => ({ hook_event_name: 'PostToolBatch', session_id: 's', transcript_path: file, ...extra });

describe('context-nudge', () => {
  it('nudges once when the context crosses 120k', () => {
    const r = run(hook(transcript(line('a', 110_000), line('b', 125_000))));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolBatch');
    expect(out.hookSpecificOutput.additionalContext).toContain('about 120k');
  });
  it('nudges harder when it crosses 160k, including a jump over both lines', () => {
    expect(JSON.parse(run(hook(transcript(line('a', 150_000), line('b', 165_000)))).out).hookSpecificOutput.additionalContext).toContain('about 160k');
    expect(JSON.parse(run(hook(transcript(line('a', 100_000), line('b', 170_000)))).out).hookSpecificOutput.additionalContext).toContain('about 160k');
  });
  it('stays silent between lines, after a compaction drop, and with one request', () => {
    expect(run(hook(transcript(line('a', 125_000), line('b', 130_000)))).out).toBe('');
    expect(run(hook(transcript(line('a', 170_000), line('b', 40_000)))).out).toBe('');
    expect(run(hook(transcript(line('a', 125_000)))).out).toBe('');
  });
  it('counts repeated lines for one message id once', () => {
    expect(run(hook(transcript(line('a', 110_000), line('b', 125_000), line('b', 125_000)))).out).not.toBe('');
    expect(run(hook(transcript(line('a', 110_000), line('a', 110_000), line('b', 125_000)))).out).not.toBe('');
  });
  it('ignores a partial last line', () => {
    const file = transcript(line('a', 110_000), line('b', 125_000));
    writeFileSync(file, '{"type":"assistant","mess', { flag: 'a' });
    expect(run(hook(file)).out).toContain('about 120k');
  });
  it('stays silent inside a subagent', () => {
    expect(run(hook(transcript(line('a', 110_000), line('b', 125_000)), { agent_id: 'a1', agent_type: 'implementer' })).out).toBe('');
  });
  it('exits 0 silently on a missing transcript or bad input', () => {
    expect(run(hook(join(dir, 'missing.jsonl')))).toEqual({ status: 0, out: '' });
    expect(run('not json')).toEqual({ status: 0, out: '' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/scripts/context-nudge.test.ts`
Expected: FAIL (the script does not exist, so every run exits non-zero).

- [ ] **Step 3: Write `scripts/context-nudge.mjs`:**

```js
#!/usr/bin/env node
// PostToolBatch hook, registered in .claude/settings.json. Claude cannot see its own context size, so this tells
// the main session when it crosses 120k and again at 160k, the points where CLAUDE.md asks it to cut at the next
// clean point. Silent otherwise, silent inside subagents, and it exits 0 whatever happens: a nudge must never block.
import fs from 'node:fs';

const LINES = [
  [160_000, 'Context is about 160k tokens. Cut the session at the next clean point: write the handoff, offer the next session, and stop. On an unattended overnight run, write the handoff and carry on with the next queued item instead. (CLAUDE.md, Session rhythm)'],
  [120_000, "Context is about 120k tokens. Finish what you're on, then at the next clean point (a merge, or a finished plan task with everything committed) write the handoff and cut the session. On an unattended overnight run, write the handoff and carry on instead. (CLAUDE.md, Session rhythm)"],
];
const TAIL = 512 * 1024;

/** The last `TAIL` bytes of a file, without a first line cut in half. */
function tail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Prompt size of each assistant message, in transcript order; a message written as several lines counts once. */
function contexts(text) {
  const byId = new Map();
  for (const l of text.split('\n')) {
    if (!l.includes('"usage"')) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    const u = j.message?.usage;
    if (!u || !j.message.id) continue;
    const writes = u.cache_creation_input_tokens ?? (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    byId.set(j.message.id, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + writes);
  }
  return [...byId.values()];
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!input.agent_id && input.transcript_path) {
    const seen = contexts(tail(input.transcript_path));
    if (seen.length >= 2) {
      const [prev, cur] = seen.slice(-2);
      const hit = LINES.find(([at]) => prev < at && cur >= at);
      if (hit) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? 'PostToolBatch', additionalContext: hit[1] } }));
      }
    }
  }
} catch {
  // Silence is the right answer to anything unexpected: the session carries on without a nudge.
}
process.exit(0);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/scripts/context-nudge.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and the full unit suite**

Run: `npm run typecheck && npm test`
Expected: both pass.

---

### Task 3: The agents (main session)

**Files:**
- Create: `.claude/agents/explorer.md`, `.claude/agents/implementer.md`, `.claude/agents/code-reviewer.md`, `.claude/agents/screen-reviewer.md`, `test/repo/agents.test.ts`
- Delete: `.claude/agents/design-reviewer.md`

- [ ] **Step 1: Write the failing test** `test/repo/agents.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../../.claude/agents', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

/** The frontmatter's `key: value` lines, as a map. */
function frontmatter(file: string): Map<string, string> {
  const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  const block = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  return new Map(block.split('\n').map((l) => l.match(/^(\w+):\s*(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].trim()]));
}

describe('.claude/agents', () => {
  it('holds exactly the routed agents', () => {
    expect(files).toEqual(['code-reviewer.md', 'explorer.md', 'implementer.md', 'screen-reviewer.md']);
  });
  for (const file of files) {
    it(`${file} names itself, pins a full model id and sets effort`, () => {
      const fm = frontmatter(file);
      expect(fm.get('name')).toBe(file.replace(/\.md$/, ''));
      expect(fm.get('description')?.length).toBeGreaterThan(40);
      expect(fm.get('model')).toMatch(/^claude-[a-z]+-\d+(-\d+)?$/);
      expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(fm.get('effort'));
      expect(fm.get('tools')).toBeTruthy();
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/repo/agents.test.ts`
Expected: FAIL, the file list includes `design-reviewer.md` and lacks the four.

- [ ] **Step 3: Write the four agent files and delete the design-reviewer.** Frontmatter per spec section 1:

| file | model | effort | maxTurns | color | tools | omitClaudeMd |
|---|---|---|---|---|---|---|
| explorer.md | claude-haiku-5-5 | low | 20 | cyan | Read, Glob, Grep | true |
| implementer.md | claude-sonnet-5-5 | medium | 60 | green | Read, Write, Edit, Glob, Grep, Bash, PowerShell | (omit) |
| code-reviewer.md | claude-sonnet-5-5 | high | 40 | red | Read, Glob, Grep, Bash | (omit) |
| screen-reviewer.md | claude-sonnet-5-5 | medium | 50 | yellow | Read, Glob, Grep, Bash, PowerShell | true |

Each body turns that agent's paragraph in spec section 1 into second-person instructions, plus a short **Report** section in the format the spec gives it. The descriptions say when the main session dispatches each one (the routing table in spec section 2), since Claude Code reads them to route.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/repo/agents.test.ts test/repo/no-em-dash.test.ts`
Expected: PASS.

---

### Task 4: CLAUDE.md and project settings (main session)

**Files:**
- Create: `CLAUDE.md`, `.claude/settings.json`

- [ ] **Step 1: Write `.claude/settings.json`:**

```json
{
  "autoCompactWindow": 300000,
  "hooks": {
    "PostToolBatch": [
      {
        "hooks": [
          { "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/scripts/context-nudge.mjs"], "timeout": 5 }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Write `CLAUDE.md`** with these sections, from spec sections 2 to 4: a first line saying the routing sections are for the main session; Roles; Routing (the table, the superpowers rule, small fixes stay); Overrides (spec section 3 verbatim in substance); Evidence; Session rhythm (window, nudge, one thread per session, cuts with the handoff chip, new requests become steps, one worktree per session, overnight); Handoff (the field list and where it is saved); Pointers (playbook test gates, the em-dash guard, deploy and `claude:install` only from the main checkout). About 80 lines.

- [ ] **Step 3: Check the hook end to end by hand.** Find this session's transcript (`~/.claude/projects/C--personal-InProgress/c0dc2f4d-*.jsonl`, over 120k by now) and run the hook on a copy truncated just after the first request over 120k:

Run: `node scripts/context-nudge.mjs < <payload file with transcript_path set to that copy>`
Expected: one JSON line containing "about 120k".

- [ ] **Step 4: Run the guards**

Run: `npx vitest run test/repo`
Expected: PASS.

---

### Task 5: Review, checks and commits (main session)

- [ ] **Step 1:** Read the implementers' diffs in full (`git diff` in the worktree). Rerun `npm run typecheck && npm test` and Task 1 Step 6 yourself.
- [ ] **Step 2:** Dispatch the code-reviewer brief (spec section 1) on Sonnet: scope `git diff main...` plus the untracked files, request: this plan. Scripts and config stay on Sonnet per spec section 3. Open each finding's `file:line` before fixing it; fix, then a proportional re-check on Haiku if the fix diff is small.
- [ ] **Step 3:** Commit in three commits, explicit paths only: the lib split and tests (`#289`); the nudge hook (`#290`); agents, CLAUDE.md, settings and the plan (`#290`).

---

### Task 6: Land as a PR (main session)

- [ ] **Step 1: Secret scan of the whole history.** Stop and ask Aiden on any hit.

Run (Git Bash, from the worktree):
```bash
git rev-list --all | xargs -n 50 git grep -I -n -E '(ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----' 2>/dev/null | head -20
git log --all --diff-filter=A --name-only --format= | grep -E '(^|/)\.env($|\.)|\.(db|sqlite|pem|key|p12)$' | sort -u
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' | awk '$1=="blob" && $2>5000000'
```
Expected: no output from any of the three.

- [ ] **Step 2: Check the personal account.** Run: `gh auth status`. Expected: `Aiden-Molyneaux` is listed. If not, stop and ask Aiden.
- [ ] **Step 3: Create the repo and push.** Run: `GH_TOKEN=$(gh auth token --user Aiden-Molyneaux) gh repo create Aiden-Molyneaux/InProgress --private`, then `git remote add origin https://github.com/Aiden-Molyneaux/InProgress.git` and `git push -u origin main dev-routing`. If git has no credentials for the personal account, pass a one-off helper on that command only (`-c credential.helper=` plus a helper that prints the `gh auth token --user Aiden-Molyneaux` token); never change global git config.
- [ ] **Step 4: Draft the PR title and body,** run them through the humanizer skill in a subagent, and open the PR: `GH_TOKEN=$(gh auth token --user Aiden-Molyneaux) gh pr create --repo Aiden-Molyneaux/InProgress --base main --head dev-routing --title ... --body-file ...`. The body ends with the Claude Code attribution line.
- [ ] **Step 5:** Brief the scribe (PR link on #290), send Aiden the link, and stop for his merge.

---

### Task 7: After Aiden merges (main session)

- [ ] **Step 1:** In the main checkout: `git fetch origin && git merge --ff-only origin/main`, then `npm run deploy`. Expected: deploy green.
- [ ] **Step 2:** Brief the scribe: playbook text "One branch per fix off main, merged locally after a green `npm run deploy`, then main is pushed to origin; a PR only when Aiden asks." (keep the rest of the playbook as it is); #290 done with its outcome; focus #291.
- [ ] **Step 3:** Write the first pilot handoff for #228 (spec section 4's shape, pilot log seeded with this session's id and the baseline from r105), save it under `~/.inprogress/resources/inprogress/`, attach it to #291, offer it as a chip, and stop. The handoff's first instruction: check `/context` shows the 300k compaction window and `/hooks` lists the PostToolBatch nudge; if either is missing, apply the spec's fallback and tell Aiden.
