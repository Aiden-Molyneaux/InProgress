# A lead on every project: InProgress under a Grok Bot lead

Date: 2026-11-14. Status: draft v2.1 for Aiden's approval. Design only, no code; one plan per stage follows approval.
Step #716. Version 1 was reviewed the same day from seven angles; section 4 lists what that changed. Version 2.1
corrects two claims in version 2: which T3 commands were run (section 3), and how hard the approval check and the
Read only level are (6.3, 6.6, 7 and 11).

Builds on `2026-10-20-inprogress-redesign-design.md` (the mirror, the backlog, project memory). Test results are in
the resource "Grok Bot as project lead: feasibility tests" (r706).

## 0. The pitch

You stop being the main person on every project. Each project in play gets a lead who knows it better than you are
expected to, carries its state, and comes to you only for what only you can give: what gets built, why, what is good
enough, and what stops. You are the holder of intent. The lead is a Grok Bot you can reach by chat, phone or voice.

InProgress is what makes the lead trustworthy. It holds the record, decides who may approve what, and performs every
mechanical act itself. The Bot reasons and talks. If the Bot is off, nothing on the board goes untrue: you lose the
voice, not the picture.

## 1. Intent and the why

### Aiden said

- He has had InProgress for a month and has not reached for it. Projects still get messy and he makes rash decisions to
  see things move.
- The rash decisions come from being asked whether a session met its definition of done without the information to
  judge. He lets it go stale, rubber stamps it, or hands the call back to Claude. Then the dashboard goes stale and he
  asks Claude what on it is still valid.
- What has helped: sessions marking their state in their names, and steps with static ids.
- He wants one point of contact per project who carries the overhead, "except for when it needs me". He does not want
  to be the main person on every project. He is the holder of intent.
- He likes the window, the idea, and the project documentation. He does not want items sitting there with no sign of
  whether they matter.
- The lead settles fixes, refactors, tests and docs alone. Anything he would see or feel comes to him with a prepared
  walkthrough.
- The leads are Grok Bots, one per project, from day one. He drives Claude Code through T3 Code.
- Version 1 read sound to him. He asked for it to be criticised so the build is right on the first pass.

### My calls (correct them)

- The lead is a role written down in InProgress. A Grok Bot runs it. The Bot's memory is never the record.
- **The Bot asks, InProgress acts.** Threads are started and messaged by InProgress through T3's own CLI. The Bot's
  access to T3 Code stays Read only.
- **Approval is data.** It is checked by the commands that land work. Nobody's chat message is an approval.
- A project with no work in play is parked, not led. InProgress is the first project to get a lead.
- Limits: 3 threads in flight per project, and 5 open decisions for Aiden across all projects. When his 5 are full,
  leads stop starting work that will need him.
- Work that lands without him starts in confirm mode (one click from him) and becomes automatic per project when he
  switches it. This follows his October rule that unsupervised work is opt-in, never the default.
- The lead may carry his yes, recorded with his words.
- The window's decision cards get two buttons, accept and park. This reopens a small part of October's "no answering
  in the window": a card with a recommendation is not a chat.
- Mip becomes the lead. The mip-orc skill runs the same role in a Claude session, for when the Bot is down.

## 2. Goals, non-goals, anti-goals

Goals: Aiden never has to ask what on the board is still valid; every call that reaches him arrives with evidence, a
recommendation and a default; work he does not need to see lands without him; one conversation per project tells him
where it stands, in the same shape every time; with the Bot unreachable, every count is still true and every decision
can still be made.

Non-goals: replacing Sigmund's roster (the checks, Murr and Parvati still judge the work); a chat inside the window;
the lead writing or judging code; design conversations through the Bot (they stay in T3 threads with Aiden, and the
lead books them); a merge queue.

Anti-goals: a lead that goes quiet; state that lives only in a Bot's memory; a check that passes when its evidence is
missing; another rule a session must remember; a new noun where an existing one will do; spend that grows with every
event.

## 3. Evidence

- `status` on 2026-11-14: 44 items "need you" across 9 projects, almost all on projects with no live session.
- That pile is unbuilt work, not neglect. Sections 4.1 to 4.6 of the October spec (a waiting state captured by hooks,
  ended sessions clearing their asks, park on Needs me) are not implemented. They are step #537.
- The title markers Aiden relies on do not run under T3 Code. The title channel is tied to the Claude desktop app
  (`src/hooks/handlers.ts:204`, `src/server/schemas.ts:138`), and so is Open session (`src/server/open-desktop.ts`).
  A session row has no T3 thread id; T3 provides one as `T3CODE_THREAD_ID`.
- Sigmund sets the bar in chat, and Murr's and Parvati's verdicts live in chat (`.claude/skills/sigmund/SKILL.md`
  151 to 168, 250 to 266). His merge rule needs the owner's explicit go-ahead (298 to 299).
- T3 Code, on this machine: `t3 thread list` and `show` were run from a shell with every T3 variable unset and
  answered with no sign-in. `start` and `send` have only been read from their help; neither has been run. `start` has
  no flag for the mode, so a thread InProgress starts is expected to run at the environment's default, which here is
  Full access. A thread record carries its status, mode, settled flag and a link; a message carries its role and text,
  not who sent it. An outside app's access level caps the mode of any thread it starts, and approvals cannot be
  answered over MCP, so a Bot with Supervised access cannot run unattended work.
- Grok Bot: connected to T3 Code at Read only and read the InProgress threads correctly. Its connectors are shared by
  every Bot on the account. A routine can be woken by a webhook whose key the Bot cannot read itself. Its local tool
  permission on this machine is set to `always`, read here as: a Bot's commands run on this laptop as Aiden, without
  asking.
- Cost: the first turn of a new Claude thread is about 18 cents; waking a long idle thread is about a dollar.
- Others running Grok Bot over coding agents: one Bot per project holds up. The Bot is unreliable at follow-ups (4 of
  24 finished threads never reported; a hold on merges never reached the threads), its memory is hidden, and every
  event wake costs a model turn. The advice that recurs: keep queues, follow-ups and state in plain code.

## 4. What the review changed

| Angle | Weakness in version 1 | Change |
|---|---|---|
| Aiden's day | The judgement moved from the end of a step to its start: he would be asked to set a bar per step. Parked cards would become the next stale pile. | Sigmund drafts the bar from the intent record; Aiden confirms only bars with a visible criterion. Five open decisions at most, and leads work at his pace. |
| The big picture | Nothing above the step: the lead had nothing to hold work to, and "where are we" had no fixed answer. | An intent record per project, a lead brief that reads from the goal down, and parked projects. |
| Reliability | The Bot was trusted to act and to write it down. | The Bot asks, InProgress acts. One queue in plain code; an item stays open until a command closes it. |
| Authority | Supervised access stalls every worker on approvals; more than that lets any Bot on the account start unattended agents on this laptop. Approval lived in messages. | The Bot stays Read only on T3. Approval is a record checked where work lands, and a missing record blocks. |
| Ground truth | Built on a mirror that is not true and a driver InProgress does not know. | Stage 0 comes first: T3 Code support and the truth work of #537. |
| The builder | Verdicts had nowhere to live; triage needed commands scheduled two stages later; four new nouns for one mechanism; three coordinators. | Evidence records, stages re-cut, asks extended, Mip becomes the lead. |
| Cost | Cold threads woken to be told to merge; a Bot polling. | Safe work lands while its worker is still warm. A watcher with no model in it batches the wakes. |

## 5. Approaches

1. **Grok Bot lead from day one (chosen by Aiden).** Version 2 keeps it and puts the acting half in plain code.
2. **Claude lead only.** A Mip thread per project. No voice and no presence outside T3. Kept as the fallback runtime.
3. **Role first, Bot second.** Safest, but the experience he wants arrives last.

## 6. The design

### 6.1 Principles

1. **The Bot-off test.** With the Bot unreachable, every lane and count is true and every decision can be made.
2. **The Bot asks, InProgress acts.** Every act is a typed command that InProgress validates, performs and logs.
3. **Approval is data, checked where work lands, failing closed.**
4. **One queue, two owners.** Everything waiting on someone is an ask, owned by Aiden or by the lead.
5. **Aiden's attention is the limit.** Work is pulled at his pace, not pushed at him.
6. **Intent is written once and read every time.**
7. **It comes to him where he already is:** the thread title, the lead's chat, the window.

### 6.2 The record

- **Project.** Status gains `parked`: no lead, no counts, nothing nagging. An **intent record**, a page in the owning
  repo shown in the Library: the goal, the current phase and what done means for it, what is out of scope, what Aiden
  cares about, standing rulings. The lead writes it from one conversation with him. Without it a lead can read a
  project but nothing can be commissioned.
- **Step.** A **bar**: criteria, each marked visible or not. A **hold** flag. A **class** that is derived, never
  declared: a visible criterion, or a diff that touches the surfaces the project lists as ones Aiden sees, makes it
  "needs Aiden"; otherwise "lands alone". **Evidence**: checks, Murr's verdict, Parvati's verdict per criterion, the
  walkthrough. Each is written by whatever produces it (the deploy script; Murr and Parvati as their last act).
- **Ask.** Gains an owner (Aiden or the lead), a recommendation, a default, a due time, links to evidence, and the
  words it was answered with. A decision for Aiden, something the lead must handle, and a promise the lead made are
  all asks. Answered asks are the decision log.
- **Session.** Gains its T3 thread id and the hook-captured waiting state from October's 4.1.

### 6.3 Who may approve what

| Work | Approval comes from |
|---|---|
| Lands alone, evidence complete | The rule, at the worker's ship step, while it is still warm. Confirm mode adds one click from Aiden. |
| Needs Aiden | His click on the card, his go-ahead typed in the thread, or his yes to the lead, recorded with his words |
| Held | Nothing |
| A backlog item parked or dropped | The lead when its origin is `proposed`; Aiden when it is `me` or `asked` |

The check lives in the commands that land work (the deploy script and a pre-push hook on main), so it applies to any
agent and to Aiden's own hands. It is a guard, not a lock. Workers run at Full access, and one that skips the hook or
merges without the deploy script is not stopped. So InProgress also compares main with its approval records on its
own, and a commit on main with no record behind it shows in the window and in the daily note. Sigmund's merge rule is
rewritten to read the check.

A go-ahead typed in a thread counts as Aiden's only when InProgress did not send that message itself: it logs every
message it relays, and the prompt hook sees every message a worker receives. Through T3 the Bot cannot write to a
thread. Whether anything else on the laptop can is section 11.

### 6.4 The lead's job

It wakes when Aiden messages it, when InProgress wakes it, or on a morning round.

1. **Read the lead brief.** Always the same shape: goal, phase and progress, in flight against the bar, waiting on
   Aiden, for the lead, next up, stale, landed since last look, said in Aiden's name, and the health of its own links.
2. **Handle what is the lead's.** Answer a worker's question from the record, push back on a failed bar, re-commission
   or park a step whose session died, sort out stale items.
3. **Bring Aiden his decisions** as cards, and record his answers.
4. **Commission** the next step. InProgress checks the intent record, the What, Why and bar, the limits and holds,
   then starts the T3 thread with a handoff rendered from a template.
5. **Promise.** Anything it will come back on is an ask it owns, with a due time.

It never judges code, never approves work that needs Aiden, and does not hold design conversations: it raises a card
saying a thread is waiting to talk to him.

Workers know the lead exists. The session briefing names it and says a question that changes what gets built is
raised as an ask, not left in chat.

The Bot's standing instructions live in the repo with a version number. Every lead command carries that number, and
the brief warns when the Bot is running an old one.

### 6.5 What reaches Aiden

Three kinds of call only: taste or direction, a bar that has to change, or something outside what was agreed. A
made-up example:

```
#412 Board: drag to reorder                      Glimpse · ui
Ready to land. Needs your eye: it changes how the board feels.
Evidence: checks green · Murr pass · Parvati 6/6 · walkthrough (4 screens)
Lead recommends: land it
If you say nothing: stays parked, lead asks again Monday
```

Once a day, one note: what landed without him, and what was recorded in his name.

Where he sees things: T3 thread titles carry the marker and step id again; the lead's chat; and the window, which
becomes the lead's desk with Decisions for you, In flight against the bar, the lead's log, and one line per project
in play.

### 6.6 How the pieces connect

| Link | Route |
|---|---|
| Bot to InProgress | The lead commands. Simplest: run on this machine through Grok Bot's local tools, which today is an open shell. Confined: InProgress serves only those commands as its own connector, or a small T3 thread whose permissions allow only those commands. Aiden picks (section 11); stage 1 proves the one picked. |
| Bot to T3 Code | Read only |
| InProgress to T3 Code | `t3 thread start`, `send`, `show`, `list` |
| InProgress to Bot | A watcher with no model in it posts a batch to the Bot's routine webhook |
| Fallback | The mip-orc skill, on the same brief and commands |

## 7. What can go wrong, and the guard

| Failure | Guard |
|---|---|
| The Bot goes quiet | Its items stay open; the watcher wakes it once more, then shows them to Aiden in the window |
| A hold never reaches the workers | A hold is data the landing commands read |
| A worker goes around the landing commands | InProgress compares main with its approval records; a landing with no record shows in the window and the daily note |
| Bot memory drifts | It reads the brief on every wake; its memory holds nothing the record lacks |
| A verdict is never recorded | The step cannot land |
| The Bot records a yes Aiden did not give | His words are stored, and the daily note lists what was said in his name |
| Spend grows with every event | The watcher batches and caps; reading state is a command, not a model turn |
| The laptop is asleep | The watcher is asleep too, so nothing wakes the Bot; asked directly, the lead says how old its last brief is |
| T3 sign-in expires after 30 days | The brief carries the date; the lead warns a week ahead |
| T3 Code or Grok Bot changes under us | Four thin links (6.6), each replaceable; the Bot-off test |

These guards are against a Bot or a worker that is wrong. They do not stop one that is hostile, or one that works
around a refusal on purpose. Section 11 covers that.

## 8. Stages

Each is one change through Sigmund and is worth having alone. Rich can already answer from T3 threads today.

0. **True ground under T3 Code. No Bot involved.** First, `t3 thread start` and `send` run once from the InProgress
   server, since stage 3 rests on them. Then the T3 thread id on a session; the title channel and Open session
   under T3; waiting state from hooks, and ended or settled sessions clearing their asks (this finishes #537);
   parked projects. *Accept:* no project shows "need you" without a live session or an open decision behind it; a
   thread's title shows its marker and step id within one turn; a thread started from the server appears as a
   session with its T3 thread id.
1. **The lead reads and talks.** The lead brief; the read commands plus answer, park, drop and promise; the Bot route
   Aiden picked, proven; instructions v1; the intent record for InProgress; triage of what stage 0 left. *Accept:* asked "where are
   we" twice, the lead gives the same facts in the same shape as the brief; with the Bot off, the window answers it.
2. **The bar and the gate.** Bars, classes, evidence, asks as cards with accept and park, the approval check in the
   landing commands, Sigmund rewritten, confirm mode. *Accept:* a step with no Murr verdict cannot land; a held step
   cannot land; a needs-Aiden step cannot land on a message alone; a lands-alone step lands on one click, no chat; a commit put
   on main around the check shows in the window as landed without a record.
3. **The lead acts and comes to you.** Commission and relay, the limits, the watcher and webhook, the daily note,
   automatic mode on offer. *Accept:* with the Bot off for a day nothing lands that should not and everything waiting
   shows in the window; a promise past its time shows as overdue.
4. **Spread.** A second project, then a primary Bot as one front door across projects.

## 9. How we will know

After two weeks on the first project: Aiden has not asked anyone what on the board is still valid; no card sat past
its date without its default applying; every merge he approved came with a walkthrough; nothing landed alone that he
would have wanted to see; the calls reaching him per day are a number he would call reasonable; Grok Bot's spend is a
number he would call reasonable. A miss sends its stage back before the next project is added.

## 10. Left to the builder

The brief's exact fields; the surfaces list format in the playbook; the watcher's thresholds and daily cap; where the
approval check sits in each project's landing commands; how Murr and Parvati write their verdicts; the migrations
(all additive); the handoff template; whether the fallback T3 thread is needed.

## 11. Open, and Aiden's to decide

- **Work repos are in reach of the Bots.** This T3 Code environment holds `C:\work\vRepos` and
  `vps-claude-skills` beside the personal projects, and the T3 connector is shared by every Bot on the account,
  including ones that read untrusted pages. At Read only that means their threads can be read. Whether work projects
  stay in this environment is his call, and perhaps his employer's.
- **Read only limits the T3 connector, not the Bot.** Grok Bot's local tools on this laptop are set to `always`, so a
  Bot has a shell that runs as Aiden. From that shell `t3 thread list` answers with no sign-in (tested), `start` and
  `send` are expected to, and InProgress's own CLI runs. So a Bot could start a Full access thread, message a worker,
  or run any InProgress command, and nothing on this laptop could tell it from him. This is true today, with or
  without this design. What the design adds is that its simplest route (6.6) needs that shell left open. The confined
  routes cost more: InProgress as its own connector needs an https address and a sign-in; the T3 thread route needs
  the Bot's T3 access raised so that it can send. My recommendation: a confined route, and local tools off `always`,
  before any project is switched to automatic mode. Whether Grok Bot can limit local tools to named commands has not
  been checked; if it can, that is the cheapest confined route.
- Grok Bot's cost and weekly limit under this use are unmeasured. Stage 1 measures them.
