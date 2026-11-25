# The lead, stage 1: the desk answers

Date: 2026-11-25. Step #743. Status: waiting for Aiden's go. Nothing in this plan is built before it.

**Spec:** `docs/superpowers/specs/2026-11-22-the-lead-design.md`, section 11, row 1, with sections 5, 6.2, 9 and 10.
Its record: `2026-11-22-the-lead-design-record.md`. What stage 0 showed:
`~/.inprogress/resources/inprogress/2026-11-23-lead-stage-0-results.md` and its second check of 2026-11-25. Prototypes
to build from: `spikes/lead-stage0/` on branch `lead-plans` (never merged as product).

**Goal.** Two things come off Aiden's hands: sessions' questions, and sessions that stop. The lead answers at his
desk; what is Aiden's is held before it happens and brought to him prepared, on his phone through the Voice; his
answer, his "ship it" included, goes back to the session in his own words.

**Branch and worktree.** `lead-stage-1-desk` in `.claude/worktrees/lead-stage-1-desk`. Plan said `lead-stage-1`. Did
`lead-stage-1-desk`. Because that name is taken by a merged branch from the design of 2026-11-14.

## The scenes

What Aiden will be able to do when this stage is done. They map to design scenes 2, 7 (in part) and 12, plus the
Voice's part of row 1. Frozen once he says go. Done means each one shown working; the result says "4 of 6 scenes",
never "shipped".

**Scene 1. A session's question is answered while he is away** (design scene 2). The session on step #745 asks
"Should search match step ids as well as titles?" Aiden is not at the laptop. Inside 90 seconds the session's T3 Code
thread shows:

```
[From Progresser, the lead] d812: yes, match ids too, so typing 745 finds #745.
Why: the board already shows ids beside titles. Aiden can undo this with "undo d812".
```

The session carries on. Nothing reaches his phone. The next morning's list carries that one line.

**Scene 2. What is his reaches his phone, and his word goes back** (design scene 2, the other half; 5.4 and 6.2).
A session asks which of two names a button people will see should carry. Within five minutes the Voice messages his
phone:

```
Yours, InProgress: #745 Board search. The button says "Find" or "Search".
I would pick "Search": the window says it everywhere else. Say "search" or "find".
```

He says "search" to the Voice. The session's thread shows `Aiden's answer, carried by Progresser from Grok at 14:02:
"search"`. Later the #745 session's review waits on him. He says "show me 745"; the Voice passes the screenshot the
session attached. He says "ship it". The session lands the work through the landing check, and the next time he sits
down at the laptop it is in the working app. He said it once, to the Voice; nobody sends him to a thread to say it
again. The same works typed in the lead's thread in T3 Code.

**Scene 3. Something goes wrong overnight and is handled** (design scene 7, in part: a stop and a held action; a red
deploy and a conflict are stage 4). The laptop is on, Aiden is asleep. At 02:10 the #746 session stops with its step
open and no word. At 02:20 the lead asks it where the work stands. No answer by 02:50: he reads its thread and git,
writes a handoff and starts a fresh session, once. At 03:40 another session runs `npm publish` as its last step: it
is held before it runs, and told it waits for Aiden. The morning list says:

```
Went wrong (1)   #746 stopped at 02:10. Restarted from its record at 02:51; 41 minutes lost.
Held for you (1) #747 wants to publish package x 1.2.0 to npm. Say "publish it" or "not yet".
```

On a night the lid is shut instead, the list says what that held back: `The lid was shut 22:06 to 10:23. 3 items
waited; none was lost.` Nothing breaks when a night is missed.

**Scene 4. The morning list, and undo** (design 4.3, 5.3; the bare list of row 1). At the end of his quiet hours the
lead's thread in T3 Code gets one message and the Voice one line: `InProgress: 6 decided for you, 1 yours. Say "the
list".` Rulings on what the product does come first, each with the word that undoes it. He says "undo d812, ids are
noise": the answer is withdrawn, the session told, and his reason stored as a standing ruling the lead reads before
the next call of that kind. He asks "how is the week?":

```
The week: 41 percent used; the line says 44. This window: 12 percent, resets 19:30.
Your reserve is untouched. Last reading 6 minutes ago.
```

**Scene 5. The lead is off, and Grok is closed** (design scene 12, and row 1's "a day with Grok closed"). He says
"turn the round off" to the Voice or in the lead's thread. From then the project works as it does today: questions
wait for him in the window, nothing is answered, held or restarted by the lead, and the hooks pass every command as
they did before this stage. "Turn the round on": what waited is taken in order, oldest first. Separately, with Grok
closed for a day, the round answers, restarts and holds exactly the same; what was his shows as cards in the window,
and the lines that could not reach him are listed in the morning list as not delivered.

**Scene 6. The old asks, cleared with the Voice** (record, 2026-11-24; the first real use of the desk). He says "the
old asks" to the Voice. On InProgress the lead has already decided what his rule allows, each numbered and undone in
a word, and brings the rest. The other projects' asks come five at a time, each with the lead's reading from stage 0
and the words that answer it:

```
Glimpse, 1 of 7: #612 Login screen review, 19 days old.
The lead would close it: the step was done and merged on 3 November. Say "close" or "keep".
```

He answers in a word; each answer is recorded in his words. When the list is empty the Voice says so.

## Done when

From row 1, with the change Aiden made on 2026-11-25: "I will not be taking a week to verify the morning briefings.
We will continue to stage 2 when stage 1 is built and verified without a week-long trial."

**Before stage 2 starts:**

1. Each scene shown on a check surface with a copy of his data, and recorded. Scenes 1 to 5 shown once more on the
   live install after landing, with real T3 Code and the real Voice.
2. The exam, run again on cases the narrowed rule has not seen (task 16): the lead decides nothing that cannot be
   taken back. The other counts are reported as they fall.
3. No item acted on twice, read from the record: every desk item has at most one applied turn, and every outside
   action at most one result.
4. The round runs the same with the Voice unreachable: on the copy with the webhook pointed nowhere, and live with
   Grok closed for at least half a day.
5. Aiden has read every decision made so far and says which, if any, were his.
6. The results page has had its independent check (design 9), and says which results rest on a file and which on
   Aiden's word.

**Measured from landing, and reported with stage 2's result, not waited for.** Plan (design) said: over a week.
Did: counts that start at landing and run on. Because: Aiden's word above. These were the week's marks:

- every session's question answered or brought to him inside its limit, at least ten answered by the lead;
- what was his reached the Voice within five minutes, nine times in ten (the stamp of task 11). That his phone then
  buzzed rests on his word: InProgress cannot see his phone;
- the same count for lines sent while the laptop was awake and nobody had typed for two hours or more, which is the
  sample stage 0 never took. If those drop, the connector returns to the plan (design 6.2, link 1).

## What stage 0 settled, and where it goes here

| Finding | Task |
|---|---|
| The rule is `lead-wide-v2.md`; one in four of his decisions differs from Aiden's in a way that matters | 5, 10, 16 |
| Give the lead his commands as tools, with no shell; act under a key that cannot repeat; bind every command to one home | 3, 4 |
| The way a turn runs must be swappable; the fallback is a turn inside the lead's T3 Code thread | 4, 12 |
| An unknown start leaves a claimed step and a session with no first message: say who clears it | 8 |
| T3 Code's thread start may take a retry key | 8 |
| Held before the act needs a hook before every shell command; full access shows no prompt | 7 |
| The landing check judges the action as well as the change | 6 |
| A pause kills the running command | 9: the lead never pauses in stage 1; restarts only after a stop |
| Usage: two gauges, a third for Fable, from every turn; a window is a tenth of the week (Aiden's word) | 13 |
| The Voice carries his go-ahead; today `lead answer` refuses a review or a permission | 11 |
| Reaching his phone is the Voice's message; T3 Code's notification is the fallback | 11 |
| The connector is not in stage 1 | Above, "Measured from landing" |
| The lead works whenever the laptop is on, nights included; a missed night breaks nothing | 4, 10, 14 |
| Pictures: copied into `~/.inprogress/resources/<project>/`; a picture's stored text is useless | 15 |
| The seven things done by hand in P6: nothing hands a session's report to the lead (stage 3), the lead could not carry a go-ahead (here) | 11 |
| Baseline 1.55 things reached Aiden per closed step; target 0.78 by the end of stage 3 | 13 counts what reached him from landing |

**Not done in stage 0, and where each goes:**

| Not done | Where |
|---|---|
| A go-ahead carried by the Voice | Here: task 11, scene 2 |
| The phone: answering in a session's own thread, saying "tweak", picking between two mocks | Stage 3, whose scenes 5 and 6 are those acts |
| The phone day of design 6.4 | Stage 3's first demonstration, which is run from the phone |
| A count of the pings; an awake laptop left alone | Here, measured from landing (above) |
| The Grok errand, and Grok's usage | Stage 6 only |
| The old asks | Here: scene 6, task 17 |

## How it works

The calls in this section are Sigmund's, named here so any of them can be undone with a word.

1. **The turn proposes; plain code disposes.** A desk turn reads through tools and answers in four lines (DECIDE,
   AIDEN or CARD, as `lead-wide-v2.md` asks). It changes nothing itself. The runner applies the answer in one
   database write under the item's key, so a retry, a restart or a second turn cannot act on an item twice. This is
   P1's shape, made product.
2. **His tools are read-only and served by InProgress, with no shell.** One small tool server (MCP, stdio) per turn,
   started by the runner with the server's own home and port fixed in its environment: desk, step, search, resource,
   brief, and three git facts (is a branch merged, the size of a change, does a branch exist). Nothing else is
   allowed, so the turn that reached for Aiden's transcripts in P1 has nothing to reach with.
3. **Every action that leaves InProgress is written down before it happens**, with an id that travels with it:
   starting a session, a message to a thread, a line to the Voice. This generalises the single-start guard that
   `src/server/lead-start.ts` already has.
4. **Decisions keep their numbers.** Today `lead decide` numbers a decision by its `lead_events` row (`d812`), and
   `lead undo` finds it there. The new decisions table holds one row beside each such event, with what the event
   cannot hold: the kind, whether it rules on what the product does, the item and turn it came from, and for what
   was brought to Aiden, the lead's would-have beside Aiden's answer. "undo d41" works for old and new alike.
5. **The round's switch is a row, like Starts and Landing.** `lead allow inprogress round` and `lead disallow
   inprogress round`, stored in `lead_events` as those two are. No column.
6. **The desk is on for InProgress only in this stage.** Design stage 7 gives the next project its desk, and a lead
   never acts on another project. So on the other four projects with old asks, the lead's stage 0 reading is brought
   to Aiden as a recommendation, and his word clears each (scene 6). Plan (handoff) said the lead decides what his
   rule allows. Did: that on InProgress; on the others, his word. Because: one lead per project. To undo: Aiden says
   "desks for all", and the round is switched on for those four in this stage.
7. **The Voice and the lead's thread act; only the desk judges** (design 6.2). Both follow one rule text (version 7
   of Progresser's rules). "You decide" said to either becomes a desk item, not a call the Voice makes.
8. **The lead's thread is new each morning.** The morning list starts the day's thread in T3 Code, so it never fills
   and needs no renewal logic (design 5.5). Aiden answers in today's thread.
9. **What is his is held by the action, not the place.** A hook runs before every shell command of every session.
   It tests the command against a short list in plain code (publish, push, deploy, merge into main, create or change
   a repository on his account, delete under the live home, plus any lines the project's playbook adds under
   "Held:"). An ordinary command never reaches the server, so it costs nothing. A command on the list asks the
   landing check; held, the session is told it waits for Aiden, and the desk gets a held item. With InProgress down,
   a command on the list is held; nothing else is touched.
10. **A yes covers the change, not a commit id.** His go-ahead is stored with the action and the change's patch id
    (`git patch-id` of the branch's diff against main). Merging main into the branch does not void it; a change to
    the work itself does, and a change that newly touches the risk list holds again (design 5.4).
11. **Quiet hours default to midnight to 09:00**, from his hours in stage 0 (P10a: before 09:00 he is almost never
    there). Lines held in them go out at 09:00 in the morning list. Changed with a word to the Voice ("quiet hours
    23 to 8").
12. **Desk turns always run; the lead's own starts respect the reserve.** A turn answers a session that is waiting,
    which is Aiden's own work, and costs 6 to 50 cents at list price. A restart is the lead's own work: it does not
    happen past 95 percent of the week, with under 30 percent of the window free while Aiden is at work (a prompt of
    his in the last 30 minutes), past 85 percent of a window, or on a reading older than an hour.

## What changes in the database

One migration, the 21st. It only adds tables, so `min_reader_version` stays 1 and a rollback across it works. It is
proved on a copy of the live database with a backup taken before landing.

| Table | One row per | Columns |
|---|---|---|
| `desk_items` | Thing the lead must deal with | id, project_id, kind (question, permission, stopped, stuck, held, unknown_send, aiden_said, old_ask, promise_due), ref (the ask, session or send it is about), node_id, created_at, due_at (its limit), state (open, leased, done, behind, waiting_aiden), done_at, outcome; unique on (kind, ref) while open, so one thing is never queued twice |
| `lead_turns` | Turn of the lead | id, item_id, project_id, way (headless, thread), model, leased_at, lease_until, started_at, finished_at, state (leased, answered, applied, failed, abandoned), verdict, answer, why, kind, cost_usd, duration_ms, tokens_in, tokens_out, refused_tools; applied once, under a unique index on item_id where state is applied |
| `lead_decisions` | Decision, beside its `lead_events` row | event_id (unique), project_id, item_id, turn_id, kind (product, technical, order, permission, restart, old_ask), product_ruling (0 or 1), line (the one line the list shows), would_have, aiden_answer, aiden_words, said_where (desk, voice, thread), said_at, shown_at |
| `lead_sends` | Action that leaves InProgress | id (written first), project_id, item_id, kind (start, relay, voice_line, carry, morning), target (thread or webhook), retry_key, state (intended, done, unknown, cleared), result (thread or message id), created_at, done_at, seen_at (the Voice's stamp) |
| `usage_readings` | Reading of the plan's gauges | id, at, source (turn, probe, import), turn_id, model, window_used, window_resets, week_used, week_resets, other (JSON: any further gauge, such as Fable's) |

Plan (design 14) said four new tables. Did five: `lead_sends` is new. Because the id written before each outside
action needs a home of its own: one turn can make several, and a go-ahead carried by the Voice makes one with no turn
at all. Still a new table, nothing rewritten.

The quiet hours, the morning time and the Voice's daily cap are stored as `lead_events` rows like the switches. The
Voice's webhook address and key go in a file under the live home that only the server reads, never printed; Aiden
gives them once through a secret card at landing.

## What lands on Aiden's word

His go on this plan starts the build. It does not land anything. The landing waits for scenes 1 to 6 on the copy,
Murr's verdicts and his look, then his "ship it" for these, each on the risk list:

1. **The migration** that adds the five tables.
2. **The hooks**: the hold before every shell command (PreToolUse on Bash and PowerShell), and the answer to a
   permission prompt (PermissionRequest), registered by `src/cli/claude-config.ts`; then `claude:install`.
3. **The change to the guard on his go-ahead**: `lead answer` stops refusing a review or a permission when it carries
   his words, on his word of 2026-11-23: "when I said, ship it to the Grok Bot, he will let the session know and it
   would be in the working app the next time I sit down on my laptop".
4. **The briefing's Landing and Lead lines** (`src/server/briefing.ts`): every session is told to ask the landing
   check before it merges, deploys or pushes, and that "Aiden's answer, carried by Progresser" is his go-ahead while
   "[From Progresser, the lead" never is.
5. **Attaching a picture** (`add_resource` in `src/mcp/`): the copy into the project's documents folder.
6. **Progresser's rules, version 7.** A lead on version 6 is refused every write until he reruns his rules; stage 0
   showed Progresser does that by himself.

## The tasks

Built by Sev from this plan, task by task, in this worktree. Sev on Opus for tasks 1, 4, 7 and 8 (transactions,
races between writers, hook ordering: the hard-ordering list). Murr on Opus for every diff on the risk list. Parvati
on task 14's window group. Each task ends with `npm run typecheck` and `npm test` green, rerun by Sigmund. Ports for
any server: 4420 to 4429. Tests never touch the live home, never start a real T3 Code thread and never post to the
real webhook: a stand-in T3 (P2's `stub-t3.mjs`, made a test helper) and a local receiver stand in.

### 1. The tables

The migration above, in `src/server/db/schema.ts`, and a repo module per table under `src/server/repo/`.

Done when: a fresh home has the five tables; a copy of today's live database migrates and every existing count is
unchanged; the build from main before this one opens the migrated copy and reads and writes it.

### 2. The desk and its items

`src/server/lead/desk.ts`. Producers, each in the write that causes it:

- a session raises a question or a permission ask on a step of a project whose round is on: a `question` or
  `permission` item, due in 3 minutes, and the runner is woken at once;
- the minute check (`src/server/main.ts`, the existing 60-second watch): a session whose step is open, with no open
  ask and no live background work, that last stopped more than 10 minutes ago: a `stopped` item;
- the hooks of task 7: `held` and `stuck` items;
- Aiden's words through the Voice or the lead's thread that leave a call open ("you decide"): an `aiden_said` item;
- a promise of the lead's past due; a send marked unknown (task 8).

Done when: each producer makes exactly one item for one cause, however often it fires; an item on a project whose
round is off is not made; `lead desk inprogress` lists open items oldest first with their limits.

### 3. The lead's tools

`src/server/lead/tools.ts` and `inprogress lead-tools <slug>`: an MCP server over stdio with the read tools of "How
it works", 2. It takes the home and port from its environment and refuses to start without both; it never starts a
server of its own (P1 found a command that finds no server starts one).

Done when: a turn given only these tools can answer P1's 50 items; a turn asked to read a file outside them has
nothing to call; with the server stopped, the tools answer "InProgress is not answering" and start nothing.

### 4. The turn runner

`src/server/lead/runner.ts`, with a `TurnWay` interface and two ways:

- **headless** (the default): `claude -p` on Opus 5.5 in the lead's own folder (`~/.inprogress/lead/<slug>/`), with
  `--setting-sources project`, `--strict-mcp-config` naming only task 3's server, no Bash, a system prompt file built
  from `lead-wide-v2.md` and the project's standing rulings, `--output-format stream-json`, and the session variables
  unset as in P1's `turn.sh`;
- **thread**: the item sent to the day's lead thread in T3 Code and its four-line answer read back (task 12).

Each item: a lease written in one write (turn row, item to leased, lease for 6 minutes), the turn run, its answer
saved, then applied (task 5) in a second write keyed on the item. After a restart: a lease whose turn saved an answer
is applied without running again; a lease with no answer past its time goes back to open; after two failures the
item shows under "The lead is behind" (design 5.4, last row). Every turn records its cost, time and tokens, and every
`rate_limit_event` in its stream becomes a usage reading. A turn that has not answered by its item's limit marks the
item behind. Separate places: at most two reflex turns at once per project, and old asks one at a time beside them.

Done when: P1's run repeated through the product on a copy (50 real items, one turn each, each applied once, the
live record unchanged); the server killed mid-turn and restarted: the item applied once and its turn not rerun;
two runners on one item: one applies, the other finds it taken; the way switched to thread on one item (task 12)
gives the same kind of answer.

### 5. What a verdict does

`src/server/lead/apply.ts`:

- **DECIDE**: the decision recorded as `lead decide` records it today (an event and its d-number) plus its decisions
  row; the ask answered; the answer sent to the session's thread marked as the lead's ruling, with the word that
  undoes it.
- **AIDEN**: the ask kept for him, prepared: what it is, what the lead found, what he would do, the words that accept
  it, his would-have recorded first (design 4.3). Context scaled to how fresh the step is for Aiden (design 6). The
  session is told at once that it is Aiden's and to carry on with what does not depend on it, or stop. Counted
  against five open per project (fixed): past five, the item waits and the one that blocks the most is brought. A
  card in the window, and a line to the Voice (task 11).
- **CARD**: the landing check run (task 6) and its verdict given to the session as the answer.

Product rulings are marked by the turn (its KIND line gains PRODUCT or TECHNICAL for a decision) and shown first in
the list. The two commits left on `lead-first-run` belong here and are brought across: the brief names the switch a
line turned on and never prints "#null" (2922a4a), and the open-decision limit counts per project (plan d392eec).

Done when: one question of each verdict on a copy gives the session the right message once; a sixth open decision
for Aiden waits and is brought when one clears; the decision shows in `lead brief` with its undo word.

### 6. The landing check

`src/core/landing.ts` and `inprogress landing <step> --action merge|deploy|push|publish|push-public`, from P3's
`landing-check.mjs`: it reads git itself (the change's size, its files against the project's risk list) and the
action. Publish, and a push to a public place (the remote's visibility read once with `gh` and cached), are Aiden's
whatever the change. The risk list is the one the project's playbook holds today. A yes of Aiden's clears only the
action and the patch id it was given for. Answers "Clear to land" or "hold: this is Aiden's (<why>)" in seconds, with
no model. The tweak lane waits for stage 2: every change is standard here.

Done when: P3's twelve cases pass in the product's tests, plus a yes surviving a merge of main into the branch and
falling when the work itself changes.

### 7. Held before the act

`src/hooks/hold.ts`, registered for PreToolUse on Bash and PowerShell, and `src/hooks/permission.ts` for
PermissionRequest, both through `HOOK_DEFS`:

- **hold**: the command tested in the hook itself against the list of "How it works", 9. No match: the hook says
  nothing and exits, and the server is not asked. A match: it asks `/api/lead/<project>/hold` with the command,
  folder and session; InProgress names the action and its range (a merge: main against the branch; a deploy: the
  live build against main; a push: the remote's branch against the local one) and runs the landing check. Clear: the
  command runs. Held: refused with "Held for Aiden before it runs: <what it does>. It waits for his word. Do not retry
  it and do not try another way." and a `held` item. InProgress not answering: held. A project whose round is off,
  or with no lead: the hook says nothing, as today.
- **permission**: a prompt that the hold list matches is refused the same way. Any other prompt becomes a `stuck`
  item; the hook waits up to 170 seconds for the lead's verdict (its timeout set to 180) and answers allow or deny
  with his reason. No verdict in time: the hook says nothing, the prompt shows as it does today, and the item stays.

Done when: P3's publish test passes through the installed hook in the ordinary mode and in full access; `npm run
deploy` from the main checkout is clear for a change off the risk list and held for one on it without Aiden's yes,
then clear with it; P8's nine prompts answered through the product; an ordinary command's time through the hook
under 50 milliseconds; the smoke test and the installer's strict gates green.

### 8. A start happens once

`src/server/lead/sends.ts`, used by `lead start`, `lead relay`, the Voice's lines and the carried go-ahead.

- The send row is written (intended) before the action and marked done with its result after.
- First, on one scratch T3 Code thread deleted afterwards, as in P8: does `t3 thread start` take a retry key, and
  does a second start with the same key return the same thread? If yes, the send id is that key. If not, the send id
  goes in the thread's title and recovery finds it with `t3 thread list`.
- Recovery, in the minute check: an intended send with no result is looked up by its key; found, it is marked done;
  T3 Code down, it waits; T3 Code up and not found after two looks, it is marked unknown and becomes an
  `unknown_send` item.
- **Who clears an unknown start** (P2's case C): the lead, at the desk. His turn reads the step, `t3 thread list` for
  threads started in the minute of the send, and the thread's messages. Found with no first message: the first
  message is sent, as a send of its own whose text carries its id, so it is never sent twice. Found with it: the
  start is recorded. Not found: the claim is released and the step can be started again. Cannot tell: it is
  Aiden's, shown in the window with what is known, and nothing is retried.

Done when: P2's six cases pass in the product's tests against the stand-in, case C ending as one session with one
first message; the retry-key question answered on real T3 Code with the thread deleted.

### 9. Stopped and stuck sessions

The design's rows for both (5.4), on the desk:

- **Stopped**: the lead's turn sends the session one message ("Where does the work on #746 stand? Reply in one line,
  then carry on."). Thirty minutes with no reply: a second turn reads its thread and git and answers RESTART (a fresh
  session from a handoff the turn writes onto the step, started once by task 8), PARK (with the cause), or DONE
  (the work is merged: told in the morning list, for stage 3's hand-in to settle later). Two restarts on one step,
  then he parks it with what was tried. Restarts count against three starts a day and the reserve ("How it works",
  12).
- **Stuck**: task 7's permission item, judged by the rule's "by what it will do".
- The lead never pauses a running session in this stage; a pause kills its running command (P8).

Done when: on a copy with the stand-in T3, a session left stopped is asked once, restarted once after 30 minutes with
a handoff that names its branch and worktree, and appears in the next morning list; a stopped session that answers
is left alone.

### 10. Numbered decisions, the morning list and undo

`src/server/lead/morning.ts`, plain code, no model. At the end of quiet hours, or at the first wake after it when the
laptop slept, one list per project with a lead:

```
InProgress · Thursday 26 November · since Wednesday 09:00
Yours (1)            #745 Board search: "Find" or "Search". I would pick "Search". Say "search" or "find".
Decided for you (6)  Product rulings first:
                     d812 #745 Board search: search matches step ids as well as titles. "undo d812"
                     ...
Held for you (1)     #747 wants to publish package x 1.2.0. Say "publish it" or "not yet".
Went wrong (1)       #746 stopped at 02:10; restarted at 02:51.
The lead             14 calls, median 70 s, slowest 2 min 50, none late.
Not delivered (0)
The week             41 percent used, the line says 44. Window 12 percent.
```

A part with nothing in it is left out; a day with nothing has no list. A night with the lid shut adds one line on
what waited. It starts the day's lead thread (task 12) and sends one line to the Voice. `lead undo` keeps its
behaviour and, for a decision answered at the desk, tells the session the answer is withdrawn and the question is
Aiden's again; his reason, when he gives one, is stored under Standing rulings.

Done when: after a night on a copy, the list holds every decision of that night with its undo word, product rulings
first; "undo d<n>" withdraws it once and the session is told once; a missed night gives one list, not two.

### 11. The Voice

- **Out.** `src/server/lead/voice.ts`. What is Aiden's leaves twice: a card in the window and one line to the
  Voice's routine by its webhook (P9's `pinger.cjs`, made product, as a send). Gathered for three minutes and sent as
  one message; at most twelve a day; held in quiet hours. Every line carries its send id. The routine's instruction
  (changed by Aiden once, as in P9) passes lines on word for word and, for the count only, stamps it with `lead seen
  inprogress <id>`. The round never waits on the stamp.
- **In.** Progresser's rules, version 7 (`src/core/lead-rules.ts`): he reads the desk (`lead desk`), acts on Aiden's
  word (answer, undo, start, park, turn the round on or off, quiet hours, "how is the week") and judges nothing: the
  commands that decide on his own judgement leave his rules, and "you decide" goes to the desk. He may carry Aiden's
  answer on an old ask of any personal project, never one under `C:\work` (scene 6). Rule 6 becomes: "You carry
  Aiden's answer, a go-ahead included, in his exact words. You never give your own."
- **The guard.** `lead answer` (`src/server/lead-commands.ts:87`) accepts a review or a permission when it carries his
  words. It records his sentence, when, where (voice or thread) and what he had been shown, and the action and patch
  id the yes covers. The answer reaches a T3 Code session as a message in its thread: `Aiden's answer, carried by
  Progresser from Grok at 14:02: "ship it"`.
- **Pictures** pass as in stage 0 (version 6), from the project's documents folder (task 15).

Done when: on a copy with a local receiver, an AIDEN verdict gives one card and one line inside five minutes; a
quiet-hours line goes at 09:00; "ship it" carried for a review makes the session's landing clear for that change and
not for a later one that touches the risk list. Then live after landing, with Aiden: scene 2 once, start to finish.

### 12. The lead's thread in T3 Code

A T3 Code project for the lead's folder (`~/.inprogress/lead/inprogress/`), outside every repo, created once on
landing. Each morning list starts the day's thread (a send), on Opus 5.5, whose first instruction is the
version 7 rules. Aiden's words there act exactly as to the Voice. The hooks treat the lead's folder as the lead's:
no briefing, no tracking. The thread is also the second way to run a turn (task 4).

Done when: a scratch thread, deleted afterwards, answers "the list", "undo d<n>" and "how is the week?" from a copy's
record, and runs one desk item by the thread way.

### 13. The week's usage, the reserve, the counts

- A reading from every turn (task 4); a probe on the smallest model when nothing has been read for an hour (P10a's
  `gauge.cjs`, made product); the hourly readings of stage 0 imported once
  (`2026-11-25-usage-gauge-readings.jsonl`).
- `lead week <slug>`: the week used, the line (the share of the week gone), the window and its reset, whether
  Aiden's reserve is touched, and the age of the last reading. Every gauge the plan reports, Fable's included.
- The reserve as "How it works", 12. The pacer's modes wait for stage 4.
- Counted from landing: what reached Aiden, per step closed, against stage 0's 1.55.

Done when: a turn's reading appears within a minute of it; "how is the week?" answers from the newest reading; with
a reading older than an hour, a restart waits and says why.

### 14. The switch, and "The lead is behind"

- `lead allow|disallow <slug> round`, by Aiden's word through the Voice or the thread, or in the window. Off: no new
  items, no turns, the hooks silent, sessions' questions wait for Aiden as today, and a turn in flight finishes the
  write it is in and stops (design 5.7). On: what waited is taken oldest first.
- In the window, under the project's asks: a group "The lead is behind" listing every item past its limit, with
  what it is and what Aiden can do with it himself. A group inside a pattern he has passed, so no mocks.

Done when: scene 5 on a copy; an item past its limit appears in the group within a minute and leaves it when
handled (Parvati, at the window's sizes).

### 15. Pictures with one home

Attaching a picture to a step copies its file into `~/.inprogress/resources/<project>/` and points the document
there, wherever it came from; its stored text is left empty and `lead resource` prints its file. Rows already
stored stay as they are (nothing is rewritten).

Done when: a PNG attached from the repo and one from T3 Code's attachments each land in the documents folder, and
`lead step` names the copied file.

### 16. The exam, on cases the rule has not seen

Before landing, on a copy: every answered review not among the 40 the first exam drew, and every ask answered since
2026-11-21 that is not among the 121, split by a fixed seed into two halves. The first half is the exam now; the
second is kept back for any rerun after a narrowing. Each case run through task 4's runner (blind, record cut off at
the ask), labelled by two judges as in stage 0, with the fourth label "landing". No past questions are left unseen;
the questions of stage 1 are scored live, by Aiden's read of the decisions (done when, 5).

Done when: the lead decides nothing that cannot be taken back. If he does, the rule is narrowed and the kept half is
run. Reached Aiden, needless asks, taste and direction missed, and differing in a way that matters are reported on
lines of their own.

### 17. The old asks, through the desk and the Voice

After landing, the first real use (scene 6). InProgress's six go on the desk as `old_ask` items. The other 35 are
brought by the Voice five at a time, in the order of the stage 0 list
(`2026-11-23-lead-stage-0-old-asks.md`), re-read against today's record first, since some have moved. Each answer is
recorded in his words; one he leaves open goes to the desk of its project if it has one, or stays his.

Done when: every one of the 41 is answered, decided or waived, and each lead decision on them has its undo word.

### 18. The results page, and its check

`~/.inprogress/resources/inprogress/<date>-lead-stage-1-results.md`: each scene shown, not shown or differs; the
recording; the deviation log as it happened; every result marked as resting on a file or on Aiden's word; "what I
would ask if I were you". Then a reviewer who did not build it gets the scenes and the running build and answers per
scene; its report reaches Aiden unedited.

## The order

Tasks 1 to 3, then 4 and 5 together, then 6 and 7, then 8 and 9, then 10 to 15, then 16. The scenes on the copy,
recorded. Murr per diff, Parvati on 14. Aiden's look and his word on the six things that land on it. Landing:
merge, `npm run deploy`, `claude:install`, push. Then the webhook address and key by secret card, Progresser's
routine instruction changed once by Aiden, the round switched on, scenes 1 to 5 live, and task 17. The results page
and its check close the stage.

## What it costs

Each desk turn is 6 to 10 cents at list price on the record alone, 35 to 50 when it reads a thread and code (design
13). At 20 to 40 items a day that is 2 to 10 dollars a day, about one to two points of the week at stage 0's rough
figure of 5 to 7 dollars a point. The morning list, the Voice's lines and the landing check use no model. The build
itself is the larger cost: roughly ten Sev runs, four of them on Opus, and Murr on Opus for most diffs.

## What I would ask if I were you

1. **One in four of his own decisions will go against what you would have chosen.** Nothing here prevents it. Every
   one is a line in the morning list, product rulings first, undone in a word, and the undo becomes a rule he reads
   next time.
2. **The hook touches every session of every project with a lead.** In this stage that is InProgress only. It is fast
   for ordinary commands and holds a publish, a push or a deploy unless the landing check clears it. If it misfires,
   the round's switch turns it off in a word.
3. **Your "ship it" to the Voice lands work for real from this stage.** It covers the change you were shown, by its
   content. A change that grows onto the risk list afterwards comes back to you.
