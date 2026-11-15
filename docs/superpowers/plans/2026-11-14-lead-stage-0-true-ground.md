# Lead Stage 0: True Ground Under T3 Code, Implementation Plan

> **For agentic workers:** each task below is one change and runs through Sigmund (`.claude/skills/sigmund/`) in its
> own worktree. Sigmund owns the line-by-line plan for his change; this plan fixes what crosses changes: the order,
> the names and types, the tests that prove each change, and the acceptance. Steps use checkbox (`- [ ]`) syntax.

**Goal:** InProgress knows a session's T3 thread, shows only what is true, and can park a project, with no Bot
involved.

**Architecture:** A session gets a `driver` and a T3 thread id from its hooks. One thin server module wraps the `t3`
CLI and is the only code that talks to T3 Code. The title channel, Open session and the truth pass read through it.
Nothing here depends on a session remembering to do something.

**Tech Stack:** TypeScript, Fastify, SQLite (`src/server/db/schema.ts`), Vitest, Playwright, the `t3` CLI.

**Spec:** `docs/superpowers/specs/2026-11-14-project-lead-design.md` (section 8, stage 0), and
`docs/superpowers/specs/2026-10-20-inprogress-redesign-design.md` (sections 4.1 to 4.6) for task 3.

## Global Constraints

- No em dashes (U+2014) or their HTML entities in any file.
- Schema changes only add. `min_reader_version` stays 1.
- One branch per change off main, in its own worktree under `.claude/worktrees/`. Gates by label, from the playbook.
- A hook never calls T3 Code and never waits on it. Only the server does, with a 10 second limit per call.
- A T3 failure never ends a session, clears an ask or blocks a hook. It leaves the state as it was.
- The desktop app keeps working exactly as it does today.
- No Bot, no lead command and no new rule a session must remember.

## Review Focus

1. **T3 Code is not running, or the CLI is missing or slow.** Sessions are still tracked, the window still loads, and
   nothing is ended or cleared. Test in task 1 and task 3.
2. **A session in the desktop app or the plain CLI.** Its title channel and Open session behave as before. Test in
   task 2.
3. **One T3 thread, several Claude sessions** (a resume, or a compaction that fires session-start again). No
   duplicate rows; the newest live session owns the thread's title and Open session. Test in task 1.
4. **An ask on a session that has ended.** It is cleared, not deleted: its text stays on the step's log with who
   cleared it. Test in task 3.
5. **A session starts in a parked project.** The project unparks, so nothing waits unseen. Test in task 4.

---

### Task 1: InProgress knows T3 Code (label: integration)

**Files:**
- Create: `src/core/driver.ts`, `src/server/t3.ts`, `scripts/t3-proof.mjs`
- Modify: `src/hooks/handlers.ts:200-204`, `src/server/schemas.ts:138-139`, `src/server/db/schema.ts:64-77`
- Test: `test/core/driver.test.ts`, `test/server/t3.test.ts`, `test/hooks/t3-thread-id.test.ts`

**Interfaces (produced for tasks 2 and 3):**

```ts
// src/core/driver.ts
export type Driver = 'desktop' | 't3' | 'cli';
export function driverOf(env: Record<string, string | undefined>): Driver;
// 't3' when T3CODE_THREAD_ID is set; else 'desktop' when CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'; else 'cli'

// src/server/t3.ts
export interface T3Thread { threadId: string; projectId: string; title: string; link: string; status: string;
  runtimeMode: string; settled: boolean; archived: boolean; pendingRequestCount: number; updatedAt: string;
  createdBy: string; creationSource: string }
// threadId is text: a thread started through the CLI has the id `mcp:<uuid>`
export interface T3Message { role: 'user' | 'assistant'; text: string }
export class T3Unavailable extends Error {}
export function t3List(project?: string): Promise<T3Thread[]>;
export function t3Show(threadId: string): Promise<{ thread: T3Thread; messages: T3Message[] }>;
export function t3Start(project: string, message: string, opts: { provider: string; model: string; title?: string; worktree?: string; branch?: string }): Promise<{ threadId: string }>;
// provider and model are required: a project with no default model refuses a start without them (the proof, step 1)
export function t3Send(threadId: string, message: string): Promise<void>;
```

- Hook body, on `session-start`, `prompt-submit` and `stop`: `driver: Driver` and, when set, `t3ThreadId: string`.
  The old `desktop: true` is still sent and still accepted for one version.
- `sessions.driver TEXT NOT NULL DEFAULT 'cli'`, `sessions.t3_thread_id TEXT NULL`, with an index on the second.
- The CLI path is `T3CODE_CLI_PATH`, else `~/.t3/bin/t3` (`t3.cmd` on Windows). Every call passes `--json`, has a
  10 second limit, parses with zod, and throws `T3Unavailable` on any failure.

- [x] **Step 1: Prove the route.** Done 2026-11-14, see `docs/superpowers/rulings/2026-11-t3-cli-proof.md`. Write `scripts/t3-proof.mjs`: it starts one thread in a scratch folder with the
  message "Reply READY and stop", sends "Reply DONE and stop", shows the thread, and prints the thread id, its
  `runtimeMode` and both replies. Run it once from a shell with every `T3*` variable unset.
  Expected: exit 0, two replies, and the mode printed. Record the output in
  `docs/superpowers/rulings/2026-11-t3-cli-proof.md`. If it fails, stop and report: stage 3 of the spec rests on it.
- [ ] **Step 2: Failing tests.** `driverOf` returns `'t3'`, `'desktop'` and `'cli'` for the three environments, and
  `'t3'` when both variables are set. `t3Show` parses a recorded fixture; a missing binary, a timeout and bad JSON
  each throw `T3Unavailable` (Review Focus 1). A `session-start` carrying `t3ThreadId` stores it; a second
  `session-start` for the same thread with a new session id makes one more row and no duplicate of the first
  (Review Focus 3).
- [ ] **Step 3: Run them.** `npx vitest run test/core/driver.test.ts test/server/t3.test.ts test/hooks/t3-thread-id.test.ts`. Expected: fail, nothing defined.
- [ ] **Step 4: Implement** the interfaces above.
- [ ] **Step 5: Gate.** `npm run typecheck && npm test && npm run test:smoke`. Expected: green.
- [ ] **Step 6: Commit.**

**Accept:** a session started in T3 Code has its thread id on its row; a thread started by `t3Start` appears as a
session with that id.

### Task 2: Title channel and Open session under T3 Code (labels: integration, ui)

**Files:**
- Modify: `src/core/title.ts:23-37`, `src/server/title-channel.ts:48-53`, `src/cli/claude-config.ts:11`,
  `src/server/open-desktop.ts`
- Create: `src/server/open-session.ts`
- Test: `test/core/title.test.ts`, `test/server/title-channel.test.ts`, `test/server/open-session.test.ts`,
  one e2e test in `test/e2e/`

**Interfaces:**
- Consumes: `Driver`, `t3Show`, `sessions.driver`, `sessions.t3_thread_id` from task 1.
- Produces:

```ts
// src/core/title.ts
export function renameToolFor(driver: Driver): string | null;
// 'desktop' -> 'mcp__ccd_session_mgmt__set_session_title'; 't3' -> 'mcp__t3-code__t3_thread_update'; 'cli' -> null

// src/server/open-session.ts
export function openSession(session: { driver: Driver; t3ThreadId: string | null; id: string }): Promise<void>;
// 't3' opens thread.link from t3Show; 'desktop' calls the existing open-desktop code; 'cli' is a 409
```

- For a `t3` session the stored title comes from `t3Show(threadId).thread.title`, read by the server after each
  `stop`. The hook body carries no title under T3.
- The nudge names the tool from `renameToolFor`. For `t3` it adds that the tool is loaded with ToolSearch first.
  `null` means no nudge.

- [ ] **Step 1: Failing tests.** `renameToolFor` returns the three values above. A `t3` session whose thread title
  lacks `expectedPrefix` gets a nudge naming `mcp__t3-code__t3_thread_update`; one whose title has it gets none. A
  `desktop` session gets exactly today's nudge text (Review Focus 2). `openSession` opens `thread.link` for `t3`,
  and throws a 409 for `cli`. When `t3Show` throws `T3Unavailable` there is no nudge and no error. With two
  sessions on one thread, only the newest live one is nudged (Review Focus 3).
- [ ] **Step 2: Run them.** Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: e2e.** The session row's Open button opens the T3 link for a `t3` session.
- [ ] **Step 5: Gate.** `npm run typecheck && npm test && npm run test:smoke && npm run test:e2e`. Expected: green.
- [ ] **Step 6: Commit.**

**Accept:** a T3 thread's title shows its marker and step id within one turn of the step being claimed.

### Task 3: Truth, finishing #537 (labels: data, integration)

Build sections 4.1 to 4.6 of the October spec as written. This task adds only the T3 Code part.

**Files:**
- Create: `src/server/t3-truth.ts`
- Test: `test/server/t3-truth.test.ts`

**Interfaces:**
- Consumes: `t3List`, `T3Thread`, `T3Unavailable`, `sessions.t3_thread_id` from task 1.
- Produces:

```ts
// src/server/t3-truth.ts
export function reconcileT3Sessions(now: Date): Promise<{ ended: string[]; waiting: string[] }>;
```

- For each live session with a thread id: `archived` or `settled` ends the session by the same path as a
  `session-end` hook, which clears its asks; `pendingRequestCount > 0` sets the October waiting state with kind
  `permission` and source `t3`.
- It runs every 60 seconds in the server and when the window loads. A prompt in a settled thread makes its session
  live again through the normal hooks.

- [ ] **Step 1: Failing tests.** A live session whose thread is `settled` ends and its open asks are cleared with
  `cleared_by` `session-ended`, and each ask's text is on its step's log (Review Focus 4). A thread with
  `pendingRequestCount: 1` sets the waiting state. When `t3List` throws `T3Unavailable`, nothing is ended and
  nothing is cleared (Review Focus 1). A project whose only asks belong to ended sessions counts 0 "need you".
- [ ] **Step 2: Run them.** Expected: fail.
- [ ] **Step 3: Implement**, with the October sections.
- [ ] **Step 4: Gate.** `npm run typecheck && npm test && npm run test:slow && npm run test:smoke`. Expected: green.
- [ ] **Step 5: Commit.**

**Accept:** no project shows "need you" without a live session or an open decision behind it.

### Task 4: Parked projects (labels: data, ui)

**Files:**
- Modify: `src/server/db/schema.ts:10`, `src/server/project-lifecycle.ts`, `src/server/routes/window.ts`,
  `src/core/board.ts`, `src/cli/commands.ts` (the `status` command), the project actions under `web/src/board/`
- Test: `test/server/project-park.test.ts`, `test/core/board-parked.test.ts`, one e2e test in `test/e2e/`

**Interfaces (produced):**

```ts
// src/server/project-lifecycle.ts
export function parkProject(slug: string): void;    // status 'active' -> 'parked'
export function unparkProject(slug: string): void;  // status 'parked' -> 'active'
```

- `projects.status` gains `'parked'`. Routes `POST /api/window/projects/:slug/park` and `.../unpark` sit beside
  archive and unarchive, behind the same guard.
- A parked project adds nothing to Needs me or to any count. The window lists it under "Parked", closed by default.
  `status` prints parked projects on one line after the active ones.

- [ ] **Step 1: Failing tests.** Parking an active project sets `parked`; parking an archived one is a 409. A parked
  project with three open asks counts 0 "need you" and is absent from Needs me. A `session-start` in a parked
  project unparks it (Review Focus 5).
- [ ] **Step 2: Run them.** Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: e2e.** Park a project from its actions; it moves under "Parked" and its count leaves the header.
- [ ] **Step 5: Gate.** `npm run typecheck && npm test && npm run test:slow && npm run test:e2e`. Expected: green.
- [ ] **Step 6: Commit.**

**Accept:** a parked project nags about nothing and comes back the moment work starts in it.

---

## Order

Task 1 first. Tasks 2 and 3 need it and can run side by side after it. Task 4 needs nothing and can run at any time.
Stage 0 is done when the three acceptance lines of the spec hold on Aiden's own board.
