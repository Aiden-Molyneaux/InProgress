# Lead stage 1: build log

The deviations from the plan (`2026-11-25-lead-stage-1-the-desk-answers.md`) and the build calls, written as they
happen. A deviation reads "Plan said A. Did B. Because C." The results page copies this log.

## Before the build

- Plan said the worktree is `lead-stage-1`. Did `lead-stage-1-desk`. Because `lead-stage-1` is taken by the merged
  branch of the 2026-11-14 design, left untouched.

## Task 1: the tables (aadbc3c)

- Plan said the five tables' kinds and states. Did them as TypeScript union types, with no CHECK constraint in the
  table (unlike the older tables). Because a state added in a later stage must not need a table rebuild.
- Plan said `lead_sends` holds id to seen_at. Did also `body` (the text sent). Because the morning list and the
  Voice's stamp need the line that went out.
- Plan said one applied turn per item, by a unique index. Did also: one live turn per item (`lead_turns_live_once`,
  leased or answered), one send per retry key (`lead_sends_retry_once`), one imported reading per time
  (`usage_readings_import_once`). Because each is a "happens once" the plan asks for, held by the database.
- `usage_readings` has no project; a project purge leaves its readings with `turn_id` cleared.
- Checked: a copy of the live database (v20) migrated to v21 with all 14 tables' counts unchanged
  (`scripts/check-migration-21.mjs`); main's deployed build ca5e2a3, on port 4421 with the migrated copy as its home,
  served the tree and raised and cleared an ask; the copy stayed at v21. typecheck and 2333 unit tests green.

## Calls made for the next tasks

- Task 2. Plan put the round's switch in task 14. Do it in task 2 (the switch and its read; the window group stays in
  14). Because task 2's producers are made only on a project whose round is on.
- Task 2. A `stopped` item's ref is the session id plus the time it stopped, so one stop makes one item even after
  that item is done, and a later stop makes a new one.
- Task 2. Clearing an ask by any path closes its open desk item in the same write (outcome `cleared`). The runner
  (task 4) treats an apply on an item no longer leased as abandoned.
- Task 2. Sev stays on Opus: the producers write inside the ask-raising transaction (hard-ordering list).
- Task 3. Plan said task 3 is done when a turn given only these tools answers P1's 50 items. Do: the tools tested
  directly in task 3, and the 50 items run once, in task 4, through the runner with these tools. Because the same run
  proves both, at half the usage.
- Task 3. The git facts run in the project's repo, which the runner passes as `INPROGRESS_LEAD_REPO`; a branch name is
  checked against a plain pattern before git sees it. The tools are: desk, step, resource, brief, search,
  branch_merged, change_size, branch_exists. Each answer is capped in size.
- Task 2. A stop is not stored as such: the Stop hook sets `sessions.state = 'idle'` and `last_seen_at = now`
  (`src/server/session-flow.ts:154`, `:195-199`, saved at `:298`), so "stopped at" is `last_seen_at` of an idle
  session. The `stopped` rule reuses the board's stall shape (`src/core/board.ts:88-91`: driver idle by
  `sessionActivity`, no waiting ask) with 10 minutes in place of `STALL_MS` (30).

- Murr on task 1 (Opus, risk list): sound, 0 blocker, 0 major, 3 minor, all fixed by Sev: plain indexes on the
  foreign-key child columns (a purge scanned without them); `lead_decisions.said_at` required; the check script's
  live-home guard expands 8.3 short names. Debt fixed with them: project_id derived from the parent row on a turn and a
  decision, `sendByRetryKey`, the readings' units written down, a reopened item drops its outcome, the migration test
  pinned at v21.
- Task 2, from Murr's owner-calls: the minute watch also sweeps for a session's open question or permission ask on a
  project whose round is on, raised after the round was switched on, with no desk item (an ask raised while a rolled-back
  build ran). Asks older than the switch are the old asks of task 17, not desk items.
- Task 4, from Murr's debt: the lease and the apply are each one repo function in one immediate transaction
  (`leaseItem`, `applyTurn`), not pairs of calls the runner must hold together.

## Where task 2 hooks in (Moh, 2026-11-25, spot-checked before use)

- Writes: `write` in `src/server/db/tx.ts:48-93` (one transaction, no nesting, events after commit; `ctx.now()`).
- Raise: `raiseAskDetailed` `src/server/repo/asks.ts:86-135`, one `write`; a session's actor is `scribe:<id>`
  (`src/mcp/server.ts:22`), the lead's `lead:<name>` (`src/server/lead-commands.ts:42`), the window `window`.
  Lead promise raise at `lead-commands.ts:267` (owner lead), undo re-raise at `:226`.
- Clear: `clearInWrite` `asks.ts:142-159` (first clear wins); callers: window `routes/window.ts:233`, HTTP
  `routes/asks.ts:14`, lead answer `lead-commands.ts:93`, decide `:119`, kept `:283`, step done or dropped
  `repo/nodes.ts:224`, `:227`. Session end clears no ask.
- Switches: `LEAD_SWITCHES` `src/core/lead.ts:8`; zod `src/server/schemas.ts:275`, `:277`; CLI check
  `src/cli/lead.ts:246`; read `leadSwitches` `src/server/lead.ts:324-333`; reset on lead change
  `src/server/repo/projects.ts:436`.
- Minute watch: `src/server/main.ts:96-113`, each part in its own try/catch.
- A lead read end to end: spec `src/cli/lead.ts:69-86`, GET at `:336`, route `src/server/routes/lead.ts:28-39`, tests
  `test/cli/lead.test.ts`, `test/server/lead-brief.test.ts`.
- Live work: `sessionActivity` `src/core/activity.ts:31-35`; session loaded with subagents and commands by
  `findSession` `src/server/repo/sessions.ts:74-81`.
