# The lead decides (#734) Implementation Plan

> **For agentic workers:** build task by task, in order. Steps use checkbox (`- [ ]`) syntax. Sev never commits: Sigmund does.

**Goal:** The lead, and every session on a project with a lead, decides what Aiden can undo in one word, records it, and
brings Aiden only what is his; Aiden sees what was decided and can undo it.

**Architecture:** The mandate is text in code (`src/core/lead-mandate.ts`), one source for the lead's rules (version 4),
the session briefing and the window, so a lead cannot widen it. A decision is a line in `lead_events` (kinds `decide`,
`park`, `drop`; a new kind `undo`), or a step log a session wrote that starts `Decided for Aiden:`. Questions stay
Aiden's in the data, so with the Bot off he still sees and answers them. No migration: `lead_events.kind` and
`asks.answered_via` are free text.

**Tech stack:** TypeScript, better-sqlite3, vitest, React, Playwright. Same patterns as `src/server/lead-commands.ts`.

**Spec:** `docs/superpowers/specs/2026-11-14-project-lead-design.md` (section 1 "Aiden said", 2026-11-16 notes, and
section 6.7 added by this plan's Task 6). The mandate as Aiden reads it: resource "The mandate: what the lead decides
for Aiden" on #734.

## Global constraints

- No em dashes (U+2014) in any file. Plain ASCII in everything the lead's rules and the brief print.
- No migration, no change under `src/server/db/`. Schema stays 20.
- Every lead write is one `write()`: `requireLead` first (outside), then checks, the change and its `lead_events` line.
- A refused command throws before anything is written.
- Port lanes: Sev's e2e 4410 to 4419. Never 4317 or 4399. Never `~/.inprogress`.
- Rules version becomes 4 (`LEAD_INSTRUCTIONS_VERSION = 4`). Every test that pins `--instructions 3` or `Version 3` moves to 4.
- Do not touch: `scripts/`, `claude/`, `src/hooks/`, `src/mcp/`, `src/server/db/`.

## The bar

- C1. `lead decide <slug> <ask> --answer "..." --reason "..."` answers an open question on the lead's judgment; a
  permission or a review is refused; the asking session's next prompt reads `Decided by this project's lead, not Aiden`.
- C2. `lead park <slug> <step> --reason "..."` parks a step of Aiden's that nobody is working on, and is refused while a
  session works on it.
- C3. `lead undo <slug> <d> --aiden "..."` puts a decision back: a parked step returns, a decided question is Aiden's
  again as a new ask; a second undo is refused.
- C4. `lead rules` prints version 4 with the mandate; a version 3 lead reads and is refused on a change.
- C5. The Lead view shows "Decided for you" (each decision, why, and the words that undo it) and the mandate.
- C6. A session's briefing in a project with a lead carries the mandate lines; a step log that starts
  `Decided for Aiden:` shows in the brief and the Lead view.
- C7, C8, C9 are Aiden's, after the gate (in Grok, and by watching a new session).

## Review focus

1. A decide on an ask that was answered between the lead's read and his command: refused with the stored answer, nothing written.
2. An undo of a decision whose step has since been parked, dropped or finished: refused with the reason, nothing written.
3. A second undo of the same decision: refused.
4. A park of Aiden's step while a helper session (focus on the step, not its driver) is live: refused.
5. A step log `decided for aiden: x` in another case, or with leading spaces: still counted; a log that merely contains the phrase mid-sentence: not counted.

---

### Task 1: The mandate text, and rules version 4

**Files:** create `src/core/lead-mandate.ts`; modify `src/core/lead.ts` (version 4, `LeadEventKind` adds `'decide' | 'undo'`),
`src/core/lead-rules.ts`, `src/core/relay.ts`; tests `test/core/lead-rules.test.ts`, `test/core/lead-mandate.test.ts` (new),
and the test that pins `leadBriefingLine` (find it with Grep).

**Produces:**

```ts
// src/core/lead-mandate.ts
/** The mandate as the lead reads it: one source for the rules, the window and (in short) the session briefing. */
export const LEAD_MANDATE: readonly string[];
/** How a session's step log marks a call it made for Aiden. */
export const DECIDED_PREFIX = 'Decided for Aiden:';
/** True for a log text that opens with DECIDED_PREFIX, ignoring case and leading spaces. */
export const isDecisionLog = (text: string): boolean => /^\s*decided for aiden:/i.test(text);
/** The log text after the prefix, trimmed. */
export const decisionText = (text: string): string => text.replace(/^\s*decided for aiden:\s*/i, '').trim();
/** The two lines a session's briefing carries after the lead line. `lead` is cleaned to one line by the caller's `one()`. */
export const sessionMandateLines = (lead: string): string[];
```

`LEAD_MANDATE` is exactly these lines:

```
Your mandate
The rule: if Aiden can undo it in one word and nothing is lost in the meantime, you decide and tell him afterwards. If not, it is his, and you bring it with a recommendation he can accept in one word.
You decide, and tell him afterwards:
- how a thing gets built: the approach, names, files, tests, the order of work inside a step. Answer a session's question from the intent record, the specs, the repo and the threads;
- the bar for work that nothing shows on a screen: fixes, refactors, tests, docs, internal scripts;
- what is next inside the current Phase, and in what order;
- setting aside (parking) a step nobody is working on, with the reason; dropping a step only when its origin is proposed;
- your own promises.
Aiden's, always:
- what cannot be undone: deleting data, a branch or a step he asked for; rewriting history; a release;
- what touches his real data: the live InProgress home and window, a merge to main, a deploy, a migration, an installer, anything outside the project's folders;
- what goes out to other people: a push, a PR, a message, an email, anything published or sent in his name;
- what changes direction: the Goal, the Phase, what is out of scope, a standing ruling, dropping or reshaping a step he asked for;
- what he would see or feel: anything on a screen or in a flow he uses, and the bar for it;
- what costs money, adds an account or a service, or changes what an agent may do: permissions, access, your rules, this mandate;
- anything the intent record marks as his.
When you are not sure: if it can be undone, decide and say you were not sure. If it cannot, it is his. Never guess at a fact: find out, or say what you could not find.
```

`sessionMandateLines(lead)` returns exactly (with `<lead>` replaced):

```
Mandate: decide for yourself what Aiden can undo in one word (how a thing gets built, names, files, tests, the bar for work nothing shows on a screen, a follow-up filed as proposed). Record each call in your next scribe brief as "log on #<id>: Decided for Aiden: <what> · <why>", and carry on. Do not stop to ask.
Aiden's, always: what cannot be undone, his real data (the live home and window, a merge, a deploy, a migration, an installer), what goes out to other people, a change of direction, what he would see or feel, money and permissions. Raise those as an ask with your recommendation and the one word that accepts it. A question you cannot settle is a question ask: <lead> sees it first, and answers it or brings it to Aiden.
```

The ` · ` in the first line is the middle dot the briefing already uses (U+00B7); keep it. Everything else is ASCII.

**Rules text changes** (`leadRules`), all else unchanged:

- Under `Change the record:` the list becomes, in this order (each command line then its description line):
  - `lead answer <slug> <ask number> --aiden "<his words>" <W>` / `his answer to a question`
  - `lead answer <slug> <ask number> --aiden "<his words>" --says "<the answer his words accept>" <W>` / `when his words accept your recommendation ("yes", "do it"): --says is the answer the session will read`
  - `lead decide <slug> <ask number> --answer "<your answer>" --reason "<why>" <W>` / `answer a session's question on your own judgment, under your mandate`
  - `lead decide <slug> <ask number> --answer "<your answer>" --reason "<why>" --aiden "<his words>" <W>` / `the same, when Aiden told you to decide`
  - `lead park <slug> <step number> --aiden "<his words>" <W>` / `set a step aside`
  - `lead park <slug> <step number> --reason "<why>" <W>` / `set aside a step nobody is working on, on your own judgment`
  - `lead drop ...` (unchanged) / `drop a step`
  - `lead undo <slug> <decision number> --aiden "<his words>" <W>` / `put a decision back: a parked or dropped step returns, a decided question becomes Aiden's again`
  - `lead relay ...` (unchanged), `lead intent ...` (unchanged)
- After the `Reading the project` block and its blank line, insert `...LEAD_MANDATE` and a blank line, before `Rules`.
- Rule 2 becomes: `2. What you decide yourself is in Your mandate. Record each decision with its command: lead decide for a question, lead park with --reason for a step nobody is working on. InProgress answers with a decision number, like d12: give it to Aiden. Everything else you change only on Aiden's word in this chat: a drop of a step that is his (origin me or asked), an undo, the intent record, and any relay that is not telling a session a decision you just recorded or asking it where its work stands. --aiden carries his exact words, inside double quotes. If his words hold a double quote, write it as a single quote. Never pass words he did not say. If he says you decide, that is his word: decide with lead decide, pass "you decide" as his words, and tell him in one line what you chose and why.`
- Rule 6 becomes: `6. You never approve or merge for Aiden, and you decide for him only what your mandate allows. You can carry his answer to a question. A permission or a review needs him in the thread or the window.`
- In `When Aiden asks "where are we"`: the first line after the heading becomes two lines:
  - `First go through the questions under Waiting on Aiden. For each one find out what you can: lead step, its documents, its thread, git. If your mandate lets you decide it, decide it with lead decide and relay the answer to its session. If it is his, keep it for him with your recommendation.`
  - `Then run the lead brief command with --mark, and answer in twelve lines or fewer. Do not recite the brief.`
  and after the `- First line: ...` bullet insert: `- Then what was decided for him since your last look, one line each, with the words that undo it, like "undo d12".`
- In the triage section the line that starts `A step whose origin is proposed, and that you would park:` becomes: `A step you would park and nobody is working on: park it yourself with --reason, and tell Aiden in one line what you parked, why, and its decision number.`
- Before the last line (`After you change the record, ...`) insert a section and a blank line:
  - `When Aiden says undo`
  - `Run lead undo with the decision's number and his words, and tell him what InProgress answered. If he says why, add his reason under Standing rulings in the intent record (read the record, add the line, send the whole record back), and do not make that call again.`

- [ ] Step 1: write the failing tests: `test/core/lead-mandate.test.ts` pins every `LEAD_MANDATE` line, `sessionMandateLines('Progresser')`, `isDecisionLog` (true for `Decided for Aiden: x`, `  decided for aiden: x`; false for `We decided for Aiden: x`, `Decided: x`) and `decisionText`. Update `EXPECTED` in `test/core/lead-rules.test.ts` line by line to the new text, version 4, and add a test that the rules contain every `LEAD_MANDATE` line in order between `Reading the project` and `Rules`.
- [ ] Step 2: run `npx vitest run test/core/lead-rules.test.ts test/core/lead-mandate.test.ts`: FAIL.
- [ ] Step 3: implement. In `src/core/relay.ts` leave `leadBriefingLine` as it is.
- [ ] Step 4: rerun: PASS.

### Task 2: lead decide, lead answer --says, park on judgment, lead undo

**Files:** modify `src/server/lead-commands.ts`, `src/server/lead.ts` (`logLeadEvent` returns the new row's id as a number),
`src/server/repo/nodes.ts` (extract `unparkNodeInWrite`), `src/server/repo/sessions.ts` (add `liveSessionOn`),
`src/server/session-flow.ts` (the answer line), `src/server/routes/lead.ts`, `src/server/schemas.ts`; tests
`test/server/lead-commands.test.ts` (or the file that holds the lead command tests: find it), `test/server/session-flow*.test.ts`.

**Produces:**

```ts
// src/server/repo/nodes.ts: unparkNode's body without `check`, inside an open write; unparkNode calls it.
export function unparkNodeInWrite(ctx: Ctx, record: RecordEvent, id: number, toNext: boolean): TreeNode;
// src/server/repo/sessions.ts: true when a session that has not ended, seen within STALE_SESSION_MS, has `nodeId` as its focus.
export function liveSessionOn(ctx: Ctx, nodeId: number): boolean;
// src/server/lead-commands.ts
export const DECIDE_QUESTION_ONLY = "The lead decides a question only. A permission or a review is Aiden's: it needs him in the thread or the window.";
export const decisionTag = (eventId: number): string => `d${eventId}`;
export function leadDecide(ctx, ref, as, instructions, input: { askId: number; answer: string; reason: string; aidenWords?: string }): { text: string; ask: Ask; decision: number };
export function leadUndo(ctx, ref, as, instructions, input: { eventId: number; aidenWords: string }): { text: string };
// leadAnswer's input gains `says?: string`; leadPark's result gains `decision: number | null`.
```

Behaviour:

- `leadDecide`: checks in order: the ask is in the project; a lead-owned ask is refused with leadAnswer's sentence
  (`<tag> is the lead's own promise. Clear it with kept.`); a kind other than question is refused with
  `DECIDE_QUESTION_ONLY`; a cleared ask is refused with leadAnswer's two sentences. Then
  `clearInWrite(ctx, record, actor, before, input.answer, true, 'lead_decided')`, and a `decide` event with `askId`,
  `nodeId`, `text: input.reason`, `aidenWords: input.aidenWords`. Reply:
  `Decided <tag>: decision d<n>. Its session reads your answer on its next prompt.`
- `leadAnswer` with `says`: the stored answer is `<says> (Aiden said: "<his words>")`; without it, his words as today.
  The event keeps `aidenWords` as his words alone.
- `leadPark`: a step of Aiden's (origin `me` or `asked`) with no `aidenWords`:
  - with no `reason`: refused with `This step is Aiden's (origin <origin>). Pass his words with --aiden, or your reason with --reason when nobody is working on it.` (replace `needsAidensWords` for park only; drop keeps the old sentence);
  - with a `reason` while `liveDriver(ctx, before) !== null || liveSessionOn(ctx, before.id)`: refused with
    `<stepRef> has a session working on it, and it is Aiden's (origin <origin>). Parking it needs his words: pass them with --aiden.`;
  - otherwise parked.
  The `park` event is written as today. Reply: `Parked <stepRef>.` and, when no `aidenWords` were passed,
  ` Decision d<n>.` appended; `decision` is the event id then, else null. `leadDrop` gets the same: without
  `aidenWords` its reply ends ` Decision d<n>.`.
- `leadUndo`: the event must be one of this project's `lead_events` with kind `decide`, `park` or `drop`, else 404
  `d<n> not found.` with hint `The brief lists decisions as d<number>.`. If an `undo` event of this project has
  `text = 'd<n>'`: 409 `d<n> is already undone.`. Then by kind:
  - `decide`: read the ask (`requireAsk`); raise it again with
    `raiseAskInWrite(ctx, record, actor, { nodeId, kind: 'question', text, sessionId })` (owner Aiden; its own
    refusals for a parked or dropped step pass through). Reply:
    `Undid d<n>: the question is Aiden's again as <new tag>. Your answer was: "<clip(answer, 120)>".`
  - `park`: the step must still be parked, else 409 `#<id> is not parked any more: nothing to undo.`; then
    `unparkNodeInWrite(ctx, record, id, false)`. Reply: `Undid d<n>: <stepRef> is back in the backlog.`
  - `drop`: the step must still be dropped, else 409 `#<id> is not dropped any more: nothing to undo.`; then
    `updateNodeInWrite(ctx, record, actor, id, { status: 'todo' })`. If that function refuses the change, stop and report.
    Reply: `Undid d<n>: <stepRef> is back in the backlog.`
  Then an `undo` event: `nodeId`, `askId` of the original, `text: 'd<n>'`, `aidenWords`.
- `src/server/session-flow.ts` line 376: an answered ask whose `answeredVia === 'lead_decided'` prints
  `Decided by this project's lead, not Aiden: <tag> "<answer>" (yours: act on it; Aiden may still undo it)`; every
  other line is unchanged.
- Routes: `POST /api/lead/:ref/decide` and `POST /api/lead/:ref/undo`, written exactly like the existing
  `POST .../answer` route (same token rule, same body shape: `as`, `instructions`, then the input fields `askId`,
  `answer`, `reason`, `aidenWords?`; and `eventId`, `aidenWords`). `answer`'s schema gains optional `says` (1 to 2,000
  characters). `answer` and `reason`: 1 to 2,000 characters, trimmed, not empty.

- [ ] Step 1: failing tests, one per sentence above: decide happy path (ask cleared, `answeredVia` is `lead_decided`,
  event kind `decide`, reply text); decide refused for permission, review, a promise, a cleared ask (nothing written:
  count `lead_events` before and after); answer with `says`; park of an `asked` step with a reason and no session
  (parked, `decision` set); park refused with a live driver, and with a live helper session; park with no reason and
  no words refused; undo of each kind; undo twice; undo of a park whose step was unparked; undo of an unknown number;
  undo of another project's event (404); the session-flow line for a lead-decided answer.
- [ ] Step 2: run them: FAIL. Step 3: implement. Step 4: `npx vitest run test/server`: PASS.

### Task 3: the brief lists what was decided

**Files:** modify `src/core/lead.ts`, `src/server/lead.ts`, `src/server/lead-text.ts`; tests `test/server/lead-brief.test.ts`, `test/server/lead-text.test.ts`.

**Produces:** `LeadBrief` gains

```ts
/**
 * What was decided for Aiden in the last LEAD_LOOK_BACK_DAYS days, newest first: the lead's `decide` events, his `park`
 * and `drop` events made with no words of Aiden's, and step logs a session opened with DECIDED_PREFIX. A decision that
 * has an `undo` event is left out. `tag` is `d<event id>`, or '' for a session's. `isNew`: at or after the last look
 * (always true with no look on record).
 */
decided: { tag: string; at: string; by: string; stepId: number | null; stepTitle: string; what: string; why: string; isNew: boolean }[];
```

- Lead events: `by` is the event's `lead`. `what`: `answered <ask tag>: "<the ask's answer>"` for decide, `parked` for
  park, `dropped` for drop. `why` is the event's `text`. `stepId` and `stepTitle` from `node_id`.
- Session logs: rows of `log_entries` on this project's steps, `created_at` at or after the cutoff, text matching
  `isDecisionLog`. `by` is `a session`, `tag` is `''`, `what` is `decisionText(text)`, `why` is `''`.
- `renderLeadBrief` prints a section after `Said in Aiden's name`, before `Links`:
  heading `Decided for Aiden in the last 7 days (<n>, <k> new):` (use `LEAD_LOOK_BACK_DAYS`), each item:
  - lead: `<tag> <stamp(at)> · <by> <what> on <step>` then ` · why: "<line(why, TEXT_CUT)>"` when why is not empty, then ` · undo: undo <tag>`, then ` · new` when new. With no step (`stepId` null) leave ` on <step>` out.
  - session: `<stamp(at)> · a session on <step>: "<line(what, TEXT_CUT)>"` then ` · new` when new.
  `none` and the cap come from `section()` as for every list.

- [ ] Step 1: failing tests: a decide, a park without words, a park with words (left out), a drop without words, an
  undone decision (left out), a session log with the prefix and one without; `isNew` against a marked look; the
  rendered section with one of each and with none. Step 2: FAIL. Step 3: implement. Step 4: PASS.

### Task 4: CLI

**Files:** modify `src/cli/lead.ts`; tests `test/cli/lead.test.ts`, `test/smoke/built.test.ts`.

- `lead decide <project> <ask> --answer "<text>" --reason "<text>" [--aiden "<words>"] --as <name> --instructions <n>`: ask as `a7` or `7`.
- `lead undo <project> <decision> --aiden "<words>" --as <name> --instructions <n>`: decision as `d12` or `12`.
- `lead answer` takes optional `--says "<text>"`.
- Usage lines added beside the existing ones, same style. Each prints the route's `text`.
- Smoke: against the built server, a decide on a seeded question then `lead brief` shows the `Decided for Aiden` section with it, and `lead undo` answers `Undid d`.

- [ ] Step 1: failing tests (argument parsing, the missing-flag usage, the printed text). Step 2: FAIL. Step 3: implement. Step 4: `npx vitest run test/cli` PASS; `npm run test:smoke` PASS.

### Task 5: the session briefing

**Files:** find every caller of `leadBriefingLine` (Grep in `src/`); modify each so the two `sessionMandateLines(lead)`
lines follow the lead line, each on its own line; tests beside the existing lead-line tests.

- A project with no lead prints neither. The lead's name goes through the same `one()` cleaning as the lead line.
- [ ] Step 1: failing tests: a briefing for a project with a lead holds both mandate lines right after the `Lead:` line; one without a lead holds none. Step 2: FAIL. Step 3: implement. Step 4: `npx vitest run test/server` PASS.

### Task 6: the window, the e2e test, and the docs

**Files:** modify `web/src/lead/leadDesk.ts`, `web/src/lead/LeadView.tsx`, `web/src/styles/lead.css`; tests
`test/web/lead-desk.test.ts`, `test/e2e/ui.spec.ts`; docs `docs/lead/instructions.md`,
`docs/superpowers/specs/2026-11-14-project-lead-design.md`, `.claude/skills/sigmund/SKILL.md`.

- `leadDesk.ts`: the desk gains `decided: { key: string; line: string; why: string; undo: string | null; isNew: boolean }[]`
  built from `brief.decided`: `line` is `<by> <what> on <#id Title>` for the lead's (`a session on <#id Title>: <what>`
  for a session's), `why` the reason, `undo` `Say: undo <tag>` for the lead's and null for a session's.
- `LeadView.tsx`: a section headed `Decided for you`, after the section that shows what was said in Aiden's name and in
  the same markup as that section: one row per decision with the line, the reason under it when there is one, the age,
  and the undo words. Empty: `Nothing decided for you in the last 7 days.` Under the intent record's `<details>`, a
  second native `<details className="ip-lead-intent">` with `<summary>The mandate, as the lead reads it</summary>` and a
  `<pre>` of `LEAD_MANDATE.join('\n')`.
- e2e, one test: `The Lead view lists what was decided for Aiden, and shows the mandate`: seed a project with a lead, a
  question ask, decide it through the API, open the Lead view: the row shows the answer and `Say: undo d`; the mandate
  opens and holds `Aiden's, always:`. Run it with `INPROGRESS_E2E_PORT=4410`, narrowed with `-g`.
- `docs/lead/instructions.md`: version 4; what the lead decides and how Aiden undoes it; the acceptance steps C7 to C9.
- Spec: a section `### 6.7 The mandate` after 6.6 holding the mandate as Aiden reads it (copy sections "The rule", A, B,
  C, D, E, F from the resource file `C:/Users/aiden.molyneaux/.inprogress/resources/inprogress/2026-11-16-lead-mandate-draft.md`),
  and one paragraph: the lead-facing text is `src/core/lead-mandate.ts`, a lead cannot widen it, questions stay Aiden's in
  the data so the Bot-off test holds, and landing stays Aiden's until "he acts".
- `.claude/skills/sigmund/SKILL.md`, Phase 0, after the paragraph that starts `Ask with AskUserQuestion`: add the
  paragraph `In a project with a lead, the mandate in the session briefing decides which of these reach the owner: decide the rest, record each call as the briefing says, and name it in the receipt.`

- [ ] Step 1: failing desk tests and the e2e test. Step 2: FAIL. Step 3: implement. Step 4: `npm run typecheck`, `npm test`, the one e2e test: PASS.

## Report

Files changed, and the raw tail of: `npm run typecheck`, `npm test`, `npm run test:smoke`, the e2e test. Anything the plan
got wrong about the code, said plainly, with what you did instead.
