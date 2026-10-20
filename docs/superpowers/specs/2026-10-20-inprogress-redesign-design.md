# InProgress redesign: a mirror, a backlog, and project memory

Date: 2026-10-20. Status: draft for Aiden. Design only, no code.

Supersedes the narrower spec written this morning, `2026-10-20-mechanical-live-capture-design.md`, whose inventory and
evidence sections (1 to 3) this document relies on and does not repeat.

## 0. Intent and the why

After three weeks of daily use Aiden's purpose for InProgress has moved. He no longer wants to know exactly what each
session is doing (subagents, commands, every log line). He wants three things, in his words, with my reading of each:

1. **A mirror.** Where each session stands on its task, phase or project, truthfully, with a link into the Claude
   desktop session. He lives in Claude Desktop, answers there, and archives sessions there when a Mip run is over.
   InProgress is where he looks to find what needs him and what is in flight across projects.
2. **A backlog he can see and shape.** His idea inbox, which Claude also files into, which Mip reads to propose what
   is next, and which he cannot get in Claude Desktop.
3. **Project memory.** The things a project's sessions know and he does not: stack, accounts, where secrets live, how
   the hooks work, whether a project is current with the Shipwright workflow. Parsed from the repo into a view he can
   read, kept current.

The failure test, his words: it misses the point if the application, its processes or its resources feel bloated,
inaccurate, outdated or non-serving. So every surface, rule and stored field below has to be used, true, and cheap to
keep true. Anything that stays true only if a session remembers to update it is suspect by default.

## 1. Decisions

### Aiden said (this conversation and his 2026-10-20 note)

- He answers in the session chat, not in InProgress. InProgress mirrors and links; it is not a second chat.
- Needs me works when it is true: salient, and actionable through Open session. Wrong lane states cost more than the
  lane gives.
- He wants to park a step from Needs me when he is not ready to decide, so it stops pulling at him.
- The backlog is his idea inbox and Claude's filing place; the add form needs a notes field; items need an origin mark
  (his or Claude's); later, an opt-in flag that lets Claude take an item unsupervised, never the default.
- Each step needs a **What** and a **Why** written for him, separate from whatever context Claude keeps, so he can
  greenlight Claude-filed follow-ups (tests, infrastructure) without asking.
- He never uses the Project view or the orchestrator slab on the Board. He rarely opens Details, and when he does the
  content is not organised for him.
- The DONE / REVIEW / BLOCKED title prefixes in the Desktop sidebar are the status channel he reads. He wants more of
  them, kept religiously. The specific pain: a session running a background subagent or command reads as idle, he
  clicks in to check, it was fine.
- Project memory and live documentation are being thought through in another session ("InProgress documentation and
  Shipwright tracking"); nothing is decided there yet.

### My calls (not Aiden's; correct them)

- The mirror's unit is the session's **waiting state**, captured by hooks, not the ask table.
- Archiving a session in Claude Desktop ends it in InProgress.
- What and Why are two short fields on a step, not sections of the body.
- The Project view goes; its one useful piece, the phase index with progress, moves to the Board's page head.
- The orchestrator slab goes from the Board; the state note stays as Mip's memory.
- Trimming waits for the v3 steps already in build (#502, #504) to land, then runs as one step.

### Open (section 12)

Project memory's shape, the title channel's enforcement, and the fate of a few surfaces.

## 2. Goals, non-goals, anti-goals

Goals: Needs me and Now true without a session's help; a backlog that holds ideas with notes and a What and Why he can
read; fewer surfaces, each used; the Desktop title prefixes reliable.

Non-goals: a chat or answer path in the window; the unsupervised queue (designed for, not built); project memory
itself (its edge is drawn, its design is the other session's); any new subagent or command detail.

Anti-goals: another rule a session must remember; a lane or field that goes stale when a session forgets; a feature
that needs its own upkeep.

## 3. Evidence

From the morning spec (section 2 there), 133 sessions in the week to 2026-10-20:

- 117 turns ended by asking Aiden something in chat; 74 (63%) never became an ask, so they never reached Needs me.
- Of 105 asks, 87 were raised and cleared by the same session's scribe, 34 within 15 minutes: the ask table is a
  write-up of a chat exchange, not the channel.
- Finishing works: 130 of 131 `done` transitions came through the scribe; every DONE-titled session has its step done.
- 11 `active` steps have no live session on them (oldest 17.7 days); 7 open asks sit on ended sessions or archived
  projects.

Window usage, 14 days to 2026-10-20, from `window.*` events (`window.shown` fires only after a gap, so it undercounts
visits):

| Surface | Events | Note |
|---|---|---|
| Details opened | 46 | about 3 a day, spread over 30 steps: used, but Aiden says the content does not serve him |
| Backlog view opened | 35 | |
| View switches to Board / Project / Backlog / Done | 10 / 9 / 2 / 1 | the Project opens are likely #503's own checks; Aiden says he never uses it |
| Ask answered or cleared from the window | 4 | against 96 scribe clears |
| Steps added from the window | 8 | against 163 by the scribe |
| Marked done from the window | 1 | |

Title control: `mcp__ccd_session_mgmt__set_session_title` can rename any session by id from inside a session; a
hook cannot rename anything. The desktop writes `postTurnSummary` (`completed` / `blocked` / `review_ready`,
`status_detail`, `needs_action`), `turnWrapUp`, `isArchived` and `cliSessionId` to
`AppData/Roaming/Claude/claude-code-sessions/**/local_<uuid>.json`, which `open-desktop.ts` already reads.

The other session's one proposal so far: a computed Sync view (from `template-sync.mjs --check` and each project's
`.claude/shipwright.json`) and a Library of concept docs in git, flagged stale when their code moves. Not decided.

## 4. Job 1: the mirror

### 4.1 Waiting on Aiden, from hooks

New session fields: `waiting_kind` (`question` | `review` | `permission` | null), `waiting_text` (one line,
clipped), `waiting_source`, `waiting_since`.

Set at the end of a turn from, in precedence: the Notification `permission_prompt` (as `state = permission` today);
the turn box (`PostToolUse` on `mcp__ccd_turn__wrap_up` with `ask` or `blocked`); `AskUserQuestion` (`PreToolUse`
sets, `PostToolUse` clears, since it is answered in the turn); a `REVIEW` or `BLOCKED` title prefix read on Stop; the
desktop `postTurnSummary` as a backfill (4.4); a Stop whose `last_assistant_message` ends in `?`. Kind: `review` from
a REVIEW title or a `review_ready` summary, else `question`. Only the question's first line leaves the hook, as
`purposeOf` does for agent prompts.

Cleared by: the next real prompt (`last_prompt_at`, #522's signal), SessionEnd, the desktop archive (4.2), and
**Dismiss** on the tile (4.6). Not by the stale sweep: no hook fires while a session waits, so a waiting session counts
as live until one of those, however old `last_seen_at` is (my call; it changes `isLive`, the sweep and the Board).

Board: a live session with `waiting_kind` puts its focus step in Needs me with the text and Open session; a session
with no focus gets a session tile in Needs me. A scribe ask on the same step merges into that tile as its record. The
briefing's Needs you line names waiting sessions as it names permission waits today.

What #522 becomes: its `last_prompt_at` is the clear; its answered-in-chat mark stays for the durable asks that
remain (4.5); its every-prompt reminder narrows to those.

### 4.2 The desktop archive ends the session

Aiden archives a session when its run is over. Read the desktop file for every live tracked
session (by `cliSessionId`) on Stop and SessionEnd, and on a 60 s poll beside the transcript watcher's (the 6-hour
maintenance tick is too slow for this: my call); `isArchived: true` ends it: subagents and commands end, its queue entries
release, its driver clears, its open asks follow question 4 (until answered: they clear with the answer `session ended`). This retires most of the
`ended_open` and stale-ask noise in 3 above. Fail soft: an unreadable or unknown file does nothing and logs once.

### 4.3 Focus from the title

A session with no focus whose title leads with `#id` (after an optional prefix) on an open step of its project is
focused on it as a scribe `set_focus` would: it drives only when no live driver exists, never takes over. `(#id)` and
`#a/#b` titles do nothing. `claim` stays the briefed path; this is the fallback for the 8 of 84 worker sessions a
week that never set one.

### 4.4 Desktop backfill

On the same 60 s poll, a tracked session whose desktop file has a newer `postTurnSummary` than its last Stop gets
its waiting state from it: `blocked` with `needs_action` as the text, `review_ready` as a review. This covers hook
posts that timed out (hooks.log shows 750 ms timeouts and an unreachable server on 2026-10-19).

### 4.5 What stays a scribe brief

New steps with their What and Why; `done` with an outcome; a block on something other than Aiden; logs, resources,
handoffs, the state note; a **durable ask**: a wait that should outlive the turn or the session (a walkthrough he does
later, a decision for next week). In-turn asks and their `aN answered` clears leave the rules.

### 4.6 Park and Dismiss on Needs me

Every step tile in Needs me gets **Park…** beside Open session, the Backlog's Park form (reason required, where
optional). A parked step leaves Needs me and Now as parked steps do today; its asks are already hidden and come back on
unpark (`openAsks`, briefing.ts:174).

Every Needs me tile, step or session, gets **Dismiss** (ghost): it clears the session's waiting state until the next
turn end sets it again. No reason, no plan state: it is the escape from a wrong lane state the weaker sources (a
trailing `?`, a lingering prefix) can produce. A session tile (no focus) has Dismiss and Open session only.

### 4.7 The Now tile

One line per session: title, state word, and when something is running in the background, `running: <purpose or
command head>` from the live subagents and commands InProgress already holds. Not a list; one line, the newest. This
is the wasted-click answer inside InProgress; 4.8 is the answer inside the Desktop sidebar.

### 4.8 The title channel

The prefixes stay the channel Aiden reads. Five states: no prefix (working), `RUNNING` (the turn ended with a
background subagent or command still live), `REVIEW`, `BLOCKED`, `DONE`. Two ways to make them reliable, for
question 2:

Both work only in the desktop app, where the title exists; elsewhere the prefix is skipped as Sigmund does today.
B is more work than A: a synchronous Stop reply where the Stop hook returns nothing today, a project setting, and an
allow rule so `set_session_title` runs without a prompt. A is in both.

- **A. Detect and nudge.** On every prompt the briefing compares the title's prefix with InProgress's own view
  (waiting state, live background work, step done) and, when they disagree, prepends one line: "Your title says
  REVIEW; nothing waits on Aiden. Set it to …". No cost; the prefix is wrong for at most one turn.
- **B. Enforce at Stop.** When they disagree at Stop, the hook returns `decision: block` with that line as the reason;
  the session sets the title and stops again (`stop_hook_active` keeps it to one pass). Cost: one short model call
  whenever a prefix changes. Gain: the sidebar is right at every turn end, `RUNNING` included.

My recommendation: B, behind a project setting, with A as its fallback where B is off. A's line exists in both.

## 5. Job 2: the backlog, and What and Why

- **Notes on add.** The quick-add form (window `QuickAdd.tsx`, title only today) gets an optional notes field that
  writes the step's body. Enter on the title adds at once; Tab reaches the notes.
- **Origin.** `nodes.created_by`, set from the writer and backfilled from `node.created` events: `me` for the window.
  For a scribe write, the mechanical reading is `claude`, but most scribe-filed steps are work Aiden asked for in
  chat (163 scribe-filed against 8 window-filed in 14 days), and the ones he wants marked are Claude's own
  follow-ups. Question 9 decides whether a third value, `proposed`, set by the scribe brief, is worth the one extra
  word in the brief. Backlog rows and tiles show a small chip for whichever origin is the minority.
- **What and Why.** Two short fields on a step, `what` and `why`, written for Aiden: what this step implements, and
  why it is worth doing. The scribe's `add_nodes` and `update_node` take them; the briefing rule for a new step with a
  deliverable reads "a new step with one label, a What and a Why". An open, Claude-filed step created after the
  migration without both carries a `no_why` hygiene mark, which Mip's reconcile lists, so the gap is visible without
  a reminder; no backfill of the 160-odd existing steps (my call). The body stays Claude's own context.
- **Details, reordered for the reader.** Head; What; Why; status, label, origin; asks; outcome; resources (handoff
  first); children; then, folded, Claude's body, the log and live work as one line. The log and live work are trail,
  not the point.
- **Mip reads What and Why** when he proposes from the Backlog and when he presents follow-ups, so his "what is this
  and why" answer is the step's own fields.
- **Unsupervised flag.** Designed for, not built: `nodes.unattended` (default false), set only by Aiden from the
  window; a later step gives Mip a rule for it. Nothing in this spec depends on it.

## 6. Job 3: project memory

Out of this spec's scope; its edge is here so the two lines do not collide. InProgress's part is to hold and show
documents a session keeps current, with a stale mark when their source moves. The other session decides the shape
(a Sync view, a Library, or something else). Two constraints from this conversation for whoever designs it: a page is
derived from the repo by a session, never typed by Aiden; and a page that cannot be checked against its source for
staleness does not belong.

## 7. The trim

| Surface | Today | Proposal | Why |
|---|---|---|---|
| Project view | its own rail view: note, phase index, sections | **Cut.** The phase index with progress moves into the Board's page head as a folded row | 9 opens in 14 days, likely #503's own; the Board answers "where are we" |
| Orchestrator slab (state note, "No claimed step") on the Board | first thing on the Board | **Cut from the Board.** The note stays as Mip's memory, readable from Details of the root and the command bar | never read by Aiden; Mip reads it through the CLI |
| Orchestrator counts, `N to tidy` menu | on the slab | tidy marks move to the HUD `[ASKS]` neighbour as `[TIDY] n`, opening the same menu | keeps the one actionable piece |
| Answer… / Send on asks | Board and Details | **Cut.** Clear stays | 4 window answers in 14 days; the chat is the answer path |
| Live work in Details (tasks, subagents, commands, ended trail) | a full section | one `running:` line in the head, the rest folded under "Trail" | Aiden no longer wants the detail |
| Subagent count and command line on Now tiles | per session | the one `running:` line (4.7) | same |
| "Done…" with outcome on Now tiles | per tile | keep | one use, but it is the window's only way to close a step a session left |
| Queued by `<session>` own queues in Next | an Eyebrow per session | keep for now; revisit if Mip's queue is the only one used | not discussed |
| Details sections | 10, trail first | reordered (5) | |
| Done lane | newest 5, All done view | keep | |
| Command bar | Ctrl K | keep | |

## 8. Effect on work in flight

- **#502 Board in v3** (build): lands as specified. The redesign's Board changes (waiting tiles, Park… on Needs me,
  the `running:` line, the slab's removal, Answer's removal) come after it, as one trim step, so #502 is not thrashed.
  One ask to the #502 session now: leave Answer… unbuilt if it is not built yet (question 5).
- **#504 Backlog view** (review): lands as specified; the notes field and origin chip follow.
- **#503 Project view** (done): the view is cut by the trim step; the phase index part moves.
- **#505 Details** (done): reordered by phase 2.

## 9. Phases

1. **Truth** (integration; full strict gates for hooks and installer): 4.1, 4.2, 4.3, 4.4, 4.6's Dismiss, and the
   briefing rules of 4.5. A day of hook capture first, to confirm `wrap_up` reaches PostToolUse with its input, what
   Stop's `last_assistant_message` holds when the box has the question, and the current Notification matchers. If
   `wrap_up` does not reach PostToolUse, the transcript watcher (`agent-watch.ts`, 60 s) reads the turn's last
   `wrap_up` tool_use from the transcript tail instead: the transcript holds it (this morning's parse counted 82 of
   them that way). Phase 1 is not blocked on the hook.
2. **Backlog and What/Why** (data, then ui): the columns and scribe tools, the briefing rule, the quick-add notes
   field, the origin chip, Details reordered.
3. **Trim** (ui), after #502 and #504 land: section 7 and 4.6, 4.7 as one step.
4. **Title channel** (integration): 4.8, A first, then B behind the setting.
5. **Project memory**: its own line, from the other session.

## 10. Left to the builder

Column names and migration numbers; the exact clipping of `waiting_text`; where the folded phase index sits in the
page head; the `running:` line's choice when both a subagent and a command are live (newest wins); the `no_why` mark's
wording in reconcile; how the trim step removes the Project view's routes and tests.

## 11. Not in this spec

The unsupervised queue's rules; the documentation views; any change to Sigmund's phases beyond the title section and
the ask lines; multi-user anything.

## 12. Questions for Aiden

1. **Waiting clears on any reply.** A session leaves Needs me when you send it any prompt, even one about something
   else. Right, or should a reply that is not an answer keep it there?
2. **Title channel.** A (nudge on the next prompt, free, one turn late) or B (enforce at Stop, one extra short model
   call when a prefix changes, right at every turn end, `RUNNING` included)?
3. **Project view.** Cut it, with the phase index moving to the Board's head? Or is there a use you have not had yet
   (coming back to a project after months)?
4. **Stale asks.** When a session ends or you archive it, its open asks: clear as "session ended", stay until you
   Clear them, or move to the step's log?
5. **#502.** Ask that session now to leave Answer… out of the v3 Needs me?
6. **What and Why.** Required on every Claude-filed step (a hygiene mark until filled), or only on backlog items?
7. **Desktop archive ends the session.** Yes?
8. **Order.** Truth, then Backlog, then Trim, then Title channel. Agree, or Backlog first?
9. **Origin.** Is the mark "I typed it vs Claude filed it" (mechanical, but it marks almost nothing since Claude
   files what you ask for too), or "work I asked for vs a follow-up Claude proposed" (one word in the scribe brief,
   `proposed`, and the thing the later unsupervised flag would attach to)?

Where an answer is missing, the builder plans the first option named in each question.
