# The lead: the record behind the design

Date: 2026-11-22. Companion to `2026-11-22-the-lead-design.md`. It holds what the design rests on: Aiden's decisions
in his words, the calls Sigmund made for him, the numbers, a table showing where each thing he asked for lives, and
how to carry on if this conversation is gone. Step #736, branch `lead-plans`, worktree `.claude/worktrees/lead-plans`.

## 1. How to carry on from here

1. Aiden approves the design (the open review ask on #736), or corrects it.
2. On approval, each stage in section 11 of the design becomes a step in InProgress, and stage 0's build plan is
   written from the design alone, opening with its scenes (design section 9). Plans go in `docs/superpowers/plans/`.
3. Nothing is built on the lead before that. The hold recorded on #736 on 2026-11-17 stands until he says go.

Files:

| File | What it is |
|---|---|
| `docs/superpowers/specs/2026-11-22-the-lead-design.md` | The design. Build from this. |
| `docs/superpowers/specs/2026-11-22-the-lead-design-record.md` | This file |
| `docs/superpowers/specs/2026-11-21-the-lead-what-he-is.md` | History: part one, with the first worked examples, the phone table and the 19 weaknesses (section 14) |
| `docs/superpowers/specs/2026-11-22-the-lead-steward-lanes-and-proof.md` | History: part two, with the reasoning for the steward, the lanes and the build controls |
| `docs/superpowers/specs/2026-11-21-the-lead-plan-c-desk-and-voice.md` | History: the chosen plan as first written, with the replay of the evening of 2026-11-16 |
| `docs/superpowers/specs/2026-11-21-the-lead-plan-a-grok-holds-the-keys.md`, `...-plan-b-the-desk.md` | History: the two plans not chosen |
| `docs/superpowers/specs/2026-11-14-project-lead-design.md` | The earlier approved design. Where it differs, the new design is the newer word. |
| `~/.inprogress/resources/inprogress/2026-11-21-lead-spikes-and-baseline.md` | Every number below with how it was made, and the vendors' pages on the phone |
| `~/.inprogress/resources/inprogress/2026-11-21-aiden-on-what-the-lead-is.md` | Aiden's notes of 2026-11-21, word for word |
| `~/.inprogress/resources/inprogress/2026-11-22-lead-design-critiques.md` | The three Opus 5.5 critiques of the first draft: 27 findings, each with its section, its fix and Sigmund's view |

The design was revised on the evening of 2026-11-22 from those critiques and Aiden's reply to them. The first draft
is commit 61c57d1 on `lead-plans`. Section 7 of this file says what was done with each finding.

Left on another branch, unmerged: `lead-first-run` (worktree `.claude/worktrees/lead-brief`). Commit 2922a4a makes the
brief name a switch and never print "#null". Commit d392eec is a build plan for counting the open-decision limit per
project, which Aiden has since confirmed. Both belong in stage 1.

Rules for whoever builds this:

- `~/.inprogress` and the live window cannot be recovered. Never start a branch build against the live home, and
  never verify on ports 4317 or 4399. A check surface runs on a copy of the data.
- Work only in a worktree under `.claude/worktrees/`; the main checkout takes only merges, deploys and
  `claude:install`. No em dashes in any file. Change work runs through Sigmund.
- Never start a real T3 Code thread or run a real `lead start` in a test: a stub stands in.
- Work repos under `C:\work` are never read, opened or acted on by a lead or the voice.
- Design section 9 binds every stage: scenes first, a deviation log, a check by someone who did not build it, a
  result Aiden can look at in two minutes, one unchecked stage at most.
- Design and build calls are made by Sigmund and named afterwards, never brought to Aiden as questions. What reaches
  him is taste, direction and what cannot be taken back (design section 1).

## 2. Aiden's decisions, in his words

| Date | His words | What it settles |
|---|---|---|
| 2026-11-14 | "It's fine that work repos are in reach of the Bots, they just shouldn't touch them." | Work projects never get a lead |
| 2026-11-16 | "I don't want his recommendations to be thin. The point of using an AI lead is so that he can figure things out." "The lead is supposed to know more than me." | The lead finds out before he recommends |
| 2026-11-16 | "Someone I talk to and trust to make all sorts of judgement calls in my stead. I get asked too many questions by AI ... I need the AI to act for me, only keeping important make or break questions for me." | The goal |
| 2026-11-16 | "Turn on the switches" | Starts and Landing are on for InProgress |
| 2026-11-17 | "I don't want to just tack on the 'session loop' - it's supposed to be engrained in what the AI Lead is, not an after thought." | The round is the lead's job (design section 5) |
| 2026-11-21 | "I need to be that guys boss." "As the Lead, they should have a backbone and a brain." "Right now ... it's a proxy between me and InProgress, but I want the lead to have more control over InProgress." | The role (sections 1, 4.5) |
| 2026-11-21 | "Claude sessions ... in charge of making sure their work is implemented well, but the Lead is in charge of making sure that the task criteria was written well. Claude sessions will claim their work is complete, but the Lead confirms before closing ... Claude sessions will ask to create new InProgress tasks, but the Lead is the one that reviews them." | The gates (section 2) |
| 2026-11-21 | "When I step away from a project for a month, in the middle of setting up services across multiple platforms, it will be the Lead ... that knows where we were, how to pick back up, what's next." | The book and its front page (4.1) |
| 2026-11-21 | "If a task requires Mocks, it should say so on the task." "UI changes/implementations without Mocks: Claude session drives to completion." "DB changes: can be actioned/managed by Lead." "Tasks need a definition of done." | Needs Aiden, the lanes, rulings 1 and 2 |
| 2026-11-21 | "I won't be greenlighting code or AI-native changes until I understanding what we are doing, why we are doing it, how it will be done, and what exactly the outcome looks like." | Scenes before every build (9, 10) |
| 2026-11-22 | "I will expect that the back and forth between the lead and the session does not allow the session's cache to expire." | The speed limits (5.2) |
| 2026-11-22 | "If ... I can just go straight to the lead, tell it, it write the DoD, then it set the task for action, that would suffice." | A new idea (2.1) |
| 2026-11-22 | "I think we need a well implemented re-open option for tasks that have been closed but have little tweaks post-merge." | Reopen (2.4) |
| 2026-11-22 | "I'd argue it should be 5 per" project | Five open decisions per project |
| 2026-11-22 | "See. Yes to a connector. Yes we can set a recommended limit across all projects though it should be exceedable. Change the rulings for 1 to 4, 6, and 7." | Plan C ("See" read as C, and told so); the connector; the limit across projects; the changed rulings |
| 2026-11-22 | "I feel like a Weekly review isn't enough ... Fix that." | The steward (4) |
| 2026-11-22 | "We should proactively plan for how to handle different work differently such that small trivial work doesn't cost 10x the time and tokens." | The lanes (3) |
| 2026-11-22 | "Do what you want to do - plan how you would better plan the implementation based on real data you can compile and collect." | The data pass, the backtest, the exam (10) |
| 2026-11-22 | "My idea was having a well-written plan document to start, monitoring development more closely and asking questions when I have them. I took my eyes off the project in the other instances and allowed you to go off track." | Keeping the build honest (9) |
| 2026-11-22 | "Adding another layer for the Lead to critique and dive in would create doubled-work. Maybe the session can include a list of the known risks/limitations and the Lead can judge can sign-off or action items for that list." | The Out gate (2.3) |
| 2026-11-22 | "We need to do what we can to ensure that we know what we are building and that it accomplishes what our goal." | The scenes and the exam (10, 11) |
| 2026-11-22 | "This all sounds good to me. Note that Opus 5.5 should be used anywhere that it would offer real benefits." | Part two accepted; the models (8) |
| 2026-11-22 | "It must be well-defined to include all of what we have talked about implementing. I don't want the writing of the plan to be endangered by context-window/compaction." | The design and this file |
| 2026-11-22 | "I'd rather skip the Read-only and shadow-mode trial. If it's read-only, I won't use it. Instead of shadow mode, I'd rather it make decisions and air on the side of asking me if unsure what I'd choose. That way it can document would it would have done, but also get the data of what I had it do, so it can still compare and improve." | No read-only stage and no watching trial. The lead acts from stage 1, asks when unsure, and records his would-have beside Aiden's answer (5.3, 4.3, 10, 11). |
| 2026-11-22 | "I'm reading the design now, but you can alter it as need be with my notes" | The design is altered from his notes as they come, each change recorded here |
| 2026-11-22 | "Anytime that I am being asked for input, or in any view that I am expected to consume, I expect there to be ample context for me to grasp what we are talking about. I don't like when AI asks me a question or states something to me like I know exactly what it's talking about." Then: "I just don't want you to go overboard and interaction doesn't feel natural, so many go in the middle, making the average experience feel better, but not having every interaction flood me with context I may already know." | Enough context to act, and no more: context in proportion to how cold the thing is for him (the opening of section 6) |
| 2026-11-22 | "Can you run some critiques on your own design plan with three Opus 5.5 reviewers to turn up any issues or improvements." | The three critiques (file above) |
| 2026-11-22 | "Re-order the stages then - I'm not in charge of that. You should be making those design/implementation calls." | Design and build calls are Sigmund's (9); the stages re-ordered (11) |
| 2026-11-22 | "Look, forget security for now. I'm not going to plan for situations such as a session can act as lead, or sure rests on the wrong words." | No credential for the lead, no provenance rule, no threat model (14) |
| 2026-11-22 | "The point of building this sturdy workflow is to start trusting Opus more, letting it make the call on more decisions. As far as I'm concerned, Opus is smarter than I am at most things, my biggest input will be taste because ultimately what Opus is building for me is my vision." | The lead decides everything outside the list of three (1, 5.3); trust starts wide (4.3) |
| 2026-11-22 | "You mentioning that my load may not go down - then we need to iterate on this because this is part of the goal. As I said, Opus should be trusted more, the lead should use foresight to act proactively, etc. I want to have ideas. let them be built by a robust system, and hold the result in my hand." | The opening of section 1; the result card (6.3); what reaches him is measured against a target (10); foresight (4.2) |
| 2026-11-22 | "Systems such as turn mechanics, gate verdicts, approvals, local server testing, resource sharing, git source control, session monitoring, etc. need to be streamlined by the system, so that I don't really need to jump in when things don't go perfectly and I can trust that my AI powerhouse is taking care of it." | What the lead takes off his hands (5.4); how a turn runs (5.7) |
| 2026-11-22 | "T3 should be enough to interface with the system and make thing smooth, but Grok Bot will also shine for computer-use stuff." | The lead's thread in T3 Code (6.2); Grok's second job as the lead's hands outside the repo (6.5). First read, wrongly, as the end of the Voice: see 2026-11-23 |
| 2026-11-22 | "I pictured the Lead, or the Voice being more flexible and capable rather than mechanical and hard to work with. You mention it being hard to pick up after a cold period, well that's a dynamic scenario that takes thought and care. This is the type of stuff that AI is so good at." | Judgement over rules: defaults, four things fixed (1); the pick-up note written fresh (4.1) |
| 2026-11-22 | "I don't want to be jumping through hoops to use this workflow." | An idea starts without a "go" (2.1); no takeover ceremony (4.3); the map and the landing card are in effect when written (4.1, 7) |
| 2026-11-22 | "Also, reading the design, do we need connectors?" | First answered no, with the Voice gone. With the Voice back (2026-11-23) the connector is in the plan again: it is how the Voice reaches the lead's commands when nobody is at the laptop, if stage 0 shows Grok's desktop link does not hold (6.2) |
| 2026-11-23 | "I'd say something that felt off would've been missing voice / grok bot element where I would've told him to start the task he would've told me when the task had its mock ready when I asked for the mock images it would've been relayed through him. Alternatively, I can just go to the T3 session and get them if I'm on my laptop and then when I said, ship it to the Grok Bot, he will let the session know and it would be in the working app the next time I sit down on my laptop for in progress. You just let me know if this is just because it's not built yet. But you also seem to be tripping about Grok Bots place in the design as Voice" | The Voice is Grok Bot: he speaks first, passes pictures and carries Aiden's go-ahead (6.2, 5.4). The lead's thread and every session's thread in T3 Code stay open to him. The Voice's checks join stage 0 (11) |
| 2026-11-23 | "Looks right to me, ship" (on #740, said to the lead after seeing screenshots) | A go-ahead said once, to the lead or the Voice, is carried to the session in his words (5.4) |
| 2026-11-24 | "Leave the old asks for now, we'll have to triage them after the fact or during a stage where I can take advantage of the Voice and Lead to figure out what needs to go." | The 41 old asks stay open and none is cleared in stage 0. Sigmund's call on where: their triage is the first use of the desk and the Voice in stage 1, with the lead deciding what his rule allows and bringing the rest through the Voice |
| 2026-11-23 | "I agree this looks correct, though I'm wondering "who" is going to be in charge of automated work such as using all Claude usage by end of work etc" (on the Voice as reinstated, ask a351) | The Voice in 6.2 is confirmed, with Sigmund's call that he acts and does not judge. His question is answered by 5.8 and now by a row in 6.2's table: the pacer in plain code sets the mode, the lead's daily pass chooses and starts the work, and the Voice only reports it |
| 2026-11-23 | "The spend cap is my weekly usage availability. I pay the $160 for the Claude subscription and the $40 for the Grok Bot subscriprtion no matter what, so using all of the resources is the important part, though I don't want to blow through usage in 3 days and nothing for the remaining 4. It would be awesome to build a system into the workflow such that we always use 99% of usage." | No cap in dollars. The week's usage is paced to be used in full and never run dry (5.8); Grok's price is not up for decision |
| 2026-11-23 | "I'll take your opinion, but I was thinking something like, once >50% through the week if we have used <=50% of usage, start ramping up development automatically, and when we reach the point where we are at risk of losing resources (not enough window refreshes to spend resources before weekly reset. I.e., 10% of weekly usage can be spent in each 6 hour window, therefore, if we have 40% usage available and only three windows then we are guarenteed to lose 10% of usage - we should avoid this)." | The pacer's modes (5.8). His lose-it check is "Use it or lose it" as he described it; his halfway check became the line, read from the first hour (Sigmund's call, section 3) |
| 2026-11-23 | "There won't always be work for Claude to pump out with extra resources available - we should have some kind of sink for it to use the tokens on - I'm not positive what that is, maybe another vibe-coded project (this is what I've been trying to do with Glimpse-mobile, not always successfully), maybe something proposing or implementing fix branches on existing projects, etc. Last week I ended with >70% usage available because I wasn't able to facilitate development." | The surplus list and the sandbox project (5.8) |

**The seven rulings he changed on 2026-11-22:**

1. "Anything I would see or feel comes to me" becomes: UI inside a pattern he has already passed is driven to done
   without him and shows in the daily note.
2. "A migration is always mine" becomes: an add-only database change, proved on a copy with a backup taken, is the
   lead's to manage. It waits on the restore check of #516.
3. "The lead may carry my answer to a question only" stays for what is his. New: the lead accepts or returns a
   hand-in on steps not marked his.
4. "A step is done when I have passed or waived what I was due to check" stays. New: a step not marked his closes on
   the lead's accept.
5. The limit on open decisions is five per project, not five across all projects.
6. "InProgress has no model in it" stays in this sense: InProgress decides nothing. It starts the lead's turn the way
   it starts a worker's thread.
7. "A permission or a review needs me in the thread or the window" becomes: his yes to a permission, given to the
   lead by chat or voice, counts, recorded in his exact words.

The mandate text is code and the intent record is the lead's to rewrite on Aiden's word, so both change with the
stage that builds each ruling, not before.

## 3. Calls Sigmund made for him (each can be undone with a word)

As revised on the evening of 2026-11-22:

- The order of the stages: proofs and a clear deck; the desk answers; an idea becomes work; work becomes a result in
  his hand; the lead keeps house; the map and foresight; hands outside the repo; the second project.
- The list of three that reaches Aiden: taste, direction, what cannot be taken back. Everything else is the lead's.
- An idea of Aiden's in the tweak or standard lane starts at once, with no "go".
- "For Aiden" on a step has three values: nothing, mocks first, his word. "Maybe" is gone.
- The landing check comes before a landing, in plain code. The lead's ruling comes after and never holds one up; a
  risk sent back is a second round on the same step.
- A reopen runs in the lane its change fits.
- Trust starts wide. An undo narrows it. Where Aiden keeps giving a plain yes the lead stops bringing that kind and
  says so once; never for what cannot be taken back.
- Four things are fixed and the rest are defaults: the list of three, Aiden's reserve of the week's usage, five open
  decisions per project, the risk list.
- (Withdrawn on 2026-11-23, on Aiden's word: a spend cap of 40 dollars per project per day. He pays a flat price, so
  a cap in dollars measured the wrong thing.)
- The week's usage, as of 2026-11-23 (design 5.8):
  - One pacer for the account, above the projects, in plain code, reading the plan's own gauges from every run.
  - The line is read from the first hour of the week, in place of Aiden's check at the halfway point. Why: a week
    that notices on Thursday has only the back half's windows to catch up in.
  - Four modes: hold, steady, catch up, use it or lose it. The bands are 10 points either side of the line, and
    "lose it" starts when what is left is more than four fifths of what the remaining windows can take.
  - The aim is 95 to 99 percent used at the reset, not 99 flat. Why: the last 5 points are Aiden's reserve until the
    final window, and a session that runs into the limit costs a cold cache.
  - Aiden's reserve is the fixed thing: the last 5 points of the week; 30 percent of the window in his usual hours;
    no starts past 85 percent of a window. He did not ask for this. Why: surplus work that leaves him unable to work
    would cost more than the usage it saved.
  - The surplus list, in order: pull forward, get ahead of Aiden's moments, upkeep, the lead's own exam, the sandbox
    project. Surplus work raises no decision for Aiden, and the share of it that was kept decides which rung gets
    more.
  - What one window is worth as a share of the week is measured, not assumed (his "10 percent per 6 hours" was an
    example).
  - Paid extra usage is money, so it is on the list of three and the lead never turns it on.
  - The sandbox project gets its desk in stage 5, and the second project of his own work in stage 7.
  - Where it is built: readings and the reserve in stage 1, the pacer and pulling forward in stage 2, the rest of the
    surplus list in stage 4, the sandbox in stage 5.
- A tweak's target is under 60 cents all in (the first draft's 25 cents did not add up).
- Each start hands out a worktree, a branch, a port and a scratch folder.
- A step waiting on Aiden does not hold a place in flight.
- The lead answers a session's permission prompt himself when it is inside the project's folders and usual tools.
- How a turn runs (design 5.7): headless Claude on Opus 5.5 with project-only settings, a written lease per turn,
  each desk item moved once, separate places for reflex turns and the passes.
- Every database change in the plan is a new table or column, never a new status, so no table is rebuilt.
- T3 Code is how Aiden talks to the lead; one thread per project, renewed when idle.
- Grok does errands: looking first, then errands where every step can be taken back.
- The lanes and their numbers: a tweak is thirty lines or fewer in three files or fewer; a batch waits a few minutes.
- The speed limits in design section 5.2, and no keep-warm pings.
- The limits: 3 in flight per project, 3 own starts a day, a recommended 6 in flight across projects, two restarts
  per step. From 2026-11-23 the first three hold only while the week's usage is on its line; behind it, the lead
  raises them himself.
- Two minds on a definition: the lead writes it, Sigmund reads it against the code.
- The backtest is the lead's exam and gates changes to his rules and model.
- How much context an ask carries: by how fresh the thing is for him, on the lead's judgement.
- The words: section 15 of the design.

After the independent review of 2026-11-23 (section 8 below):

- What is Aiden's is held before the act, judged by what the action does, for a session, the lead and Grok alike. A
  yes covers the action, the step and the revision he saw.
- Each outside action carries an id written before it is made; a step and a place in flight are claimed in one write.
- The reserve is a promise while Aiden is at work and a target in his usual hours before he arrives. One account of
  headroom for every project; work in flight counted and paused; the reserve outranks every mode.
- The pacer's ramp-up moved from stage 2 to stage 4. Why: before the lead can accept work (stage 3), more starts
  would put more hand-ins in front of Aiden.
- 95 to 99 percent stays the aim, as Aiden asked. A week that ends lower says what went unspent and why; it is not
  made a pass mark that would reward burning usage.
- Surplus work is judged four weeks on by whether it was used, sat idle or was undone, read by InProgress and never
  asked of Aiden. "Kept" is gone: work the lead lands himself would always have counted.
- The exam has two scores (whose call, and was the answer acceptable), fails outright on one decision that cannot be
  taken back, and runs on cases the rule has not seen.
- What reaches Aiden is counted per result delivered, not per week.
- Closed, landed and live are three recorded facts; "is live" needs the deploy's evidence for the landed revision.
- A step with no definition is defined as it starts and never refused. A batch is at most five tweaks, each its own
  commit and check.
- Stage 0 gains: the start that cannot happen twice, the held action, the pause, the baseline re-made, and the
  sentence by hand. Stage 3 ends on the first demonstration, and stages 4 to 7 do not start before it.

## 4. The numbers

How each was made is in the resource "The lead: baseline numbers and spike results".

**The record, 2026-11-21 and 22 (all projects unless said):**

| Fact | Number |
|---|---|
| Steps that became done in the 60 days to 2026-11-21 | 431 by their completion date (InProgress 162, which is what the weekly row below adds up to). Corrected on 2026-11-23: this row first said 135, which counted close events in the event log. The log holds a close for only 121 of the 431. Every close it does hold was made by the worker's own scribe; for the other 310 or so it holds nothing, so who closed them is not known. 7 reopened, by the same log. |
| "Active" steps with no live session | 29 of 30 |
| Open steps with anything like a definition of done | 4 of 114 |
| Steps sessions proposed | 41; nothing records who let them in |
| Asks for Aiden, all time | 248 reviews, 54 questions, 36 permissions. 43 open, 10 to 14 days old on average. |
| Reviews he answered | 204. At least 135 a yes with no change asked. |
| Reviews where his answer had substance, by kind | ui 25 of 72, docs 8 of 40, research 8 of 22, ops 5 of 16, fix 4 of 15, server 3 of 11, refactor 2 of 9, integration 1 of 8, data 0 of 11 |
| Steps closed per week, InProgress, oldest first | 34, 31, 35, 54, 0, 0, 1, 7 |
| Open steps older than four weeks | InProgress 25, InGame 19, InThink 12 |
| A change of 30 lines or fewer | 1.69 dollars and 48 requests at the median; 27 times more per line than a change of 600 to 2,000 lines. 13 of 79 landed changes are that small. |
| Money lost to cold caches since 9 October | 173 of 1,211 dollars, 117 times |
| The session the lead started on #537 | 5.07 dollars in its first 29 minutes |
| Repo litter | 48 worktrees, 112 merged branches not removed |

**The first spike (hand-picked items, 2026-11-21):** six gate calls right out of six on the cheapest model at about a
cent each, including a false "merged and deployed" caught from git; two definitions on the middle model, one sound,
one written in function names; one turn lost its tool to a permission rule and refused to guess.

**Definitions against Sigmund's bars (two past steps, blind, 2026-11-22):** the lead covered what Aiden would check
in plainer words and added lines the bars lacked; he missed what was decided later in conversation and the code-level
edge cases. 8 to 11 cents on the middle model, 34 to 52 cents on Opus 5.5.

**The backtest (2026-11-22):** every answered question for Aiden (51) and every proposed step (41), run blind: the
record cut off at the moment of asking, the record only, one short turn. Questions judged by a separate Opus turn
against Aiden's recorded answer.

| | Haiku | Sonnet | Opus 5.5 |
|---|---|---|---|
| Questions: decided himself, brought to Aiden | 11, 40 | 20, 31 | 10, 41 |
| Decided the way Aiden did, another way | 5, 6 | 14, 6 | 9, 1 |
| Of those, calls that were Aiden's | 5 | 4 | 0 (1 when judged by Sonnet) |
| Recommendation same, different, cannot compare | 18, 17, 3 | 11, 14, 5 | 22, 14, 4 (18, 20, 2 when judged by Sonnet) |
| The judge's count of questions truly Aiden's | 43 of 51 | 36 of 51 | 40 of 51 |
| Proposals: admit, merge, Aiden, decline | 20, 12, 8, 1 | not run | 32, 2, 5, 1 (one verdict unreadable) |
| Of the 20 proposals later built, admitted | 9 | not run | 17 |
| Cost: the 51 questions, the 41 proposals | 0.09, 0.10 dollars | 1.11 dollars, not run | 2.97, 4.12 dollars |
| Median time for a call | 31 s | 26 s | 26 s on questions, 41 s on proposals |

Reading: Opus 5.5 decided fewer questions than Sonnet, got nine of ten the way Aiden did, and decided nothing that
was his by one judge and one thing by another. It let in 17 of the 20 proposals that were later built, where Haiku
let in 9 and folded or escalated the rest. Each model declined one proposal that was later built (Haiku #673, Opus
#650). A call on Opus costs 6 to 10 cents. This is why the design gives every call to Opus 5.5.

Limits of the backtest: the judge is a model and its count of "truly Aiden's" moved between runs; Aiden's answers are
as the scribe recorded them; the lead had no repo and no thread.

## 5. Where each thing Aiden asked for lives in the design

| He asked for | Design section |
|---|---|
| To be the boss, not the person who knows every project | 1, 4 |
| A lead with a backbone and a brain, who stands up for the project | 4.5 |
| More control over InProgress; not a proxy | 2.5, 6.2 |
| The lead owns the task criteria; tasks need a definition of done | 2.2 |
| The lead confirms before a task closes | 2.3 |
| The lead reviews a proposed task's what and why | 2.1 |
| Nothing undoes a deliberate change; nothing declined comes back | 2.1, 2.3, 4.1 |
| A month away: where we were, how to pick back up, what is next, across outside platforms | 4.1, 2.3 |
| The lead knows everything about the project; InProgress is his tool and may adapt | 4.1, 14 |
| No greenlight until he understands what, why, how and the outcome | 9, 10, 11 |
| Does a lead per project make sense | 1 |
| The lead actions tasks in Claude and corresponds with the session | 5 |
| Some tasks need him, some might, some will not | 2.2 |
| Any task can escalate what is make-or-break or taste | 2.2, 5.3 |
| Mocks as the signal for taste; he answers in the session | 2.2, 3, 6.4 |
| UI without mocks is driven to done by the session | 3 |
| Database changes managed by the lead | 3, record 2 |
| Something keeps InProgress current when sessions do not | 2.3, 2.5, 4.1 |
| Whether Grok is worth 40 dollars | Settled by him on 2026-11-23: he pays it regardless. Its usage is put to work (5.8, 6.5) |
| The week's usage spent in full, and not gone in three days | 5.8, 13 |
| Development ramps up by itself when usage is behind | 5.8 (the modes), 5.4 (the limits give way) |
| No usage lost for want of windows before the reset | 5.8 ("Use it or lose it", "What a shut lid costs") |
| Somewhere for spare usage to go | 5.8 (the surplus list, the sandbox project) |
| The loop as what the lead is | 5 |
| The daily note | 6.1 |
| Speed, so a session's cache does not expire | 5.2 |
| Context windows and compaction | 5.5 |
| New ideas straight to the lead | 2.1 |
| Branches, worktrees, staging and production, per project | 7 |
| Definitions as good as Sigmund's | 2.2, record 4, stage 0 |
| Reopening a closed task for a tweak | 2.4 |
| Five open decisions per project | 5.4 |
| The limits of the phone, and the ways round | 6.4 |
| One place to talk to the lead, which carries what got past him | 6.2 (the lead's thread in T3 Code) |
| Many tasks, several asks at once | 6.2, 5.4 |
| A question or feedback for a session, through the lead | 6.2 |
| What the minute check is | 5.1 |
| "Where does InGame's launch stand?" | 6.2, 4.4 |
| The connector | 6.5: asked for, then dropped on his own question |
| Ideas in, a robust system builds them, the result in his hand | 1, 2.1, 6.3 |
| His load goes down | 1, 10 (the measure and its targets), 11 (what each stage takes off him) |
| Opus trusted to make more of the calls | 1, 4.3, 5.3, 8 |
| The system handles it when things do not go perfectly | 5.4, 5.7 |
| T3 Code as the interface; Grok for computer use | 6.2, 6.5 |
| A lead who is flexible, not mechanical | 1 (judgement over rules), 4.1 |
| No hoops | 2.1, 4.3, 4.1, 7 |
| Design and build calls made for him | 9 |
| A recommended limit across projects that can be exceeded | 5.4 |
| A steward, not a gatekeeper | 4 |
| Different work handled differently; a fast lane | 3 |
| A plan grounded in real data | 10, record 4 |
| A way to stop the build drifting from the plan | 9 |
| The lead rules on a session's known risks; no second review | 2.3 |
| Knowing what is being built before it exists | 10, 11 |
| Opus 5.5 wherever it helps | 8 |
| No read-only stage and no watching trial: he acts, asks when unsure, and learns from what Aiden chose | 5.3, 4.3, 10, 11 |
| Enough context in every ask and view to grasp it, without flooding him | 6, opening |
| A plan that survives a lost conversation | These two files |

## 6. What is still open

- The six checks that wait on Aiden from earlier work (a107, a308, a335, a336, a338, a340). Stage 0 brings each with
  a recommendation.
- Not proved on his laptop: the lead's thread and a session's thread in T3 Code's phone app; which message reaches
  the phone; whether a stuck permission prompt can be answered for a session; a Grok errand out and back. Stage 0
  proves or disproves each.
- The wider rule for what the lead decides (design 5.3) has not been tested. Stage 0 runs it on the 51 past
  questions before anything is built.
- Whether the plan's terms cover headless Claude turns at this volume. To be checked in stage 0.
- The week's usage (design 5.8). Proved on 2026-11-23: a headless run on Aiden's login reports the five-hour window
  and the week, each with the share used and the time it resets (the event is `rate_limit_event`, with
  `unifiedWindows.five_hour` and `unifiedWindows.seven_day`; paid extra usage showed as off). Not yet known, and
  measured in stage 0: what one window is worth as a share of the week; whether an Opus run reports a further limit
  of its own; how many sessions it takes to fill a window; whether Grok's usage can be read at all.
- Which project is the sandbox. The design names Glimpse-mobile from his words; his word changes it.
- The baseline in section 4 is to be made again in stage 0 with one meaning of a close, the cutoff dates, the
  projects counted and repeats counted once. The event log is not a full record of closes (121 of 431), so no gauge
  may be read from it. Found in stage 0: the log began on 2026-10-23, and it is whole from that date.

## 7. What was done with the critiques

The 27 findings are in `~/.inprogress/resources/inprogress/2026-11-22-lead-design-critiques.md`, numbered as below.

| Finding | Done |
|---|---|
| 1 Stages out of order · 2 stage 3 oversized, migrations unnamed | Re-ordered and split; every stage names its database change; none rebuilds a table (11) |
| 3 Nothing tells the lead from a session · 5 "sure" can rest on planted words | Not planned for, on Aiden's word (14) |
| 4 Many write paths | The gates hold on every ordinary path a session writes through, against forgetting only (2.5) |
| 6 The accept comes after the deploy | A landing check in plain code before the landing; the lead's ruling after (2.3, 7) |
| 7 The learning rule | Replaced: trust starts wide and narrows by undo (4.3) |
| 8 Evidence overstated | Said plainly, and the wider rule is tested in stage 0 (8). Aiden's position recorded. |
| 9 His load may not shrink | The list of three; the measure and its targets (1, 10) |
| 10 Spend has no ceiling | The cap, every start counted, two restarts (5.4, 13) |
| 11 Runtime unnamed · 12 tool set · 13 one turn at a time · 14 answers reach only T3 sessions | Section 5.7 |
| 15 The voice | Kept. The revision of 22 November wrote "Gone: T3 Code is the interface, Grok does errands, no connector". That was Sigmund's misreading, corrected on 2026-11-23: Grok Bot is the Voice (6.2), with errands as his second job (6.5) |
| 16 Away for a month | The pick-up note written fresh; waiting steps hold no place; the lead's judgement (4.1, 5.4) |
| 17 Missing failures | Added (12) |
| 18 Checks on the session's word; owner-call notes | InProgress gathers the facts itself at hand-in (2.3). Owner-call notes reach Aiden only when on the list of three. |
| 19 Done-when lines that pass vacuously | Floors and things Aiden can read (11) |
| 20 "A third of UI reviews" · 21 tweak target · 22 reopen and lanes · 26 thirty lines and three files · 27 Parvati and tweaks | Fixed (3, 2.4, 12) |
| 23 Note length against context · 24 undefined terms · 25 no data behind "stopped" and "last touched" | The note sample and section 15; the data is named in each stage's plan |

## 8. What was done with the independent review (2026-11-23)

Aiden had another model review the design and its record, and asked what Sigmund would action. The review is kept as
`C:\Users\aiden.molyneaux\.inprogress\resources\inprogress\2026-11-23-lead-design-independent-review.md`. Its
headline: approve stage 0, and hold stage 1 until its first four checks have answers. That is how the design already
works: Aiden's approval starts stage 0 only, and the four checks are now proofs of stage 0.

| Finding | Verdict | What was done |
|---|---|---|
| 1. Approval before the first action that needs it | Right. The permission rule went by folder and tool, so a release tool could publish before the landing check saw anything. | Design 5.4: judged by what the action does, held before the act; a yes covers the action, step and revision. 4.3: yeses do not widen to a new direction. 7: only Aiden's word shrinks a risk list. Stage 0 tests the held action. |
| 2. Protect the worker start as well as the desk item | Right. The lease covered the desk item and not the start it makes. | Design 5.7: an id per outside action, looked for after a crash; claims in one write; what happens with the lead off; a late hand-in does not reopen a step Aiden closed. Stage 0 tests the stopped start and the raced starts. |
| 3. Say what reserve the pacer can guarantee | Right. "Never short" could not be promised: work in flight keeps spending, and a full night cannot be given back. | Design 5.8: a promise while he is at work, a target before he arrives; one account of headroom; work in flight counted and paused; stale readings stop the lead's own starts; the reserve outranks the modes. |
| 4. Test whose decision it was | Right. "At most a third reach Aiden" passed for a lead who never asks. | Design 10: two scores; one decision that cannot be taken back fails the run; cases the rule has not seen. Design 8: the 9 of 10 is put in its place. |
| 5. Give each stage what it needs | Right on all four. | Stage 1 gets a bare list of decisions; admitted work sits under the Phase until outcomes exist; an old step is defined as it starts; stage 3 uses the risk list the playbook holds today; a table says what each proof is for. |
| 6. Closure, deployment and acceptance | Right. The result card said "is live" on the strength of an accept. | Design 2.3: closed, landed and live recorded apart; each done-when line met, not met or waived. Design 3: the rules for a batch of tweaks. |
| 7. Measure what Aiden gets | Right, with one part taken in part. | Design 10: per result, time to something usable, taste against missed. Design 5.8: used, idle or undone four weeks on. Taken in part: the review would make 95 to 99 percent a soft target. Aiden asked for it, so it stays the aim, and a week that ends lower says why. |
| 7, the baseline: 162 weekly closes against 135 in total | Right, and it was Sigmund's error. | Recounted on the same copy of the data: 431 steps became done in the 60 days. Section 4 is corrected, and stage 0 makes the baseline again. |
| The first demonstration | Taken. | Stage 0 runs the sentence by hand, so Aiden holds one result before anything is built. Stage 3 ends on the demonstration for real, and stages 4 to 7 wait for it. The usage readings stay in stage 1 because they cost almost nothing; the ramp-up moved to stage 4. |

## 2026-11-24 and 25: what the Voice's checks changed in the design

No decision of Aiden's was changed. Lines in the design that said "not known" or "not yet proved" now say what
stage 0 found (6.2 "How the Voice is wired", 6.4).

| Aiden's words, or the finding | What it changed |
|---|---|
| "We can change the Grok Bot's rules, whatever we need to do. I need you to figure it out this time instead of just trying and failing" (2026-11-24) | The lead's rules, version 6: he may read the file `lead step` lists for a document and show Aiden a picture. Product code in a stage that had none, on his word. |
| Grok's file tools copy only from inside the user folder, and no setting changes it (found in the app's own code) | Design 6.2, pictures: a picture the Voice shows is a document on a step, kept in InProgress's documents folder for the project. |
| "WE finally have a picture." (2026-11-25, after "Show me the picture r777 on step 740") | Design 6.2 and 6.4: the Voice passes pictures is proved. |
| "Yes I am getting pings on my phone now." (2026-11-24) | Design 6.2 and 6.4: the Voice speaks first is proved; T3 Code's notification is the fallback. |
| The laptop slept from 22:06 to 10:23 with its lid closed, and the one check sent in that time was never answered | Design 6.4 already asks for a laptop that does nothing when the lid closes. It is not set, and waits on his word (ask a353). The connector is decided by one more sample: an awake laptop left alone for hours. |
| "my laptop is often left on overnight. Sometimes it will also be closed/off. I only expect T3/Grok/InProgress to work when the laptop is "on", and if it's on overnight, then technically work can be ongoing, I just won't be around if I'm sleeping obviously." (2026-11-25) | Design 6.4: the lead works whenever the laptop is on, nights included; nothing is expected when it is closed or off; the power settings are left alone. Sigmund had first read his "known limitation" as "plan nothing overnight", which was too narrow. |
