# The lead: the design

Date: 2026-11-22, revised that evening and on 2026-11-23 (the week's usage, 5.8). Status: draft for Aiden's approval. Step #736. Design only: nothing here is
built until he says go, and each stage gets its own build plan before it starts.

**Read this first, whoever you are.** This is the one document to build from. Its record (Aiden's decisions in his
words, the numbers, where each thing he asked for lives) is `2026-11-22-the-lead-design-record.md`. Earlier documents
in this folder are history. If this conversation is lost, those two files are enough.

**What changed in this revision.** Three Opus 5.5 reviewers read the first draft, and Aiden answered their findings.

- The design is now built around one sentence of his: have an idea, let it be built, hold the result in his hand.
- The lead decides far more. Only three kinds of thing reach Aiden (section 1). Before, he asked whenever unsure.
- Aiden talks to the lead through the Voice, which is Grok Bot, and through T3 Code. (This line first said the
  Voice was gone and Grok Bot ran errands only. That was Sigmund's misreading, corrected on 2026-11-23: see below.)
- The stages are in a new order: each one takes something off Aiden, and none needs a later one.
- The lead's rules are defaults he may depart from with a reason. Only four things are fixed (section 1).
- A new section 5.4 lists what the lead handles when things go wrong, so Aiden does not have to step in.
- Nothing here guards against a session that tries to get round the lead. Aiden: "forget security for now."
- 2026-11-23: the spend cap in dollars is gone. Aiden pays a flat price for his plans, so the lead's job is to use
  the whole week's usage without running dry, and to have worthwhile work ready for what is spare (5.8).
- 2026-11-23, after an independent review Aiden asked for: what is Aiden's is held before the act and not at the
  merge (5.4); a start cannot happen twice (5.7); the usage reserve says what it can promise (5.8); closed, landed
  and live are kept apart (2.3); the exam scores whose call it was (10); each stage carries what it needs, and a
  first demonstration gates stages 4 to 7 (11).
- 2026-11-23, after the sitting of stage 0: **the Voice is back.** The revision of 22 November read Aiden's "T3
  should be enough to interface with the system ... but Grok Bot will also shine for computer-use stuff" as the end
  of the Voice, and wrote Grok Bot down as errands only. He had not said that. What he pictures, in his words of
  2026-11-23, is in 6.2. Changed: 6.2, 6.4 and 6.5; the Voice carries Aiden's own go-ahead to a session (5.4); the
  Voice's checks are in stage 0 and the Voice is built from stage 1 (11). Who does what, and how he is wired, are
  in 6.2.

## 1. What this is for

Aiden, 2026-11-22: "I want to have ideas, let them be built by a robust system, and hold the result in my hand."

```
Aiden          the idea · taste · direction · the result in his hand
   |
The lead       what "done" means · what gets in · what closes · every call that is not Aiden's · memory · momentum
   |
The sessions   building it well (Sigmund and his roster, in T3 Code)

InProgress     the lead's book and his desk: it keeps the record, runs his turns and holds his gates
The Voice      Grok Bot: how Aiden and the lead talk, from anywhere. Also the lead's hands outside the repo
```

**What reaches Aiden, and nothing else:**

1. **Taste.** A look or a feel he has not seen: mocks to pick from, a result to hold.
2. **Direction.** A choice that changes what the project is for, or two things he asked for that cannot both be had.
3. **What cannot be taken back.** Spending money; real data that could be lost; anything sent to people in his name;
   a sign-in or a payment only he can make; any action on his accounts (creating or changing an account, a
   repository, a service or a credential); a change on the project's risk list (section 7).

Everything else is the lead's: technical choices, scope inside an idea, order, what gets into the plan, what closes,
a session's known risks, what to do when something breaks, and the tidying. Aiden: "Opus is smarter than I am at most
things, my biggest input will be taste because ultimately what Opus is building for me is my vision."

- **The desk.** One per project, inside InProgress. InProgress puts items on it and starts a fresh Opus 5.5 turn to
  deal with them (section 5.7). The lead never writes code and never reviews code.
- **The lead's thread.** A T3 Code thread per project, in the lead's role. Aiden talks to the lead there, at the desk
  or from T3 Code's phone app. It is the same lead: it reads the desk before it answers and acts with the same
  commands.
- **One lead per project.** Gates, memory and rules belong to one project and a lead never acts on another.
- **InProgress decides nothing.** It keeps the record, holds the gates in plain code, measures, and runs the turns.
- **Judgement over rules.** Aiden: "I pictured the Lead ... being more flexible and capable rather than mechanical
  and hard to work with." The numbers in this design are defaults. The lead may depart from one when the case calls
  for it, and says so with his reason in the daily note. Four things are **fixed** and he never departs from them:
  the list of three above, Aiden's reserve of the week's usage (5.8), five open decisions for Aiden per project
  (5.4), and the risk list on the landing card (7).

## 2. The four gates

A step is Aiden's "task": any contained piece of work. It meets the gates in this order.

### 2.1 In: nothing enters the plan until the lead has understood it

A session that wants a new step proposes it. The lead reads the What and the Why, searches the record, and answers:

- **Admit.** It enters the plan under the outcome it serves (section 4.1; until outcomes exist in stage 5, under the
  current Phase) and gets a definition before it starts.
- **Merge into #n.** The plan already holds this work.
- **Decline.** With the reason and the record it rests on, and what would meet the need without undoing the earlier
  decision. Declined proposals are kept, so the next one meets the same answer.

He brings a proposal to Aiden only when letting it in would change the project's direction.

**A new idea from Aiden.** He tells the lead in a sentence, in the lead's thread. Inside two minutes the lead has
checked it against the record, written its definition, named its lane, and read it back.

- A tweak or a standard step with nothing for Aiden in it **starts at once**. "Stop" or a correction changes it.
- A taste step starts with mocks. A heavy step waits for his word.
- If it undoes something on record the lead says so once, before it starts. Aiden's word wins and becomes a ruling.
- If the limit in flight is reached, the lead says which step waits.
- "Note it" puts the idea in the backlog as Aiden's, not started. Telling the lead is the note; there is no file.

### 2.2 Ready: no step starts without a definition the lead wrote

```
#722 Parked projects                                   data · lane: standard · serves: "the board is true"
What: A parked status for a project, park and unpark in the window, out of every count.
Why:  A project with no work in play should nag about nothing.
Done when:
  1. Park a project from its actions in the window: it moves under Parked, and its asks leave every count.
  2. Run status: parked projects sit on one line after the active ones. Unpark: the counts come back.
  3. Start a session in a parked project: it is active again, with nothing a session had to remember.
  4. Run it on a copy of the real data: existing projects and steps are unchanged, and the change only adds.
For Aiden: nothing. The Parked group sits where the plan already fixes it.
Must not undo: the step-level park (#535); parked means out of every count (a317).
Landed means: on main, deploy green.
Defined by the lead, 2026-11-21.
```

- About five done-when lines, seven for a heavy step, one for a tweak. Each is "do X, expect Y", checkable by
  someone who was not there, with no file or function names.
- **Two minds.** The lead writes it from what the project intends and what its history forbids. The session's
  Sigmund reads it against the code before he builds and tells the lead when a line cannot be checked or misses a
  case. The lead decides; a changed line is logged with the reason.
- **For Aiden** is set by the lead, and Aiden can change it on any step:

| Value | Meaning | What happens |
|---|---|---|
| nothing | No taste, no direction, nothing that cannot be taken back | The session drives it to done. Aiden gets the result. |
| mocks first | A look or feel he has not seen | The session makes mocks. The lead tells him they are ready and where. He picks in the session's thread. Then it is built to the pick and lands. |
| his word | It is on the list of three in section 1 | Nothing lands without his word. |

  Any step can still raise a taste or direction call to the lead the moment one turns up.
- A session Aiden starts by hand on a step with no definition asks the lead for one as its first act.

### 2.3 Out: a session hands in, the lead rules on what is known

A session cannot close a step. Two things happen when it is finished.

**Before it lands: the landing check.** The session asks InProgress, which answers in seconds, with no model: the
size of the change, whether it still fits its lane, and whether it touches the risk list. "Clear to land" or "hold:
this is Aiden's". InProgress reads git for this itself.

**After it lands: the hand-in.**

```
Hand-in on #722
1. Park from the window ... met: e2e "parks a project" green; screenshot attached.
2. status line ............ met: output pasted in the thread.
3. session start unparks .. met: unit test project-park.
4. copy of real data ...... met: the migration check ran clean on today's copy.
Known risks: parking a project while a session is live on it has no test (Murr, debt). The Parked group has no
             empty state (Parvati, polish).
On purpose: a parked project keeps its asks; they only stop counting.
Outside the repo: nothing.
Landed: 3f2c1ab on main, deploy green.
```

1. **An answer per done-when line.**
2. **Known risks and limits.** What was not done, not tested, uncertain, could break, or was left as debt. The
   reviewers' debt, owner-call and polish notes go here word for word. Never empty: a session with none writes why.
3. **On purpose.** What was done deliberately, so nobody "fixes" it later.
4. **Outside the repo.** Accounts, keys, DNS, dashboards: what changed, never a secret.

The lead does not review the work again. Shipwright's reviewers did that (Aiden: "adding another layer for the Lead
to critique and dive in would create doubled-work"). He does three things:

1. Reads the facts InProgress gathered for itself: merged or not, the deploy's result, the branch gone.
2. Reads the hand-in against the definition for a line with no answer.
3. Rules on each known risk: **accept it** (with his reason), **make it a step**, **send it back** (a second round
   on the same step), or **Aiden's** (only when it is on the list of three, with what he would do).

Then **Accept**: the step closes, "on purpose" and "outside the repo" go into the book, and Aiden gets the result
(section 6.3) when it was his idea or has something to see. Or **Return**: what is not met, what he found, what would
meet it. A step is done when it is accepted, not when it merges. Aiden's Done button always closes a step.

**Closed, landed and live are three facts**, recorded apart. Closed: by the lead's accept, by Aiden's Done, or by a
waiver, with who. Landed: the revision on the main branch. Live: the deploy's own evidence for that same revision.
A result says "is live" only when the third is there. Otherwise it says where the step stands: "closed by you, not
merged", or "merged, not yet deployed". Each done-when line ends as met, not met, or waived, with who waived it: the
lead for what is his, Aiden for the list of three. A line that must hold before anyone is exposed to the change is
checked before it lands. InProgress writes this receipt itself, and nobody reviews anything twice.

What stays uncovered is a session that is confidently wrong and lists nothing. That shows up as a reopen. Reopens are
counted by lane and kind of work and go to the Phase pass and to Shipwright's retro.

### 2.4 Reopen: a closed step that needs a tweak

Aiden holds a result and wants it different: "tweak #722: the Parked group should start closed." The lead's test: had
we known, would the definition have said this? Then it is the same step: the line is added, marked round 2, and the
step is open again with its history. Something more, or something else, is a new step that names the one it follows.

A reopen runs in the lane its change fits, whatever lane the step was in: most are tweaks. It goes to the thread that
built it if that is still warm, otherwise to a fresh session started from the step's record. The hand-in covers the
new line and that the earlier lines still hold. A reopen the lead makes himself, on finding a miss, counts against
him.

### 2.5 What InProgress holds, in plain code

| Today | After |
|---|---|
| Any session can mark any step done, with no check | A session's "done" becomes a hand-in. The lead or Aiden closes a step. |
| A session can add a step straight into the plan | A session's new step waits at the In gate |
| A step can start with only a title | A step with no definition gets one as it starts: the lead writes it inside two minutes while the session reads in. Aiden's own start is never refused. |
| A session ends and its step stays "active" | The next round sees it within ten minutes (section 5.4) |
| Nothing ties ceremony to size | The lane is on the step, and InProgress reads the size of the change itself |

These hold on every ordinary path a session writes through. They guard against a session that forgets, not one that
tries to get round them. One switch per project turns the gates off and puts the project back to today's behaviour.
With the lead down, items older than their limit show in the window under "The lead is behind", where Aiden can act
on each himself.

## 3. Lanes: the ceremony fits the work

The lead puts every step in a lane before it starts, from its label, the size he expects from reading the code,
whether it shows, whether it touches the risk list, and whether the pattern exists. Aiden can move it with a word.

| Lane | What goes in it | Definition | Who does it | Review | Accept |
|---|---|---|---|---|---|
| Chore | Mechanical, no judgement: remove merged branches and worktrees, run a deploy again, close a duplicate | None: a command | InProgress or a script. No model. | The command's result | Automatic |
| Tweak | Thirty lines or fewer in three files or fewer, inside a pattern that exists, nothing on the risk list, undone by one commit: wording, spacing, a one-line fix, a setting, most reopens | One line | The warm thread that built it; otherwise one lean session that takes a batch of the project's tweaks, with a fifteen-line briefing, no plan and no receipt | The checks. A screenshot when it changes a screen. | Automatic when the landing check and the checks are green |
| Standard | Most features and fixes | About five lines | A fresh session under Sigmund | Murr; Parvati when it shows | The lead rules on the known risks |
| Taste | A look or feel Aiden has not seen | The same, mocks first | The same | The same, against the mock he picked | The lead; Aiden holds the result |
| Heavy | The risk list; a release; data rewritten or deleted; what goes out to people | About seven lines, and a written plan first | A fresh session, full strict gates | The strongest reviewers | The lead, on Aiden's word |
| Research | A question to answer, a comparison, an investigation | The question, and what a good answer holds | A session that changes no code | None | The lead reads it and turns findings into steps |
| Hands | What happens outside the repo: an account, a dashboard, DNS, a store page | An errand brief or a click list | Grok Bot when it can be done in a browser and taken back (section 6.5). Aiden when it needs his sign-in, a payment, or cannot be taken back: the lead prepares it and batches it, "fifteen minutes of your hands, four things". | The lead reads the result | The lead |

- **A step can climb a lane on its own.** The landing check reads the change. A tweak that has outgrown thirty lines
  or three files, touches the risk list, or fails a check twice is refused with "this has outgrown the tweak lane",
  and the lead writes a real definition.
- **Tweaks ride together.** They are gathered for a few minutes and sent as one batch. "Now" sends what is there.
  The thirty-line limit is per tweak, and a batch holds at most five. Each tweak is its own commit with its own
  check, and its own screenshot when it shows. One that fails is dropped from the batch and returned alone; the rest
  land.
- **The target for a tweak:** today 48 requests and 1.69 dollars at the median. The aim is fifteen requests in a
  small context: under 60 cents all in, and under ten minutes from Aiden's words to landed.
- **This changes Sigmund** in every project: the lanes become his rule for how much lifecycle a change gets, he reads
  the definition where he used to write the bar, he asks for the landing check, and his receipt ends in a hand-in.

By kind of work:

| Kind | For Aiden | Lane |
|---|---|---|
| UI with a new look or feel | mocks first | Taste |
| UI inside a pattern he has already passed | nothing | Tweak or standard. He sees it in the result; "tweak" changes it. |
| Database change that only adds, proved on a copy with a backup taken | nothing | Standard. Waits on the restore check of #516. |
| Database change that rewrites or deletes | his word | Heavy |
| Server, fix, refactor, docs, tests | nothing | By size |

## 4. The steward

### 4.1 Four things he keeps, all stored in InProgress

**The map.** Goal, then Phases in order, then for the current Phase its **outcomes**: three to seven things that must
be true for the Phase to close, in Aiden's words. Under each outcome, the steps that deliver it and their order. And
**your moments**: the points in the Phase where Aiden will be needed (a pick, a payment, a sign-in) and roughly when,
so he hears of them ahead of time. The lead writes the map when a Phase begins, in one long turn that reads the whole
repo and record, from the project's intent and Aiden's own words. He shows it to Aiden once and works from it at
once. Inside it he defines, starts, orders, splits and cuts steps without asking. A new outcome, a dropped outcome or
a changed Phase is direction, and comes to Aiden.

**The book.** What the project is, how it is built and shipped, what is live, what is set up outside the repo, the
decisions that must not be undone and why, the known debts. InProgress already has pages that know when the code
under them changed. The lead owns them: an accept that touches a page's ground updates the page. Its front page is
the **pick-up note**: where we are, what is half done and the next action on it, what is set up on each outside
platform and what is not, what he would do next.

```
InProgress · where we are · 2026-12-21
You left on 2026-11-21 in the middle of: offsite backups (#516).
Done since: the lead's gates (3 steps), the parked projects view, 6 tweaks. Nothing waited on you to land.
Half done: GitHub repo inprogress-data exists and takes pushes; force-push protection is NOT on (needs GitHub Pro,
           a payment: yours). Restore from offsite has not been tried on a scratch home.
Next: the restore check, which I will run on a scratch home this week. Then add-only data changes land on their own.
Yours (2): the GitHub Pro payment; a pick between two mocks for the board (#812).
```

Aiden: picking up after a cold period is "a dynamic scenario that takes thought and care". So the pick-up note is not
a replay of the daily notes. When he has been away, the lead writes it fresh, in one long turn, thinking about what
matters now: what moved, what he decided in Aiden's place and would most like checked, and the few things that are
Aiden's, in the order that matters. While Aiden is away the lead keeps building what does not need him, and uses his
judgement about not stacking costly work on top of a decision Aiden might still undo.

**The gauges.** Measured by InProgress in plain code, read every morning: progress (outcomes done, in flight, not
started; steps closed this week against the last four); flow (how long steps wait on Aiden, on the lead, on a
session; stalls; returns and reopens by lane); usage (the week and the window against the line of 5.8; what became of
surplus work; usage lost to cold caches; list-price dollars per closed step by lane, as a yardstick);
Aiden's load (what reached him this week, and how much of it was not on the list of three); drift (work in flight
that serves no outcome; backlog older than four weeks). A gauge out of range is a desk item the lead must answer:
what happened, and what he has done about it.

**The forecast and the risks.** "At this pace the Phase closes around 12 December. Three things could move that."
He commits to it, moves it daily, and is judged on it.

### 4.2 Three speeds of thinking

| Speed | When | What he does |
|---|---|---|
| Reflex | An item lands on the desk | The gate calls and answers of sections 2 and 5 |
| The daily pass | Each morning, at a time Aiden sets | Reads the map, the gauges, the desk and yesterday. Chooses the day's starts across the whole map and starts them. Moves the forecast. Goes through old backlog: keep with a reason, merge, or drop. Runs the tidying (5.4). Writes the daily note (6.1). |
| The Phase pass | A Phase begins; an outcome closes; a gauge is far out of range; Aiden changes direction | Writes or rewrites the map. Looks back: what bounced, which lane was wrong for which work, what reached Aiden that should not have. Changes his own standing rules and files fixes to the workflow. |

The lead uses foresight. He does not wait to be asked: when he sees that output has halved, that a step will need a
payment in two weeks, or that the queue has drifted from the Phase, he acts on what is his and tells Aiden what is
Aiden's before it blocks anything.

### 4.3 Trust starts wide and narrows by exception

The lead is trusted from the first day with everything outside the list of three. Trust moves in two ways, and
neither is a ceremony:

- **An undo narrows it.** Every decision is numbered, and "undo d41" takes it back. Aiden may add why. The undo and
  the reason become a ruling the lead reads before every later call of that kind.
- **A pattern widens it.** When the lead sees he keeps bringing Aiden a kind of thing and getting a plain yes, he
  stops bringing it and says so once in the daily note: "I have stopped bringing you docs reviews. 'Bring docs
  reviews' gets them back." This never applies to the third item on the list of three, and a run of yeses on one
  kind of thing is not leave to take a new direction.

When he does bring something, he records what he would have chosen before Aiden answers, and Aiden's answer goes
beside it. That pair is how he learns Aiden's taste and direction over time.

### 4.4 Above the projects

Each morning, one page: every project's Phase, forecast and gauge lights; the week's usage against its line (5.8),
which is one pool for every project; what is Aiden's across all of them, in the order that matters; where the next
session should go; which project should be parked. Aiden sets the order of priority among projects once. The page does not overrule a project's lead.

### 4.5 Backbone, and how Aiden judges him

- To a session: return, decline and "no, and here is the record" are his to say.
- To Aiden: an objection once, before the thing starts, with what he would do. Then Aiden's word, recorded.
- For the project: when the queue drifts from the Phase or work piles up behind a call of Aiden's, he says so with a
  recommendation, not a question.
- Once a week the note carries his numbers: what reached Aiden and how much of it was on the list of three, steps
  closed, hand-ins returned, steps reopened after he accepted them, Aiden's undos, how much of the week's usage was
  used and what became of the surplus work (5.8), and how far the forecast was off.

## 5. The round

### 5.1 What starts one, and its order

Three things start a round: something lands on the desk; Aiden speaks; the morning. A session's question and a
hand-in start a turn the moment they are written, because a session is waiting. Everything else is picked up by a
check InProgress's server already runs once a minute. No item, no turn, no cost.

Desk items: a hand-in; a proposal; a session's question; a session that stopped with its step open; a session stuck
on a permission prompt; the next step on the map with no definition; a promise due; an answer from Aiden; a gauge out
of range.

Every round: read the desk; clear what is the lead's; bring Aiden only what is his, the one that blocks the most
first; start the next step from the map when there is room; update the book if something closed or changed outside
the repo.

### 5.2 How fast

A waiting session's cache lasts an hour on Aiden's plan and five minutes once the account is past its included
usage; after that its next turn reads everything again at full price. Since 9 October that was 173 of 1,211 dollars
at list price: usage that bought nothing.

| What | Typical | Limit |
|---|---|---|
| A session's question | 90 seconds | 3 minutes |
| A hand-in: accept or return | 2 minutes | 4 minutes |
| Aiden's new idea: the definition read back | 1 minute | 2 minutes |
| A stopped session noticed | 5 minutes | 10 minutes |
| A proposal | 15 minutes | 1 hour |

The note reports them: calls, the median, the slowest, how many were late. A late one shows under "The lead is
behind". The daily pass and the Phase pass run beside the reflex turns and never make one wait.

### 5.3 Questions: what he decides and what he brings

- **He decides.** A session's question is the lead's to answer unless it is on the list of three in section 1. He
  reads what he needs (the record, the step, the thread, the code) and answers with his reason.
- **Each decision is numbered and can be taken back.** It shows in the daily note in one line. "Undo d41" takes it
  back, and the lead then does the work of unwinding it.
- **What is Aiden's comes prepared:** what it is, what the lead found, what he would do, and the words that accept
  it. He records his would-have first (4.3). At most five are open per project (fixed); past that he holds the rest
  and brings the one that blocks the most.
- **When he is not sure whether something is Aiden's,** the test is: would Aiden see or feel it as a choice about his
  vision, or can it not be taken back? If neither, it is the lead's.

What to expect, said plainly: in a blind test on 51 past questions, Opus 5.5's choice matched Aiden's about half to
three fifths of the time where the two could be compared (section 8). So the lead will sometimes choose differently
from what Aiden would have. The design does not prevent that. It makes each choice visible in one line, cheap to take
back, and a lesson once taken back.

### 5.4 What the lead takes off Aiden's hands

Aiden: these things "need to be streamlined by the system, so that I don't really need to jump in when things don't
go perfectly." The lead handles each and tells him afterwards, in one line of the daily note.

| When | The lead |
|---|---|
| A session stops with its step open and no hand-in | Asks it once where the work stands. No answer in 30 minutes: he reads its thread and git, then restarts the step in a fresh session with a handoff. |
| A session is stuck on a permission prompt | He judges the action by what it will do, not by where it runs or which tool it is. If it publishes, sends, pays, deletes real data or touches the risk list, it is Aiden's and it waits before it runs: his yes is given in the lead's thread and recorded in his words. Otherwise the lead answers it. |
| A deploy goes red, or the environment breaks | The session runs the project's own doctor first. Still red: the lead has the deploy rolled back, restarts the step fresh, or parks it with the cause. |
| Two sessions collide: the same files, a merge conflict, the same port | He sets the order of landing and tells the later session to rebase. Each start hands out its own worktree, branch, port and scratch folder, so most collisions never happen. |
| A hand-in is returned twice | He changes the approach: rewrites the definition, splits the step, or starts it fresh. Still failing: he parks it and says what was tried and what he would do next. |
| A session drifts off its step | Work outside the definition is returned, or filed as a proposal, at hand-in at the latest. |
| A result needs a place to be held | The session leaves a check surface running on a copy of the data at hand-in. The lead links it in the result and closes it afterwards. |
| One session needs what another found | He attaches it to the step as a resource and tells the session. |
| Merged branches and worktrees pile up | A chore in every daily pass. |
| A session's context fills | Section 5.5. |
| The answer is Aiden's and he is away | The lead tells the session at once. It writes where it stands onto the step and carries on with what does not depend on the answer, or stops. A step waiting on Aiden does not hold a place in flight. Aiden is told once, and once each morning. When he answers, the lead resumes the thread if it is still warm, and otherwise starts a fresh session from the step's record. He never pings a session to keep it warm, and he does not nag. |
| The lead himself goes quiet, or a turn fails | The item stays on the desk. One retry, then "The lead is behind" in the window. |

**What is Aiden's is held before the act.** One rule binds a session, the lead at his desk, the Voice and an errand:
an action on the list of three waits for Aiden before it happens. The landing check alone would be too late for a
release tool that has already published. A yes from Aiden covers what it was given for: the action, the step and the
revision he saw. If the change later grows to touch the risk list (a rebase that picks up a change to the database,
say), it holds again.

**The lead carries Aiden's go-ahead; he never gives his own.** When Aiden says "ship it" to the Voice, or in the
lead's thread, about something that waits on him, those words are recorded exactly against the thing they answer and
the session is told. Said once, to whichever of them he is talking to, it is enough: he is not sent to another
thread to say it again. What is recorded is his sentence, when and where he said it, and what he had been shown.
Stage 0 found today's tool refuses this (a review "needs Aiden in the thread or the window"), and a result sat
unshipped for that reason. That rule goes.

**The lead never grants a landing.** A request to merge, deploy, push or release is answered by the landing check, in
plain code, from the change and the project's landing card. The lead says "this is for the landing check" and adds
what the record shows; he never says "go ahead" to one and never refuses one. He does not stretch an earlier yes of
Aiden's to a later request. Why: in stage 0's exam, on 121 of Aiden's past asks, a lead left to judge landings waved
through ten that were Aiden's, among them a push that deploys his public site. With this rule he granted none, and
the check settled a quarter of all the asks by itself.

**Limits.** Defaults, except where marked fixed:

- 3 sessions in flight per project, not counting steps that wait on Aiden. 3 starts a day on his own judgement.
- Across all projects a recommended 6 in flight.
- Those numbers hold while the week's usage is on its line. When usage is behind, the lead raises them himself (5.8)
  and the note says so. Aiden's word raises them at any time.
- Every start counts: a restart, a fresh session after a return, a batch of tweaks. Two restarts on one step, then he
  changes the approach.
- **Fixed:** five open decisions for Aiden per project.
- **Fixed:** Aiden's reserve of the week's usage (5.8). The lead's own work never takes the share of the week, or of
  the current window, that is held for Aiden.

### 5.5 Context windows

- The lead never fills one: each desk turn starts fresh and ends. His thread with Aiden is renewed when it has been
  idle for some hours, with the day's thread summed up onto the desk.
- A session cannot lose its definition: InProgress prints the definition, the hand-in format and the mandate into it
  again after every compaction.
- Steps are sized to fit: much more than the lane's lines means the work is split at the Ready gate.
- InProgress already measures each session's context. Near the limit the session writes where it stands onto the
  step and carries on. After a second compaction on one step the lead treats it as too big: the session hands in what
  is done, and the rest becomes a new step in a fresh session.
- Aiden is never asked to compact.

### 5.6 The first round on a project

It sorts what is already there: the proposals nobody let in (17 in InProgress), the steps marked active with nobody
on them (29 across his projects), and the old asks (43). The lead rules on everything that is his, and Aiden gets one
short list of what is left, each with a recommendation.

### 5.7 How a turn runs

- A desk turn is one headless Claude run on Opus 5.5 (`claude -p`), started by InProgress's server in the lead's own
  folder, with project-only setting sources. So it loads none of the hooks, skills or briefing a worker gets, and it
  leaves no trace as a session. The spikes of 2026-11-21 ran this way.
- Its tools: the lead's commands, file reads, and read-only git, inside the project's own folders. The facts he needs
  most (is it merged, the size of a change, does a branch exist) are served by InProgress as commands.
- Each turn's cost and time come from the run's own result and are recorded.
- **One turn per desk item, and each item moves once.** A turn takes a lease that is written down, so a server
  restart or a deploy mid-turn does not start a second turn on the same item, and a retry cannot accept or return a
  step twice.
- **A start or a message happens once.** Each action that reaches outside InProgress (starting a session, sending a
  message, an errand) gets an id that is written down before the action and travels with it. After a crash the
  runner looks for that id's result before it tries again. If it cannot tell whether the action happened, the item is
  marked unknown and shown, and not retried. A step, and the last free place in flight, are claimed in one write
  against the current state, so two turns cannot both take them.
- **With the lead switched off:** a turn in flight finishes the write it is in and stops; items stay on the desk;
  sessions carry on as they do today, and their hand-ins wait for Aiden as ordinary "done" claims. A hand-in that
  arrives for a step Aiden has already closed is recorded and does not reopen it.
- Reflex turns, the daily pass and the Phase pass have separate places, so a long pass never holds up an answer.
- The answer reaches a T3 Code session as a message in its thread, marked as the lead's ruling. A session Aiden
  started by hand outside T3 Code hears it at its next prompt, and the window says so.

### 5.8 The week's usage: use all of it, never run dry

Aiden, 2026-11-23: "I pay the $160 for the Claude subscription and the $40 for the Grok Bot subscriprtion no matter
what, so using all of the resources is the important part, though I don't want to blow through usage in 3 days and
nothing for the remaining 4." And: "Last week I ended with >70% usage available because I wasn't able to facilitate
development."

So there is no budget in dollars. The price is flat, paid extra usage is switched off on the account, and usage not
spent by the weekly reset is lost. Dollars at list price stay as a yardstick for comparing one kind of work with
another, and nothing else.

**What can be read.** The plan reports two gauges with every run: the share of the current five-hour window that is
used and when it resets, and the share of the week that is used and when it resets. Proved on 2026-11-23: one small
headless run returned both (the window at 8 percent, the week at 5 percent, the week resetting on Sunday).
InProgress records them from every turn the lead runs, and asks with a run that costs a tenth of a cent when it has
heard nothing for an hour. The usage is one pool for every project, so there is one pacer, above the projects (4.4).
One reading proves the gauges can be read. It does not prove that the plan's terms allow headless runs at this
volume, or that a window is always worth the same share of the week: stage 0 checks the first, and the pacer keeps
measuring the second.

**Three numbers, in plain code:**

- **Left:** the share of the week not yet used, less Aiden's reserve.
- **The line:** the share that should be used by now if the week is spent evenly.
- **Room:** what the windows still to come can take before the reset. What one window is worth as a share of the week
  is measured, by watching the two gauges move together; it is not assumed. Only windows in which the laptop will be
  awake count.

**Four modes.** The pacer sets the mode, and the lead chooses the work.

| Mode | When | The lead |
|---|---|---|
| Hold | Usage is more than 10 points ahead of the line | Starts only what Aiden asked for, and no surplus work. Says so, with the day the line catches up. |
| Steady | Within 10 points of the line | The limits of 5.4 |
| Catch up | More than 10 points behind the line | Raises his own limits and starts more: first from the maps, then down the surplus list |
| Use it or lose it | Left is more than four fifths of Room | Every window from now runs full, and he says what share will be lost if one does not |

Aiden proposed two checks: one at the halfway point of the week, and one for when there are too few windows left to
spend what remains. The second is "Use it or lose it", as he described it. The first is replaced by the line, read
from the first hour of the week: a week that waits until Thursday to notice has only the back half's windows to
catch up in.

The pacer never slows Aiden's own asks. If his asks are what put the week ahead of its line, the lead says once when
the week will run out at that rate and what he would hold back, and Aiden's word decides.

**Aiden's reserve (fixed).** The lead does not start his own work, or keep it running, into the share held for
Aiden. What that can and cannot promise:

- In the week: the last 5 points are Aiden's until the final window before the reset. The aim is to end the week
  between 95 and 99 percent used, when there is worthwhile work and the reserve allows it. A week that ends lower
  says in the note what went unspent and why.
- In the window, while Aiden is at work: the lead's own work leaves 30 percent free. That is a promise.
- In the window, in his usual hours before he arrives (InProgress knows them from when he has spoken over the last
  four weeks): the same share is a target. The lead plans the windows around those hours, and he cannot give usage
  back if Aiden sits down early after a full night. A miss is counted and shown.
- **One account of headroom.** Starts in every project draw on one count of what is free, in the week and in the
  window. Before a start the lead sets aside what that session is expected to use, from what sessions in its lane
  have used before, with a margin. A start that does not fit does not happen, so two projects cannot spend the same
  room.
- **Work in flight is counted, and can be paused.** When Aiden is at work and the window passes its line, the lead
  pauses surplus sessions at their next turn and picks them up after the reset. Stage 0 proves the pause. Until it
  is proved, no surplus work runs in a window that reaches Aiden's usual hours.
- A reading older than an hour, or none: no starts on the lead's own judgement. Aiden's own work is never held.
- When the modes disagree, the reserve comes first, then Use it or lose it, then Hold.
- The lead stops starting work in a window at 85 percent, so that sessions in flight finish before the wall and not
  into it. A session that does hit the wall is a stopped session (5.4), picked up after the reset.
- When Aiden starts talking to a session, surplus work in that project gives way to it.
- Paid extra usage is spending money. It is on the list of three, and the lead never turns it on.

**The surplus list.** Aiden: "There won't always be work for Claude to pump out with extra resources available - we
should have some kind of sink for it to use the tokens on." In Catch up and in Use it or lose it, the lead takes the
highest of these that has work:

1. **Pull forward.** The next steps on any project's map whose definition says "For Aiden: nothing", in Aiden's
   order of priority among projects.
2. **Get ahead of Aiden's moments.** What will need him soon is made ready now: two or three mocks for the next taste
   step where one would have done, the research behind a decision that is coming, the definitions for the next
   outcome. His part is then waiting for him, and not the other way round.
3. **Upkeep.** Each project keeps a list the lead adds to as he works: tests where steps keep being reopened, an
   audit of a module on the risk list, missing end-to-end checks, updates to what the project depends on, dead code,
   slow tests, docs that have drifted. He admits these himself under the In gate. They are built as chores and
   standard steps and land by the landing check. This is Aiden's "proposing or implementing fix branches on existing
   projects".
4. **The lead's own exam.** A second Opus reads the week's decisions cold and marks the ones it would have made
   differently, and the backtest is run against changes to his rules. At most three of these reach the weekly note,
   as "worth a look".
5. **The sandbox project.** One project Aiden names as the place surplus goes when the rest is dry (Glimpse-mobile
   today). He gives it a few sentences of intent, once. The lead writes its map and runs it at his widest: everything
   lands without Aiden except the list of three, and its results wait as cards he looks at when he likes.

Two rules hold on every rung:

- **Surplus work never adds to what reaches Aiden.** It raises no decision for him. What it finds that is his waits
  in the book for the weekly note. A branch that needs his eye waits unmerged in a pile of at most five, and when
  the pile is full the lead takes work from another rung.
- **Used is the aim; useful is how he chooses.** Landing proves nothing here: upkeep the lead admits and lands
  himself would always count. So four weeks on, InProgress reads each piece of surplus work for itself. Later work
  was built on it, or a check it added caught something: used. It is still there and nothing has touched it: idle.
  It was undone or replaced: undone. Aiden is not asked. A rung that is mostly idle or undone gets less.

**What a shut lid costs.** A night with the laptop asleep is room that cannot be used. The note says what it cost,
so the choice stays Aiden's: "the lid was shut for 14 hours: about a fifth of the week could not be spent."

**Grok.** Its plan is flat as well. Whether its usage can be read is looked at in stage 0. Its surplus goes to
errands that look and do not act: trying each result's "Try it" in a browser the way Aiden would, and checking the
dashboards the book says are half set up (stage 6).

## 6. How the lead reaches Aiden, and Aiden the lead

**Enough context to act, and no more.** Aiden, 2026-11-22: "Anytime that I am being asked for input, or in any view
that I am expected to consume, I expect there to be ample context for me to grasp what we are talking about. I don't
like when AI asks me a question or states something to me like I know exactly what it's talking about." And: "I just
don't want you to go overboard ... not having every interaction flood me with context I may already know."

So everything that addresses him stands on its own, and carries context in proportion to how fresh the thing is for
him. InProgress knows when he last touched a step. The lead judges from that. As a guide:

| The thing is | He gets |
|---|---|
| Fresh: he touched it today, or he is talking about it now | Its name and the question |
| Recent: he touched it this week | One line first: what it is and why it is in front of him |
| Cold: older than that, or he has never seen it | Two or three lines first: what it is, why it exists, where it stands |

Always: a step is named by its id and title, never a bare number; no term is used that he was not given; and "more"
gets him the whole background. "What is this?" from him is a miss: that kind of thing carries more next time.

### 6.1 The daily note

Written by the daily pass, one per project. A dozen lines; a part with nothing in it is left out; a day with nothing
has no note. He can skip it for a week and nothing stalls except what is under "Yours".

```
InProgress · Sunday 22 November · since Saturday 8:00
Yours (2)
  The board's drag and drop (#812): two mocks are ready in its thread. <link>
  GitHub Pro, 4 dollars a month, to protect the offsite backup of your data (#516 Offsite backups). "pay it"
In your hand (2)      #722 Parked projects: park InGame from its menu. <link> · #721 The title follows T3's thread
Today I am            starting #537 Truth's review of a day of capture; running the restore check on a scratch home
Decided for you (2)   d52 #537 Truth: capture T3's own thread state beside the hooks. "undo d52"
                      d53 cut the strict hook validation proposal: it undoes #545.
Went wrong (1)        the #812 session stopped at 02:10; restarted from its record, 20 minutes lost
Forecast              Phase closes about 12 December (was 10 December: #537 Truth slipped two days)
The lead              14 calls, median 70 s, slowest 2 min 50, none late
The week's usage      41 percent used, the line says 44 · steady · no window reached your reserve
```

Every line that asks something carries the exact words that answer it; every decision the words that undo it.

### 6.2 The Voice, and the lead's thread

The Voice is how Aiden and the lead talk. It is one Grok Bot for every project: Progresser today. Aiden reaches him
by chat or by voice, from anywhere. Aiden, 2026-11-23, on what was missing when stage 0 took one idea of his to a
result by hand: "I would've told him to start the task he would've told me when the task had its mock ready when I
asked for the mock images it would've been relayed through him. Alternatively, I can just go to the T3 session and
get them if I'm on my laptop and then when I said, ship it to the Grok Bot, he will let the session know and it
would be in the working app the next time I sit down on my laptop".

- **He is the lead speaking, not a second mind.** The Voice holds nothing of his own. For the project named he reads
  its rules and its desk before he speaks, and acts with the lead's commands under the lead's rules. The log says
  which calls were made at the desk and which with Aiden.
- **He speaks first.** When something is Aiden's, when a mock is ready to pick from, when a result is in his hand,
  the Voice tells him: one message, batched, held in quiet hours he sets.
- **He passes pictures.** "Show me the mocks", "what does it look like": the mock or the result's screenshot comes
  back through him. Stage 0 showed why: a result that sat on the laptop while Aiden had only his phone waited 68
  minutes for a picture.
- **He carries the go-ahead** (5.4): "ship it" said to him reaches the session, and the result is in the working
  app when Aiden next sits down.
- **T3 Code stays open to him.** At the laptop Aiden can go into any session's thread and look or answer for
  himself, and the lead has a thread of his own there that does everything below. With Grok off, the Voice and his
  messages are lost; the desk, the cards and the threads carry on.

Wherever this document says "the lead's thread", the Voice does the same. They are two doors to one lead.

**Who does what.**

| | |
|---|---|
| Judging while Aiden is not talking: a session's question, a hand-in, what starts next | A desk turn: a fresh Claude turn started by InProgress (5.7) |
| Acting on Aiden's word: "start it", "send it back", "ship it", "park that", "undo d52" | The Voice, in the conversation, with the lead's commands. Or the lead's thread |
| What Aiden leaves open ("you decide the rest") | It goes to the desk. The Voice makes none of the lead's judgement calls: one mind judges, and it is the one the exam measures |
| Waking the round; queues; follow-ups | InProgress, in plain code. Never the Voice's memory |
| Spending the week's usage | The pacer, in plain code, reads the gauges and sets the mode. The lead's daily pass chooses the work and starts it (5.8). The Voice only reports it, and carries Aiden's "hold" or "go harder" |
| Telling Aiden | A card in the window, always. And one line to the Voice, so his phone has it |
| Outside the repo | The Voice looks (6.5) |
| With Grok off | The Voice and his messages are lost. The round, the cards and the lead's thread carry on |

**One Bot for every project.** He holds nothing: for the project Aiden names he fetches that project's rules and
reads its desk before he speaks. If he mixes two projects, the fallback is one Voice per project. He reads back a
step's title before he acts on it, because a voice mishears numbers.

**How the Voice is wired.** Three links. Each is proved in stage 0 before anything is built on it.

1. *Aiden's words to the desk.* The Voice runs the lead's commands. Today he does it through Grok's desktop app,
   which has a shell on the laptop. The vendor says that app pauses its link when nobody is at the laptop, and
   Aiden's own log shows it failing; away from the laptop is exactly when he picks up the phone. So the lead's
   commands are also served as a connector: over https, with a sign-in, the lead's commands and nothing else. Aiden
   said yes to a connector on 2026-11-22. It opens a door to the laptop, so it lands on his word.
   *Stage 0 found (P9, 2026-11-25):* the desktop link answered every time the laptop was awake, in 16 to 25
   seconds, woken by webhook with nobody typing. It failed once, with the laptop asleep under a closed lid, and a
   connector would not cure that, because it too runs on the laptop. So the connector is not in stage 1. An awake
   laptop left alone for hours was not sampled: stage 1's own mark (what is his reaches his phone within five
   minutes, nine times in ten, over a week) shows it if the link drops then, and the connector returns.
2. *The desk's words to Aiden.* What is his leaves the desk twice: as a card in the window, and as one line to the
   Voice's routine, by its webhook, which he passes to the phone. Batched, capped per day, held in quiet hours. The
   webhook carries only words InProgress wrote: a routine woken that way may be held back from acting, so it is
   never asked to act.
   *Stage 0 found:* a line to the webhook shows in the chat and, on Aiden's word (no count was taken), his phone is told, once the Bot's own notification
   setting is on. A routine woken that way can also act on the laptop (it ran a lead command inside half a
   minute). The round still never depends on that; the errands of 6.5 are what use it.
3. *Pictures.* A mock or a result's screenshot is a file on the laptop. The Voice finds it with a lead command
   (`lead step` lists a step's documents and their files), copies it to his own computer and shows it in the
   conversation. *Stage 0 found (P9, 2026-11-25):* this works, under one limit that no setting changes. Grok's file
   tools copy only from inside the user folder (`C:\Users\<user>`), and the project's own folders are outside it. So
   a picture the Voice shows is a document on a step, kept in InProgress's documents folder for the project
   (`~/.inprogress/resources/<project>/`), and a session that wants Aiden to see a picture attaches it to its step.
   The lead's rules say so from version 6. The fallback is the session's thread in T3 Code's phone app.

The grind never rides on Grok: no queue, no follow-up and no judgement lives in the Voice, and every stage works
with Grok closed.

Talking to the lead, by either door:

- **It acts.** "Start #721", "tweak #722: start it closed", "park that", "where are we": it does these itself with
  the lead's commands. Aiden's words are recorded exactly.
- **Several things at once:** one message from the lead, in the order of what blocks most, each with the words that
  answer it. "Pay it, the second mock, you decide the rest." Each answer is recorded against its item.
- **A question or feedback for a session:** "ask the #812 session why it chose tabs". The lead passes it to that
  thread marked as Aiden's words, word for word, and brings the answer back. A design conversation belongs in the
  session's own thread, which is one tap away in the same app.
- **"Where does InGame's launch stand?"** Any lead can read another project's front page and daily note and answer
  from them; he acts only on his own project. The page above the projects (4.4) answers it for all of them.
- **Cards in the window** carry the same things with Accept and Park, for when Aiden is at the desk.
- **Being told on the phone:** the Voice's message. Stage 0 showed the Voice can speak first, on Aiden's word and not on a count (above). T3 Code's
  own notification is the fallback: stage 0 showed it reaches his phone, with a lock-screen widget. Claude's push
  was refused twice and is dropped.

### 6.3 The result, in his hand

When a step that was Aiden's idea, or that has something to see, is accepted, he gets one card and one line in the
lead's thread:

```
#722 Parked projects is live.
You asked: "a project with no work in play should nag about nothing."
You can now: park a project from its menu in the window; it moves under Parked and leaves every count. Starting a
             session in it wakes it.
Try it: the window, on InGame. Or look: <screenshot> <20-second recording>
Decided for you on the way: the Parked group keeps its asks, they only stop counting. "undo d47"
Not right? "tweak #722: ..." and it is changed, usually inside ten minutes.
```

A result that is not live yet (a mock, a branch that waits on his word) is held on a check surface running on a copy
of his data, linked the same way.

### 6.4 From the phone

The laptop is the whole system: sessions, InProgress and T3 Code run on it. It must be on, awake and online.

| Aiden wants to | From the phone | What blocks it | The way round |
|---|---|---|---|
| Talk to the lead | The Voice, in Grok's app | A sleeping laptop: stage 0 showed his link answers whenever the laptop is awake and not at all when it sleeps. Still to sample: an awake laptop left alone for hours (an earlier finding says Grok's desktop app pauses its link then) | The lead's thread in T3 Code's phone app, which stage 0 showed works. The laptop must be reachable; a phone unused for 30 days pairs again |
| Answer in a session, pick a mock | The session's thread, same app | A mock may not render | It is exported as an image |
| Hold a result | The result card's screenshot or recording, passed by the Voice (shown once in stage 0, on Aiden's word, for a picture that is a step's document) | A live page on the laptop is not reachable; a picture kept inside the project's folders cannot be copied by Grok | The recording; the live thing waits for the desk |
| Give a yes | To the Voice, or in the lead's thread | | Recorded in his exact words and carried to the session (5.4) |
| Be told | A message from the Voice (in stage 0 on Aiden's word; not counted) | The Bot's own notification setting must be on | T3 Code's own notification, proved in stage 0 |

To prepare: the laptop never sleeps on mains and does nothing when the lid closes; InProgress and T3 Code start at
sign-in; T3 Connect is set up and the phone paired. The lid is the exception, by Aiden's word of 2026-11-25: "I'm
aware that this doesn't work when the laptop is closed. That's a known limitation, but I work around it." And: "my laptop is often left on overnight. Sometimes it will also be closed/off. I only expect T3/Grok/InProgress to work when the laptop is "on", and if it's on overnight, then technically work can be ongoing, I just won't be around if I'm sleeping obviously."
So the lead works whenever the laptop is on, nights included, and nothing is expected of him when it is closed or
off. The power settings are left as they are. With the lid shut the lead is asleep (stage 0 saw it: lid closed
22:06 to 10:23, and everything of the lead's slept with it), and the note says what that held back (5.8). **The phone day**, once, in stage 0: laptop at home on mains,
Aiden out with the phone on mobile data, six things tried (ask where we are, give a new idea, answer what is his,
reply in a session's thread, look at a mock, receive a message) and all of it again two hours later.

### 6.5 The Voice's second job: the lead's hands outside the repo

Aiden: "T3 should be enough to interface with the system ... but Grok Bot will also shine for computer-use stuff."

- **What it does.** Errands in a browser that no session can do: read a billing page, check a DNS record, set up a
  service's dashboard, fill in a store listing. The lead writes the errand as a brief that stands on its own; Grok
  does it and reports what it saw and did; the lead writes that into the book with the date.
- **What stays Aiden's.** A sign-in only he can make, a payment, and anything that cannot be taken back. The lead
  prepares those as a click list.
- **How it starts.** Looking first. Then errands where every step can be taken back. The first three run with Aiden
  watching.
- **Progresser,** today's Bot, is the Voice (6.2). He keeps every command he has.
- **The link.** As in 6.2. An errand goes out the way a message does, as a line to the Voice's routine, and its
  result comes back by a lead command.

## 7. Where work lands

The lead never touches git or a deploy. Sessions do, under that project's own ship rules. The lead holds the
project's **landing card**, kept in the playbook InProgress prints into every briefing. He drafts it from the repo
when he takes a project on. It is in effect at once, and Aiden corrects it when he wants.

| Line | What it says | InProgress's own card |
|---|---|---|
| Branches | Where work happens. The lead's start gives each step its own worktree, branch, port and scratch folder. | One worktree and one branch per step, off main |
| Staging | What it is, how a session pushes there, how to check it | None. A scratch server on a copy of the data stands in. |
| Production | What it is, who may push, how to check it is live | main, after a green deploy, then a push |
| Risk list (fixed) | What never lands without Aiden's word. The landing check reads the change against it. | The database, the hooks and installer, the deploy scripts |
| Clean-up | What a hand-in must leave behind | The branch merged and deleted, the worktree removed |

Work marked "nothing" for Aiden lands when the landing check and the project's checks are green. The lead's ruling
comes after the landing and never holds one up: a risk he sends back is a second round on the same step.

Only Aiden's word shrinks a risk list; the lead may propose it, with the proof. Aiden has said so for one case
(2026-11-22): once a restore from the offsite backup (#516) has run clean on a scratch home, an add-only data change
proved on a copy is the lead's to land.

## 8. Models, and what the evidence says

**Opus 5.5 makes every call the lead makes**: the gate calls, the answers, the definitions, the daily pass, the Phase
pass and the lead's thread. A cheaper model is used only for a kind of call where the exam (section 10) shows no
loss, and none is assumed.

The backtest, on the 51 questions that reached Aiden, each answered blind from the record alone:

| | Haiku | Sonnet | Opus 5.5 |
|---|---|---|---|
| Decided himself, under the narrow rule of the first draft | 11 | 20 | 10 |
| Decided the way Aiden did | 5 | 14 | 9 |
| Recommendation matched Aiden's answer, where comparable | 18 of 35 | 11 of 25 | 22 of 36 (18 of 38, by a second judge) |
| Of the 20 proposals that were later built, let in | 9 | not run | 17 |
| Cost and time for one call | 0.2 cents, 31 s | 2 cents, 26 s | 6 to 10 cents, 26 to 41 s |

What this does and does not show:

- The samples are small and the judge was a model that disagreed with itself between runs. Treat every figure as
  rough.
- Opus 5.5 was the most careful and the closest to Aiden. It was not the same as Aiden: about half to three fifths.
- It was tested under a narrow rule (decide only when the record answers it). The rule in this design is wider, and
  that rule has not been tested. Stage 0 tests it before anything is built: how many of the 51 would still reach
  Aiden, and where the lead decides, how often Aiden's recorded answer went another way on something that mattered.
- The 9 of 10 is from the ten questions Opus chose to answer under the narrow rule. It does not say how often he
  will match Aiden on the decisions he is now told to make.
- The lead had the record alone in the test. In use he reads the thread and the code as well.
- **Stage 0's exam (2026-11-23), on 121 past asks.** Under the rule as first written the lead failed: he waved
  through ten landings that were Aiden's and let a session create a repository on Aiden's account. Under the
  narrowed rule now in 5.4 he granted no landing and no account action and asked needlessly twice. Two things did
  not come right. 49 percent of the cases still reach Aiden, because about half of what he was asked in the past
  really was his. And one in four of the lead's own decisions differed from Aiden's in a way that mattered. The
  full tables are in the stage 0 results page.

Aiden's position, which the design follows: "the point of building this sturdy workflow is to start trusting Opus
more, letting it make the call on more decisions."

## 9. Keeping the build honest

What went wrong in November: parts were reported against criteria Sigmund wrote and not against what Aiden wanted to
be able to do; the approved design was narrowed in three places without saying so; three stages shipped before any
of their checks came back; each check was a twenty-minute written walkthrough, so it waited.

- **Design and build calls are Sigmund's.** Aiden: "You should be making those design/implementation calls." They are
  made, named in the stage's result, and never brought as questions. What changes what Aiden would see, feel or be
  asked is shown to him first.
- **Every stage's build plan opens with scenes:** three to six things Aiden will be able to do, from his seat, with
  the exact words and screens. Frozen before the build. Done means each scene shown working. Reports say "4 of 6
  scenes", never "shipped".
- **Each stage ends as a result in his hand** (the card of section 6.3): what he can now do, where to try it, a
  recording of the scenes on a copy of his data, and the deviation log. Two minutes to look at.
- **A deviation log, kept as it happens:** "Plan said A. Built B. Because C. To undo: D."
- **A check by someone who did not build it:** a fresh reviewer gets only the scenes and the running build and
  answers per scene: shown, not shown, differs. Its report reaches Aiden unedited.
- **At most one unchecked stage:** the next stage may be built on a branch while a look waits; nothing lands on top
  of a stage he has not looked at.
- **"What I would ask if I were you":** each result names the three things most likely to differ from what he
  pictured.

## 10. Knowing it works before it is trusted

**Thirteen scenes of the finished lead.** Every stage says which it makes true.

1. Aiden tells the lead a new idea in a sentence. The definition is read back inside two minutes and a session is
   running inside three, with nothing more from him.
2. A session's question is answered in ninety seconds. Aiden reads one line about it the next morning.
3. A proposal that would undo an old decision is declined, with the reason and what to do instead.
4. A hand-in arrives with four known risks. The lead accepts two, makes one a step, sends one back.
5. Mocks are ready. The Voice tells Aiden on his phone and passes the pictures. He picks by telling the Voice, or
   in the session's thread.
6. A result lands in his hand: what he can now do, and where to try it. "Tweak: make the header smaller", and it is
   changed inside ten minutes for under 60 cents.
7. Something breaks overnight: a session stops, a deploy goes red, two changes conflict. It is handled. One line in
   the morning.
8. Morning: one short page for every project. Nothing on it needs him except what is under "Yours".
9. A month away. "Where were we?" The pick-up note, written fresh, with what is half done outside the repo.
10. The lead tells Aiden something he did not ask: "Output has halved. Here is why. I have parked three steps; I
    would cut the viewer overhaul from this Phase."
11. "Is the DNS record live?" Grok looks. The book has the answer, with the date.
12. The lead is off. One switch, and the project works as it does today.
13. Thursday evening, half the week's usage is unspent. By Sunday's reset 96 percent is used, on work that landed or
    that proved useful, and the lead's work took no window past Aiden's reserve while he was at work.

**The measure that matters most: what Aiden gets, and what it costs him.** A quiet week would halve a raw count of
asks with nothing being better, so the count is taken per result. Stage 0 measures the last eight weeks, by the
queries the gauges will use:

- which of the results he asked for he received, and how long from his words to something he could use;
- what reached him (reviews, questions, permissions) per result delivered, and the minutes it took him;
- tweaks after a result, in two kinds: a change of taste once he had seen it, and something he had said that was
  missed. Only the second counts against the lead.

The targets: by the end of stage 3, half of what reached him per result, or less. By the end, only the list of
three: over two weeks he marks anything that reached him and was not his, and the target is none.

**The exam.** Two scores, kept apart:

- **Whose call was it?** Each case is labelled Aiden's or the lead's by the list of three: Sigmund labels, a second
  judge labels blind, and a case they split on is scored both ways. One case where the lead decides something that
  cannot be taken back fails the whole run. Missed taste or direction, needless interruptions, and harmless
  differences are each reported on their own line. A lead who always asks fails, and so does one who always decides.
- **Was the answer acceptable?** Only for the cases that were the lead's to decide.

The 51 past questions and 41 proposals shaped the rule, so they cannot be its only test. Stage 0 also runs cases the
rule has not seen (what Aiden has been asked since, and the other projects' records), and live cases are kept back
for later runs. Live work adds to it: each would-have beside Aiden's answer, and each undo. A change to the lead's
rules or his model ships only if both scores are at least as good.

**The before picture.** The numbers in the record file are measured again every week by the same queries: what
reached Aiden, what a small change cost, what cold caches cost, how many steps closed.

## 11. The stages

Each stage is built from its own plan, written just before it starts and opening with its scenes. Section 9 applies
to every one. Each takes something off Aiden, none needs a later one, and every change to the database only adds.
There is no read-only stage: from stage 1 the lead acts for real.

| Stage | What is built | Off Aiden's hands | Scenes | The database | Done when |
|---|---|---|---|---|---|
| 0. Proofs and a clear deck | No product code. A desk turn on a copy of the data, 50 times, and once across a server restart. A start that cannot happen twice: a stub stops the runner after a start is made and before its receipt is saved, and two starts are raced for one step. One action that is Aiden's (a release tool about to publish) held before it runs. The exam of section 10 on the wider rule of 5.3. The baseline of section 10, with one meaning of a close. The sentence by hand: one small idea of Aiden's taken from a sentence to a result and a tweak with what exists today, Sigmund doing by hand what the lead will do, so that Aiden holds one result before anything is built. The lead's thread and a session's thread from the phone; the phone day. Which message reaches the phone. Whether a stuck permission prompt can be answered for a session. The Voice's four checks, with Aiden at Grok: he speaks first; he passes a picture; a "ship it" said to him reaches a session; his link to the laptop holds with nobody at it. One Grok errand, look-only, out and back. The plan's usage gauges read on an Opus turn and recorded for a week: what one window is worth, and Aiden's usual hours. Whether Grok's usage can be read. Whether a session can be paused at its next turn. The definition head-to-head on ten past steps, including the seven reopened. The 43 old asks sorted by the lead's rule, and the six checks that wait on Aiden, each with a recommendation. | The old asks, in one sitting | none | none | 50 of 50 turns keep their tools and leave no trace on the live record; the stopped start and the raced starts each end as one session and one message; the held action did not run; on the exam the lead decides nothing that cannot be taken back, at most a third of the cases still reach Aiden, and each kind of miss is counted; Aiden has held the result of the sentence by hand and said what felt wrong; each phone check has a result and a way round; what one window is worth is measured; the old asks are answered, decided or waived |
| 1. The desk answers | The desk and its items. The turn runner (5.7). A session's question answered by the lead inside the limits. Numbered decisions and "undo", with a bare list of them in the lead's thread each morning (the daily note comes in stage 4). What is Aiden's brought prepared, with the would-have. Stopped and stuck sessions handled, with what is Aiden's held before the act (5.4). A start that cannot happen twice (5.7). The landing check in plain code, from stage 0's prototype, so a session's request to land is answered by it and not by the lead (5.4). "The lead is behind". The Voice and the lead's thread in T3 Code: Aiden's words reach the desk by either, and his go-ahead is carried to the session (5.4). Progresser's rules rewritten: he reads the desk and acts on Aiden's word, and the judging moves to the desk. What is Aiden's goes out as one line to the Voice as well as a card. The connector, if stage 0 shows Grok's desktop link does not hold with nobody at the laptop. The week's usage recorded from every turn, and "how is the week?" answered in the lead's thread. Aiden's reserve. Open decisions counted per project. A switch that turns the round off. | Sessions' questions; stopped sessions | 2, 7 in part, 12 | New tables: desk items, turns, decisions, usage readings | Each scene shown; over a week every session's question was answered or brought inside its limit, with at least ten answered by the lead; no item was acted on twice; what was Aiden's reached his phone through the Voice within five minutes, nine times in ten; a day with Grok closed changed nothing in the round; Aiden has read the week's decisions and says which, if any, were his |
| 2. An idea becomes work | Definitions and the Ready gate. The In gate: admit, merge, decline. A new idea told to the Voice, or in the lead's thread: defined, read back to him and started. The lanes, and the lean session for tweaks. The lead's own starts. Each start hands out a worktree, branch, port and scratch folder. Sigmund reads the definition. | Writing up ideas; vetting proposals; choosing what starts | 1, 3 | New columns on a step: definition, lane, for Aiden, admitted | Each scene shown; five ideas of Aiden's went from a sentence to a running session with nothing more from him; one old step with no definition was defined as it started; every proposal in a week has a recorded answer |
| 3. Work becomes a result in his hand | The landing check, against the project's risk list as its playbook holds it today (the full landing card comes in stage 4). Closed, landed and live recorded apart (2.3). The hand-in and the lead's ruling on known risks. Accept and return. The result card, brought by the Voice with its picture. "Ship it" and "tweak" said to the Voice. Reopen and "tweak". Tweaks accepted on green checks. A session's "done" becomes a hand-in. The Lead view in the window (mocks first). The switch that turns the gates off. The first round. | Reviews that are not taste; closing steps; small changes | 4, 5, 6 | A new table for hand-ins and rounds | Each scene shown; ten steps closed on the lead's accept; five tweaks landed inside the target; what reached Aiden per result that week is half of stage 0's figure or less; and the first demonstration, live: one idea from a sentence spoken to the Voice, from the phone, to a result Aiden opens from its card, then a tweak; one action of Aiden's held before it ran; one interrupted start that recovered as one session. Stages 4 to 7 do not start before it. |
| 4. The lead keeps house | The daily pass and the daily note. The gauges. The tidying chores. Old backlog gone through. The book, its pages and the pick-up note. The landing card. The remaining rows of 5.4. The pacer's four modes and the surplus list (5.8): pulling forward, getting ahead of Aiden's moments, upkeep, the lead's own exam, and the count of what became of it. The lead's weekly numbers. | Tidying; asking what is still valid; picking up after a gap; finding work for spare usage | 7, 8, 9, 13 in part | A new table for notes | A week of notes, each a dozen lines or fewer; three real things that went wrong were handled without Aiden; merged branches and worktrees are gone; "where were we" after a week of silence is right when checked against git and names one thing outside the repo; in a week that fell behind its line the lead started more without being asked, that work raised nothing for Aiden, and what becomes of it is being counted |
| 5. The map and foresight | Outcomes under a Phase; steps tied to outcomes; "your moments"; the Phase pass; the forecast; the map in the window (mocks first). The sandbox project (5.8) gets its desk: a few sentences of intent from Aiden, a landing card, a map, a first round. | Planning the Phase; being surprised by what needs him; facilitating work to use the week | 10, 13 | A new table for outcomes | The map is written and Aiden has read it; the daily pass picks its starts from it; the forecast moved with the work for two weeks; the lead told Aiden one thing he had not asked that proved right; a week ended with 95 percent or more of the usage spent, or the note says what went unspent and why, and the lead's work took no window past Aiden's reserve while he was at work |
| 6. Hands outside the repo | Grok errands: the brief, the routine, the result into the book. Grok's spare usage put to looking: each result's "Try it" tried in a browser. | Looking things up in dashboards and accounts | 11 | none | Three errands done with Aiden watching, then five without; each result is in the book with its date |
| 7. The next project, and the page above | A second project of Aiden's own work gets its desk: intent, landing card, map, first round. The page across projects. The order of priority, which the pacer follows. | Holding the projects in his head | 8 in full | none | The page's "Yours" equals the projects added up; a week across them that ended with 95 percent or more of the usage spent |

**What each proof of stage 0 is for.** A proof that fails holds back only what depends on it.

| Proof | What depends on it | If it fails |
|---|---|---|
| The desk turn, 50 times; the start that cannot happen twice; the held action | Stage 1 and everything after | Nothing is built until it passes |
| The exam on the wider rule | How wide the lead's rule is from stage 1 | The rule is narrowed to what passed |
| The plan's terms for headless runs | The turn runner as designed (5.7) | Turns run inside the lead's T3 Code thread |
| The phone checks, and which message reaches the phone | 6.4 and scene 5 | The desk and the window work without them; the way round is used |
| Answering a stuck permission prompt for a session | One row of 5.4 | It stays Aiden's, shown in the window |
| Pausing a session; what a window is worth | The reserve and the pacer (5.8, stage 4) | No surplus work in a window that reaches his usual hours |
| The Voice's four checks | How Aiden talks to the lead from stage 1 | Until they pass, the lead's thread in T3 Code and T3 Code's own notification carry it, both proved in stage 0. If the link does not hold with nobody at the laptop, the connector returns to the plan |
| The Grok errand | Stage 6 only | Stage 6 is changed or dropped; nothing else waits |

**Complete when**, after two weeks across the projects:

- five ideas went from a sentence to a result in his hand with nothing from him in between but a pick;
- nothing reached him that was not on the list of three;
- at least three things went wrong and were handled without him;
- he has not asked anyone what on the board is still valid;
- both weeks ended with 95 percent or more of the usage spent, or the note says what went unspent and why;
- the lead's work took no window past Aiden's reserve while he was at work; and
- nothing he undid had to be undone twice.

## 12. What can go wrong, and the guard

| Failure | Guard |
|---|---|
| The lead chooses differently from what Aiden would have | Expected (5.3). Every decision is one line in the note and taken back in a word; an undo becomes a ruling; stage 0 measures how often before anything is built. |
| It asks more of Aiden before it gives anything back | Stage 0 sorts the old asks. By Aiden's word of 2026-11-24 he does not read them off a page: they are triaged with the Voice and the lead once the desk answers (stage 1); every stage names what it takes off him; what reaches him is measured weekly against a target |
| A session is confidently wrong and lists no risk | Reopens are counted by lane and fed to the Phase pass and Shipwright's retro |
| Work lands that should have waited for Aiden | The landing check reads every change against the risk list before it lands, in plain code |
| Usage runs away: a session restarted again and again, starts that lead to starts | The pacer holds when the week is ahead of its line (5.8); every start counts; two restarts and he changes the approach |
| Usage is left unspent at the reset | The line is read from the first hour of the week; the surplus list gives the pacer work; the note says what a shut lid cost (5.8) |
| Spare usage is burned on work nobody wants, or it puts more in front of Aiden | Surplus work raises no decision for him; what became of it four weeks on moves usage away from a rung that is mostly idle or undone |
| A start happens twice, or two turns take the same step | An id written before each outside action and looked for after a crash; a step and a place in flight claimed in one write (5.7) |
| Something of Aiden's is done before he is asked | Held before the act, judged by what the action does (5.4); the landing check reads the revision that lands |
| The same item is acted on twice | A lease per turn, written down; each item moves once (5.7) |
| The lead is down | The item stays; one retry; "The lead is behind"; the switch that puts the project back to today |
| InProgress itself is down after a bad deploy of its own | The deploy rolls itself back on red, and any session's start brings the server up. Until then there is no lead: the cost of the lead living in the thing he builds. |
| The week's usage is gone early, or a window is full when Aiden sits down | Aiden's reserve, fixed (5.8): one account of headroom for every project, work in flight counted and paused, 30 percent of the window free while he is at work. In his usual hours before he arrives it is a target, and a miss is counted and shown. |
| Small work gets heavier | The tweak and chore lanes; the landing check; a tweak outside its target shows in the note |
| His memory is thin on a project | The first round and the book start it; he says what he could not find and never guesses |
| Something visible lands that Aiden does not like | It is in the result with a screenshot; "tweak" changes it in minutes; a new look always starts as mocks |
| The build drifts from this design | Section 9, all of it |
| The Voice says one thing and the desk did another | Both read the desk before they speak or act. One log, and each call says who made it. The Voice never answers from memory |
| One Bot mixes two projects | Rules and desk are fetched per project, per answer. Fallback: one Voice per project |
| Grok is down, limited or changed by an update | The cards in the window and the lead's thread in T3 Code. The round never used Grok |
| The Voice records a yes Aiden did not give | His exact words are stored with when and where he said them, and the note lists what was done in his name |
| The Voice has a shell on the laptop | As today: his rules allow the lead's commands only. A rule, not a wall. The connector narrows it to those commands |
| Everything runs on one laptop | Known. With the lid shut the lead is asleep; the note says how old it is. |
| Headless Claude turns at this volume | Runs on Aiden's login as a session does; the plan's terms for it are checked in stage 0 |

## 13. Cost

Aiden pays a flat price: 160 dollars for the Claude plan and 40 for Grok. Nothing the lead does changes that bill, and
paid extra usage is off. So cost is counted in the week's usage (5.8). The dollar figures below are list prices, kept
as a yardstick for comparing one kind of work with another.

- A reflex call on Opus 5.5: 6 to 10 cents from the record alone, 35 to 50 cents when he reads the thread and code.
- The daily pass: two to four dollars per active project per day. The Phase pass: larger and rare.
- What he starts costs more than he does: about 9 dollars a session at today's median.
- Across all projects the busy weeks to date ran at about 45 dollars a day.
- The week before this was written ended with more than 70 percent of the usage unspent. What share of a week one
  dollar at list price is has not been measured; stage 0 measures it.
- Usage already being wasted that the lead should win back: 173 dollars to cold caches in six weeks; 1.69 dollars
  for each thirty-line change.

## 14. What changes in InProgress, and what does not

Changes: the record (new tables and columns only: desk items, turns, decisions, usage readings, the step's
definition, lane and hand-ins, notes, outcomes); the lead's commands; the gates; the turn runner; the pacer; the
landing check; the Lead view and the
map view (both mocks first); Sigmund's lanes, landing check and hand-in; the message a session gets from the lead;
Progresser's rules (he becomes the Voice: he reads the desk and acts on Aiden's word, and judges nothing himself);
the command that records Aiden's answer, which now carries his go-ahead; the line to the Voice's routine; the
connector, if stage 0 calls for it.

Does not change: the lead never writes or reviews code; the checks, Murr and Parvati judge the work; Aiden's Done
button; nothing unmerged runs against his real data; with the lead off every count is true and every decision can
still be made; a work project never gets a lead.

Not planned for, on Aiden's word: a session that passes itself off as the lead, or text planted for the lead to cite.
The message a session gets from the lead changes the hooks, which are on the risk list, so that change lands on
Aiden's word like any other.

## 15. The words

| Word | Meaning |
|---|---|
| Step | One contained piece of work in a project's plan. Aiden's "task". |
| Definition | What "done" means for a step: its done-when lines, written by the lead |
| Lane | How much ceremony a step gets, by its size and risk |
| Desk | Where InProgress puts what the lead must deal with |
| Turn | One fresh run of the lead on one desk item |
| Round | The lead clearing his desk |
| Hand-in | A session's "I am finished", with its known risks |
| Landing check | InProgress's own read of a change before it lands: size, lane, risk list |
| Landing card | A project's rules for branches, staging, production, the risk list and clean-up |
| Risk list | What never lands without Aiden's word in a project |
| Result | The card Aiden gets when something is in his hand |
| Would-have | What the lead would have chosen, recorded before Aiden answers |
| The map, the book, the gauges | The plan by outcomes; the project's memory; its measurements |
| Pick-up note | The book's front page: where we are |
| The week's usage | The share of the plan's weekly allowance that is used. One pool for every project. |
| Window | The plan's five-hour allowance, which resets on its own |
| The line | Where the week's usage should stand by now if it is spent evenly |
| Reserve | The share of the week, and of the window, that the lead leaves for Aiden's own work |
| Surplus list | Where spare usage goes, in order, when the week is behind its line |
| Sandbox project | The project Aiden names to take spare usage when the rest is dry |
| Mandate | The text every session gets that says what it may decide for itself |
| Shipwright | The workflow sessions build under: Sigmund, Sev, Murr, Parvati and their checks |
| Progresser | The name of InProgress's lead, and of the Grok Bot who is his Voice |
| The Voice | Grok Bot: how Aiden and the lead talk, by chat or by voice, from anywhere. He speaks first, passes pictures and carries Aiden's go-ahead (6.2) |
| T3 Connect | What links T3 Code's phone app to the laptop |
