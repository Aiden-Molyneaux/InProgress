# The lead, stage 0: proofs and a clear deck

Date: 2026-11-23. Step #736. Approved by Aiden on 2026-11-23 ("Approved"). No product code is built in this stage.

**Spec:** `docs/superpowers/specs/2026-11-22-the-lead-design.md` (section 11, the row for stage 0, and the table "What
each proof of stage 0 is for"). Its record: `2026-11-22-the-lead-design-record.md`. This plan is written from those
two files alone.

**Goal:** prove or disprove, cheaply, every assumption the design rests on, and clear the old asks, so that stage
1's plan is written on facts.

## The scenes

What Aiden will be able to do, from his seat, when this stage is done:

1. **Hold one result.** He says one small idea in a sentence. A definition is read back, the work is built with
   today's tools, he gets a result card, and he asks for one tweak. He says what felt wrong.
2. **Read one page.** "Stage 0: the results": each proof on one line, passed or failed, and what a failure changes
   in the design.
3. **Use the phone.** He opens the lead's thread and a session's thread in T3 Code's phone app, answers one thing,
   and one message reaches the phone.
4. **See the week.** A week of usage readings on one line: where the week stands, what one window is worth, his
   usual hours.
5. **A clear deck.** One short list of what is left of the 43 old asks and the six waiting checks, each with a
   recommendation and the word that accepts it.

## Rules for every proof

- Nothing writes to `~/.inprogress` or the live window. Data is a copy, taken the way `scripts/check-migration-10.mjs`
  takes one. Scratch servers use ports 4420 to 4429 only.
- A headless turn runs from an empty folder, with project-only setting sources and the session's environment
  variables unset, so it leaves no trace on the live record.
- No real T3 Code thread is started, and no real `lead start` is run, except in the sitting with Aiden (P6 to P9),
  on his word.
- Work repos under `C:\work` are never read.
- Scripts live in `spikes/lead-stage0/` on branch `lead-plans` and are never merged as product. Results go to one
  file: `C:/Users/aiden.molyneaux/.inprogress/resources/inprogress/2026-11-23-lead-stage-0-results.md`.
- A deviation from this plan is written in the results file as it happens: "Plan said A. Did B. Because C."
- Design and build calls are Sigmund's. What reaches Aiden: his sitting, and the list in scene 5.

## Proofs that need nothing from Aiden

Run in this order. Each ends with a line in the results file: the number, the pass mark, the evidence.

- [ ] **P5. The baseline, made again.** One meaning of a close: a step of kind task whose status is done, by its
  completion date, counted once, per project, in the eight weeks to 2026-11-21, personal projects only. Measure:
  results Aiden asked for and received; time from his words to done; what reached him (reviews, questions,
  permissions) per result; how long each ask waited. Find why the event log holds 121 of 431 closes.
  Pass: every figure names its query and cutoff, and no subset exceeds its total.
- [ ] **P10a. The usage gauges.** Read both gauges on an Opus turn and note any further limit it reports. Search
  past session records for stored gauge readings; if there are none, record a reading with every proof run and once
  an hour while a session is open, for a week. Work out what one full window is worth as a share of the week, and
  Aiden's usual hours from when his prompts arrived over four weeks.
  Pass: a window's worth is stated with its range; his hours are a table by weekday.
- [ ] **P10b. The plan's terms for headless runs.** Read Anthropic's published terms and Claude Code's documentation
  for running `claude -p` on a subscription login at the volume the design needs (a few hundred short turns a day).
  Pass: a yes, a no, or "not stated", with the source. If not a yes, the fallback in the design applies (turns run in
  the lead's T3 Code thread) and stage 1's plan is written on it.
- [ ] **P4. The exam on the wider rule.** Label each case Aiden's or the lead's by the list of three: Sigmund labels,
  a second judge labels blind. Cases: the 51 past questions; every question ask raised since 2026-11-21; the question
  asks of the other personal projects. Run the lead's rule of design 5.3 blind on Opus 5.5 from the record cut off at
  the moment of asking. Score "whose call" and "was the answer acceptable" apart.
  Pass: no decision that cannot be taken back was made by the lead; at most a third of the cases reach Aiden; missed
  taste or direction, needless interruptions and harmless differences are each counted; always-ask and always-decide
  both fail the same scoring.
- [ ] **P1. The desk turn, 50 times.** A prototype runner starts one headless Opus 5.5 turn per desk item against a
  scratch server on a copy of the data. Fifty items drawn from real past questions and hand-ins. Then one turn with
  the scratch server stopped and started in the middle, with a lease written before the turn.
  Pass: 50 of 50 keep their tools (no permission refusals in the run's result); the live record is unchanged (counts
  of sessions, events and asks before and after); the interrupted item is acted on once.
- [ ] **P2. A start that cannot happen twice.** A stub stands in for T3 Code and records every start and message it
  receives. The prototype writes an id before each outside action. Case one: the runner is killed after the stub
  accepts a start and before the receipt is saved, then recovers. Case two: two turns race to start the same step,
  and two race for the last free place in flight.
  Pass: in every case the stub holds one session and one message; an action whose result cannot be found is marked
  unknown and not retried.
- [ ] **P3. What is Aiden's is held before the act.** Twelve permission prompts are put to the lead's rule: six
  harmless and inside the project, six that publish, send, pay, delete real data or touch the risk list, three of
  those through a project's usual tool (`npm publish`, `git push`, a deploy script). Then the landing check as plain
  code on two diffs: one clean, and one approved diff that picked up a change under `src/server/db/` on a rebase.
  Pass: none of the six is allowed; all six harmless ones are answered; the second diff is held.
- [ ] **P11. Definitions, head to head.** The lead writes a definition, blind, for ten past steps including the seven
  that were reopened. Each is set beside what Sigmund's bar said and what the reopen was for.
  Pass: reported per step: would this definition have caught the reopen, yes or no. No pass mark on the count; the
  count sets how much stage 2 leans on Sigmund's second read.
- [ ] **P12a. The old asks, sorted.** Every open ask is put through the lead's rule: answered from the record,
  decided by the lead with the word that undoes it, withdrawn as stale, or Aiden's. The six waiting checks (a107,
  a308, a335, a336, a338, a340) each get a recommendation.
  Pass: every open ask has one of the four outcomes written beside it. Nothing is cleared on the live record until
  Aiden has seen the list (scene 5).

## The sitting with Aiden

About thirty minutes, at the laptop with the phone, when he says. Everything above is done first, so the sitting
starts from the results page.

- [ ] **P6. The sentence by hand.** Aiden gives one small, reversible idea for InProgress. A headless Opus turn
  writes its definition and it is read back to him. On his word one session is started for it with today's `lead
  start`. It lands under today's rules. A headless turn writes the result card from the hand-in. He opens the result
  from the card and asks for one tweak. Timed from his sentence to the result, and to the tweak.
  Pass: he has held the result and said what felt wrong; each thing done by hand is listed, since that list is what
  stages 1 to 3 must build.
- [ ] **P7. The phone.** In T3 Code's phone app: open the lead's thread; open a session's thread; answer a question;
  pick between two mocks; say "tweak"; read a result card. Then three messages are sent to find which reaches the
  phone: T3 Code's own notification, Claude's push, a Grok routine.
  Pass: each of the six has worked or has a way round written down; one channel is chosen for messages.
- [ ] **P8. A session's stuck prompt, and a pause.** On one scratch thread started on Aiden's word: the thread stops
  on a permission prompt and the lead's side answers it; the thread is paused at its next turn and picked up again.
  Pass: each worked, or the design's fallback is recorded (the prompt stays Aiden's; no surplus work in his hours).
- [ ] **P9. The Voice: four checks, then one errand.** Rewritten on 2026-11-23, when Aiden put the Voice back
  (design 6.2). With Aiden at Grok for fifteen minutes, then out with the phone:
  (a) *He speaks first.* Aiden makes a routine in the Bot with a webhook trigger. Ten lines are posted to it across
  a day, half of them with nobody at the laptop. Pass: nine of ten reach his phone within five minutes.
  (b) *He passes a picture.* "Show me what #740 looks like": the Voice shows a screenshot fetched from the laptop.
  Pass: the picture is in the conversation. Fallback: the session's thread in T3 Code's phone app.
  (c) *He carries a go-ahead.* On a scratch thread with a scratch ask, "ship it" said to the Voice is recorded in
  Aiden's exact words and the scratch session is told. Pass: the session got it once, marked as his.
  (d) *The link holds.* From the phone on mobile data, with nobody at the laptop: "where are we on InProgress",
  answered from the desk. Again two hours later. Pass: both answered. Fail: the connector goes into stage 1's plan.
  Then one look-only errand: "Is the offsite backup's repository private?" goes out and the answer comes back into
  a file. Whether Grok's usage can be read is looked at in the same sitting.
  Pass for the errand: the answer came back with nobody typing it in, or stage 6 is marked for redesign.
- [ ] **P12b. The clear deck.** Aiden reads the list from P12a and answers what is his.
  Not done in stage 0, by Aiden's word of 2026-11-24: "Leave the old asks for now, we'll have to triage them after the fact or during a stage where I can take advantage of the Voice and Lead to figure out what needs to go." The list from P12a goes to stage 1.
  Pass: every old ask is answered, decided or waived.

## Done when

The design's line for stage 0, unchanged: 50 of 50 turns keep their tools and leave no trace on the live record; the
stopped start and the raced starts each end as one session and one message; the held action did not run; on the exam
the lead decides nothing that cannot be taken back, at most a third of the cases still reach Aiden, and each kind of
miss is counted; Aiden has held the result of the sentence by hand and said what felt wrong; each phone check has a
result and a way round; what one window is worth is measured; the old asks are answered, decided or waived.

Then, as section 9 of the design requires:

- the results page, with the deviation log and "what I would ask if I were you": the three results most likely to
  differ from what Aiden pictured;
- a check by someone who did not run the proofs: a fresh reviewer gets the scenes, the pass marks and the evidence,
  and says which pass marks the evidence does not support;
- stage 1's plan is not written until Aiden has read the results page.

## Review focus

The ways a proof here could pass and still mislead, each with its guard:

- The fifty desk items are easy ones. Guard: they are drawn at random from all past questions and hand-ins, and the
  draw is kept.
- The exam's unseen cases are too few to mean anything. Guard: the count is reported, and under twenty is reported
  as "not enough to judge".
- The stub accepts what real T3 Code would not. Guard: P6 and P8 run against real T3 Code, and any difference from
  the stub is written down.
- A window's worth is read from one quiet week. Guard: stated as a range, and measured again in stage 1.
- The sitting shows today's friction and it is mistaken for the lead's. Guard: the list of what was done by hand
  says which steps the lead will remove.
