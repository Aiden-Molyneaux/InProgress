# Background work (#228) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show background work in InProgress: a session that stopped while work runs reads `busy`, background commands are stored and drawn, a resumed agent moves to the step it was sent to, and every step holding running work is lit.

**Architecture:** Busy is derived, never stored (`sessionActivity` in core). Background commands get their own table (migration 9) fed by a new async PostToolUse hook group, the Stop and prompt hooks, and the agent watcher reading `queue-operation` end lines. Re-homing is a SendMessage PostToolUse that moves a subagent row. The window gains a commands line, a `busy` character and live steps.

**Tech Stack:** TypeScript (strict), better-sqlite3, Fastify + zod (server), React (web), Vitest, Playwright.

**Spec:** `.superpowers/iter/2026-10-07/activity/design.md` (r79; gitignored, read it from the main checkout `C:/personal/InProgress/.superpowers/...`). Aiden's answers at its end override the body. Capture evidence: `capture-report.md` in the same folder.

**How this plan is used:** the branch spans several sessions. Task 1 is written out in full. Tasks 2 to 7 name their files, interfaces and tests from the design; the session that starts each one expands it into steps against the code as it stands then (the earlier tasks change the ground under it), and commits that expansion to this file before dispatching.

## Capture findings that change the design (2026-10-09)

The full list is in design.md section A, "Capture, 2026-10-07 to 2026-10-09". For the tasks below:

- Task 2: Monitor's id is `tool_response.taskId` (an object, not text). PowerShell's response is an object with `backgroundTaskId` like Bash's. A subagent's PostToolUse carries `agent_id` (and `agent_type`); a main-thread call carries neither, and `transcript_path` is the parent's in both (session 3 matched 3,043 subagent calls by `tool_use_id`; session 1's "no `agent_id`" was wrong). `command-started` sends `agentId: input.agent_id` when present.
- Task 3: `background_tasks` is session-wide, so the Stop reconcile covers subagents' shells too (safe to end missing rows of any agent). A shell the reconcile inserts has `agent_id = ''`. Task notices for subagents' commands still only reach the transcript (the watcher's end lines stay).
- Tasks 1, 4 and 5 are unchanged.

## Global Constraints

- One branch, `activity`, worktree `.claude/worktrees/activity`. Commit per task; merge to main only after task 7, a green `npm run deploy` from the main checkout, then push main.
- No em dashes (U+2014) or their HTML entities in any file (`test/repo/no-em-dash.test.ts`).
- Migration 9 only adds: `min_reader_version` stays `'1'`.
- Hooks and server ship in one deploy: the server's strict `hookBody` rejects unknown fields.
- The full command text never leaves the hook: only `command_head` (at most 3 words, 60 characters) and the tool's description (at most 200).
- Gates by label. Data (task 1): `npm run typecheck`, `npm test`, plus the migration's strict gates (a v8 database upgrades with data, a v8 build opens a v9 database and writes, `min_reader_version` stays 1). Integration (tasks 2, 3): typecheck + unit + `npm run test:smoke`, strict gates for hooks and installer. UI (tasks 5, 6): typecheck + unit + one e2e per user-visible feature. Docs (task 7): typecheck + unit.
- E2E runs use `INPROGRESS_E2E_PORT` from 4410 to 4419, never the default 4399; implementers never run deploy or `claude:install` and never use port 4317.
- Reviewer: `code-reviewer` with model `opus` for tasks touching `src/server/db/`, `src/hooks/`, `src/cli/claude-config.ts`, `src/server/session-flow.ts`, `src/server/repo/`, `web/src/stream.ts`; Sonnet otherwise (CLAUDE.md, Overrides).

---

### Task 1: Migration 9 and types (label: data)

**Files:**
- Modify: `src/server/db/schema.ts` (append the 9th entry to `MIGRATIONS`, after migration 8 at `:187-194`)
- Modify: `src/core/types.ts` (`SubagentInfo` `:176-206`, `Session` `:247-267`, near `END_REASONS` `:173`)
- Create: `src/server/repo/commands.ts` (read side only: row type, `toCommandInfo`, `listCommands`)
- Modify: `src/server/repo/sessions.ts:22-37` (`toSession` attaches `commands`)
- Modify: `src/server/repo/subagents.ts` (`SubagentRow` `:7-22`, `toInfo` `:67-80`)
- Test: `test/server/db.test.ts`, `test/server/commands.test.ts` (new), `test/server/subagents.test.ts`, and every fixture that builds a full `Session` or `SubagentInfo` (typecheck lists them; known: `test/hooks/handlers.test.ts`, `test/web/describe.test.ts`, `test/server/sessions.test.ts`, `test/web/live.test.ts`, `test/web/character.test.ts`, `test/core/layout.test.ts`, `test/web/breadcrumb.test.ts`)

**Interfaces:**
- Produces (types, `src/core/types.ts`):

```ts
export const COMMAND_KINDS = ['shell', 'monitor'] as const;
export type CommandKind = typeof COMMAND_KINDS[number];
export const COMMAND_OUTCOMES = ['completed', 'failed', 'killed', 'session', 'unknown'] as const;
export type CommandOutcome = typeof COMMAND_OUTCOMES[number];

/** A background command (Bash, PowerShell or Monitor) a session or one of its subagents started. */
export interface CommandInfo {
  /** Claude Code's background task id (`b...`). */
  taskId: string;
  kind: CommandKind;
  /** The subagent that started it; '' for the main thread. */
  agentId: string;
  /** A persistent Monitor: never counts as work. */
  persistent: boolean;
  /** The tool call's description, at most 200 characters. */
  description: string | null;
  /** The command's first words, at most 60 characters; never the full command. */
  commandHead: string | null;
  nodeId: number | null;
  startedAt: string;
  endedAt: string | null;
  outcome: CommandOutcome | null;
  exitCode: number | null;
}
```

  `Session` gains `commands: CommandInfo[]` (after `subagents`). `SubagentInfo` gains `runStartedAt: string` (after `startedAt`): when its current run started; the server sends `run_started_at ?? started_at`.
- Produces (`src/server/repo/commands.ts`): `listCommands(ctx: Ctx, sessionId: string): CommandInfo[]`: running rows and rows ended less than `ENDED_AGENT_MS` ago, running first, then newest `started_at` first, at most `COMMANDS_LISTED = 30`. Export `CommandRow` and `toCommandInfo` for task 3's writers.
- Consumes: the `Ctx` type and the time cutoff `listSubagents` uses (`before(ctx, ENDED_AGENT_MS)`, `subagents.ts:60`). If `before` is module-private, move it to a shared spot both repos import (no copy).

- [ ] **Step 1: Write the failing migration tests** in `test/server/db.test.ts`, copying the shape of the migration 8 tests (`:411` "migrates a database at v7 with data to v8", `:478` "marks migration 8 readable by v1 builds ..."; they use `makeCtx`, `MIGRATIONS.splice`, `migrate`, `schemaVersion`). Add a `COMMANDS = 8` index constant next to `SOFT_DELETE`. Cases:
  1. `migrates a database at v8 with data to v9`: build to v8 (splice from `COMMANDS`), insert a project, node, session and subagent row; push migration 9 back and migrate; `schemaVersion` is 9; `SELECT * FROM session_commands` is `[]`; the subagent's `run_started_at` is `null`; every other column of that subagent row is unchanged.
  2. `marks migration 9 readable by v1 builds, so a v8 build still opens a v9 database and its own writes work`: on a fresh (v9) ctx `min_reader_version` is `'1'`; splice off migration 9 (assert `shipped[0]` contains `session_commands`); `migrate(db)` does not throw; the v8 build's own writes work: `INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at) ...` without `run_started_at`, then an `UPDATE` of `ended_at`; the row reads `run_started_at: null`.
  3. `deletes a session's commands with it, and clears a command's step when the step is deleted`: insert a session, a node, and a `session_commands` row with `node_id`; `DELETE FROM nodes` (or the repo's hard-delete path if nodes are soft-deleted; use what the existing SET NULL tests for `session_subagents.node_id` use) leaves the row with `node_id` null; `DELETE FROM sessions` removes the row.
  4. `takes only a known kind and outcome`: inserting `kind = 'agent'` throws; `outcome = 'done'` throws; `outcome = NULL` with `ended_at = NULL` is accepted.
  5. Any existing test that asserts a full `SELECT *` of `session_subagents` gains `run_started_at: null` (design section 5); find them with `grep -n "session_subagents" test/server/*.ts`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/server/db.test.ts`
Expected: FAIL (no migration 9; `session_commands` missing).

- [ ] **Step 3: Add migration 9** as the last entry of `MIGRATIONS` in `src/server/db/schema.ts`, in migration 8's style:

```ts
  // 9: background commands, and when a resumed subagent's current run started (#228, design r79 section 2).
  // A new table and a nullable column: v1 to v8 builds can still read and write this schema, so a rollback across it
  // works.
  `
CREATE TABLE session_commands (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  tool_use_id TEXT,
  agent_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('shell','monitor')),
  persistent INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  command_head TEXT,
  node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','failed','killed','session','unknown')),
  exit_code INTEGER,
  PRIMARY KEY (session_id, task_id)
);
CREATE INDEX session_commands_live ON session_commands (session_id, ended_at);
ALTER TABLE session_subagents ADD COLUMN run_started_at TEXT;
-- A new table and a nullable column: v1 to v8 builds can still read and write this schema, so a rollback across it works.
INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`,
```

Match the surrounding entries' exact indentation and comment style; if migration 8 keeps its SQL comment inside the string, keep only one copy of the rollback sentence.

- [ ] **Step 4: Run the migration tests**

Run: `npx vitest run test/server/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing read-side tests.**
  - `test/server/commands.test.ts` (new; set up a ctx, project, session and clock the way `test/server/subagents.test.ts` does, and insert command rows with raw SQL, since the writers come in task 3):
    1. `lists running commands and those ended in the last five minutes`: rows running, ended 4 min ago, ended 6 min ago: the first two are listed.
    2. `lists running first, then newest first`: two running (older, newer start) and one ended: order is newer running, older running, ended.
    3. `lists at most 30`: 35 running rows: 30 listed, the 30 newest.
    4. `maps a row to CommandInfo`: one row with every column set (`persistent = 1`, `exit_code = 0`, outcome `completed`) reads back as the full `CommandInfo` with `toEqual` (`persistent: true`); a main-thread row has `agentId: ''`.
    5. `lists only this session's commands`.
  - `test/server/sessions.test.ts`: `findSession` returns `commands` (one inserted row) and `[]` for a session with none.
  - `test/server/subagents.test.ts`: `runStartedAt` is `startedAt` when `run_started_at` is null, and `run_started_at` when it is set (set it with raw SQL; task 4 writes it).

- [ ] **Step 6: Run them and see them fail**

Run: `npx vitest run test/server/commands.test.ts test/server/sessions.test.ts test/server/subagents.test.ts`
Expected: FAIL (no `commands.ts`, no `commands`, no `runStartedAt`).

- [ ] **Step 7: Add the types** to `src/core/types.ts` as in Interfaces, following the doc-comment style of `SubagentInfo`; `COMMAND_*` constants beside `END_REASONS`.

- [ ] **Step 8: Write `src/server/repo/commands.ts`**:

```ts
import { ENDED_AGENT_MS, type CommandInfo, type CommandKind, type CommandOutcome } from '../../core/types';
// Import Ctx and the cutoff helper from where subagents.ts gets them.

/** At most this many commands per session reach the window. */
export const COMMANDS_LISTED = 30;

export interface CommandRow {
  session_id: string;
  task_id: string;
  tool_use_id: string | null;
  agent_id: string;
  kind: CommandKind;
  persistent: number;
  description: string | null;
  command_head: string | null;
  node_id: number | null;
  started_at: string;
  ended_at: string | null;
  outcome: CommandOutcome | null;
  exit_code: number | null;
}

export const toCommandInfo = (r: CommandRow): CommandInfo => ({
  taskId: r.task_id,
  kind: r.kind,
  agentId: r.agent_id,
  persistent: r.persistent === 1,
  description: r.description,
  commandHead: r.command_head,
  nodeId: r.node_id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  outcome: r.outcome,
  exitCode: r.exit_code,
});

/** Running commands and those ended less than ENDED_AGENT_MS ago: running first, then newest first, at most 30. */
export function listCommands(ctx: Ctx, sessionId: string): CommandInfo[] {
  const rows = ctx.db.prepare(
    `SELECT * FROM session_commands
     WHERE session_id = ? AND (ended_at IS NULL OR ended_at >= ?)
     ORDER BY (ended_at IS NULL) DESC, started_at DESC, task_id
     LIMIT ${COMMANDS_LISTED}`,
  ).all(sessionId, before(ctx, ENDED_AGENT_MS)) as CommandRow[];
  return rows.map(toCommandInfo);
}
```

Adjust the db access (`ctx.db.prepare`) and imports to the pattern `listSubagents` uses (`subagents.ts:87-96`).

- [ ] **Step 9: Wire the read side.** `toSession` (`sessions.ts:36`) adds `commands: listCommands(ctx, r.id)` after `subagents`. `SubagentRow` gains `run_started_at: string | null`; `toInfo` adds `runStartedAt: r.run_started_at ?? r.started_at` after `startedAt`. `saveSession` still persists no child rows.

- [ ] **Step 10: Fix the fixtures.** Run `npm run typecheck`; every full `Session` literal gains `commands: []`, every full `SubagentInfo` gains `runStartedAt` (equal to its `startedAt`). Where a test helper builds them (`test/core/layout.test.ts` `session(...)`, `agent(...)`), add the field in the helper once. Then `npm test`; every full-shape `toEqual` on `SubagentInfo` from the server gains `runStartedAt`.

- [ ] **Step 11: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both green; report the test count.

- [ ] **Step 12: Commit** (main session, after review)

```bash
git add src/server/db/schema.ts src/core/types.ts src/server/repo/commands.ts src/server/repo/sessions.ts src/server/repo/subagents.ts test/server/db.test.ts test/server/commands.test.ts test/server/sessions.test.ts test/server/subagents.test.ts <each fixture file changed>
git commit -m "Migration 9: session_commands and run_started_at, with CommandInfo (#228)"
```

---

### Task 2: Hooks and install (label: integration)

Design: section 2 "Hooks and install" (design.md `:169-201`), section 3 "What moves it" first paragraph (`:258-262`), section 5 unit bullets for `handlers.test.ts` and `claude-config.test.ts`, the smoke bullet.

**Files:** `src/cli/claude-config.ts` (`HookDef.async`, `hookEntry` writes `"async": true`, the new `HOOK_DEFS` group `^(Bash|PowerShell|Monitor|SendMessage|TaskStop)$`), the hook script's tool body builder (`buildToolHookBody`) and the `stop` and `prompt-submit` bodies in `src/hooks/`, a `commandHead(command)` helper, `src/server/schemas.ts` (`hookBody` gains the events `command-started`, `command-ended`, `agent-ended`, `agent-messaged` and the fields `taskId`, `kind`, `persistent`, `commandHead`, `durationMs`, `outcome`, `exitCode`, `reason`, `resumed`, `summary`, `tasks`, `background`, all optional and bounded); the server accepts and ignores them until task 3. Tests: `test/hooks/handlers.test.ts`, `test/cli/claude-config.test.ts`, `test/smoke/built.test.ts` (a captured Bash PostToolUse with `backgroundTaskId` and a Stop with `background_tasks`; take real shapes from the capture files, redacted).

**Interfaces produced:** the hook bodies exactly as design `:180-196` and `:259-261` (the capture findings below can change the parsing, not the bodies).

**Expanded by pilot session 3 against the code at 8e0cc7c.**

State found: the install half is already done. `HOOK_DEFS` (`src/cli/claude-config.ts:39-41`) has the async group, `HookDef.async` exists (`:19-26`), `hookEntry` writes `"async": true` (`:70-72`), and `test/cli/claude-config.test.ts:554` covers `kitStatus` for an install from before the group. `src/hooks/capture.ts` stays as is (off by its file flag). What is left is the hook bodies (`src/hooks/handlers.ts`), the server schema (`src/server/schemas.ts:57-86`, `HOOK_EVENTS` in `src/core/types.ts:20-23`) and tests. The server's `handleHookEvent` switch (`src/server/session-flow.ts:108`) has no default, so new events that pass `hookBody` are accepted and ignored until task 3.

Bodies (every optional field is left out when absent, never sent as `null`; every field clipped to its schema bound in the hook, so a post is never rejected for length):

| Hook input | Body |
|---|---|
| post-tool, Bash or PowerShell, with a background id | `{ event: 'command-started', taskId, toolUseId?, kind: 'shell', description?, commandHead?, durationMs?, agentId? }` |
| post-tool, Monitor | `{ event: 'command-started', taskId, toolUseId?, kind: 'monitor', persistent, description?, commandHead?, durationMs?, agentId? }` |
| post-tool, TaskStop, `task_type` `local_bash` or containing `monitor` | `{ event: 'command-ended', taskId, outcome: 'killed' }` |
| post-tool, TaskStop, `local_agent` | `{ event: 'agent-ended', agentId: <the stopped task's id>, reason: 'killed' }` |
| post-tool, SendMessage, `success: true` and an id | `{ event: 'agent-messaged', agentId, resumed, summary?, purpose? }` |
| prompt-submit, a notice with `<task-notification>` blocks | today's body plus `tasks: [{ taskId, toolUseId?, status, exitCode? }]` (only when non-empty) |
| stop, input has a `background_tasks` array | today's body plus `background: [{ taskId, type, description?, commandHead? }]` (also when empty) |

Parsing rules:
- `agentId` on `command-started` is `input.agent_id` (a subagent's call; capture findings), as the task tools already read it (`handlers.ts:214-216`). TaskStop and SendMessage never send the caller's `agent_id`: their `agentId` is the target.
- Bash and PowerShell id: `tool_response.backgroundTaskId` when the response is an object; when the response is a string, `/\bID:\s*([a-z][a-z0-9]{5,39})\b/`. Either way the id must match `/^[a-z][a-z0-9]{5,39}$/`. No id: return `undefined` (no post).
- Monitor id: `tool_response.taskId` (object), else from a string response `/Monitor started \(task ([a-z][a-z0-9]{5,39})\b/`. `persistent`: the response's boolean, else `tool_input.persistent === true`.
- TaskStop id: `tool_response.task_id`, else `tool_input.task_id`; other `task_type`s (`local_workflow`, unknown) post nothing.
- SendMessage: only when `tool_response.success === true`; `agentId` is `resumedAgentId`, else `pin.id`; `resumed` is whether `resumedAgentId` was there. `summary` is `tool_input.summary` clipped to 200; `purpose` is `purposeOf(tool_input.message)`, falling back to `tool_input.content` when `message` is not a string. Nothing else of the message leaves the hook.
- `durationMs`: `input.duration_ms` when a finite number from 0 to 7 days, rounded; else left out.
- Notices: only when `NOTICE` matches (`handlers.ts:62`). From the raw prompt after `stripPasted`, every `<task-notification>…</task-notification>` block, at most 20; from each, `<task-id>` (required, else skip the block), `<tool-use-id>`, `<status>` (one of `completed`, `failed`, `killed`, else skip the block), and `exitCode` from `exit code (-?\d+)` inside `<summary>`. A malformed block (no closing tag) is skipped. The prompt text itself still never leaves.
- Stop: entries with a string `id` (else skipped), at most 50; `type` clipped to 40 (skip when not a non-blank string); `description` clipped to 200; `command` becomes `commandHead`. The full `command` is never in the body.
- `commandHead(command: string): string | undefined`, exported from `handlers.ts`:
  1. Strip leading set-up segments, repeatedly: `cd`, `pushd`, `Set-Location` or `sl` up to and including the next `&&`, `;` or newline; a PowerShell assignment `$name = …` up to and including the next `;` or newline that is outside quotes; `export NAME=…` the same way.
  2. Cut at the first `'`, `"`, `` ` ``, `|`, `>`, `<`, `;`, `&&`, `(` or newline.
  3. Split on whitespace. Drop `NAME=value` words. Drop words that start with `-`; when the dropped word is a dash and one letter (`-o`, `-i`, `-C`), drop the next word too unless it starts with `-`.
  4. Take the first three words, join with one space; longer than 60 is cut to 59 plus `…`. Empty is `undefined`.
  Examples (tests): `cd /c/x && npm run test:e2e 2>&1 | tail -5` gives `npm run test:e2e`; `ssh -o BatchMode=yes -i ~/.ssh/k vdxiii@cadapp76dev 'cd /x && ls'` gives `ssh vdxiii@cadapp76dev`; `Set-Location C:\x; npm test` gives `npm test`; `$SP = 'C:\a;b'; node "$SP\run.js"` gives `node`; `FOO=1 BAR=2 npm run build -- --watch` gives `npm run build`; `git -C /repo status --short` gives `git status`; a 100-character single word gives 59 characters plus `…`.

Schema (`hookBody`, all optional, `.strict()` kept): `HOOK_EVENTS` gains `command-started`, `command-ended`, `agent-ended`, `agent-messaged`. Fields: `taskId` string 1 to 100; `kind` `z.enum(COMMAND_KINDS)`; `persistent` boolean; `commandHead` string max 60; `durationMs` int 0 to 604,800,000; `outcome` `z.enum(COMMAND_OUTCOMES)`; `exitCode` int; `reason` `z.enum(['killed'])`; `resumed` boolean; `summary` string max 200; `tasks` array max 20 of strict `{ taskId: string 1..100, toolUseId?: string 1..200, status: enum completed|failed|killed, exitCode?: int }`; `background` array max 50 of strict `{ taskId: string 1..100, type: string 1..40, description?: max 200, commandHead?: max 60 }`. Extend the comment at `:71-75` to say what each new event carries. If typecheck shows an exhaustive map over `HookEvent` elsewhere, give the new events a no-op entry.

- [ ] **Step 1: Write the failing hook tests** in `test/hooks/handlers.test.ts`, in its existing describes (`buildHookBody`, `buildToolHookBody post-tool`) plus a new `describe('commandHead')`. Use the redacted capture samples in the dispatch brief for the input shapes. Cases: every row of the bodies table; Bash with no `backgroundTaskId` and plain stdout posts nothing; the string-response id; the timeout response (`timedOutAfterMs`, no `run_in_background`); PowerShell's object without `isImage`; a subagent's call carries `agentId`, a main-thread call has none; Monitor `persistent` from the response; TaskStop for `local_bash`, `local_agent`, `local_workflow` (nothing); SendMessage resumed, queued (`resumed: false`, id from `pin.id`), `success: false` (nothing), name-only `to`; the message body never appears in the posted JSON; `durationMs` absent, negative and huge; notices: one, several, malformed, over 20, exit code 0 and 127, status `killed` without an exit code, a non-notice prompt quoting a `<task-notification>` sends no `tasks`; Stop: no array (no `background`), empty array (`background: []`), 60 entries (50 sent), `command` turned into a head and the full command absent from the JSON; every `commandHead` example above.
- [ ] **Step 2: Add a `runHandler` case per new body** in the existing `describe('runHandler')` (`:289`), which posts to the real app: each new body is accepted (no throw), so the schema and the builders agree.
- [ ] **Step 3: Run them and see them fail** (`npx vitest run test/hooks/handlers.test.ts`); record the failure output.
- [ ] **Step 4: Schema and types**: `HOOK_EVENTS`, `hookBody` as above.
- [ ] **Step 5: Hook bodies**: `commandHead` and the parsers in `src/hooks/handlers.ts`, next to `purposeOf`; the post-tool branch in `buildToolHookBody` after the TaskUpdate branch; `tasks` in the `prompt-submit` branch and `background` in a `stop` branch of `buildHookBody`. Bounds as named constants beside `DESCRIPTION_MAX`, each with the "mirror the server's hookBody" comment. Update the comment at `claude-config.ts:39-40`, which says the hook posts nothing for these tools.
- [ ] **Step 6: Run the hook tests** until green.
- [ ] **Step 7: Install tests**: check `test/cli/claude-config.test.ts` against design section 5 (the async group written with `"async": true`, `kitStatus` reports `settings` until reinstall, uninstall strips the group, another tool's async hook on `PostToolUse` is kept by install and uninstall). Add only the missing cases; they should pass at once (the code exists), so say which were added and that they passed.
- [ ] **Step 8: Smoke** in `test/smoke/built.test.ts`, next to the TaskCreate case (`:106-123`): the built hook script (`runHook`) fed the captured Bash PostToolUse with `backgroundTaskId` and then the captured Stop with `background_tasks` (session ids swapped for the test's), each exits 0 silently, and the built server accepted both: the Stop's state change lands (`storedRows` or the session's state, as the file already checks for stop), and no rejection is logged for the `command-started` post (read how the hook logs a non-2xx in `src/hooks/main.ts` and assert on that log; if it logs nothing, POST the body the built `buildToolHookBody` returns for the same input and expect 2xx).
- [ ] **Step 9: Run the gates**: `npm run typecheck`, `npm test`, `npm run build` then `npm run test:smoke` (check `package.json` for whether smoke builds first). Report raw tail output of each.
- [ ] **Step 10: Commit** (main session, after review).

### Task 3: Commands server and the watcher's end lines (label: integration)

Design: section 2 "Server" (`:203-231`), section 1 "How it enters and leaves" (`:79-94`), "Retention and caps" (`:165-167`), "Its step" (`:155-157`).

**Files:** `src/server/repo/commands.ts` (writers: `startCommand` upsert, `endCommand` never re-opens but replaces `unknown`, `reconcileCommands`, `endSessionCommands`, `pruneCommands` 24 h and 200 per session), `src/server/session-flow.ts` (`handleHookEvent` cases; `'commands'` in `changed`; `activity` and `command: { label, outcome? }` in event data; `endSessionCommands` on `resume`, `end`, expiry), `src/server/agent-watch.ts` (end lines from `queue-operation` `enqueue` lines, per-session byte offset, 8 MB first read), `TaskStop` `local_agent` to `endAgent`. Tests: `test/server/commands.test.ts` (design section 5 list), `test/server/agent-watch.test.ts`.

**From task 1's review:** `listCommands` compares `ended_at` and orders by `started_at` as text, which only holds for `toISOString()` form with milliseconds (`...T12:00:00Z` sorts after `...T12:00:00.500Z`). Every writer normalizes an `at` through `new Date(x).toISOString()`, and a test pins it.

**From task 2's review (pilot session 3):** the Stop body may carry `backgroundTruncated: true` (over 50 entries); then `reconcileCommands` ends nothing. The async `command-started` can land after the sync Stop or notice that ended a fast command: `startCommand` on an ended row keeps it ended (only fills missing fields). A notice `tasks` entry for an unknown or already-ended id is a no-op apart from replacing `unknown`; an agent notice quoting another notice is parsed by header only, but a stale id can still arrive. Accepted, not fixed: between `promote` and `restart` in a deploy (seconds), the old server 400s a Stop carrying `background`, so a session stopping then stays working until its next prompt.

**Interfaces produced:** `startCommand(ctx, sessionId, c: { taskId; toolUseId?; agentId?; kind; persistent?; description?; commandHead?; startedAt })`, `endCommand(ctx, sessionId, taskId, outcome: CommandOutcome, at: string, exitCode?: number)`, `reconcileCommands(ctx, sessionId, background: { taskId; type; description?; commandHead? }[], at)`, `endSessionCommands(ctx, sessionId, at)`, `pruneCommands(ctx)`. Note: `activity` in event data needs `sessionActivity`; task 3 adds `src/core/activity.ts` with `sessionActivity` and `countsAsWork` (design `:64-77`, plus Aiden's server-head rule below) so task 5 only extends it.

**Expanded by pilot session 4 against the code at d3247e4.**

State found: `src/server/repo/commands.ts` has the read side only (`COMMANDS_LISTED`, `CommandRow`, `toCommandInfo`, `listCommands`); nothing writes `session_commands` but a test. `HookEventInput` (`src/server/session-flow.ts:12-34`) lacks the task 2 fields; the route passes `hookBody.parse(req.body)` straight in (`src/server/routes/sessions.ts:10`), so they arrive but are untyped. The switch (`session-flow.ts:108-172`) has no case for the new events and reads neither `tasks` nor `background`. `changed` compares `VISIBLE` plus `subagents` (`:181-182`); event data is `{ changed, state }` (`:184`). `expireStaleSessions` (`src/server/repo/sessions.ts:108-128`) ends subagents at `last_seen_at`, not commands. `leadingNode` is `src/server/repo/nodes.ts:54-59`; `subagentNode` (`src/server/repo/subagents.ts:118-121`) can return a node outside the project, and `work.ts:67` wraps it in `inProject`. `endAgent` (`subagents.ts:221-225`) takes reasons `limit|error|killed|silent`. The watcher (`src/server/agent-watch.ts`) reads only subagent transcripts' last 64 KB; its tick is `main.ts:86-98`; `runMaintenance` (`src/server/project-lifecycle.ts:192-211`) runs at start-up and every 6 h. `src/core/activity.ts` does not exist; `isReader` is in `src/core/types.ts`. The notice block parser is `noticeTasks` in `src/hooks/handlers.ts:376`. A transcript's enqueue line is `{"type":"queue-operation","operation":"enqueue","timestamp":"…Z","sessionId":"…","content":"<task-notification>\n<task-id>…"}`; Stop `background` types are `shell`, `monitor`, `subagent`, `workflow`, … (design A).

Rulings (main session, pilot session 4):
- A notice, TaskStop or watcher end for an id the server has no row for is a no-op. This follows task 2's review note over design `:231-232` (insert an ended row): an agent notice can carry a stale id, and a phantom ended row would then sit in the list. The cost: a fast command whose async start lands after its notice shows running until the next Stop reconciles it as `unknown`.
- `startCommand` on an existing row: `kind` and `persistent` take the start's values (the tool call knows them; a reconcile insert guessed); `tool_use_id`, `description`, `command_head` and `agent_id` fill only when missing (`''` counts as missing for `agent_id`); `node_id` takes the start's (its leading `#id` and agent make it exact; a reconcile insert only had the focus); `started_at` becomes the earlier of the two. `ended_at`, `outcome` and `exit_code` are never touched.
- `endCommand` ends a running row, or replaces an `unknown` end (outcome, time and exit code). A `session` end is final. Returns whether a row changed.
- `prompt` with `tasks`: `endCommand` for every entry, no id-prefix test. Agent ids never have a `session_commands` row, so the design's "agents are left to the watcher" holds by construction.
- `command-started`, `command-ended` and `agent-ended` come from PostToolUse, so like `subagent-start` they turn `permission` into `working`.
- `agent-ended`: `endAgent(ctx, sessionId, agentId, 'killed', now, now)`.
- `countsAsWork` takes Aiden's server rule now (design `:469`), so the server's `activity` matches the window from the start: not running, a persistent Monitor, 30 minutes old or more, or a head word (or a `:`-separated part of one, as in `test:watch`) equal to `dev`, `serve`, `preview`, `start` or `watch` means it does not count. Task 5 then only adds the layout side.
- `command` in event data is set only when the event started or ended exactly one command; its `label` is `commandLabel` (design `:268`: head, else description with a leading `#id` dropped, else `a background command`), in `src/core/activity.ts` so task 6's `live.ts` reuses it.
- The watcher's `session.updated` and the expiry's also carry `activity`, so every `session.updated` has it.
- The notice block parser moves to `src/core/notices.ts` (`noticeTasks`, with its bounds) so the hook and the watcher share it; the hook imports it unchanged.

Code:

- `src/core/activity.ts` (new): `Activity = 'working' | 'busy' | 'idle' | 'permission' | 'ended'`; `COMMAND_WORK_MS = 30 * 60 * 1000`; `SERVER_WORDS = ['dev','serve','preview','start','watch']`; `looksLikeServer(head?: string | null): boolean`; `countsAsWork(c: Pick<CommandInfo,'endedAt'|'startedAt'|'persistent'|'commandHead'>, now: number): boolean`; `sessionActivity(s: Pick<Session,'state'|'subagents'|'commands'>, now: number): Activity` (`idle` becomes `busy` with a running non-reader subagent, `endedAt === null`, or a command that counts as work; other states as stored); `commandLabel(c: Pick<CommandInfo,'commandHead'|'description'>): string`.
- `src/core/notices.ts` (new): `noticeTasks(prompt)` moved from `handlers.ts` with `NOTICE_TASKS_MAX` and the id bounds it uses, returning a typed `NoticeTask { taskId; toolUseId?; status: 'completed'|'failed'|'killed'; exitCode? }[]`.
- `src/server/repo/commands.ts`: `startCommand(ctx, sessionId, c: { taskId; toolUseId?; agentId?; kind; persistent?; description?; commandHead?; startedAt; nodeId: number | null })` (one `INSERT … ON CONFLICT (session_id, task_id) DO UPDATE` per the ruling), `endCommand(ctx, sessionId, taskId, outcome, at, exitCode?): boolean`, `reconcileCommands(ctx, sessionId, background, at, opts: { truncated: boolean; nodeId: number | null }): number` (entries of type `shell` or `monitor` only; ends running `shell`/`monitor` rows of any agent missing from the list as `unknown` unless truncated; inserts listed ones it lacks with `agent_id ''`, `started_at = at`, the Stop's focus, `ON CONFLICT DO NOTHING` so an ended row is never re-opened; returns rows changed), `endSessionCommands(ctx, sessionId, at): number` (outcome `session`), `pruneCommands(ctx)` (ended over 24 h ago; then per session beyond 200 rows, oldest ended first; running rows never). Every `at`/`startedAt` goes through `new Date(x).toISOString()` first; an invalid date is skipped (no write).
- `src/server/session-flow.ts`: `HookEventInput` gains `taskId`, `kind`, `persistent`, `commandHead`, `durationMs`, `outcome`, `exitCode`, `reason`, `resumed`, `summary`, `tasks`, `background`, `backgroundTruncated` (types from `hookBody`). Cases:
  - `command-started` (needs `taskId`, `kind`): `pruneCommands`; `startedAt = now - (durationMs ?? 0)`; node = `leadingNode(description, projectId)` ?? (agentId ? `subagentNode` kept only when the node is in the session's project, as `work.ts:67` does) ?? `before.focusNodeId`; `startCommand`.
  - `command-ended` (needs `taskId`, `outcome`): `endCommand(…, now, exitCode)`.
  - `agent-ended` (needs `agentId`): `endAgent` per the ruling.
  - `prompt`: as today, plus `endCommand` for each of `tasks` at `now`.
  - `stop`: as today, plus `reconcileCommands` when `background` is an array (absent: nothing), `truncated: backgroundTruncated === true`, node `before.focusNodeId`.
  - `start` with source `resume`, and `end`: `endSessionCommands(…, now)`.
  - After the switch: `'commands'` joins `changed` when `JSON.stringify(before.commands) !== JSON.stringify(after.commands)`; data gains `activity: sessionActivity(after, Date.parse(now))` and, per the ruling, `command: { label, outcome? }`.
- `src/server/repo/sessions.ts` `expireStaleSessions`: `endSessionCommands(ctx, id, last_seen_at)` beside `endSubagents`; its event data gains `activity: 'ended'`.
- `src/server/project-lifecycle.ts` `runMaintenance`: `pruneCommands(ctx)` beside `pruneSubagents`.
- `src/server/agent-watch.ts`: `WatchState` gains `commandOffsets: Map<string, { path: string; offset: number }>`; new `watchCommandEnds(ctx, state): { sessionId: string; taskId: string; outcome: CommandOutcome }[]`, called from the same tick in `main.ts` after `watchAgents`. It selects sessions not ended, with a `transcript_path`, and with a running command. Per session: stat the file (missing or unreadable: skip, keep state); on first sight, or when the path changed or the file shrank, start at `max(0, size - 8 MB)` and drop the first partial line when not at 0; read to `size`, keep only up to the last `\n`, advance the offset past it. Lines that contain `"queue-operation"` are parsed (bad JSON skipped); `operation === 'enqueue'` with a string `content` is fed to `noticeTasks`; each task id that matches a running row of that session ends with its status and exit code at the line's `timestamp`. Offsets for sessions no longer selected are dropped. All ends in one `write`; one `session.updated` per touched session, `{ changed: ['commands'], state, activity }`. Bytes are read with `openSync`/`readSync` in one bounded buffer per file (at most 8 MB), as `readAgentTail` does.

Tests (failing first, raw output pasted in the report):

- [ ] **Step 1: `test/core/activity.test.ts`** (new): `countsAsWork` running, ended, persistent, 29:59 and 30:00 old, each server word, `test:watch`, `npm run build` counts; `sessionActivity` for each stored state, idle with a running subagent, a running reader (`Explore`) only, a subagent at the limit (ended), a counting command, a serving command only; `commandLabel` head, description with `#228 ` dropped, neither.
- [ ] **Step 2: `test/server/commands.test.ts`** (extend; the design section 5 list): start then end; end then late start keeps it ended and fills the description and an earlier `started_at`; a reconcile insert then the start takes `kind`, `persistent`, node and the earlier time; `endCommand` on an unknown id is a no-op returning false; `unknown` replaced by a notice's real end; a `session` end is not replaced; reconcile ends a missing running row as `unknown`, inserts a listed one, ignores `subagent` and `workflow` entries, ends nothing when truncated, never re-opens an ended listed row, ends a subagent's missing shell too; `endSessionCommands`; `pruneCommands` 24 h, the 200 cap oldest ended first, running rows kept past both; a non-ISO `at` (`2026-10-09T12:00:00Z`) is stored as `…12:00:00.000Z` and an invalid one writes nothing; `listCommands` ordering still holds over writer-made rows.
- [ ] **Step 3: `test/server/sessions.test.ts`** (extend `describe('handleHookEvent')`, or a new `describe('background commands')`): `command-started` stores the row with `started_at = now - durationMs`, the node from a leading `#id`, from the subagent's node, from the focus, and not from a subagent node in another project; it lifts `permission` to `working`; `command-ended` and a notice `tasks` end rows (exit code kept); a Stop with `background` reconciles, without it does nothing; `start` `resume` and `end` end running rows as `session`, `compact` does not; `agent-ended` ends the subagent as `killed`; `session.updated` carries `'commands'` in `changed`, `activity` (`busy` on a Stop with a counting command running, `idle` with only a serving one) and `command: { label, outcome? }` for one start or end, none for two; an event that changes nothing about commands adds no `'commands'`; `expireStaleSessions` ends commands at `last_seen_at`.
- [ ] **Step 4: `test/server/agent-watch.test.ts`** (extend, temp dirs as the file does): an enqueue line for a running command ends it at the line's time with status and exit code; a second tick reads only new bytes (append another line, the first is not re-applied: assert via a row ended `unknown` by hand in between staying `unknown`, or count writes); first sight of a file over 8 MB reads only the tail; a shrunk file restarts; a missing transcript changes nothing; a non-enqueue line, a bad JSON line, an id with no row and an agent's notice are ignored; one `session.updated` per touched session with `activity`; no read at all for a session without running commands.
- [ ] **Step 5: hook tests stay green** after the move to `src/core/notices.ts` (`test/hooks/handlers.test.ts` unchanged).
- [ ] **Step 6: run the new tests and see them fail**; paste the failure summary.
- [ ] **Step 7: build** `src/core/activity.ts`, `src/core/notices.ts`, the writers, the session-flow cases, expiry, maintenance, the watcher, in that order; run the suites until green.
- [ ] **Step 8: smoke**: extend the task 2 smoke case in `test/smoke/built.test.ts`: after the captured Bash PostToolUse with `backgroundTaskId` and the Stop whose `background_tasks` lists it, the built server's session has that command running; a second Stop with `background_tasks: []` ends it as `unknown`.
- [ ] **Step 9: gates**: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:smoke`; raw tails in the report.
- [ ] **Step 10: commit** (main session, after review).

### Task 4: Re-home a resumed agent (label: server)

Design: section 3 (`:254-301`).

**Files:** `src/server/repo/subagents.ts` (`messageAgent` per the table at `:266-272`; `startSubagent` revival sets `run_started_at = at`; `pinStartFocus` skips rows with `node_id` set), `src/server/session-flow.ts` (`agent-messaged` case). Tests: `test/server/subagents.test.ts` (each row of the table, revival, ruling 42 merge after a move, `pinStartFocus`).

**From task 3's review (pilot session 4), unconfirmed:** `agent-ended` (TaskStop on an agent) calls `endAgent(…, 'killed', now, now)`, and `reviveAgent` accepts `killed`; if the stopped agent writes its interrupt line after the async PostToolUse lands, the watcher's next tick sees a line newer than `last_active_at` and revives it, so it reads busy until `SILENT_MS`. Check against a captured TaskStop transcript; if it reproduces, a hook `killed` end is not revived by the watcher (only a SendMessage resume brings it back, per this task's table).

**Expanded by pilot session 4 against the code at 22d8457.**

State found: no `messageAgent`, and `handleHookEvent` has no `agent-messaged` case (only the `HookEventInput` comment, `session-flow.ts:45`); the hook already posts `{ event: 'agent-messaged', agentId, resumed, summary?, purpose? }` (`src/hooks/handlers.ts:283-296`). `toInfo` already sends `runStartedAt: r.run_started_at ?? r.started_at` (`src/server/repo/subagents.ts:70`) and `nodeId: r.node_id ?? r.start_focus_id` (`:73`), but nothing writes `run_started_at`. `startSubagent`'s revival path (`:168-175`) clears `ended_at`, `end_reason`, `last_active_at` and returns. `pinStartFocus` (`:199-204`) already skips rows with `node_id` set. `reviveAgent` (`:232-236`) accepts `limit|error|killed|silent`. The watcher revives an ended row when the transcript's last line is newer than `last_active_at ?? ended_at` (`src/server/agent-watch.ts:136-142`). "Ruling 42" (`docs/superpowers/rulings/2026-10-04-review-actions-rulings.md:122-131`) is the merge order `#id`, focus at dispatch, focus at start: the design's point is that a move writes `node_id`, which then wins over `start_focus_id`, and `start_focus_id` stays.

Rulings (main session, pilot session 4):
- `messageAgent` acts on a known row only (no row: no-op, false). The scribe never has a row (`subagent-start` skips it), so no separate check is needed. Readers are treated like any agent.
- Resumed: the step is a leading `#id` (in the project, `leadingNode`) of the summary, else of the purpose, else the session's current focus; with none of these, `node_id` stays. `description` becomes the summary, else the purpose, else stays (trimmed, as `recordDispatch` stores it, leading `#id` kept). `purpose` becomes the new one when sent. `run_started_at = at`. An ended row is revived whatever its `end_reason`, a clean stop and `session` included (`ended_at`, `end_reason`, `last_active_at` cleared): the response says it runs.
- Reached while running (`resumed` false): only a leading `#id` of the summary, else of the purpose, in the project and different from the row's current `node_id ?? start_focus_id`, moves it; then `description` and `purpose` change as for a resume. Otherwise nothing changes. `run_started_at` never changes, and an ended row is not revived (the design's "n/a"; the watcher and SubagentStart cover a wrong end).
- `startSubagent`'s revival path also sets `run_started_at = at`.
- `started_at` and `start_focus_id` are never touched by a message (ruling 33 and ruling 42 hold).
- `agent-messaged` comes from PostToolUse, so like the other tool events it lifts `permission` to `working`.
- Killed-agent revival (the note above): a `killed` row is revived by the watcher only when the transcript's last line is more than `MARKER_QUIET_MS` (60 s) newer than `last_active_at ?? ended_at`. An interrupt line written just after the hook's TaskStop end then does not revive it; a real resume is caught by `messageAgent` and SubagentStart anyway. Other end reasons keep today's rule.

Code:

- `src/server/repo/subagents.ts`: `messageAgent(ctx, sessionId, agentId, m: { resumed: boolean; summary?: string; purpose?: string; focusNodeId: number | null; projectId: number | null }, at: string): boolean` per the rulings (true when the row changed); `startSubagent` revival adds `run_started_at = ?` (`at`), and runs whenever the row exists (a running row's SubagentStart is a resume too, so its run time restarts).
- `src/server/session-flow.ts`: `case 'agent-messaged'`: `if (input.agentId) messageAgent(ctx, sessionId, input.agentId, { resumed: input.resumed === true, summary: clean(input.summary) ?? undefined, purpose: clean(input.purpose) ?? undefined, focusNodeId: before.focusNodeId, projectId: before.projectId }, now)`; `permission` to `working`. The `'subagents'` change detection already covers the event.
- `src/server/agent-watch.ts`: the killed grace in the revive branch, with a comment naming the TaskStop race.

Tests (failing first, raw output pasted in the report):

- [ ] **Step 0: check the race** (bounded, at most 10 minutes, a node script in your scratchpad, read only): in `~/.claude/projects/**/*.jsonl` main transcripts find TaskStop `tool_use`s whose `tool_result` names a `local_agent`, and for each compare the result's timestamp with the last line timestamp of that agent's `subagents/agent-<id>.jsonl`. Report how many there are and how many agents wrote after the TaskStop result (and by how much: min, median, max). Report only; the ruling stands either way.
- [ ] **Step 1: `test/server/subagents.test.ts`**, a new `describe('a message re-homes its agent')`: resumed with a leading `#id` summary moves to that step, sets the summary as description, the purpose, `runStartedAt = now`, keeps `startedAt`; resumed with no `#id` takes the session's focus; resumed with no `#id` and no focus keeps the node; a `#id` of another project is ignored (falls to the focus); resumed revives an ended row for each end reason (`null` clean stop, `limit`, `killed`, `silent`, `session`); reached while running with a `#id` naming another step moves it and changes description and purpose; reached while running with no `#id`, or the same step, changes nothing (returns false, `runStartedAt` unchanged); reached while running on an ended row does not revive it; an unknown agent is a no-op; after a move `subagentNode` returns the new node, `startFocusId` is unchanged (ruling 42), and `setFocus` (so `pinStartFocus`) no longer changes its node; `startSubagent` on an existing row sets `runStartedAt`.
- [ ] **Step 2: `test/server/sessions.test.ts`** or the same file through `handleHookEvent`: `agent-messaged` re-homes and records `session.updated` with `'subagents'` in `changed` and no node target; it lifts `permission` to `working`; a later command started by the agent goes to the new step (`subagentNode`).
- [ ] **Step 3: `test/server/agent-watch.test.ts`**: a `killed` row whose transcript gains a line 30 s after its end stays ended; one 90 s after is revived; a `silent` row 30 s after is still revived (today's rule).
- [ ] **Step 4: run them and see them fail**; paste the summary.
- [ ] **Step 5: build** in `subagents.ts`, `session-flow.ts`, `agent-watch.ts`; suites green.
- [ ] **Step 6: gates**: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:smoke`; raw tails in the report.
- [ ] **Step 7: commit** (main session, after review).

### Task 5: Core activity and layout (label: ui)

Design: section 1 "Derived, not stored" and the window rules (`:58-126`), section 2 "Window" layout bullet (`:235-238`), section 4 (`:303-323`), Aiden's answers (`:443-446`).

**Files:** `src/core/activity.ts` (complete: `Activity`, `COMMAND_WORK_MS`, `countsAsWork` with Aiden's server rule: a command 30 minutes old or more, or whose head reads like a server (`dev`, `serve`, `preview`, `start`, `watch`), is `serving` and does not count), `src/core/layout.ts` (`commands` row item, `COMMAND_LINE` 20 px, anchors and pins, `occupiedSteps`, `LayoutNodeItem.live`, the grown `working` chain, `findFrontier` with busy), the server's `busySessions` SQL (`EXISTS` on `session_commands` under the work rule), briefing other-sessions line `busy`. From task 1's review: `listCommands` caps at 30 ranked by `started_at` alone, so with more than 30 running (persistent Monitors started after one real build) the build can fall off and core's `sessionActivity` would disagree with the server's `EXISTS`; settle it here (order counting commands first, or have core trust a server flag). Tests: `test/core/activity.test.ts` (new), `test/core/layout.test.ts`, `test/server/projects.test.ts`, briefing suites.

**Expanded by pilot session 5 against the code at c9ef821.**

State found: `src/core/activity.ts` is complete for the rule (`Activity`, `COMMAND_WORK_MS`, `SERVER_WORDS`, `looksLikeServer`, `countsAsWork`, `sessionActivity`, `commandLabel`) with `test/core/activity.test.ts`. `src/core/layout.ts` never reads `Session.commands`. Lines per card are built in `layoutOutline` (`:532-548`): per session group an agent line (`AGENT_LINE` 28) then a readers line (`READERS_LINE` 20, `last = { y, kin: false }`), then the done row shares `last` when it holds no kin (`:557-562`). Groups come from `anchorOf(homeOf(s, a))` (`:425-435`); pins hold shown agents' homes, in-progress work and queued steps (`:394-398`). `working` is the working sessions' focus chains (`:436-444`); `workingFoci` the foci alone (`:446`). `occupiedSteps(byId, sessions, workItems)` (`:266-282`) counts foci, running or at-limit agents' homes and in-progress work; called by `layoutOutline` (`:447`) and `web/src/panels/Details.tsx`. `findFrontier(nodes, sessions, layout, queue)` (`:589-600`): working focus seen last, queue head, newest active, last row; called by `web/src/canvas/useCamera.ts:104`. The window already passes its 30 s clock as `LayoutInput.now` (`web/src/canvas/Canvas.tsx:74-89`). `busySessions` (`src/server/repo/projects.ts:438-439`) counts `working` or a running non-reader agent; no commands. `listCommands` (`src/server/repo/commands.ts:38-48`) orders running first, then `started_at DESC`, cap 30. The briefing's other-sessions line (`src/server/briefing.ts:265-272`) prints `s.state`; covered at `test/server/sessions.test.ts:317,327`.

Rulings (main session, pilot session 5):
- Shown commands: a command shows on the canvas while running or for `ENDED_AGENT_MS` after its end, by the layout's `now` (`commandShown` in core, as `agentShown` is for agents), so the 30 s clock drops an ended line. Serving commands (past 30 minutes, or a server head) still show; the window greys them in task 6.
- A command's home is `agentHome(s, c, inTree)` (its `nodeId` while in the tree, else the session's focus), anchored with `anchorOf` like an agent. Running commands pin their home (serving ones too: the design's "running ones pin"); ended ones do not.
- The `commands` item: `LayoutCommandsItem { kind: 'commands'; id: 'c<sessionId>:<nodeId>'; sessionId; nodeId; taskIds; x; y }`, one per (session, card), after that session's agent line and readers line, `COMMAND_LINE = 20`. `taskIds`: running commands by `startedAt` ascending, then ended ones by `startedAt` ascending (the line shows the first one, then `+n`). It sets `last = { y, kin: false }`, so the done row shares it as it shares a readers line. Card height follows from `ly` as today. A session group whose only content is commands still emits its commands line (no agent line).
- `occupiedSteps` gains a 4th parameter `now: number = Date.now()`; a live session's command that `countsAsWork` occupies its home and ancestors. `Details.tsx` passes its 30 s clock.
- `LayoutNodeItem.live: boolean`: the card has, anchored to it, a running worker or reader of a live session (`endedAt === null`), a command that `countsAsWork`, a pulsing task on this node (`pulses`, whether or not the card is folded), or the lead of a `working` session. Anchors, not homes: a folded subtree's work lights the visible card that shows it. A `busy` lead alone does not make a card live (design section 4, point 3).
- The `working` chain is every live card and its tree ancestors, plus today's working foci chains (a working focus hidden by a fold keeps its own chain). Computed before the card loop, since ancestors draw first. `workingFocus` is unchanged.
- `findFrontier` gains a 5th parameter `now: number = Date.now()`: the working focus seen last, then the focus of the `busy` session (`sessionActivity`) seen last, then the queue as today. `useCamera` keeps the default.
- The server's work rule lives in one SQL fragment built from `SERVER_WORDS` in `src/server/repo/commands.ts`: `countsAsWorkSql(alias)` returns `<a>.ended_at IS NULL AND <a>.persistent = 0 AND <a>.started_at > ? AND NOT (<server head>)`, the head test being `' ' || lower(replace(coalesce(<a>.command_head, ''), ':', ' ')) || ' ' LIKE '% <word> %'` for each word, joined with `OR`; the one `?` is `msAgo(ctx, COMMAND_WORK_MS)`. A parity test runs it against `looksLikeServer` over a table of heads (`npm run dev`, `vite:preview`, `npm run test:watch`, `npm run test:e2e`, `NPM START`, `devserver`, `node scripts/serve.mjs`, `tsc`, null); if a stored head can hold tabs, also replace them.
- `busySessions` gains `OR EXISTS (SELECT 1 FROM session_commands c WHERE c.session_id = s.id AND <countsAsWorkSql('c')>)`.
- The 30-cap mismatch: `listCommands` orders running first, then counting work first (`CASE WHEN <countsAsWorkSql> THEN 0 ELSE 1 END`), then `started_at DESC, task_id`. With more than 30 running, a counting one is always listed, so core's `sessionActivity` agrees with the server's `EXISTS`; the window's `+n` can undercount past 30, accepted.
- Briefing: the other-sessions line prints `sessionActivity(s, now)` (now from the briefing's existing clock), so `B "InThink session" (busy, on #223)`.
- `Canvas.tsx` skips `commands` items until task 6 draws them (the 20 px stays reserved on the branch, which merges only after task 6). No new web rendering of `live` in this task.
- E2E: this task adds none. Its one user-visible change (a command-busy session lights the tab dot) is asserted by design e2e test 1 in task 6. The existing e2e suite runs once as a regression check (markers now pulse up live chains).

Code:

- `src/core/activity.ts`: `commandShown(c: Pick<CommandInfo, 'endedAt'>, now): boolean`.
- `src/core/layout.ts`: `COMMAND_LINE`, `LayoutCommandsItem` in `LayoutItem`, `commandIds` in `Group`, pins, grouping, the line in the card loop, `live`, the grown `working`, `occupiedSteps` and `findFrontier` per the rulings.
- `src/server/repo/commands.ts`: `countsAsWorkSql`, `listCommands` order. `src/server/repo/projects.ts`: the `EXISTS`. `src/server/briefing.ts`: the activity word.
- `web/src/canvas/Canvas.tsx` (skip `commands`), `web/src/panels/Details.tsx` (pass `now` to `occupiedSteps`).

Tests (failing first, raw output pasted in the report):

- [ ] **Step 1: `test/core/activity.test.ts`**: `commandShown` running, ended 4 min ago, ended 5 min ago (gone).
- [ ] **Step 2: `test/core/layout.test.ts`**, a new `describe('commands')`: a running command on its step gives a `commands` item after the session's agent line and readers line with `y` and card `h` grown by `COMMAND_LINE`; a session with only commands on a card gets just the commands line; `taskIds` order (running by start, then ended); an ended command shows until 5 min by `now`, then goes; a subagent's command homes to its `nodeId`, one with no node to the focus; a command under a manual fold anchors to the visible ancestor; a running command pins a step a done run would fold, an ended one does not; the done row shares a commands line (`shared: true`, its `y`); two sessions on one card get one commands line each.
- [ ] **Step 3: `test/core/layout.test.ts`**, `occupiedSteps` and `live`: a counting command occupies its step and ancestors (not paused); a command 30 min old, a server head, a persistent monitor, an ended one do not; `live` for a running worker, a running reader, a counting command, a pulsing task, a working lead; not for a busy lead alone, an ended kin, a serving command; a folded subtree's running agent lights the visible ancestor; `working` holds every live card's chain (a stack head over a running agent), and a working focus hidden by a fold keeps its chain.
- [ ] **Step 4: `test/core/layout.test.ts`**, `findFrontier`: a working session wins over a busy one; with none working, the busy session seen last wins over the queue; an idle session with only a serving command is not busy (falls to the queue).
- [ ] **Step 5: `test/server/commands.test.ts`**: the parity table; 31 running persistent monitors started after one real build list the build; ordering otherwise unchanged (existing tests stay green).
- [ ] **Step 6: `test/server/projects.test.ts`**: an idle session busy by a command only counts; one whose only command is 30 min old, a server head, persistent or ended does not; a session busy by both counts once.
- [ ] **Step 7: briefing** (`test/server/sessions.test.ts` near `:317`): another idle session with a running worker reads `(busy, on #id)`; an idle one with nothing running still reads `(idle…)`.
- [ ] **Step 8: run them and see them fail**; paste the summary.
- [ ] **Step 9: build**; suites green.
- [ ] **Step 10: gates**: `npm run typecheck`, `npm test`, `npm run build`, and the e2e suite once on `INPROGRESS_E2E_PORT` from the brief; raw tails and exit codes in the report.
- [ ] **Step 11: commit** (main session, after review).

### Task 6: Window (label: ui)

Design: section 1 "How busy reads in the window" (`:96-126`), section 2 "Window" (`:239-252`), section 4, Aiden's answers (the `serving` line: a still, hollow mark and the word `serving`, `◦ a3 · npm run dev · serving 3h`; `▸n` counts only commands that count).

**Files:** the Simple character (`busy` state, `ip-breathe`), chip and popover, focus badge and lead title, tab dot (still for busy), `CommandLine.tsx` (new), Details `Background` section, `.ip-card.live`, copy helpers in `web/src/live.ts` (`commandLabel`, `commandLineParts`, `commandsSuffix`), `WORDS.busy`, activity strip `is busy`. Tests: `test/web/*` per design section 5, and the five e2e tests (`test/e2e/ui.spec.ts`, design `:355-369`). Screen-reviewer before merge.

### Task 7: Docs (label: docs)

**Files:** rulings 53 onward in `docs/superpowers/rulings/`, the live-work note (commands, re-home, run time), `docs/guide/inprogress-guide.html`, an amendment to the Quiet spec for `busy` and live steps.
