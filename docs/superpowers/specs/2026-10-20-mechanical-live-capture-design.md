# Mechanical live capture

Date: 2026-10-20. Status: superseded the same day by `2026-10-20-inprogress-redesign-design.md`, which keeps this document's
inventory and evidence (sections 1 to 3) and replaces its direction. Research and spec only: no code.

## 0. Summary

InProgress holds two kinds of state and treats them the same way. **Plan state** (steps, outcomes, labels, logs,
resources, handoffs, order) is semantic: only the session knows what a step is or what it achieved. **Live state**
(which session is on what, whether it is waiting on Aiden, whether he has replied) is observable: the hooks and the
Claude desktop app already see it. Today the second kind still leans on the session remembering to brief the scribe,
and the data shows where that fails: most questions a session puts to Aiden in its chat never reach Needs me.

Direction (Aiden, 2026-10-20): Aiden answers in the session's chat; InProgress mirrors where each session stands and
links into it. So:

1. A session's **waiting state** (waiting on Aiden for a question, a review or a permission, with the text) becomes a
   mechanical field on the session, set by hooks at the end of a turn and cleared by his next prompt. Needs me reads
   it first; scribe asks become an optional, durable record on top.
2. **Focus** gets a mechanical fallback from the session title's leading `#id`.
3. The scribe keeps plan state, where judgement is the point.
4. The window stops being an input path for answers. Needs me tiles lead with **Open session**.

## 1. Inventory: live state and how it gets there

M = mechanical (hooks, title, transcript, desktop files: no model memory needed). C = a command the model must
remember to run, deterministic once run. J = judgement: the model must remember to brief the scribe, and decide what
to say.

| State | Where | Written by | Trigger | Kind |
|---|---|---|---|---|
| Session state `working` / `idle` / `permission` / `ended` | `sessions.state` | `handleHookEvent` (src/server/session-flow.ts:137-255); stale sweep `expireStaleSessions` (src/server/repo/sessions.ts:113) | UserPromptSubmit, Stop, Notification (`permission_prompt` only, src/cli/claude-config.ts:32), SessionEnd, subagent and command events lift `permission` back to `working` | M |
| Title | `sessions.title` | session-flow.ts:136 | hook `session_title` on UserPromptSubmit; on Stop the last `custom-title` in the transcript (src/hooks/handlers.ts:98, src/lib/transcript.ts) | M |
| cwd, branch, transcript path | `sessions.cwd/branch/transcript_path` | session-flow.ts:133-135 | SessionStart and UserPromptSubmit only (handlers.ts:92) | M |
| Last real prompt (#522) | `sessions.last_prompt_at` | session-flow.ts:153 | UserPromptSubmit that is not a task notice | M |
| Prompts since last scribe write | `sessions.prompts_since_update` | session-flow.ts:152; reset by any scribe write (src/server/db/tx.ts) | UserPromptSubmit | M |
| Subagents, dispatches | `session_subagents`, `subagent_dispatches` | src/server/repo/subagents.ts | SubagentStart/Stop, Pre/PostToolUse on Agent, SendMessage, TaskStop; transcript watcher (src/server/agent-watch.ts) | M |
| Background commands | `session_commands` | src/server/repo/commands.ts | PostToolUse on Bash/PowerShell/Monitor; Stop `background_tasks`; task notices; transcript watcher | M |
| Working tasks | `work_items` | src/server/repo/work.ts | PostToolUse on TaskCreate/TaskUpdate (M); else the `tasks` CLI (C) | M or C |
| Focus, driver | `sessions.focus_node_id`, `nodes.driver_session_id` | `applyFocus` (session-flow.ts:402) | `claim` CLI (C), or scribe `set_focus` from a `focus → #id` brief (J) | C or J |
| Step starts | `nodes.status = active` | focus on a todo step (session-flow.ts:424) | as focus | C or J |
| Step finishes, blocks, outcome | `nodes.status/outcome/completed_at` | `patchNode` via MCP `update_node` | scribe brief `#id → done; outcome …` | J |
| New steps, labels, order | `nodes`, `projects.queue` | `add_nodes`, `update_node`, `set_queue` | scribe brief | J |
| Asks raised | `asks` | `raiseAskDetailed` (src/server/repo/asks.ts:67) | scribe brief `ask on #id: …` (or the `ask` CLI) | J |
| Asks cleared, answer | `asks.cleared_at/cleared_by/answer` | `clearInWrite` (asks.ts:104) | scribe brief `a7 answered: …` (J); window Answer/Clear (Aiden) | J |
| Answered in chat mark (#522) | derived, not stored | `answeredInChat` (src/core/board.ts:76) | `last_prompt_at` after `raised_at` | M (derived) |
| Open-asks reminder (#522) | prompt context | session-flow.ts:331-343 | every real prompt while the session holds an open ask; still needs a J brief to clear | M nudge for a J write |
| Answer delivered | `asks.answer_delivered_at` | `markAnswersDelivered` (asks.ts:228) | next real prompt after a clear (pull), or a claim (`owedAnswers`) | M |
| Permission wait | `sessions.state = permission` | as session state | Notification `permission_prompt` | M |
| Logs | `log_entries` | src/server/repo/logs.ts:31 | scribe brief `log on #id` | J |
| Resources, handoffs, state note | `resources` (`purpose` handoff / state) | src/server/repo/resources.ts | scribe brief | J |
| Derived marks: `stalled`, `ended_open`, `no_outcome`, `stale_ask`, `done_focus`, `answer_waiting` | derived on read (board.ts:176-191) | `deriveBoard` | session liveness, STALL_MS 30 min, TRAIL_MS 7 d | M (derived), but built on J inputs |
| Desktop link | none stored | `open-desktop.ts` reads `claude-code-sessions/**/local_<uuid>.json` on demand | Open session click | M |

Not found anywhere: title prefix parsing, a stored waiting-on-Aiden field, a permission-allow path (there is none, and
there should be none), a handoffs table (handoffs are resources).

The mechanical layer already mirrors what a session is **doing**. Everything about what a session **needs from Aiden**,
and most of what it is **on**, is judgement.

## 2. Where judgement capture failed

Read-only queries of `~/.inprogress/inprogress.db` and the transcripts of the 133 tracked sessions in active projects
started 2026-10-13 to 2026-10-20 (360 turns parsed). Scripts kept in this session's scratchpad.

### 2.1 Questions in chat that never reached Needs me (the main failure)

A turn "asks Aiden" when it ends with a turn-box question (`mcp__ccd_turn__wrap_up` with `ask`), calls
AskUserQuestion, or ends its last message on a `?`. "Recorded" means this session raised an ask between the turn's
prompt and the next one.

| How the turn asked | Turns | Recorded as an ask | Not recorded |
|---|---|---|---|
| Turn-box question (`wrap_up.ask`) | 82 | 38 | **44 (54%)** |
| AskUserQuestion | 15 | 5 | 10 |
| Last message ends on `?`, neither of the above | 20 | 0 | 20 |
| **All** | **117** | **43 (37%)** | **74 (63%)** |

Examples of unrecorded turn-box questions: "Should I push 7ebdfeb to origin/staging?", "Close #268 as done with that
outcome?", "Plan the release of staging to main next?". These are exactly the questions Aiden's #522 note describes:
the session sits waiting on him and the Board shows it in Now or as stalled.

### 2.2 Recorded asks are mostly a write-up of a chat exchange

105 asks raised since 2026-10-10:
- 87 were raised and cleared by the same session's scribe, 9 by another session, 4 from the window.
- 34 were cleared within 15 minutes of being raised, 62 within an hour.
- Answers like "ship it (Aiden, 2026-10-19)", "land it", "Aiden allowed the push" show the pattern: the session asks in
  chat, Aiden answers in chat, and the scribe writes both after the fact.

So the ask table is rarely the channel; it is a log. The window's Answer box was used close to never (4 window clears
in ten days, against 96 scribe clears).

### 2.3 Permission

46 `permission_prompt` notifications against 13 `permission` asks. The hook path already covers real permission
prompts. The `permission` asks are almost all the session asking "may I push / land / merge" in chat, which is a
question, not a tool permission.

### 2.4 What works

- **Finishing.** 130 of 131 `done` transitions came from the scribe, and all 17 sessions titled `DONE …` have their step
  done. Sigmund's ship gate makes this reliable.
- **Briefing at all.** Of 84 InProgress sessions since 2026-10-10 only one with three or more prompts never wrote
  through the scribe. Sessions do brief; they miss specific moments, mostly asks.
- **Starting.** 64 step activations came from `claim` (a session actor), the rest from scribe focus.

### 2.5 Stale and orphaned state

- 11 open asks today. 7 sit on archived projects or ended sessions (6 to 15 days old). Asks 74 and 75 on #482 Parked
  steps and loose tasks belong to a session that ended 2.4 days ago while the step stays `active`.
- 11 `active` steps have no live session on them, the oldest 17.7 days.
- 8 InProgress worker sessions since 2026-10-13 never set a focus (mostly runs, tests and this kind of review session).
- 135 sessions in the week: 61 titles lead with `#id` (after an optional prefix), 27 more carry `(#id)`. Of the 92
  focused sessions, 63 have that id in the title.

### 2.6 Delivery

`hooks.log` shows hook posts timing out at 750 ms and the server unreachable on 2026-10-19. A dropped Stop post loses
that turn's end; the next event corrects `state`, but anything only the Stop carried is gone. Mechanical capture needs
a backfill (section 4, phase 2).

## 3. Mechanical signals

| Signal | Where it arrives | What it tells | What it cannot tell | How it fails |
|---|---|---|---|---|
| **Turn-box `wrap_up`** (`ask`, `blocked`, `recap`, `actions`) | PostToolUse on `mcp__ccd_turn__wrap_up` (needs a matcher; not registered today), and the transcript | The session ended its turn with one question for Aiden, its exact text, whether it is blocked | Which step (unless the text has `#id`); whether the question is a review or a permission | Desktop Code tab only; an MCP tool name the app can rename; a session that asks in prose and skips the box. Must confirm the hook fires for this internal tool (phase 1 capture) |
| **AskUserQuestion** | PreToolUse / PostToolUse on `AskUserQuestion`; transcript | A blocking in-turn question and its text; Post means answered | Step; kind | Answered inside the turn, so it is only a short wait; Sigmund's title rule ignores it |
| **Stop `last_assistant_message`** | Stop hook body (seen in capture files; not read today) | The final text: a trailing `?` | Whether the `?` is for Aiden or rhetorical; step; kind | When the turn box holds the question there may be no trailing text (needs checking); false positives on rhetorical questions |
| **Title prefix** `REVIEW` / `BLOCKED` / `DONE` (Sigmund, skill line 371-376) | Title on UserPromptSubmit and Stop (from the transcript) | Sigmund's own read of the turn end: review waiting, other wait, shipped | Anything for non-Sigmund sessions; the question's text | Model forgets (58 prefixed titles in 234 title changes in the week); prefix lingers until the next turn end; rename declined outside the desktop |
| **Title leading `#id`** | Same | Which step the session is on (63 of 92 focused sessions agree) | Multi-step titles (`#459/#460`), trailing `(#436)` refs to another step, renames | Wrong step if the title names something it is not on; needs a project check and "only when no focus" |
| **Desktop `postTurnSummary`** (`status_category` completed / blocked / review_ready, `status_detail`, `needs_action`, `summarizes_uuid`) and **`turnWrapUp`** (`description`, `needsUser`), `isArchived`, `title`, `branch`, `worktreePath`, `spawnedFrom` | `AppData/Roaming/Claude/claude-code-sessions/**/local_<uuid>.json`, which open-desktop.ts already finds by `cliSessionId` | The app's own per-turn read: blocked vs review-ready vs done, a short "needs action" line, the box's question; archived sessions | Step | Undocumented internal format that can change without notice; written by the app's classifier (a judgement, but one that runs every turn without the session's help); desktop sessions on this machine only; a lag after the turn |
| **`last_prompt_at`** (#522) | UserPromptSubmit | Aiden replied after a point in time | Whether the reply answered the question | Notices excluded already; a reply about something else also counts. For a mirror that is right: the session is no longer waiting, it is working |
| **Notification** `idle_prompt`, `elicitation_dialog` | Notification hook with more matchers (only `permission_prompt` today) | The session has sat waiting for input; an MCP elicitation is open | Why | `idle_prompt` fires after a delay; its exact matcher names need checking against the current Claude Code |
| **git branch / worktree** | SessionStart, UserPromptSubmit (branch); desktop file (worktree) | Where the session works; a worktree branch is one session's | The step: worktree branches are random names (`claude/eager-mirzakhani-518257`) | Little use for steps; useful to show and to link |
| **Commits and merges on main** mentioning `(#id)` | not watched today | That a step's change landed | That the step is done (follow-ups, partial merges) | Missing or multiple ids; a reconcile hint at most |
| **`claim` CLI** | the command | Exact focus and driver | n/a | The model must remember to run it (C) |
| **TaskCreate / TaskUpdate mirror** | PostToolUse | Working tasks, with `#id` attribution | Plan-level steps | Only when the session uses TaskCreate |

## 4. Direction

### 4.1 The model

Add one mechanical field set to a session: **what it waits on**.

```
sessions.waiting_kind   NULL | 'question' | 'review' | 'permission'
sessions.waiting_text   the question, one line, clipped
sessions.waiting_source 'turn_box' | 'ask_tool' | 'title' | 'last_message' | 'desktop' | 'notification'
sessions.waiting_since  ISO time
```

Precedence when several fire in one turn: `permission` (the hook state, as today) > turn box > AskUserQuestion >
`BLOCKED` / `REVIEW` title > desktop summary > trailing `?`. Kind: `REVIEW` title or desktop `review_ready` gives
`review`; everything else `question`.

Cleared by: the next real prompt (`last_prompt_at`), SessionEnd, the stale sweep, and the desktop marking the session
archived. That is the same rule #522 already applies to asks, moved to where it belongs.

The Board: a live session with `waiting_kind` set puts its focus step in **Needs me**, with the text and **Open
session ↗**. A session with no focus gets a session tile in Needs me (no step). A scribe ask on the same step merges
into that tile as its durable record.

### 4.2 Phases

**Phase 1: waiting from hooks** (integration; full strict gates for hooks and installer).
- Turn capture on for a day to confirm three facts before building: PostToolUse fires for `mcp__ccd_turn__wrap_up`
  and carries `ask`/`blocked`; Stop's `last_assistant_message` when the box holds the question; the current
  Notification matcher names.
- Installer: PostToolUse matcher for `mcp__ccd_turn__wrap_up` and `AskUserQuestion`; PreToolUse for `AskUserQuestion`.
- Hooks send only the question's first line, clipped, as `purposeOf` does for agent prompts; nothing else of the text.
- Server: the four columns (migration that only adds; `min_reader_version` stays 1), set and clear as 4.1, a
  `session.updated` with `changed: ['waiting']`.
- Board and briefing: Needs me reads `waiting_*`; the briefing's Needs you line names a waiting session the same way
  it names a permission wait today (briefing.ts:216).
- Title prefixes parsed on Stop as a waiting source for Sigmund sessions.

**Phase 2: desktop mirror** (integration).
- Read `postTurnSummary`, `turnWrapUp`, `isArchived` from the desktop session file on Stop (by `cliSessionId`, the
  lookup open-desktop.ts already does) and on the maintenance tick, as a backfill when a Stop post was dropped and as
  the `needs_action` line on the tile.
- Fail soft: an unreadable file or an unknown shape is ignored and logged once; nothing depends on it.
- `isArchived` ends the session in InProgress: archiving in the desktop is Aiden saying it is over.

**Phase 3: focus without a brief** (server).
- On a prompt or Stop, a session with no focus whose title leads with `#id` (after an optional prefix) on an open step
  of its project gets focus as a scribe `set_focus` would: drives only when no live driver, never takes over. A
  `(#id)` or a `#a/#b` title does nothing.
- The briefing still tells sessions to run `claim`; the title is the fallback, and claim keeps `--take-over`.

**Phase 4: narrow the briefing** (server, docs).
- Drop "Aiden must answer, allow or look at something (ask on …)" from the per-session rules for the in-turn case; keep
  `ask on` for waits that should outlive the turn (a walkthrough Aiden does later, a decision parked for days).
- Drop the every-prompt open-asks reminder for asks the session raised in the current turn's exchange (phase 1 clears
  those waits on the prompt). Keep it, or not, for durable asks (question 3).
- Update the inprogress skill, Sigmund's Session title section (it can keep the prefixes; they become one signal of
  several) and the scribe agent text where they mention asks.

**Phase 5 (optional): landed-change hint.** Watch main for merges naming `(#id)` and add a `landed_open` reconcile
mark on an `active` step with no outcome. A hint for Mip, never an automatic `done`: the data says finishing already
works.

## 5. What stays a scribe brief, and why

| Brief | Why it stays |
|---|---|
| New steps, splits, labels, order | Only the session knows the plan and the deliverable |
| `#id → done; outcome …` | The outcome is the point; done capture already works (2.4) |
| `blocked` with a reason | A block on something other than Aiden (a dependency, an outage) is not observable |
| Logs, resources, handoffs, state note | Semantic content |
| Durable asks | A wait that should outlive the turn or the session: a review walkthrough, a decision for later |
| `focus → #id` when the title does not name the step | The fallback for the fallback |

What leaves: in-turn asks and their `aN answered` clears. The session asks in chat; the hooks see it; Aiden answers
in chat; the prompt clears it.

## 6. Window-side input paths

| Path | Use in ten days | Proposal |
|---|---|---|
| Answer… / Send on an ask | about 0 to 3 | Retire. Aiden answers in the chat, and a window answer reaches the session only on its next prompt anyway |
| Clear on an ask | 4 | Keep, for tidying: stale asks from ended sessions (2.5) |
| Mark done from the window | 1 | Keep, for tidying |
| Open session ↗ | (not counted) | Make it the primary action on every Needs me tile |
| Allow a permission from the window | none exists | Do not add: approving tool permissions belongs in the session, and it would be a security setting InProgress should not hold |

## 7. How #522 fits

#522 is the first piece of this direction: `last_prompt_at` is a mechanical "Aiden replied" signal, and the
answered-in-chat mark moves a step out of Needs me on it. This spec adds the other half, a mechanical "the session
asked" signal, so a question asked only in chat puts the step **into** Needs me, and the same `last_prompt_at` takes
it out.

What changes for #522's pieces:
- `last_prompt_at`: stays, and becomes the clear for `waiting_*`.
- The answered-in-chat mark: stays for durable asks (still open, Aiden has replied, the scribe has not recorded it).
- The every-prompt reminder: narrowed in phase 4.

## 8. Effect on the v3 Board (#502)

The v3 spec's Needs me section (docs/superpowers/specs/2026-10-18-window-v3-port-design.md:702-717) assumes asks are
the content and the window is an input path. Changes:
- **A waiting tile**: a third variant beside the ask tile and the permission wait. `#id` (or the session title when it
  has no step), a `needs` Chip (`QUESTION` / `REVIEW`), the age, the question text cut at four lines, **Open
  session ↗** as `primary`.
- **The ask panel**: drop **Answer…** and its Field/Send; keep **Clear** as `ghost`. A scribe ask on a waiting
  session's step shows as a panel inside the waiting tile, not a second tile.
- **The `[ASKS] n` count** (v3 spec:497) counts waiting sessions too.

#502 is in build. Phase 1 can ship first behind today's Board, adding waiting sessions to the snapshot; #502 then shows
them. If #502 lands first, the Answer… field is cheap to leave out now and costly to remove later (question 5).

## 9. Questions for Aiden

1. **Mirror semantics.** Is "the session is waiting on you" (cleared by any reply in its chat) the right meaning for
   Needs me, even when your reply is about something else? The alternative keeps a step in Needs me until a scribe
   records an answer, which is the judgement path this spec moves away from.
2. **The desktop file.** Phase 2 reads an undocumented app file (`postTurnSummary`, `turnWrapUp`, `isArchived`). Accept
   that dependency as a fail-soft backfill, or stay on hooks only?
3. **Durable asks and the reminder.** Keep the every-prompt reminder for asks that outlive a turn, or drop it and rely
   on the answered-in-chat mark plus the three-day check line?
4. **Stale asks.** When the raising session ends and no live session drives the step, should its open asks clear on
   their own (marked "session ended"), stay until you Clear them, or move to the step's log?
5. **#502.** Leave Answer… out of the v3 Needs me now, before phase 1 lands?
6. **Auto-focus from the title.** Accept phase 3 (focus from a leading `#id` when a session has none, never a
   take-over), or keep focus to `claim` and the scribe only?
7. **Archive ends the session.** Should archiving a session in the desktop end it in InProgress (phase 2)?
8. **Order.** Phases 1 and 4 together first, then 3, then 2; phase 5 only if Mip wants it. Agree?
