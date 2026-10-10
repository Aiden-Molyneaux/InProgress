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

**Interfaces produced:** `startCommand(ctx, sessionId, c: { taskId; toolUseId?; agentId?; kind; persistent?; description?; commandHead?; startedAt })`, `endCommand(ctx, sessionId, taskId, outcome: CommandOutcome, at: string, exitCode?: number)`, `reconcileCommands(ctx, sessionId, background: { taskId; type; description?; commandHead? }[], at)`, `endSessionCommands(ctx, sessionId, at)`, `pruneCommands(ctx)`. Note: `activity` in event data needs `sessionActivity`; task 3 adds `src/core/activity.ts` with `sessionActivity` and `countsAsWork` (design `:64-77`, plus Aiden's server-head rule below) so task 5 only extends it.

### Task 4: Re-home a resumed agent (label: server)

Design: section 3 (`:254-301`).

**Files:** `src/server/repo/subagents.ts` (`messageAgent` per the table at `:266-272`; `startSubagent` revival sets `run_started_at = at`; `pinStartFocus` skips rows with `node_id` set), `src/server/session-flow.ts` (`agent-messaged` case). Tests: `test/server/subagents.test.ts` (each row of the table, revival, ruling 42 merge after a move, `pinStartFocus`).

### Task 5: Core activity and layout (label: ui)

Design: section 1 "Derived, not stored" and the window rules (`:58-126`), section 2 "Window" layout bullet (`:235-238`), section 4 (`:303-323`), Aiden's answers (`:443-446`).

**Files:** `src/core/activity.ts` (complete: `Activity`, `COMMAND_WORK_MS`, `countsAsWork` with Aiden's server rule: a command 30 minutes old or more, or whose head reads like a server (`dev`, `serve`, `preview`, `start`, `watch`), is `serving` and does not count), `src/core/layout.ts` (`commands` row item, `COMMAND_LINE` 20 px, anchors and pins, `occupiedSteps`, `LayoutNodeItem.live`, the grown `working` chain, `findFrontier` with busy), the server's `busySessions` SQL (`EXISTS` on `session_commands` under the work rule), briefing other-sessions line `busy`. From task 1's review: `listCommands` caps at 30 ranked by `started_at` alone, so with more than 30 running (persistent Monitors started after one real build) the build can fall off and core's `sessionActivity` would disagree with the server's `EXISTS`; settle it here (order counting commands first, or have core trust a server flag). Tests: `test/core/activity.test.ts` (new), `test/core/layout.test.ts`, `test/server/projects.test.ts`, briefing suites.

### Task 6: Window (label: ui)

Design: section 1 "How busy reads in the window" (`:96-126`), section 2 "Window" (`:239-252`), section 4, Aiden's answers (the `serving` line: a still, hollow mark and the word `serving`, `◦ a3 · npm run dev · serving 3h`; `▸n` counts only commands that count).

**Files:** the Simple character (`busy` state, `ip-breathe`), chip and popover, focus badge and lead title, tab dot (still for busy), `CommandLine.tsx` (new), Details `Background` section, `.ip-card.live`, copy helpers in `web/src/live.ts` (`commandLabel`, `commandLineParts`, `commandsSuffix`), `WORDS.busy`, activity strip `is busy`. Tests: `test/web/*` per design section 5, and the five e2e tests (`test/e2e/ui.spec.ts`, design `:355-369`). Screen-reviewer before merge.

### Task 7: Docs (label: docs)

**Files:** rulings 53 onward in `docs/superpowers/rulings/`, the live-work note (commands, re-home, run time), `docs/guide/inprogress-guide.html`, an amendment to the Quiet spec for `busy` and live steps.
