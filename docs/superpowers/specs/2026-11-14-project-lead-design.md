# A lead on every project: InProgress under a Grok Bot lead

Date: 2026-11-14. Status: draft for Aiden's approval. Design only, no code; the plan follows approval. Step #716.

Builds on `2026-10-20-inprogress-redesign-design.md` (the mirror, the backlog, project memory). Evidence and test
results are in the resource "Grok Bot as project lead: feasibility tests" (r706).

## 0. The pitch

You stop being the main person on every project. Each project gets a lead who knows it better than you are expected
to, carries its state, keeps the board true, and comes to you only for what only you can give: what gets built, why,
what is good enough, and what stops. You are the holder of intent. The lead is a Grok Bot you can reach by chat, phone
or voice. InProgress is what makes that Bot trustworthy: the record it reads on every wake, the bar it holds work to,
and the rule for when it speaks.

## 1. Intent and the why

### Aiden said

- He has had InProgress for a month and has not reached for it. Projects still get messy and he makes rash decisions to
  see things move.
- The rash decisions come from being asked whether a session met its definition of done without the information to
  judge. He lets it go stale, rubber stamps it, or hands the call back to Claude. Then the dashboard goes stale and he
  asks Claude what on it is still valid.
- What has helped: sessions marking their state in their names, and steps with static ids.
- He wants one point of contact per project who carries the overhead, "except for when it needs me". He does not want
  to be the main person on every project.
- He likes the window, the idea, and the project documentation. He does not want items sitting there with no sign of
  whether they matter.
- The lead settles fixes, refactors, tests and docs alone. Anything he would see or feel comes to him with a prepared
  walkthrough.
- The leads are Grok Bots, one per project, from day one. He drives Claude Code through T3 Code.

### My calls (correct them)

- The lead is a role written down in InProgress. A Grok Bot runs it. The Bot's own memory is never the record.
- The first project is InProgress, because the Bot "Rich" is already connected to it and the build happens here.
  The second is the project with the largest stale pile (InGame or Glimpse).
- A project has at most 3 threads in flight.
- The lead gets Supervised access to T3 Code, not Full access.

## 2. Goals, non-goals, anti-goals

Goals: Aiden never has to ask what on the board is still valid; every call that reaches him arrives with evidence, a
recommendation and a default; work he does not need to see lands without him; one conversation per project tells him
where it stands.

Non-goals: replacing Sigmund's roster (Murr, Parvati and the checks still judge the work); a chat inside the window;
the lead writing code; a front door across all projects (later, section 7).

Anti-goals: a lead that goes quiet; state that lives only in a Bot's memory; another rule a session must remember; a
decision that reaches Aiden without what he needs to make it; spend that grows with every event.

## 3. Evidence

- `status` on 2026-11-14: 44 items "need you" across 9 projects, almost all on projects with no live session.
- Connection test, 2026-11-14: a Grok Bot connected to T3 Code through T3's MCP server over T3 Connect, listed the 17
  InProgress threads and said correctly what the open one was waiting on. It also named the gap itself: it could see
  the threads but not InProgress's own items.
- From this machine: a Claude session can be started, tracked by InProgress and resumed from a plain shell. A first
  turn costs about 18 cents before any work. The InProgress CLI cannot add, close, drop or park a step.
- Others running Grok Bot over coding agents: one Bot per project holds up; the Bot is unreliable at follow-ups (4 of
  24 finished threads never reported, a hold on merges never reached the threads), its memory is hidden, and each event
  wake costs a model turn. The advice that recurs: keep queues, follow-ups and state in plain code, and let the Bot
  reason and talk.

## 4. Approaches

1. **Grok Bot lead from day one (chosen by Aiden).** One Bot per project drives T3 threads over MCP, with InProgress
   as its record. A standing lead he can reach anywhere, at once. The risk is that it rests on the parts others found
   unreliable; section 6 is how InProgress catches them.
2. **Claude lead only.** A standing Mip thread per project in T3 Code. Same model as the workers and no new vendor,
   but no voice and no presence outside T3.
3. **Role first, Bot second.** Build the plain-code half, run it with a Claude thread, add the Bot later. Safest, but
   the experience he wants arrives last.

## 5. The design

### 5.1 The lead's job

On each wake (Aiden messages it, the morning round, or InProgress wakes it):

1. **Read.** One call returns the lead brief for its project (5.3). It also reads thread state from T3.
2. **Settle what it may.** For a step in the settle-alone class whose bar is met, it tells the thread to merge. It
   closes, drops or parks what is stale, clears asks from ended sessions, and answers a worker's question when the
   project record already holds the answer.
3. **Bring the rest to Aiden** as decision cards (5.2), batched.
4. **Commission.** With room under the cap, it starts the next backlog step as a T3 thread, with the handoff Mip
   already writes and the bar attached.
5. **Write it down.** Every settle, every decision and every promise goes into InProgress before the turn ends.

It never judges code itself. The bar is checked by the tests, Murr and Parvati; the lead reads their verdicts.

### 5.2 What reaches Aiden

Only three kinds of call: one that needs taste or direction, a bar that has to change, or something outside what was
agreed. Each arrives as a card. A made-up example:

```
#412 Board: drag to reorder                      Glimpse · ui
Ready to merge. Needs your eye: it changes how the board feels.
Evidence: checks green · Murr pass · Parvati 6/6 · walkthrough (4 screens)
Lead recommends: merge
If you say nothing: stays parked, lead asks again Monday
```

He answers in the Bot's chat. The answer is recorded with its reason in the decision log, and the lead reads that log
before it asks anything again.

### 5.3 What InProgress builds (the plain-code half)

- **The bar on a step.** Acceptance criteria and a class (settle alone, or bring to Aiden), set when the step is
  commissioned. Sigmund already sets a bar at the start of a change; this stores it where the lead can read it.
- **The decision queue.** Needs me becomes a list of cards, each with evidence, a recommendation, a default and a
  date. An item with none of those is not allowed in it.
- **The decision log.** What Aiden decided and why, per project.
- **The lead brief.** One read-only command: where the project stands, what changed since the lead last looked, what
  is in flight against its bar, what is stale, what is promised and due.
- **Lead commands.** Close, drop, park, commission, record a decision, record a promise. Today these exist only
  inside a Claude session.
- **Holds.** A hold is a field on a step or project that the workers' hooks read. It is never a message someone has
  to pass on.
- **The promise ledger and wake rule.** Anything the lead says it will come back on is a row with a due time. A
  watcher with no model in it batches events (bar met, bar failed, ask raised, promise due), applies a daily cap,
  and wakes the Bot through its routine. Nothing passes, nothing wakes.
- **The project doc.** The lead's standing knowledge of the project, kept in the repo. This is job 3 of the
  October redesign, now with a reader.
- **The window as the lead's desk.** Three things: Decisions for you, In flight against the bar, and the lead's log.

### 5.4 How the Bot reaches things

Threads: T3 Code's MCP server over T3 Connect, Supervised access. InProgress: the lead brief and lead commands, run
on this machine. How the Bot calls them (its own local tools, a second connector, or a T3 thread) is the builder's to
settle with a test; the commands are the same either way.

## 6. What can go wrong, and the guard

| Failure seen elsewhere | Guard |
|---|---|
| The Bot goes quiet after "I'll get back to you" | The promise ledger wakes it when due; an overdue promise shows in the window |
| A hold never reaches the workers | Holds are data the hooks read |
| Bot memory drifts or is wrong | It reads the lead brief on every wake; its memory holds nothing the record lacks |
| Spend grows with every event | The watcher batches and caps; reading state is a command, not a model turn |
| The laptop is asleep | The lead says it cannot reach the machine, and queues what it would have done |
| T3 sign-in expires after 30 days | The lead brief carries the expiry date; the lead warns a week ahead |
| A lead on another model misjudges the work | It does not judge the work; it reads the roster's verdicts |

## 7. Stages

1. **Triage (no new authority).** The lead brief, read-only. The lead's first job is the stale pile: for each of the
   open items it proposes close, drop, park or decide, and Aiden answers in batches.
2. **The bar, the decision queue, the decision log.** Decisions start arriving as cards.
3. **The lead acts.** Lead commands, Supervised access, the settle-alone class, commissioning under the cap.
4. **The lead comes to you.** The watcher, the wake rule, the promise ledger.
5. **Spread.** The window reshaped, a second project, then a primary Bot as the one front door across projects.

Each stage is its own spec-sized change through Sigmund. Stage 1 is worth having alone.

## 8. How we will know

After two weeks on the first project: Aiden has not asked anyone what on the board is still valid; no decision card
sat past its date without its default applying; every merge he approved came with a walkthrough; the count of calls
reaching him per day is one he would call reasonable. If any of these fails, the stage that owns it is reworked before
the next project is added.

## 9. Left to the builder

The lead brief's exact fields; how the Bot calls InProgress commands; the watcher's thresholds and daily cap; the
Bot's standing instructions; whether Mip's reconcile marks become the lead brief's stale list; the migration that
adds the bar and class to a step.

## 10. Open

Grok Bot's cost and weekly limit under this use are unmeasured. Stage 1 measures them before stage 3 adds load.
