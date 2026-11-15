# Lead Stage 1: The Lead Reads and Talks, Implementation Plan

> **For agentic workers:** each task below is one change and runs through Sigmund (`.claude/skills/sigmund/`) in its
> own worktree. Sigmund owns the line-by-line plan for his change; this plan fixes what crosses changes: the order,
> the names and types, the exact text, the tests that prove each change, and the acceptance. Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** Aiden asks the lead "where are we" in Grok and gets InProgress's record in one fixed shape, and can answer,
park, drop and pass a message on through it; with the Bot off, the window shows the same brief.

**Architecture:** The lead is a name on a project. A `lead` command group on the CLI is the only door the Bot uses;
each command is one server function that checks the project has that lead, acts, and writes a line to the lead's log.
The brief is built by plain code from data InProgress already holds. Nothing here lets the lead land or approve work.

**Tech Stack:** TypeScript, Fastify, SQLite (`src/server/db/schema.ts`), Vitest, Playwright, React (`web/src`).

**Spec:** `docs/superpowers/specs/2026-11-14-project-lead-design.md` (sections 6.2, 6.4, 6.6 and stage 1 of 8).

**Changes from the spec, for Aiden to confirm:**
1. **Relay moves from stage 3 to stage 1.** InProgress can already send to a T3 thread (#720), and it is the first
   thing Aiden tried with the Bot.
2. **The intent record lives in InProgress, not as a page in the repo.** The lead has to be able to write it without
   committing to a repo it must not touch. Every version is kept in the lead's log.
3. **A promise is an ask owned by the lead with a due time.** No new kind of ask: an older build would not know it.
4. **In stage 1 the lead carries Aiden's answer to a question only.** A permission or a review still needs Aiden in
   the thread or the window. Stage 2 builds the gate that makes his yes to the lead count for those.

**Proven before this plan:** the Bot, named Progresser, ran `inprogress status` on the laptop through Grok's local
tools and returned the list in about 2 seconds with no approval prompt. It refused to message a thread, as its
version 0 instructions say.

## Global Constraints

- No em dashes (U+2014) or their HTML entities in any file.
- Schema changes only add. `min_reader_version` stays 1.
- One branch per change off main, in its own worktree under `.claude/worktrees/`. Gates by label, from the playbook.
- A lead command acts only on a project whose `lead` is set and equals the name it was called with. Only the window
  sets a project's lead; the CLI has no command for it. Work projects never get one.
- Every lead command that changes anything writes one line to `lead_events`, with the instructions version.
- A write command is refused when its `--instructions` is lower than `LEAD_INSTRUCTIONS_VERSION`. A brief still
  answers, and says so on its first line.
- No lead command lands, merges, approves, starts a thread or edits a file in a repo.
- From `src/server/t3.ts`, catch `TypeError` as well as `T3Unavailable`. Never retry when `outcomeUnknown` is true.
- Any value the Bot passes that may hold quotes or newlines (Aiden's words, a message, the intent record) can be
  given as `-` and read from stdin.

## Review Focus

1. **A lead command on a project with no lead, or with another lead's name.** Refused in one sentence that says only
   Aiden can give a project a lead, with a non-zero exit, and nothing is written. Test in task 1 and task 2.
2. **An ask answered twice** (Aiden answers in the thread while the lead records his words). The second is refused
   as already answered and the first answer stands. Test in task 2.
3. **A relay that cannot be delivered:** the session ended, is not under T3 Code, or the send times out. The lead is
   told plainly which, nothing is retried, and a timeout is logged as unknown, not as delivered. Test in task 3.
4. **A project with no intent record, no session and sixty stale steps.** The brief still prints every section in
   order, says "none" where empty, and caps each list at eight lines plus a count. Test in task 1.
5. **A lead-owned ask must not reach Needs me.** It adds nothing to "need you" in the window or in `status`. Test in
   task 1.

---

### Task 1: The lead record and the brief (labels: data, server)

**Files:**
- Create: `src/core/lead.ts`, `src/server/lead.ts`, `src/server/routes/lead.ts`, `src/cli/lead.ts`
- Modify: `src/server/db/schema.ts` (append entry 20), `src/core/types.ts` (`Project`, `Ask`),
  `src/server/repo/projects.ts` (`open_asks` at :534, the row mapping), `src/server/repo/asks.ts`,
  `src/core/taskState.ts:85-88`, `src/core/board.ts:176-193`, `src/cli/commands.ts:19-20` and `:107-112`,
  `src/server/app.ts:117` (register the routes)
- Test: `test/core/lead.test.ts`, `test/server/lead-brief.test.ts`, `test/server/migration20.test.ts`,
  `test/cli/lead.test.ts`

**Interfaces (produced for tasks 2 to 5):**

```sql
-- migration 20, written like entry 16
ALTER TABLE projects ADD COLUMN lead TEXT;                        -- the lead's name; NULL means no lead
ALTER TABLE projects ADD COLUMN lead_seen_at TEXT;                -- when the lead last marked a brief as read
ALTER TABLE projects ADD COLUMN intent TEXT NOT NULL DEFAULT '';  -- the intent record, Markdown
ALTER TABLE projects ADD COLUMN intent_updated_at TEXT;
ALTER TABLE asks ADD COLUMN owner TEXT NOT NULL DEFAULT 'aiden';  -- 'aiden' or 'lead'
ALTER TABLE asks ADD COLUMN due_at TEXT;
ALTER TABLE asks ADD COLUMN answered_via TEXT;                    -- 'lead' when the lead carried Aiden's words
CREATE TABLE lead_events (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  at TEXT NOT NULL, lead TEXT NOT NULL, instructions INTEGER NOT NULL, kind TEXT NOT NULL, node_id INTEGER,
  ask_id INTEGER, session_id TEXT, text TEXT NOT NULL DEFAULT '', aiden_words TEXT);
CREATE INDEX lead_events_project_at ON lead_events (project_id, at);
```

```ts
// src/core/lead.ts
export const LEAD_INSTRUCTIONS_VERSION = 1;
export const LEAD_LIST_CAP = 8;
export const AIDEN_OPEN_LIMIT = 5;
export const IN_FLIGHT_LIMIT = 3;
export type AskOwner = 'aiden' | 'lead';
export type LeadEventKind = 'answer' | 'park' | 'drop' | 'promise' | 'kept' | 'intent' | 'relay' | 'relay_unknown' | 'relay_failed';
export interface LeadBrief {
  project: { slug: string; name: string; lead: string | null };
  at: string;
  instructions: { current: number; yours: number | null };
  intent: { goal: string; phase: string; updatedAt: string | null };
  inFlight: { stepId: number | null; title: string; sessionId: string; app: SessionApp; state: string; lastSeenAt: string }[];
  waitingOnAiden: { askId: number; kind: AskKind; stepId: number; stepTitle: string; text: string; raisedAt: string }[];
  aidenOpenAcrossProjects: number;
  forTheLead: { askId: number; stepId: number; stepTitle: string; text: string; dueAt: string | null; overdue: boolean }[];
  nextUp: { stepId: number; title: string; status: string }[];
  stale: { stepId: number; title: string; marks: string[] }[];
  landedSince: { stepId: number; title: string; outcome: string; completedAt: string }[];
  saidInAidensName: { at: string; kind: LeadEventKind; ref: string; words: string }[];
  links: { t3: 'ok' | 'unavailable' | 'not checked'; t3At: string | null; lastSeenAt: string | null };
}
export function renderLeadBrief(b: LeadBrief): string;
/** The first paragraph under `## Goal` and under `## Phase`, each cut to 300 characters; '' when absent. */
export function intentHeadlines(intent: string): { goal: string; phase: string };

// src/server/lead.ts
export function requireLead(ctx: Ctx, ref: string, as: string, instructions: number, write: boolean): Project;
export function readLeadBrief(ctx: Ctx, ref: string, yours: number | null, now: Date): LeadBrief;
export function markLeadSeen(ctx: Ctx, ref: string, now: Date): void;
export function logLeadEvent(ctx: Ctx, e: { projectId: number; lead: string; instructions: number; kind: LeadEventKind; nodeId?: number; askId?: number; sessionId?: string; text?: string; aidenWords?: string }): void;
```

- Routes, behind the same token guard as the other API routes: `GET /api/lead/:ref/brief?as=&instructions=&mark=`
  returns `{ brief, text }`; `GET /api/lead/:ref/events` returns the last 100 `lead_events`, newest first. With
  `as`, the brief route calls `requireLead`, so a Bot cannot read a project it does not lead. Without `as` it
  answers the window: no lead check, and it never marks.
- CLI: `inprogress lead brief <project> --as <name> --instructions <n> [--mark] [--json]`, in `src/cli/lead.ts`,
  dispatched from `runCli` like `digest`. `USAGE` gains `lead`.
- The brief reads what exists: in flight from `readProjectSessions`; waiting on Aiden from open asks with owner
  `aiden`; for the lead from open asks with owner `lead` (`overdue` when `due_at` is past); next up from
  `projects.queue`; stale from `deriveBoard`'s marks; landed and said-in-his-name since `lead_seen_at`, or seven days
  when it is NULL. It does not call T3: `links.t3` is the outcome of the server's last `t3` call, kept in memory.
- A lead-owned ask is left out of `open_asks`, out of the `needs` list in `taskBoxes`, and out of the `stale_ask`
  mark. `raiseAskDetailed` takes an optional `owner` and `dueAt`.
- `requireLead` throws an `ApiError` 409 with this text when the project has no lead or another name:
  `This project has no lead named <as>. Only Aiden can give a project a lead, from its actions in the window.`
  With `write` true it also refuses a lower `instructions` with:
  `Your instructions are version <n>; version <current> is needed to change anything. Ask Aiden to paste the new ones.`

**The brief's text, exactly this shape** (every section always present, in this order):

```
Lead brief · <project name> · <local date and time> · instructions v<current> (yours: v<yours>)
Goal: <goal, or "No intent record yet.">
Phase: <phase, or "none">
In flight (<n> of 3):
  #<step id> <title> · <state> · <app> · seen <age> ago
Waiting on Aiden (<n> here, <m> of 5 across all projects):
  a<ask id> <kind> on #<step id> <step title>: "<text, cut to 120>" · <age>
For the lead (<n>):
  a<ask id> on #<step id> <step title>: "<text>" · due <date and time> [· OVERDUE]
Next up (<n>):
  #<step id> <title> · <status>
Stale (<n>):
  #<step id> <title> · <marks>
Landed since your last look (<n>):
  #<step id> <title>: "<outcome, cut to 120>"
Said in Aiden's name since your last look (<n>):
  <date and time> <kind> <ref>: "<his words, cut to 120>"
Links: T3 Code <ok | unavailable | not checked> · your last look <age> ago
```

An empty section prints its heading with `(0)` and one line, `  none`. A list longer than eight prints eight lines
and `  and <k> more`. When `yours` is lower than `current`, a second line says
`Your instructions are out of date: you can read, you cannot change anything.`

- [ ] **Step 1: Failing tests.** `renderLeadBrief` on a full fixture equals the shape above line for line; on an
  empty brief every section prints `(0)` and `none`; a list of sixty prints eight lines and `and 52 more` (Review
  Focus 4). `intentHeadlines` reads both headings and returns `''` for a missing one. `readLeadBrief` on a seeded
  project lists a `lead` ask under For the lead and not under Waiting on Aiden, and `open_asks` and `taskBoxes` leave
  it out (Review Focus 5). `requireLead` throws the 409 text for no lead and for another name, and nothing is written
  (Review Focus 1). Migration 20 from version 19: existing asks read owner `aiden`, existing projects read `lead`
  NULL and `intent` `''`, and `min_reader_version` is `'1'`. The CLI prints the route's `text`, and with `--json`
  the brief.
- [ ] **Step 2: Run them.** Expected: fail, nothing defined.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Gate.** `npm run typecheck && npm test && npm run test:slow && npm run test:smoke`. Expected: green.
- [ ] **Step 5: Commit.**

**Accept:** `inprogress lead brief inprogress --as Progresser --instructions 1` prints the same shape twice running,
with only the times changed.

### Task 2: The lead's commands (labels: server, data)

**Files:**
- Modify: `src/server/lead.ts`, `src/server/routes/lead.ts`, `src/cli/lead.ts`, `src/server/schemas.ts`,
  `src/server/repo/asks.ts` (`clearInWrite` at :104)
- Test: `test/server/lead-commands.test.ts`, `test/cli/lead.test.ts`

**Interfaces:**
- Consumes: `requireLead`, `logLeadEvent`, `AskOwner`, the migration 20 columns from task 1; `clearAsk`,
  `raiseAskDetailed`, `updateNode`, `parkNode` as they stand.
- Produces, each a `POST` under `/api/lead/:ref/` with `as` and `instructions` in a strict zod body:

| Command | Body | What it does |
|---|---|---|
| `lead answer <ask id> --aiden <words>` | `{ askId, aidenWords }` | Clears an open `question` ask owned by Aiden with his words as the answer, `answered_via` `lead`, cleared by `lead:<name>` |
| `lead park <step id> [--reason <text>] [--aiden <words>]` | `{ stepId, reason?, aidenWords? }` | Parks the step |
| `lead drop <step id> --reason <text> [--aiden <words>]` | `{ stepId, reason, aidenWords? }` | Drops the step |
| `lead promise <project> <text> --due <iso time> [--step <id>]` | `{ text, dueAt, stepId? }` | Raises a `review` ask with owner `lead` and `due_at`, on the step or else the project's root step |
| `lead kept <ask id> [--note <text>]` | `{ askId, note? }` | Clears a lead-owned ask |
| `lead intent <project> <file>` | `{ intent }` | Replaces the intent record |

- `answer` refuses a `permission` or `review` ask with:
  `The lead can carry Aiden's answer to a question only. A permission or a review needs Aiden in the thread or the window.`
  It refuses an ask that is already cleared with `Already answered: "<the stored answer, cut to 120>".`
- `park` and `drop` need no words for a step whose origin is `proposed`. For `me` or `asked` they need `--aiden`,
  and without it refuse with: `This step is Aiden's (origin <origin>). Pass his words with --aiden.`
- `promise` refuses a `dueAt` in the past and a text over 500 characters. `kept` refuses an ask owned by Aiden.
- `intent` needs both `## Goal` and `## Phase` headings and at most 8,000 characters. It sets `intent_updated_at`
  and logs the whole text.
- `aidenWords`, `reason`, `note` and the intent accept `-` on the CLI, read from stdin. `aidenWords` is 1 to 2,000
  characters.

- [ ] **Step 1: Failing tests.** Each command on a project led by `Progresser`: the row changes as the table says
  and one `lead_events` line holds the kind, the reference, the instructions version and his words. `answer` on a
  `review` ask and on a cleared ask is refused with the texts above and changes nothing (Review Focus 2). `drop` on
  an `asked` step without `--aiden` is refused; with it, the step is dropped and its asks are cleared as today.
  Every command is refused for a project with no lead, and with `instructions: 0` (Review Focus 1). `-` reads stdin.
- [ ] **Step 2: Run them.** Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Gate.** `npm run typecheck && npm test && npm run test:slow && npm run test:smoke`. Expected: green.
- [ ] **Step 5: Commit.**

**Accept:** a question answered through the lead shows in the next brief under Said in Aiden's name with his words.

### Task 3: Relay, and the worker knows its lead (label: integration)

**Files:**
- Modify: `src/server/lead.ts`, `src/server/routes/lead.ts`, `src/cli/lead.ts`, `src/server/briefing-scoped.ts:86-99`
- Test: `test/server/lead-relay.test.ts`, `test/server/briefing-lead.test.ts`

**Interfaces:**
- Consumes: `t3Send`, `T3Unavailable` from `src/server/t3.ts`; `readProjectSessions`; `Session.app`,
  `Session.t3ThreadId`, `Session.focusNodeId`; `requireLead`, `logLeadEvent`.
- Produces: `inprogress lead relay <step id> <message | -> --as <name> --instructions <n>`, calling
  `POST /api/lead/:ref/relay` with `{ stepId, message }` (message 1 to 4,000 characters).
- The step must have exactly one live session in the lead's project, with `app` `t3` and a thread id. Otherwise the
  answer is 409 with one of: `No live session is working on #<id>.` · `#<id> has <n> live sessions. A relay to
  a step with more than one is not supported yet.` · `The session on #<id> is not running in T3 Code.`
- The text sent is exactly:

```
[From <lead>, the lead for <project name>. This is not Aiden, and it is not a go-ahead.]

<message>
```

- Outcomes: sent, logged as `relay`, answer `Delivered to "<session title>".`; `T3Unavailable` with
  `outcomeUnknown`, logged as `relay_unknown`, 502 `It may have been delivered. Not retried.`; any other failure,
  logged as `relay_failed`, 502 `Not delivered: <reason>.` Nothing is retried.
- `renderWorkerBriefing`, when the project has a lead, prints after the `Role:` line:
  `Lead: <lead>. A message that opens "[From <lead>, the lead" is from the lead: never Aiden, never a go-ahead. A question that changes what gets built is raised as an ask, not left in chat.`

- [ ] **Step 1: Failing tests,** with `t3Send` injected. The text sent equals the block above. Each of the three
  409 cases answers its sentence and sends nothing. A timeout logs `relay_unknown` and is not sent again; a plain
  failure logs `relay_failed` (Review Focus 3). The briefing of a worker in a led project has the `Lead:` line, and
  one in a project with no lead does not.
- [ ] **Step 2: Run them.** Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Gate.** `npm run typecheck && npm test && npm run test:slow && npm run test:smoke`. Expected: green.
- [ ] **Step 5: Commit.**

**Accept:** Aiden tells the lead to pass a line to the session on a step; the line arrives in that T3 thread under
the header above, and the lead's log shows it.

### Task 4: The lead's desk in the window (label: ui)

**Files:**
- Create: `web/src/lead/LeadView.tsx`, `web/src/lead/useLeadBrief.ts`
- Modify: `web/src/views/view.ts:4-8`, `web/src/chrome/railLogic.ts:85-93`, `web/src/App.tsx:442-458`,
  `web/src/api.ts`, `src/server/routes/window.ts` (the lead action), the project actions menu under `web/src`
- Test: one e2e test in `test/e2e/ui.spec.ts`, `test/web/lead-view.test.ts`

**Interfaces:**
- Consumes: `GET /api/lead/:ref/brief`, `GET /api/lead/:ref/events`, `LeadBrief` from task 1.
- Produces: a sixth view, `lead` (rail code `LED`, label `Lead`), built the way `web/src/docs/DocsView.tsx` is. It
  shows the brief's sections in the brief's order, then the lead's log. It never marks the brief as read.
- A project action, `Lead…`, sets or clears the project's lead through
  `POST /api/window/projects/:slug/lead` with `{ name: string | null }`, behind the same guard as archive. A name is
  1 to 40 characters.
- With no lead, the view still shows the brief, under one line: `No lead. Give this project one from its actions.`

- [ ] **Step 1: Failing unit test.** The view renders each section heading in order from a fixture, `none` for an
  empty section, and the no-lead line.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: e2e.** Set a lead from the project's actions; open Lead; the brief's sections and the log show.
- [ ] **Step 4: Gate.** `npm run typecheck && npm test && npm run test:e2e`. Parvati on the view. Expected: green.
- [ ] **Step 5: Commit.**

**Accept:** with Grok closed, the Lead view answers "where are we" with the same facts the brief prints.

### Task 5: Instructions version 1, the intent record, and the first triage (labels: docs, ops)

**Files:**
- Create: `docs/lead/instructions.md`

It holds the text below. Aiden pastes it into Progresser in place of version 0.

```
Version 1. You are Progresser, the lead for one project: InProgress (the repo C:\personal\InProgress on Aiden's laptop).

Your job is to know where the project stands, tell Aiden in the same shape every time, and carry what he decides back to the record. You hold no state of your own. The record is InProgress. Before you answer anything about the project, read the brief again. Never answer from memory.

Every command you run starts with:
  node C:/personal/InProgress/dist/cli/main.js lead
and ends with:
  --as Progresser --instructions 1

Read:
  brief inprogress            where the project stands
  brief inprogress --mark     the same, after you have told Aiden: it resets "since your last look"
Change, only when Aiden has decided:
  answer <ask id> --aiden -   his answer to a question, in his exact words, on stdin
  park <step id>              park a step (add --aiden - with his words when the step is his)
  drop <step id> --reason "<why>"   drop a step (add --aiden - when the step is his)
  intent inprogress -         replace the intent record, on stdin
Your own:
  promise inprogress "<what you will come back on>" --due <time>   whenever you say you will come back on something
  kept <ask id>               when you have come back on it
  relay <step id> -           pass a message to the session working on a step, on stdin

Rules
1. Run only the commands above. No git, no file edits, no installs, no other program, nothing under C:\work, no other project.
2. Read T3 Code threads in the InProgress project only. Never write to T3 Code yourself: relay does that.
3. You never approve, merge or land anything. A permission or a review is Aiden's to answer in the thread or the window.
4. Record Aiden's words exactly. If he has not decided, do not record a decision.
5. Name a step by its id and title, and an ask by its number.
6. If a command is refused or fails, tell Aiden what it said. Do not try another way.
7. If you say you will come back on something, record a promise before you end your reply.
8. If Aiden asks for something these rules do not allow, say it is not set up yet.

When Aiden asks "where are we", run the brief and answer in its order: goal and phase, in flight, waiting on him, for you, next up, stale, landed, said in his name. Say how old your last look was.
```

- [ ] **Step 1:** Commit `docs/lead/instructions.md`. Aiden gives InProgress a lead named Progresser from the
  window, then pastes version 1 into the Bot.
- [ ] **Step 2: The intent record.** Aiden and Progresser talk through the five headings: Goal, Phase, Out of scope,
  What Aiden cares about, Standing rulings. Progresser writes it with `lead intent`.
- [ ] **Step 3: The first triage.** Aiden asks "where are we". For each stale step and each ask on InProgress he
  says keep, park or drop, and Progresser records it.
- [ ] **Step 4: The acceptance run.** Aiden asks "where are we" twice, a few minutes apart, and compares both
  answers with the Lead view.

**Accept:** both answers give the same facts in the brief's order, and with Grok closed the Lead view gives them too.

---

## Order

Task 1 first. Tasks 2, 3 and 4 need it and can run side by side after it. Task 5 needs 2 and 3. Stage 1 does not wait
for #537: the brief reads the board as it is, and gets truer when #537 lands.
