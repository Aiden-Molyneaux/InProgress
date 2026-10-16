# Keep the thread: one driver per step, owned answers, one session per Sigmund

Date: 2026-10-15. Status: approved by Aiden section by section on 2026-10-15 and 2026-10-16; the written spec awaits his
review. Tracked in the `inprogress` project as #442.

- **Case study.** `~/.inprogress/resources/inprogress/2026-10-15-why-422-lost-its-thread.md` (r260): how #422 went
  through five sessions, lost an approval, and was misread by Mip.
- **Handoff.** `2026-10-15-keep-the-thread-design.md` (r264).

## Goal

Aiden's principle (2026-10-15): Mip spawns Sigmunds. A Sigmund lives in one session and drives its step to done. He
updates his step and tasks in InProgress, and reports back to Mip only through InProgress, when something meaningful
happens: the step is done, a new step is needed, or Aiden must answer something. Aiden talks to the Sigmund in its own
session, never to Mip, for the state of a step.

Success means the #422 story cannot repeat:

- the Board shows which session drives each active step, so Aiden knows where to talk;
- a step is driven by one session from start to done, with no chain of handoffs as context fills;
- an answer Aiden gives ("land it") reaches a live session or stays visibly owed on its step;
- a step whose driver has gone quiet is flagged, and Mip checks before calling anything stalled.

## Decisions (Aiden, 2026-10-15 and 2026-10-16)

| # | Question | Decision |
|---|---|---|
| D1 | Cut a session at the context nudge? | No. Compaction is the reset. A session cuts only when its thread is done or the next item is unrelated. |
| D2 | Where the driver lives | Stored on the step: `nodes.driver_session_id`. |
| D3 | A claim on a step with a live driver | Joins as a helper. `--take-over` moves the driver. |
| D4 | Where an answer goes | Owed on the step: delivered to the asker if live, else the step's driver; an `answer_waiting` mark until delivered. |
| D5 | Stalled threshold | Driver idle 30 minutes, nothing running, no open ask. |
| D6 | Compaction | Sigmund asks Aiden for `/compact` at a clean point from 150k; `autoCompactWindow` 250k is the backstop. |
| D7 | Report channel to Mip | InProgress (step status and outcome, new steps, asks). No live session link. |
| D8 | Waiting for the go-ahead | Sigmund raises a `review` ask at phase 7, so a wait on Aiden never reads as stalled. |

## 1. The driver

### 1.1 Data

Migration 11 adds one nullable column:

```sql
ALTER TABLE nodes ADD COLUMN driver_session_id TEXT;
```

followed by the usual `min_reader_version` insert with value `'1'`: only a nullable column, so older builds still read and
write the schema. `TreeNode` gains `driverSessionId: string | null`.

Backfill, in the same migration: for each node with status `active`, the driver is the non-ended session focused on it
with the latest `last_seen_at`, if any. Without it, every active step with sessions on it would read as driverless on
the first deploy.

### 1.2 Claim

`claimStep(ctx, actor, sessionId, nodeId, { takeOver })`, and `inprogress claim <id> [--take-over] --session <id>`:

- **No live driver** (null, or a session that is ended or past `STALE_SESSION_MS`): the claimer becomes the driver.
  Note: `You drive #442.`
- **A live driver, no `--take-over`**: the claimer focuses on the step as a helper; the driver is unchanged. Note:
  `H drives #442; you are helping. Pass --take-over to drive.`
- **A live driver, `--take-over`**: the claimer becomes the driver. The previous driver's focus is cleared directly (not
  through `applyFocus`, so its `lastSeenAt` does not move and it is not kept live), it gets a `session.updated` event, and
  its next prompt owes it a briefing (`markBriefingDue`). Note: `You drive #442; took over from H.`
- **The claimer is already the driver**: no change, no note.

The driver is written inside the claim's `write()`, after `applyFocus`, so a refused claim leaves it as it was.

A scribe `set_focus` follows the no-take-over rule: it makes the session the driver only when the step has no live
driver. It never takes over.

### 1.3 Leaving

- The driver focuses on another step (a claim or `set_focus`): the old step's `driver_session_id` is cleared.
- The step goes `done` or `dropped`: cleared, in the same write as the status change.
- The driver ends or goes stale: the column keeps its id. The step still says who drove it last, which the stalled mark
  (section 3) reads.

### 1.4 What sessions see

- **Step block** (`stepBlock`, briefing-scoped): a `Driver:` line, `you` or `H "<title>" (<activity>)`.
- **Previous driver's next briefing** after a take-over: `N took over #442. Claim another step, or claim #442
  --take-over to drive it again.`
- **Briefing rules** (the "Claim one:" lines and the session-start hook text): mention `--take-over` for a successor that
  inherits a step.

### 1.5 The window

- `BoardRow` gains `driver: Session | null` (the live driver). `row.sessions` puts the driver first, then the helpers in
  the current order.
- The Now row's session line (`NowColumn.tsx` `SessionMessage`) shows a role word after the state word: `drives` for the
  driver, `helping` for the others. A row whose step has no live driver shows no role word.
- A session that lost the driver role to a take-over has no focus, so it leaves the row. The activity strip records the
  take-over (`N took over #442 from H`).

## 2. Answers become owed work

Today an answer is delivered once, on the next real prompt, to the session that raised the ask
(`undeliveredAnswers`, `src/server/repo/asks.ts:139`; `session-flow.ts:324`). The a12 answer was lost because that
session had ended.

### 2.1 Delivery

An answered ask (cleared with a non-empty answer, `answer_delivered_at` null) is delivered on the next real prompt of:

1. the session that raised it, when that session is live; otherwise
2. the step's driver, when the driver is live.

`undeliveredAnswers(ctx, sessionId)` returns both: asks this session raised, and asks on steps this session drives whose
asker is not live. Delivery sets `answer_delivered_at` as today. The line for an answer reads
`Answered: a12 "land it" (yours: act on it, or add it to your tasks)`. A clear with no answer keeps today's
`Cleared: a12, no answer` and is never owed.

### 2.2 A claim delivers

When a claim makes the session the driver (section 1.2), the step block lists the step's undelivered answers as
`Owed: a12 answered "land it"` and marks them delivered. A successor gets them even when the asker is gone.

### 2.3 After delivery

Delivery hands the answer over. If the session then ends without acting, the step's existing `ended_open` mark or the
new `stalled` mark catches it. Nothing else is tracked.

### 2.4 The `answer_waiting` mark

A row is marked `answer_waiting` when one of its asks is cleared with a non-empty answer and not yet delivered. The
snapshot holds asks cleared within `ASK_TRAIL_MS` (7 days), so the mark covers that window; on the first deploy it shows
the past week's undelivered answers once, which is the point. Label: `answer waiting`.

## 3. Stalled, and Mip's checks

### 3.1 The `stalled` mark

`STALL_MS = 30 * 60 * 1000` in `src/core/types.ts`. Derived in `deriveBoard` for a row whose node is `active` and not
assigned to Aiden, when either:

- (a) its driver is live, `sessionActivity(driver, now)` is `idle`, `now - lastSeenAt >= STALL_MS`, and the step has no
  open ask; or
- (b) at least one live session is focused on it but its driver is not live (ended, stale, or null).

`permission` and `busy` (a running subagent, or a command that counts as work) never count. A driver waiting on Aiden
with an open ask is waiting, not stalled; section 4.3 makes Sigmund raise one. `ended_open` keeps its meaning for
open steps that no live session is on. Label: `stalled`.

### 3.2 The reconcile line

The `--status` Reconcile list prints the facts Mip needs for a stalled row:

```
#422 stalled: H idle 45m · branch cell-form · cwd C:/personal/InProgress/.claude/worktrees/cell-form
```

and for (b), `#422 stalled: driver H ended 2h ago · helping: K`.

### 3.3 Mip (`claude/skills/mip-orc/SKILL.md`)

- **Reconcile:** `stalled` and `answer_waiting` join the mark list.
  - `stalled`: before calling a step stalled, or saying no session is working on it, run
    `git -C <cwd> status --porcelain` and `git -C <cwd> log -1 --format=%cr` for each live session on the step.
    Uncommitted or recent work is a status ("H has uncommitted work in cell-form, idle 45m: talk to H"), not a stall.
    Mip never takes over. When the driver is not live, Mip offers a successor handoff whose first line is
    `Claim #<id> --take-over`.
  - `answer_waiting`: name the step's driver if it is live ("a12 waits for H's next prompt"), else offer to start a
    session on the step; the claim delivers the answer.
- **What's next:** a step with a live driver is not ready (already true for any live session).
- **Start a step:** the handoff names a stable worktree, `.claude/worktrees/<topic>` on the topic branch, never a chip's
  folder, and says the chip's fresh worktree stays empty.

## 4. Sigmund in one session

### 4.1 Compaction, not cuts (`.claude/skills/sigmund/SKILL.md`, Across the session)

- One Sigmund drives one step in one session, from claim to done.
- At the 150k nudge he finishes the task he is on, commits, and asks Aiden to run `/compact` with a focus line naming
  the plan file, the branch and any open findings. He does not cut.
- `autoCompactWindow` in `.claude/settings.json` goes from 300000 to 250000: the backstop when Aiden is away.
- The unattended overnight bullet folds into the main rule: the same rhythm, and compaction is the reset.

### 4.2 When a Sigmund still starts or hands to another session

- **Thread done:** the step is done with its outcome; the session ends. No handoff.
- **Independent parallel pieces** on separate files: helper sessions on the same step, which claim without
  `--take-over`. Sev subagents in the same session stay preferred for mechanical work.
- **Another repo, machine or cloud environment.**
- **Scope that splits into a new step:** a new step through the scribe; it gets its own Sigmund later.
- **A broken session** (compaction lost the plan, a loop, a harness crash): a handoff from the plan file.
- **A long wait with a large context** (days, over 200k): a handoff costs about what the cold wake would.

Every handoff to a successor on the same step opens `Claim #<id> --take-over`, names `.claude/worktrees/<topic>`, and
lists the step's undelivered answers. The context nudge, a review wait and a subagent run are never reasons to hand off.

### 4.3 Waiting for the go-ahead (phase 7)

When Sigmund presents the receipt and stops for Aiden's go-ahead, he briefs the scribe with
`ask on #<id>: review, <one line on what is ready>`. Aiden's "ship it" answers it, and the answer reaches Sigmund on his
next prompt (section 2.1). The open ask keeps the step from reading as stalled.

### 4.4 Reporting to Mip

Through InProgress only: the step's status and outcome, new steps, asks, and the working tasks. Mip reads them at its
next opening. Sigmund does not message Mip, and Mip keeps `spawn_task` chips.

### 4.5 The nudge (`scripts/context-nudge.mjs`)

- **150k:** `Context is about 150k tokens. Finish what you're on, commit, and at the next clean point ask Aiden to run
  /compact with a line naming your plan, branch and open findings. Do not cut the session. Unattended, carry on: the
  250k autocompact is the reset.`
- **200k** (replaces the 160k line): `Context is about 200k tokens. If Aiden has not compacted, carry on; the autocompact
  at 250k is the backstop.`
- **After a compaction** (the hook already sees the fall below 150k): one line, `Context was compacted. If you are running
  Sigmund, reload him (.claude/skills/sigmund/SKILL.md) and reread your plan file and the step block before you go on.`
  The nudge runs in every main session of this repo, Mip's included, hence the "if".

## 5. Out of scope

- Waking an idle session. InProgress delivers on the next prompt; `answer_waiting` makes a wait visible but does not end
  it.
- Enforcing the stable-worktree rule in code. It stays a skill rule, and Mip's check makes a breach visible.
- A live link between Mip and its Sigmunds (`start_session`): it would wake Mip on every Sigmund turn.
- Retiring session letters and characters (#438).

## 6. Testing and gates

Labels: data, integration and ui. Gates: typecheck, unit, smoke, the full strict gates for the hooks, one e2e test.

- **Unit, claim:** no driver, a live driver (helper), `--take-over` (previous driver's focus cleared, `lastSeenAt`
  unchanged, briefing due), a stale driver replaced without the flag, a refused claim leaving the driver as it was,
  `set_focus` never taking over, the driver leaving by focus, by done and by drop.
- **Unit, answers:** asker live gets it; asker ended and driver live, the driver gets it; neither live, it stays
  undelivered and the row is `answer_waiting`; a claim delivers it in the step block; a clear with no answer is never
  owed.
- **Unit, marks:** `stalled` (a) at 29 and 31 minutes, with a running subagent, a counted command, `permission`, an open
  ask, an Aiden-owned step; (b) with a live helper and an ended driver.
- **Unit, migration:** 11 adds the column, keeps `min_reader_version` at 1, and backfills the driver of an active step.
- **Unit, nudge:** the new 150k and 200k lines, and the post-compaction line once per compaction.
- **Smoke:** the claim CLI with `--take-over` through the installed hook path.
- **e2e:** a Now row shows `drives` on its driver and `helping` on a helper.

Murr runs on Opus: the diff touches `src/server/db/`, `src/server/session-flow.ts`, `src/server/briefing.ts` and
`claude/`. Parvati is skipped: the window change is a word on an existing line.

The merge gate: a full deploy (migration 11), then `npm run claude:install` for the mip-orc skill and the hook text.
