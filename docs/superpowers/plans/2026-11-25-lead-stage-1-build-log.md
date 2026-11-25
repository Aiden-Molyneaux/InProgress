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
- Murr's proportional re-check of 809be9f: sound, no findings. Migration 21 was edited in place before it shipped;
  only scratch copies ran its first text (`mig21`, `home21`, both discarded), so no home holds the old schema.
- Task 2, from Murr's owner-calls: the minute watch also sweeps for a session's open question or permission ask on a
  project whose round is on, raised after the round was switched on, with no desk item (an ask raised while a rolled-back
  build ran). Asks older than the switch are the old asks of task 17, not desk items.
- Task 4, from Murr's debt: the lease and the apply are each one repo function in one immediate transaction
  (`leaseItem`, `applyTurn`), not pairs of calls the runner must hold together.

- Usage units, read from stage 0's readings file: `rate_limit_info.unifiedWindows.five_hour.utilization` and
  `.seven_day.utilization` are fractions (0.47 is 47 percent); `resetsAt` is epoch seconds. `usage_readings` stores the
  fraction as reported and the reset as ISO; text multiplies by 100. (809be9f's doc comment said percent 0 to 100:
  corrected with task 2.)
- Task 3. Plan said `inprogress lead-tools <slug>`. Do a build entry of its own, `dist/lead/tools.js <slug>`
  (source `src/server/lead/tools.ts`). Because the CLI then need not carry the MCP library on every call, and the
  scribe's MCP server (`src/mcp/`, risk list) stays untouched.

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

## Task 2: the desk and its items

- Built by Sev (Opus: the producers write inside the ask-raising transaction). The round's switch, the producers in
  `src/server/lead/desk.ts` (raise, clear, the minute watch's stopped, promise_due and sweep passes), the wake, and
  `lead desk <slug>` with `GET /api/lead/:ref/desk`. typecheck and 2352 unit tests green.
- Plan said `lead desk inprogress`. The CLI asked every lead command for `--as`; `desk` takes none (a `noWho` spec
  field). Because the desk is a read anyone may make, as `/events` is.
- A task step marked done keeps its asks (`src/server/repo/nodes.ts:220-229`); only a drop, a park or a finished
  question step clears them. So a desk item about an ask on a finished step stays until the ask clears. Left as it is:
  the lead's turn reads the step and finds it done.
- "No open ask on the step" for a stopped session means no open ask of Aiden's, as the board's stall check reads it; a
  lead's promise on the step does not block a stopped item.
- The wake is a hint to read the desk, not proof an item exists: a write that rolls back may still wake the runner once.

## Task 3: the lead's tools

- Built by Sev (Sonnet). `src/server/lead/tools.ts` and the entry `dist/lead/tools.js <slug>`: eight read tools
  (desk, brief, step, resource, search, branch_merged, change_size, branch_exists), each answer capped at 40 KB, git on
  full refs through execFile with no shell, "InProgress is not answering" when nothing listens, no server started.
  typecheck and 2364 unit tests green.
- The start check also asks for `INPROGRESS_LEAD_AS` (the lead's name for the reads' lead check). The runner sets it.
- The entry's exit 2 is tested through its check function, not by spawning the built entry; the scenes' build runs it.
- Murr on task 2 (Opus, risk list): sound, 0 blocker, 0 major, 3 minor. He hit his 40-turn limit before reporting and
  was resumed once to write it. Fixes sent to the same Sev: the raise path held to the sweep's rule; a deleted step
  closes its asks' items; archived projects skipped; the producers moved into `src/server/repo/` (no import cycle
  through `repo/asks`); one switch reader; a plain join never makes a second item; two indexes added to migration 21
  (it has not shipped); a stopped item closes when its session moves again.
- Plan (scene 5) says turning the round back on takes what waited, oldest first. Did: the bound for asks and stops is
  the first time the round was ever switched on, not the newest. Because an ask raised while the round was off after
  that is the desk's, and only asks older than the first switch-on are task 17's old asks.
- Left for task 14: the window's switch list and the brief's switch line are written by hand (`web/src/lead/leadDesk.ts`,
  `src/server/lead-text.ts:137`) and show no round yet; the rules text gains the round with version 7 (task 11).
- Murr on task 3 (Sonnet: not on the risk list): sound, 0 blocker, 0 major, 2 minor (git found inside the repo's tree
  on Windows; a branch name matched in another case). Fixes sent to the same Sev with the debt worth doing now.
- Task 3, from Murr's owner-calls: the tools check that a home is given, not that the port's server serves that home.
  The runner (task 4) passes both from the server's own settings, so they come from one place. "No repository" and
  "Not a branch name" are plain answers, not errors: the turn reads the words. The trunk is `main`, as on every
  project with a lead in this stage.
- Task 2 and 3 fixes committed (3947eca, 2817e1f): typecheck, 2377 unit tests and 35 smoke tests green. Murr's
  proportional re-check of both is running.
- Found on the way: `test/smoke/built.test.ts` passed `--instructions 5` to `lead decide`, so smoke was red on main
  since rules v6 (50f559c). Fixed here: the test reads `LEAD_INSTRUCTIONS_VERSION`.

## Task 4: the turn runner

- Brief to a fresh Sev on Opus (hard-ordering list: leases, recovery, two runners). The calls in the brief: the lease,
  the answer, the apply and a failure are each one repo function in one immediate transaction; `behind` means the
  runner gave up after two failed turns (past due is shown late, not moved); the headless way runs `claude -p` with
  `--tools ""` and only the lead's MCP tools allowed, in `<home>/lead/<slug>/` with its own empty project settings, the
  session variables removed; `INPROGRESS_LEAD_CLAUDE` names another executable (a stub for the scenes on a copy);
  `INPROGRESS_LEAD_RUNNER=off` keeps it from starting; a stand-in apply until task 5.
- Murr's re-check of the task 2 and 3 fixes: 1 major in the fix (any git failure read as "no such branch"), sent back
  with three small follow-ups (a deleted step closes its stopped items; no item on an archived project's raise; the
  index test plans the real SQL). Accepted as is: the round's first switch-on is the first ever, across lead changes;
  migration 21's added indexes exist only where 21 runs fresh, which is every home, since no home but scratch copies
  has run 21.
- Murr's round 2 re-check (Haiku, proportional): sound, no findings. Two debt lines fixed inline by Sigmund (unseen by
  a reviewer, both one line): a deleted step's stopped items are looked up within its project (the index serves it), and
  a repeated comment in `switches.ts` removed. Accepted: the raise path's archived check relies on a deleted project
  being archived first, which `deleteProject` does; an ask raised while archived is swept as overdue on unarchive.
- Task 4 built by Sev (Opus). typecheck and 2410 unit tests green. Deviations, each Sev's and accepted:
  - Brief said a failed compare-and-set in the apply abandons the turn. Did: only an answered turn is abandoned; a
    leased one is left for its lease to run out. Because abandoning a leased turn would strand its item in leased.
  - Brief named no model. Did `claude-opus-5-5` (`LEAD_MODEL`).
  - A `.js` stub named by `INPROGRESS_LEAD_CLAUDE` runs under node, since there is no shell to run a script.
  - Stopping the server aborts running turns as abandoned (the items reopen; they count toward behind).
  - The repo for the git tools is the project's first bound folder; a project with no lead is skipped before a lease.
- Open from task 4, for task 5: an apply that throws leaves the turn answered and recovery retries it every tick. Task 5
  bounds it: a second throw fails the turn.

## Task 7: facts read before the brief (Claude Code hooks docs, code.claude.com/docs/en/hooks and hooks-guide)

- A hook handler takes an `if` field in permission-rule syntax (`"if": "Bash(git push *)"`, `"PowerShell(Remove-Item *)"`),
  one rule per handler, evaluated before the process is spawned, on PreToolUse and PermissionRequest among others.
  Each subcommand of a compound command is checked; input it cannot split runs the hook regardless.
- PreToolUse deny: `hookSpecificOutput { hookEventName: "PreToolUse", permissionDecision: "deny",
  permissionDecisionReason }`, honoured in every mode, bypassPermissions included.
- PermissionRequest: input has tool_name and tool_input; output `hookSpecificOutput { hookEventName:
  "PermissionRequest", decision: { behavior: "allow" | "deny", message? } }`; exit 0 with no output leaves the normal
  prompt. It fires only when Claude Code would ask, so not in bypassPermissions. The deny shape and a timeout's effect
  are not shown verbatim in the docs: the task proves them on a real `claude -p` run against a scratch home.
- Plan said every shell command goes through the hold hook, under 50 ms when it matches nothing. Do: one handler per
  watched family with an `if` rule (push, merge, publish, deploy, gh, delete), so an ordinary command starts no hook at
  all. Because about 2,700 shell commands a day would otherwise each wait on a Node start. A playbook's `Held:` lines
  refine within those families; a line outside them is reported by the installer, not watched.

## Murr on task 4 (Opus, risk list)

- Needs fixes: 0 blocker, 2 major. A run that cannot start or ends in error put the whole desk behind for good (now a
  runner fault: no count against the item, a back-off); a failed run lost its cost and usage readings (now kept). Minors
  and debt sent with them: a stop deadline, a result read before an abort wins, per-turn prompt files, a guarded tick,
  the scheduler's SQL in repo functions, and applyTurn under `write()` so a verdict's writes record their events (task 5
  needs it). Accepted from his owner-calls: the env filter keeps user settings (an explicit list, as P1's script had);
  a run whose item is no longer leased is aborted at the next tick. Left for task 9: a leased stopped item whose session
  moved on.

## Murr on task 6 (Sonnet), before its commit

- Needs fixes: 2 blocker, 3 major, each a way to a false "Clear to land": a rename hid a risk file; a merge asked from
  the main checkout compared main with itself; the glob escape escaped nothing; an unreadable remote read as private;
  a publish of a pushed head could never be cleared. All sent back, every doubt resolving to held.
- Calls made on his owner-calls (Sigmund's, for Aiden to undo with a word): a deploy is held when the live build is not
  behind main or was built from uncommitted work; a first push of a new branch is checked against main; `Risk:` lines
  add to the defaults and never replace them; the patch id counts whitespace (`--verbatim`); a remote that cannot be
  read as private, or is not on GitHub, is held; "changed since his yes" only for a yes on the same step; a check
  writes a log line only when it holds.

## Task 5: what a verdict does (Sev, Opus)

- Built: `src/server/lead/apply.ts` (`applyVerdict`, the runner's `apply` in main.ts), `decideInWrite` shared by
  `lead decide` and the desk, the bring (`src/server/repo/deskBring.ts`: `bringItem`, `bringNext`, `broughtOpen`), the
  brief's "Brought to Aiden by the desk" section.
- From Murr's task 4 debt: the apply runs in `write(ctx, 'lead:<name>', ..., { immediate: true })` with applyTurn's
  compare-and-set inside it (a savepoint), and the effect gets the write's `record`, so ask.cleared and the rest reach
  the window after the commit. `write()` gained the `immediate` option.
- Plan said "five open per project". Did: AIDEN_BROUGHT_LIMIT counts the items the lead brought (a `bring` line) still
  waiting on Aiden, old asks left out. Because InProgress's 6 old asks would otherwise stop the desk from bringing
  anything.
- Brought across from `lead-first-run`: 2922a4a by hand (the brief and the Lead view name the switch a line turned on,
  never `#null`; its tests applied as they were), on this branch's switch reader. From plan d392eec, Task 1 only:
  `aidenOpenAsks` (this project and across projects), the start gate and the brief read it, the brief's line reads
  `Aiden's open asks in this project: <n> of 5 · across all projects: <m>`. Not brought: its rules text and version bump
  (rules version 7, task 11) and its Task 2 (the Lead view's note still reads across all projects).
- The application keeps an item's outcome on waiting_aiden too (`AIDEN d<id>`, `AIDEN waiting (limit)`); only a reopen
  drops it.
- applyTurn's item move is from leased or done: the effect's own clear closes the item (deskOnAskCleared) in the same
  transaction, and the effect's outcome replaces `cleared by lead:...`.
- An item past the limit tells its session nothing until it is brought: the message's retry key needs the bring's
  d-number. bringNext does nothing while the round is off.
- CARD on a permission item is left as `CARD (no action in this task)` with the ask open for Aiden: the brief names CARD
  on a question only.
- CARD's line names the ask's step: `inprogress landing <step id> --action <...>`.
- An apply that throws twice for one turn fails it (`failAnsweredTurn`, answered to failed, the item back as failTurn
  moves it).
- Task 4 fixes from Murr in the same change: a runner fault (claude would not start, no result line, an is_error result
  other than error_max_turns) moves the turn to a new state `interrupted`, which does not count toward behind, and backs
  the project off 5 minutes, then one try; a stop and an item that left the desk mid-run (cleared, step deleted, round
  off: checked every tick) interrupt too. A run killed at its lease's end and an answer that does not parse still count.
  After a failure the next lease waits for the tick. A failed or faulted run keeps its cost, tokens and readings.
  `claude` on Windows is found as .exe, then .cmd or .bat on PATH, and a .cmd runs through `cmd.exe /d /s /c` with each
  argument quoted (one with a quote, % or ! is refused). The turn's prompt and tools files are per turn and removed after;
  the settings file is written once. stop() waits at most 2 seconds; a taskkill that fails falls back to kill; a result
  line wins over a later abort, and a run that lingers 5 seconds past its result is killed. The env filter is P1's list
  plus CLAUDE_CODE_SESSION*, CLAUDE_CODE_MESSAGING* and T3CODE_*. The scheduler's SQL moved to repo functions
  (`answeredTurns`, `expiredLeases`, `openItemsInLane`, `liveProjectsWithRound`, `isLiveWithRound`), the last two shared
  with the minute watch.
- Murr's re-check of task 6 (Sonnet, proportional): sound, 3 minors, each a narrow false clear, fixed inline by
  Sigmund (lines no reviewer has seen; they go in the receipt): a push is "nothing to push" only with no commits, so a
  commit and its revert still go to the remote read (tested); every diff takes `--no-relative`; every push URL of
  origin is read (`get-url --push --all`), any public one public, any unread one held. Also `gh repo view` gets the
  full github.com URL so gh's default host cannot answer for it. Accepted as known: a private read is kept 10 minutes;
  a deploy is judged on main's commits, not the main checkout's working tree; a hostile branch's odd paths (short names,
  trailing dots) are not caught. "forget security for now" covers the last.
