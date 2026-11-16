# The lead investigates before he recommends (#729, rules version 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Progresser can find out where a stuck step really stands (its whole record, its documents, the repo, git, its thread) and can read the whole intent record back, so his triage is not thin and a new Phase is one sentence from Aiden.

**Architecture:** Three new reads behind the lead's CLI (`lead step`, `lead resource`, `lead intent` with no file), three new facts on the brief's intent block, and rules version 3 with a "Reading the project" section and a triage section. No write path changes. No migration.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-project-lead-design.md` (the note of 2026-11-16 under "Aiden said"). Branch `lead-investigates`, worktree `C:\personal\InProgress\.claude\worktrees\lead-brief`.

## Why (Aiden, 2026-11-16)

"I don't want his recommendations to be thin. The point of using an AI lead is so that he can figure things out. If a task is stale, I'd want him to be able to figure it out, not tell me why. ... The lead is supposed to know more than me."

His rulings, same day: the lead may read the step's whole record, the project's repo with read-only git, and the project's threads; build it now under #729, with #733's two pieces (read the intent record back, the stale Phase signal).

## The bar (replaces C6 of the #729 plan)

- **C9** `lead step inprogress 516 --as Progresser --instructions 3` prints the step's whole record: What, Why, sessions with thread ids, asks with answers, documents with where to read each, the log. Under one second on a copy of the live data. *Sigmund, check surface.*
- **C10** `lead intent inprogress --as Progresser --instructions 3` prints the stored record. The Lead view shows the whole record under "The whole intent record". *Sigmund for the CLI; e2e and Parvati for the window.*
- **C11** The brief and the Lead view say when the record was written and how many steps landed since, and say so when every step the Phase names is finished. *Unit tests; Sigmund.*
- **C12** `lead rules` prints version 3 with the project's folders under "Reading the project" and the triage section. A version 2 lead can still read, and is told to fetch the rules again when it tries to change something. *Sigmund.*
- **C13** *Aiden, in Grok, after the gate.* Say "triage": for each stuck step and ask Progresser says where the work really stands, from having read its record, its documents, its thread and git, and names what he could not find. He parks the proposed ones he would park himself and says why. For the rest he gives a recommendation Aiden can answer in one word, and records the answer.
- **C14** *Aiden, in Grok, after the gate.* Give him a new Phase in one sentence: he rewrites the record with the other four headings unchanged, and the Lead view shows the new Phase.

Depth: a list, after the gate (it needs the deployed build and the real Bot).

## Global Constraints

- No em dashes (U+2014) in any file. Plain ASCII in every string the lead's commands print, except the `·` separator the brief already uses.
- Reads only: no new write, no migration, nothing behind the token guard.
- Every new read goes through `requireLead(ctx, ref, as, instructions, false)`: a project with no lead, another lead's, or an archived one is refused; any instructions version may read.
- A step or a document of another project is refused with a 409: `#<id> is not in this project.` and `r<id> is not in this project.`
- Sev does not commit, merge, push or deploy, and does not touch `docs/` (Sigmund owns the docs in this change).

## Review Focus

1. A step with a very long log, body or ask text: the output stays bounded (caps below) and says what it cut.
2. A document with no stored content and no path: `lead resource` says so, it does not print `null`.
3. A Phase that names no step, or only steps of another project: no "finished" claim.
4. A project with no folder bound to it: the rules say so and list no folder.
5. A folder under `C:\work` bound to the project: it is never printed in the rules.

---

### Task 1: The step's whole record (`lead step`)

**Files:**
- Create: `src/server/lead-step.ts`
- Modify: `src/server/repo/asks.ts`, `src/server/repo/sessions.ts`, `src/server/routes/lead.ts`, `src/server/schemas.ts`, `src/cli/lead.ts`
- Test: `test/server/lead-step.test.ts`, `test/cli/lead.test.ts`

**Interfaces:**
- `listNodeAsks(ctx: Ctx, nodeId: number): Ask[]` in `src/server/repo/asks.ts`: every ask on the node, open and cleared, oldest first, mapped as that file maps a row. Use an existing function when one already does exactly this.
- `listStepSessions(ctx: Ctx, nodeId: number, limit = 10): Session[]` in `src/server/repo/sessions.ts`: sessions whose `focus_node_id` is the node, live and ended, newest sign first (`ORDER BY COALESCE(ended_at, last_seen_at) DESC, id`), mapped with the file's own row mapper.
- `readLeadStep(ctx: Ctx, ref: string, as: string, instructions: number, stepId: number, now: Date): { text: string }` in `src/server/lead-step.ts`.
- `readLeadResource(ctx: Ctx, ref: string, as: string, instructions: number, resourceId: number): { text: string }` in the same file.
- Constants there: `LEAD_STEP_LOG_CAP = 60`, `LEAD_STEP_TEXT_CUT = 4_000`, `LEAD_RESOURCE_CUT = 120_000`.
- Routes: `GET /api/lead/:ref/step/:id?as=&instructions=` and `GET /api/lead/:ref/resource/:id?as=&instructions=`, no token, query parsed with `leadBriefQuery`'s shape but with `as` and `instructions` both required (add `leadReadQuery` to `src/server/schemas.ts`).
- CLI: `lead step <project> <step id> --as <name> --instructions <n>` and `lead resource <project> <document id> --as <name> --instructions <n>`. A step is given as `#42` or `42` (the file's `stepId`), a document as `r42` or `42`. Both print the route's `text` and exit 0; a refusal prints its sentence and exits 1. Add both to `LEAD_USAGE` and `COMMANDS` (one positional, no flags), and handle them as GETs beside `brief` and `rules`.

**The text `readLeadStep` prints.** One fixed order; a section with nothing in it is left out, except the first three lines. Free text is flattened to one line with the control-character cleaning `lead-text.ts` already has (export its `clean`); `<age>` is `spanAgo` against `now`; times are `stamp(...)`.

```
#516 Build the backup strategy for InProgress's real data · active · data · origin asked
Under: #26 InProgress
Changed 27d ago · created 2026-10-19 14:02
What: <node.what, whole>
Why: <node.why, whole>
Outcome: <node.outcome, whole>
Notes: <node.body, cut at LEAD_STEP_TEXT_CUT>
Sessions (2):
  "<title, or Session <first 6 of id>>" · t3 · thread <t3ThreadId> · working, seen 2m ago
  "<title>" · desktop · ended 27d ago
Asks (3):
  a107 review · open, raised 27d ago: "<text, cut at LEAD_STEP_TEXT_CUT>"
  a98 question · answered 28d ago: "<text>" -> "<answer>"
  a99 permission · cleared 28d ago with no answer: "<text>"
Working tasks (5 done, 2 open):
  open: <subject>
Documents (2):
  r342 spec "Data backup strategy" · file C:/personal/InProgress/docs/superpowers/specs/2026-10-19-data-backup-strategy.md
  r345 handoff "Backup handoff" · stored in InProgress, 5210 characters: lead resource inprogress 345 --as Progresser --instructions 3
Steps under it (1):
  #556 Backups panel in the window · done
Log, newest first (20 of 34):
  2026-10-20 14:02 · <text, one line, cut at 1000>
```

Rules for the lines:
- Line 1: `#<id> <title> · <status> · <label, left out when null> · origin <origin>`. A parked step adds ` · parked` through its status only.
- Line 3 adds ` · done <stamp(completedAt)>` when `completedAt` is set.
- `What:`, `Why:`, `Outcome:`, `Notes:` are each left out when empty. A cut text ends with ` (cut: <n> more characters)`.
- A session line: `· thread <id>` only when `t3ThreadId` is set; then `ended <age> ago` when `endedAt` is set, else `<state>, seen <age> ago`.
- An ask the lead owns (`owner === 'lead'`) reads `a12 promise · ...` in place of its kind.
- A document line ends with `· file <path>` when `path` is set, and with `· stored in InProgress, <contentLength> characters: lead resource <slug> <id> --as <lead> --instructions <LEAD_INSTRUCTIONS_VERSION>` when `contentLength > 0`, and with `· link <url>` when `url` is set; one with none of the three ends with `· nothing stored`. More than one may apply: print them in that order, joined with ` · `.
- Working tasks come from `listWorkItems(ctx, project.id)` filtered to the node, main session and subagents together; print the open ones' subjects, at most 10, then `  and <k> more`.
- The log total in the heading is a `SELECT COUNT(*)` on the node's log rows; the lines are `listLogs(ctx, id, LEAD_STEP_LOG_CAP)`.

**The text `readLeadResource` prints.** First line `r345 handoff "<title>" on #516 <step title>`, a blank line, then:
- the stored content when it is non-empty, cut at `LEAD_RESOURCE_CUT` with a last line `(cut: <n> more characters)`;
- else, with a path: `Not stored in InProgress. Read the file: <path>`;
- else, with a url: `A link: <url>`;
- else `r345 has nothing stored.`

- [ ] **Step 1: Write the failing tests** in `test/server/lead-step.test.ts`, building the data the way `test/server/lead-brief.test.ts` does (its `setup()` and helpers; reuse them, do not copy them when they can be imported):
  - `prints the header, What, Why, a session with its thread, asks open and answered, documents and the log`: one step with all of it; assert each line of the format above with exact strings.
  - `leaves out the sections that are empty`: a bare step prints exactly its first three lines.
  - `cuts a long body and says how much it cut`: a 5,000 character body ends with ` (cut: 1000 more characters)`.
  - `caps the log and says how many there are`: 70 log lines give the heading `Log, newest first (60 of 70):` and 60 lines.
  - `refuses a step of another project` with a 409 and `#<id> is not in this project.`
  - `refuses a project with no lead, and another lead's name`, with `noLeadNamed`.
  - `a version 1 lead can read it`.
  - `lead resource prints stored content`, `points at the file when nothing is stored`, `says a link`, `says nothing stored`, `cuts at LEAD_RESOURCE_CUT`, `refuses a document of another project`.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run test/server/lead-step.test.ts`
- [ ] **Step 3: Implement** the two repo reads, `src/server/lead-step.ts`, the schema, the two routes.
- [ ] **Step 4: CLI tests** in `test/cli/lead.test.ts`: `step` and `resource` call their GET with `as` and `instructions` and print `text`; `#42`, `42`, `r42` are accepted; a bad id prints the usage and exits 1; both appear in `LEAD_USAGE`. Then implement.
- [ ] **Step 5: Run** `npx vitest run test/server/lead-step.test.ts test/cli/lead.test.ts` and see them pass.

### Task 2: The intent record read back, and its age on the brief

**Files:**
- Modify: `src/core/lead.ts`, `src/server/lead.ts`, `src/server/lead-text.ts`, `src/server/routes/lead.ts`, `src/cli/lead.ts`
- Test: `test/server/lead-text.test.ts`, `test/server/lead-brief.test.ts`, `test/cli/lead.test.ts`

**Interfaces:**
- `LeadBrief['intent']` becomes `{ goal: string; phase: string; updatedAt: string | null; text: string; landedSince: number; phaseFinished: boolean }`.
  - `text`: the whole record, `''` when there is none.
  - `landedSince`: how many steps (never the root) are `done` with `completedAt >= updatedAt`; `0` with no record.
  - `phaseFinished`: true when the first paragraph under `## Phase`, uncut, names at least one step of this project as `#<digits>`, and every step it names that is in this project is `done` or `dropped`. Ids not in the project are ignored. Only ids written out count: `#725 to #729` names 725 and 729.
- `intentParagraphs(intent: string): { goal: string; phase: string }` in `src/server/lead-text.ts`: the two paragraphs uncut. `intentHeadlines` calls it and clips each to `HEADLINE_CUT`, unchanged for its callers.
- `intentLine(i: LeadBrief['intent'], now: number, forLead: boolean): string | null` exported from `src/core/lead.ts` (the window uses it too, so it takes `spanAgo` from `src/core/span.ts`): `null` when `updatedAt` is null; else
  `Intent record: written <age> ago · <n> step(s) landed since` (`1 step`, `2 steps`), and when `phaseFinished` it adds ` · every step the Phase names is finished` and, with `forLead` true, `: ask Aiden what the Phase is now`.
- `renderLeadBrief` prints `intentLine(b.intent, now, true)` straight after the `Phase:` line when it is not null.
- `readLeadIntent(ctx: Ctx, ref: string, as: string, instructions: number): { text: string; updatedAt: string | null }` in `src/server/lead.ts`; `text` is the stored record, or `No intent record yet.` when it is empty.
- Route `GET /api/lead/:ref/intent?as=&instructions=` (no token; `leadReadQuery`). The POST on the same path is unchanged.
- CLI: `lead intent <project> --as <name> --instructions <n>` with no file reads and prints; with a file or `-` it writes as today. `CommandSpec` gains `minPositionals?: number` (default `positionals`); `intent` sets it to 0. `LEAD_USAGE` shows both forms:
  `  inprogress lead intent <project> ${WHO}` and `  inprogress lead intent <project> <file | -> ${WHO}`.

- [ ] **Step 1: Failing tests.**
  - `test/server/lead-text.test.ts`: `intentParagraphs` returns the uncut paragraphs; `intentLine` for no record, for `1 step`, for `2 steps`, with and without `phaseFinished`, with `forLead` true and false; `renderLeadBrief` prints the line after `Phase:` and prints none with no record.
  - `test/server/lead-brief.test.ts`: `text` carries the whole record; `landedSince` counts only steps done at or after `updatedAt` and never the root; `phaseFinished` is false when the Phase names no step, false while one named step is open, true when all named steps are done or dropped, and ignores an id of another project.
  - `test/cli/lead.test.ts`: `lead intent <project>` with no file calls the GET and prints `text`; with `-` it still posts.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/server/lead-text.test.ts test/server/lead-brief.test.ts test/cli/lead.test.ts` and see them pass.

### Task 3: Rules version 3

**Files:**
- Modify: `src/core/lead.ts` (`LEAD_INSTRUCTIONS_VERSION = 3`), `src/core/lead-rules.ts`, `src/server/lead.ts` (`readLeadRules` passes the folders), every test that pins version 2
- Test: `test/core/lead-rules.test.ts`, `test/server/lead-brief.test.ts` or the file that tests `readLeadRules`, `test/smoke/built.test.ts`

**Interfaces:**
- `LeadRulesFor` gains `folders: string[]`.
- `leadFolders(ctx: Ctx, projectId: number): string[]` in `src/server/lead.ts`: the paths of the project's bindings (`listBindings(ctx)` filtered to the project), each with backslashes turned to forward slashes, without a trailing slash, deduplicated ignoring case, sorted, and without any path that is `c:/work` or under it (ignoring case). `readLeadRules` passes it.

**The text.** Change `leadRules` so that it prints exactly this (values in `<...>`; `<W>` is `--as <Lead> --instructions 3`; everything not shown here stays as it is in version 2):

Under "Read, whenever you need to:", after the `lead brief ... --mark` pair and before `outline`:

```
  lead step <slug> <step number> <W>
      everything on record about one step: what it is for, its sessions, asks, documents and log
  lead resource <slug> <document number> <W>
      a document attached to a step, when lead step says it is stored in InProgress
  lead intent <slug> <W>
      the whole intent record, as stored
```

The change line for the intent record becomes:

```
  lead intent <slug> - <W>
      replace the intent record, piped in on stdin, plain ASCII only. To change one heading, read the record first, change that heading, and send the whole record back
```

A new section between "Your own:" and "Rules", when `folders` is not empty:

```
Reading the project
You may read, and never change, anything inside:
  <folder>
  <folder>
That means reading files there, and these git commands, each starting with: git -C <folder> --no-optional-locks
  status --short, log, show, diff, branch -a, worktree list
Nothing else from git, and nothing that writes, moves or deletes.
You may also read this project's T3 Code threads.
```

and when it is empty:

```
Reading the project
This project has no folder on record. Read it through the commands above and its T3 Code threads.
```

**He decides what is already his, and brings drafts, not questions** (Aiden, 2026-11-16: "I need the AI to act for me, only keeping important make or break questions for me"). The code already lets the lead park a step of origin `proposed` without Aiden's words (`requireWordsFor` in `src/server/lead-commands.ts`, and section 6.3 of the spec); version 2's text forbade it. Only the text changes:

The heading `Change the record, only when Aiden tells you to in this chat:` becomes `Change the record:`, and one command is added straight after the `lead park ... --aiden` pair:

```
  lead park <slug> <step number> --reason "<why>" <W>
      set aside a step whose origin is proposed, on your own judgment
```

Rule 2 becomes: `2. What you may decide yourself: parking a step whose origin is proposed (lead step prints the origin), and your own promises. Everything else you change only on Aiden's word in this chat: an answer, a step that is his (origin me or asked), any drop, a relay, the intent record. --aiden carries his exact words, inside double quotes. If his words hold a double quote, write it as a single quote. Never pass words he did not say. If he says you decide, that is his word: decide, pass "you decide" as his words, and tell him in one line what you chose and why.`

A rule 11 after rule 10: `11. Never ask Aiden an open question. Find out what you can first, then bring him a draft or a recommendation he can accept in one word.`

The intent paragraph becomes: `The intent record has five headings, each a line starting with "## ": Goal, Phase, Out of scope, What Aiden cares about, Standing rulings. Do not ask Aiden to write it. Draft it yourself from the specs, plans and record you can read, show him the draft, and store it once he has corrected or accepted it. Never store a ruling he has not made.`

Rule 1 becomes: `1. On Aiden's laptop, run only the commands above and what Reading the project allows. No file edits, no installs, no other program.`

Rule 5's first sentence (`You may read the T3 Code threads of this project.`) is removed, since Reading the project now says it; the rest of rule 5 stays.

After the "When Aiden asks where are we" section, one more line in it, before `Leave out anything that is empty.`:

```
If the brief says every step the Phase names is finished, ask Aiden what the Phase is now, and replace the intent record when he tells you.
```

Then a new section, before the last line (`After you change the record, ...`):

```
When Aiden says triage, or asks what is stuck
Run the lead brief. Take each step under Stale and each ask under Waiting on Aiden, one at a time. Before you speak about one, find out where it really stands:
- run lead step on it, and read the documents it lists: its plan or handoff says what was meant to be built;
- read its T3 Code thread, when lead step names one;
- look in git: is its work merged, is a branch or a worktree still open, is anything uncommitted.
Then tell Aiden, for each one, in a few lines:
- what it is for;
- where the work really stands: what is built, what is merged, what is left;
- why it stopped;
- what you would do (keep, park or drop, or a message you would relay to its session), and the exact words he can say.
Say what you could not find out. Never guess, and never fill a gap from memory.
A step whose origin is proposed, and that you would park: park it yourself with --reason, and tell Aiden in one line what you parked and why.
For every other one, give him your recommendation so that he can answer in one word, and record what he decides: park and drop with their commands. Keep changes nothing; if he gives a date, record a promise for it.
```

- [ ] **Step 1: Failing tests** in `test/core/lead-rules.test.ts`: the heading `Change the record:`; the `lead park ... --reason` pair; rule 2's first sentence and its `you decide` sentence; rule 11; `Do not ask Aiden to write it.` in the intent paragraph; `park it yourself with --reason` in the triage section. In the file that tests `leadPark`: a `proposed` step parks without Aiden's words and an `asked` one is refused (add the two tests only where they are missing). Then: the title says `Version 3.`; the three new read commands with their `<W>`; the folders printed in order under `Reading the project`; the no-folder sentence with `folders: []`; rule 1's new sentence; the triage section's heading and its last line; the Phase line in the where-are-we section; every line is plain ASCII. And for `leadFolders`: forward slashes, no trailing slash, deduplicated ignoring case, sorted, `C:\work\x` and `c:/work` left out, another project's binding left out.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement,** then bring every test that pins `2` to the constant or to `3` (`grep -rn "instructions 2\|Version 2\|instructions: 2\|v2" test/`), the smoke test included.
- [ ] **Step 4: Run** `npm run typecheck` and `npm test` and see them pass.

### Task 4: The Lead view shows the whole record and its age

**Files:**
- Modify: `web/src/lead/leadDesk.ts`, `web/src/lead/LeadView.tsx`, `web/src/styles/lead.css`
- Test: `test/web/lead-desk.test.ts`, `test/e2e/ui.spec.ts`

**Interfaces:**
- `DeskHead` gains `intentLine: string | null` (`intentLine(b.intent, now, false)`) and `intentText: string` (`b.intent.text`).
- `LeadView` prints `intentLine` as one muted line under the Phase, and, when `intentText` is not empty, a native `<details className="ip-lead-intent">` whose `<summary>` reads `The whole intent record` and whose body is the record in a `<pre>` (the text as it is stored: no Markdown rendering). No new focus handling: the summary is the browser's own control.
- CSS: the `<pre>` wraps (`white-space: pre-wrap`), uses the view's text size and colour tokens, and has no horizontal scroll at the narrow window width.

- [ ] **Step 1: Unit tests** in `test/web/lead-desk.test.ts`: `deskHead` gives `intentLine` null and `intentText` '' with no record; with a record it gives the line without `ask Aiden` and the whole text.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: e2e,** one new test in `test/e2e/ui.spec.ts` beside the Lead view's test, named `The Lead view shows the whole intent record and when it was written`: give the project a lead, write an intent record through `POST /api/lead/:ref/intent` the way the existing lead test reaches the API, open the Lead view, expect the line that starts `Intent record: written`, expect `The whole intent record` closed, click it, expect the text of the last heading (`## Standing rulings`) to be visible.
- [ ] **Step 4: Run the whole e2e suite, not a narrowed one** (a narrowed run missed two broken tests on #728): `npm run test:e2e` with `INPROGRESS_E2E_PORT` set to a port from 4410 to 4419.

### Task 5: Report

- [ ] `npm run typecheck`, `npm test`, `npm run test:smoke`, and the whole e2e suite: paste the last lines of each.
- [ ] List every file changed, and anything in this plan that did not fit the code as written.

## Docs (Sigmund)

- `docs/lead/instructions.md`: version 3, the three new reads, Reading the project, the triage, the acceptance steps C13 and C14.
- `docs/superpowers/specs/2026-11-14-project-lead-design.md`: the 2026-11-16 note under "Aiden said".
- `docs/known-issues.md`: the two hits from the #729 deploy.
