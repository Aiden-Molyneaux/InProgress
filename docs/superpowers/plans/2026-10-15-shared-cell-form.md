# Plan: the shared task box on the Board (#422)

Owner: Sigmund (session A, 2026-10-15). Labels: ui + data. Copy this file to `docs/superpowers/plans/2026-10-15-shared-cell-form.md` on the branch as its first commit.

Reference: the round-3 mock, `~/.inprogress/resources/inprogress/2026-10-15-shared-cell-form-round-3.html` (r245): `box()` (lines 246-271), `STATES` (187-191), CSS lines 100-142, hue tokens lines 12, 24, 32.

## Decisions this plan rests on

- Aiden (handoff r249): one skeleton in every box; task hue on the left edge (7 hues), given on entering Next/Now/Needs me, freed at Done or Backlog; orange for Working, amber for Needs you (#401 closed into this); one cell per task; no characters, session letters, kind icons or breadcrumb in Board boxes; Done boxes have no session area; createdAt goes to Details, not the box.
- Aiden (2026-10-15, session A): "Open session" makes the server run `claude --desktop --resume <session id>`. If that fails, the box shows the command to copy. Needs CLI 2.1.285+ (the machine had 2.1.266; Aiden runs `claude update`).
- Aiden (same): Next shows Ready, or Blocked for a blocked step. Not ready with a reason is a follow-up step (queued under #399).
- Aiden (same): migration approved: nodes gain nullable `board_state`, `state_since`, `hue`; add-only; `min_reader_version` stays 1; updated inside each write's transaction.
- Sigmund: `deriveBoard`'s columns stay as they are (the scoped briefing reads `deriveBoard(...).next` for readiness, `src/server/briefing-scoped.ts:68`). The cell and state of a box are a new layer over it, in `src/core/taskState.ts`, shared by the window and the server.
- Sigmund: a step whose status is `active` with no live session shows in Now as Unattended only when its assignee is `me` or its last session ended within `TRAIL_MS`; an older one stays in the column `deriveBoard` gives it. This keeps Now bounded.
- Sigmund: precedence when several apply: permission > question / review (oldest open ask's kind) > done > working > blocked > idle > unattended > ready > backlog.
- Sigmund: a permission wait whose session has no focus step still shows in Needs me: a box with no id whose title is the session's display title.
- Sigmund: the reconcile records no events. The write that triggered it already emits events, so the window refetches a snapshot that includes it, and no event loop is possible.
- Sigmund: a reconcile that throws is caught and logged, never rolls back the write (prime law: a bug here must not stop every write).

## Task 1: core state (src/core/taskState.ts, new) [Sev, Sonnet]

- `export const TASK_STATES = ['backlog', 'ready', 'working', 'idle', 'unattended', 'blocked', 'question', 'permission', 'review', 'done'] as const; export type TaskState`.
- `export type TaskCell = 'needs' | 'next' | 'now' | 'done' | 'backlog'`.
- `export const COLOURED: ReadonlySet<TaskState>`: every state but backlog and done. `export const HUES = 7`.
- `export interface TaskBox { row: BoardRow | null; session: Session | null; cell: TaskCell; state: TaskState }` (row null only for a focusless permission wait, whose `session` is set).
- `export function taskBoxes(board: Board, input: BoardInput, now: number): Record<TaskCell, TaskBox[]>` applying the precedence above. Order: needs by the oldest open need (ask raisedAt, or the waiting session's lastSeenAt), then id; next in `board.next` order; now in `board.now` order, then the unattended rows that came from Next/Backlog in tree order; done in `board.done` order; backlog in `board.backlog` order.
- `export function taskStateOf(row, input, now)`: the per-row state the reconcile stores (the same rule; one function both call).
- State rules for `taskStateOf(row, input, now)`, first match wins (`row.sessions` are the live sessions focused on it, `row.asks` its open asks, oldest first):
  1. permission: a session in `row.sessions` has state `permission`, or an open ask has kind `permission`.
  2. question or review: `row.asks` is not empty; the oldest open ask's kind.
  3. done: `node.status === 'done'`.
  4. working: a session in `row.sessions` has state `working`.
  5. blocked: `node.status === 'blocked'`.
  6. idle: `row.sessions` is not empty.
  7. unattended: `node.status === 'active'`, and its assignee is `me` or the newest past session focused on it (`input.pastSessions`, by `endedAt`) ended within `TRAIL_MS` of `now`.
  8. ready: `row.column === 'next'`.
  9. backlog: anything else.
- Cell from state: permission, question and review go to needs; done to done; working, idle and unattended to now; ready to next; backlog to backlog; blocked stays in the column `deriveBoard` gave the row (now, next or backlog).
- `TaskBox.session`: for permission, the session in `permission` state (null when only an ask raised it); otherwise `row.sessions[0] ?? null`.
- A focusless permission wait: a live session (`isLive`) with state `permission` and `focusNodeId` null gives `{ row: null, session, cell: 'needs', state: 'permission' }`; its need time is the session's `lastSeenAt`. Among equal need times rows come before focusless boxes (rows by id, focusless by session id).
- "Tree order" for the unattended rows that came from Next or Backlog: `dfsOrder(buildIndex(input.nodes))` from `src/core/tree.ts`.
- Add `boardState: TaskState | null; stateSince: string | null; hue: number | null` to `TreeNode` (`src/core/types.ts:154`).
- Tests: `test/core/taskState.test.ts`, a table over the precedence, the unattended rule (me / within TRAIL_MS / older), the focusless permission box, one cell per task.

## Task 2: data and reconcile [Sev, Opus: migrations and transactions are on the hard-ordering list]

- Migration 11, appended to `MIGRATIONS` in `src/server/db/schema.ts` in the shape of migration 6 (`schema.ts:167-171`): `ALTER TABLE nodes ADD COLUMN board_state TEXT; ALTER TABLE nodes ADD COLUMN state_since TEXT; ALTER TABLE nodes ADD COLUMN hue INTEGER;` plus the `min_reader_version '1'` upsert, with the comment that only nullable columns are added.
- Map the three columns in the nodes row reader (`src/server/repo/nodes.ts`) and anywhere a TreeNode is built from a row (grep `completed_at`).
- `src/server/repo/taskState.ts`, new: `reconcileProjects(ctx, projectIds: number[])`. Per project: read nodes, live sessions (no stale-expiry write; read the rows with `readProjectSessions`, which does not call `expireStaleSessions`), past sessions, asks and resources; `deriveBoard` with `Date.parse(ctx.now())`; `taskStateOf` per row. For each node whose state differs from `board_state`:
  - `state_since` = `ctx.now()`, except on the first set (stored `board_state` null): done gives `completed_at`, an ask state gives the oldest open ask's `raised_at`, anything else `updated_at`.
  - hue: entering a coloured state with hue null takes the hue fewest coloured nodes in the project hold (ties: the lowest index); entering backlog or done sets hue null; moving between coloured states keeps it.
  - Dropped nodes, the root and groups (any node with no row in `board.byId`): set all three to null if not already.
  - Process nodes in id order; the hue counts include the hues this reconcile has already given.
  - The UPDATE sets only `board_state`, `state_since` and `hue`. It never touches `updated_at` and records no event.
- `src/server/db/tx.ts`: `Ctx` gains `reconcile?: (ctx: Ctx, projectIds: number[]) => void`. In `write()`, after `fn` returns and before the scribe counter reset, inside the transaction: collect distinct non-null `projectId`s from `pending`; if any and `ctx.reconcile` is set, call it inside its own nested `ctx.db.transaction(...)` (better-sqlite3 makes that a SAVEPOINT, so a throw rolls back the reconcile's partial updates and nothing else), wrapped in try/catch; on catch `console.error('[reconcile]', err)` and carry on.
- Set `ctx.reconcile = reconcileProjects` where the server creates its ctx (find `createCtx(` in `src/server/`), not in `createCtx` itself, so unrelated tests stay as they are.
- Tests: `test/server/task-state.test.ts`: the migration adds the columns and a v10 reader rule still holds (follow the existing migration tests); state_since changes only on a change; first-set fallbacks; hue fewest-holders, kept between coloured states, freed at done and backlog; a reconcile that throws leaves the write committed; no events recorded by the reconcile.

## Task 3: open a session in the desktop app [Sev, Sonnet]

- Route in `src/server/routes/window.ts`, following that file's existing POST pattern (origin checks and schema validation as its other routes do): `POST /api/ui/sessions/:id/open-desktop`. 400 unless the id matches a UUID; 404 unless the session exists. Spawn `claude` with `['--desktop', '--resume', id]` via `child_process.spawn`, `shell: false`, `windowsHide: true`; wait for exit up to 10 s. Exit 0 gives `{ ok: true }`; a spawn error, non-zero exit or timeout gives `{ ok: false, command: 'claude --desktop --resume <id>' }` (status 200). On Windows resolve `claude` the way the other spawned commands in `src/` do (grep `spawn(`); if none, `claude.exe` from PATH.
- `web/src/api.ts`: `openDesktop(sessionId)`.
- Tests: route test with the spawn injected (ok, non-zero, bad id, unknown id).

## Task 4: the box and the four cells [Sev, Sonnet]

- `web/src/styles.css`: hue tokens `--hue-0` to `--hue-6` day and night from the mock; port the mock's task-box CSS (lines 100-142) with `ip-` prefixes: `ip-card` (and `st-working`, `st-needs`, `st-done`), `ip-card-top`, `ip-sid`, `ip-card-title`, `ip-sess`, `ip-block`, `ip-main`, `ip-cmd`, `ip-kin-count`, `ip-outcome`, `ip-sys`, `ip-foot`, `ip-st` with the state modifiers. Map the mock's `--active-fill`, `--active-line`, `--amber-fill`, `--red-fill` onto the window's existing tokens where they exist, adding only the missing ones. Remove the board-only rules the cells no longer use (`ip-msg`, `ip-quote`, `ip-crumb`, `ip-num`, `ip-rail` styling, `ip-timeline` dots), checking each with grep first.
- `web/src/board/TaskBox.tsx`, new: the skeleton from the mock's `box()`: top (`#id`, right: `extra`, state pill, `ageShort(stateSince ?? fallback)`), the title button, the cell's body, an optional system line, the foot (`StepMarks` without the ask mark, the docs count, `LabelChip` pushed right). `style={{ '--hue': hue == null ? undefined : 'var(--hue-N)' }}`, none for done and backlog. The pill shows the state `taskBoxes` computed; the age uses `node.stateSince` only when `node.boardState` equals that state, else the fallback (`completedAt` for done, the oldest open ask's `raisedAt` for an ask state, `updatedAt` otherwise), since a time-only change (a session going stale) writes nothing. Keeps `data-node` and `rowClick`.
- `SessionLine`: the session's display title and "Open session ↗" (`data-act`), which calls `openDesktop`; on `{ ok: false }` the line shows the command in `ip-code` with a Copy button (`navigator.clipboard.writeText`).
- `NeedsMe.tsx`: boxes from `taskBoxes(...).needs`; body: the session line, then a permission block ("Allow a shell command", the newest running command in `ip-code`, "Open session to allow") or one ask block per open ask (text clamped to 2 lines, `AskActions`). No characters, letters or `KIND_MARK` (keep the export only if something outside the board imports it).
- `NowColumn.tsx`: per session the session line and a block: the session's in-progress task, the command line as `▸ label · when` (from `commandLineParts`, without the tag), and "N subagents" whose `title` lists each running subagent's description and run time, one per line. Unattended: "No session is on it" and a system line "Its last session ended 40m ago without closing it" (rewrite `endedLine` in `text.ts` without the letter; check its other callers).
- `NextColumn.tsx`: keep all drag, pending and Backlog logic; `nextRow` renders `TaskBox` with "back to Backlog" as `extra`; no numerals or letters; an owned group's head reads "Queued by <session display title>". Keep `numeral` only if imported elsewhere.
- `DoneColumn.tsx`: `TaskBox` with the outcome clamped to 2 lines; keep the divider, the narrow fold and "All done · n ›".
- `Backlog.tsx`: session letters, where shown, become session display titles. Leave the rest.
- `HeaderLines.tsx` stays as it is (#438 retires characters there).
- Tests: update the board unit and e2e tests that assert letters, numerals, characters or the breadcrumb. One new e2e test in `test/e2e/ui.spec.ts`: "Board cells share one task box" (a step in each of Needs me, Next, Now and Done shows its id, state pill and title; the Needs me box shows Answer and Clear).

## Task 5: spec

- Update the Board sections of the window spec in `docs/superpowers/specs/` (2.2, 2.8 and wherever Needs me, Next rows or the Done timeline are described) to the box, the states, one cell per task, and the hues. Sigmund writes this himself.

## Checks

- typecheck, `npm test`; data full strict gates; the new e2e test with `-g` on a port from 4410 to 4419; Doctor Nick's preflight before any UI verification.
- Murr on Opus for Tasks 2 and 3 (db, repo, a spawned process); Sonnet for the web diff. Parvati on the Board at every viewport, with seeded data that reaches each state (including a focusless permission wait and 8+ coloured tasks).
- Risk statement at the receipt: a migration on the live database and a new spawn endpoint; the merge gate is a full `npm run deploy`; no `claude:install` (no `claude/` or `src/hooks/` change).
