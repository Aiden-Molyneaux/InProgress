# Lead stage 1: the four fixes Aiden accepted (#743)

Aiden, 2026-11-26, on a356: "go ahead with the four optional fixes". They come from the second independent check of
stage 1 (results page r811). Branch `lead-stage-1-desk`, worktree `.claude/worktrees/lead-stage-1-desk`. Nothing here
lands before his "ship it" on the stage.

Rules for every task: the house rules; no em dashes; never `~/.inprogress`, ports 4317 or 4399, the real `t3` or a
real `claude` in a test; Parvati's lane 4400 to 4409, Sev's e2e lane 4410 to 4419. Each task adds unit tests beside the
module's existing ones; a test must fail with its change removed.

## The bar

- C1. Undo d<n> with a reason, then the lead's next turn on the same step: its prompt names the undone decision, its
  question and his words, and says not to give that answer again; `lead step` shows the old ask's answer as withdrawn.
- C2. `lead old-asks next` with nothing left for this lead, while another lead's project still has open old asks: the
  last Voice line says `The old asks are done. Still open for another lead: InThink 6 (InThinker).`; `lead old-asks
  --all` names each project it left out and why.
- C3. `npm publish` held in a folder whose package.json says `x` `1.2.0`: the hook's reason, the Voice line and the
  morning list all say `publish x 1.2.0 to npm`.
- C4. A held command shows as a card in the window's Needs me band within two seconds of the hold, with what it does and
  two buttons; "Go ahead" records his yes for exactly that command and the session may run it; "Not yet" tells the
  session it waits; either takes the card away and clears a Voice line not yet sent. Clicking twice does one thing.

## Task A: rulings name their question (C1)

1. `src/server/lead/prompt.ts`: after the `Standing rulings` section (which reads `kind='ruling'` lines, lines 15-27),
   add a section `Undone by Aiden` built by the server from the project's `undo` lead_events of the last 30 days whose
   text is `d<n>` of a `decide` event with an ask: one line each,
   `- d<n> on #<step> "<the ask's question, clipped 120>": he withdrew "<the decision's answer, clipped 120>". His
   words: "<the undo's aiden_words, clipped 160>". Do not give that answer again; it is his now.`
   Newest first, at most 10. No section when there are none. It does not depend on what Progresser writes.
2. `src/server/lead-step.ts` (answers printed at :45): an ask whose `decide` event was later undone prints
   `answered <age> ago: <text> -> "<answer>" (withdrawn: Aiden undid d<n>: "<his words>")`.
3. `src/core/lead-rules.ts:170`: Progresser adds his reason as one line that names what it is about:
   `On "<the question, short>" (#<step>): <his reason, in his words> (undo d<n>, <date>)`. Update the pinned test
   `test/core/lead-rules.test.ts:144`. LEAD_INSTRUCTIONS_VERSION stays 7 (7 has not landed).
4. `scripts/lead-scenes/run.mjs` scene 4: the harness writes the ruling in that shape, and a PASS check reads the
   `Undone by Aiden` line in the next turn's prompt.

## Task B: the old asks name the rest (C2)

1. `src/server/lead/oldAsks.ts` `--all` (:112-127, `personalProjects` :100-105): projects whose lead has another name
   and that have open old asks are listed after the result, one line each: `Left for its own lead: InThink, 6 old
   asks (InThinker).` A project with no lead stays as today.
2. The done line (`intendOldAsksDoneLine`, `voice.ts:330`, called at `oldAsks.ts:179`): when other leads' projects
   still have open old asks, the line is `The old asks are done. Still open for another lead: InThink 6 (InThinker),
   <next>.` Counted with the same rule that picks old asks. Otherwise `The old asks are done.` as today.

## Task C: a held publish names the package (C3)

1. `src/server/lead/hold.ts` `judge` (:104-132): for a publish whose command is `npm publish`, `pnpm publish` or
   `yarn publish` (any flags), read `<folder>/package.json` (the `match.folder` the hook resolved): with a string
   `name` and `version`, `what` is `a publish of <name> <version> to npm`. Unreadable or missing: today's
   `a publish of <branch>`. Other publishes unchanged.
2. The morning list's Held line (`morning.ts`, `commandOf` today prints the raw command) says `#747 wants to publish
   <name> <version> to npm.` when the hold's `what` named a package: store `what` with the held item (its outcome, or
   the held event's text after the command and arrow, whichever keeps `commandOf` working), and print it in place of
   the command. A held item made before this change prints as today.
3. The Voice's held line reads the same `what` (it already uses `what`: check it now says `wants to publish x 1.2.0 to
   npm`, not `wants to do a publish of`). Drop the doubled "do a" wording for every `what`: `wants to <what>` reads
   `wants to publish ...`, `wants to deploy main to the live build`, and so on (word the `what`s as verbs).

## Task D: held commands as cards in the window (C4), after A to C

1. The snapshot the window reads gains the project's `held` desk items in `waiting_aiden`, each with its id, step,
   created time and the `what` of task C (or the command when there is none).
2. `web/src/board/NeedsMe.tsx`: a held card beside the ask cards, oldest first among them by time. Eyebrow `HELD`, its
   age, the text `#<step> wants to <what>.`, the command below in the mono face, two buttons `Go ahead` and `Not yet`.
   Same card frame, spacing and keyboard order as an ask card; follow `AskActions.tsx` for the buttons and the
   pending state.
3. A route `POST /api/ui/held/:itemId` `{ answer: 'go' | 'not-yet' }` in `src/server/routes/window.ts`: answers the item
   through the same path `lead answer --send` uses for a held target (`carry.ts` `leadAnswerItem`), as Aiden's own words
   said in the window now (`go ahead (window)` or `not yet (window)`), with a yes for exactly the actions of that held
   command on `go` and none on `not-yet`. The item must be `held` and `waiting_aiden`: anything else answers 409 and
   changes nothing, so a second click does nothing. A held Voice line still `intended` is cleared in the same write.
4. One e2e test in `test/e2e/ui.spec.ts`: a held item on a scratch home shows its card; Go ahead removes it and the
   landing check answers clear for that command; a second click is refused.
5. Parvati reviews the card at her viewports (C4, the keyboard path, the pending state, a long command).

## Order and checks

A, B, C, then D. `npm run typecheck`, the lead tests, `npm test`, the scenes harness dry run, and for D the e2e test on
a port from 4410 to 4419. Murr reviews the diff (Opus: D adds buttons and a route that records a yes); Parvati reviews
D; then the real scenes once more and an independent check of C1 to C4.
