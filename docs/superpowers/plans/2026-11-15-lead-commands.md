# The lead's commands: build plan

Sigmund's plan for task 2 of `2026-11-14-lead-stage-1-reads-and-talks.md` (#726). Read that task first: its table of
commands, its refusal texts and its tests are the contract, and are not repeated here. Labels: server and data.
Worktree `.claude/worktrees/lead-brief`, branch `lead-commands` (off main at 7b2d300).

**Criteria.**
- C1: `lead answer` on an open question of Aiden's clears it with his words. The asking session is handed the answer
  as for any answer, and the next brief cites his words under Said in Aiden's name.
- C2: `lead answer` on a review, a permission, a promise of the lead's or a cleared ask is refused and changes
  nothing. When Aiden answered first, his answer stands.
- C3: `lead park` and `lead drop` on a step of Aiden's (origin `me` or `asked`) need his words; a `proposed` step
  needs none. The step is parked or dropped as it is from the window.
- C4: `lead promise` puts an ask under For the lead with its due time, OVERDUE once past, and adds nothing to "need
  you". `lead kept` clears it, and no session is told of an answer.
- C5: `lead intent` makes the brief print the Goal and the Phase.
- C6: every command is refused, with nothing written, on a project with no lead, under another lead's name, on an
  archived project, with instructions below the current version, and without the bearer token.
- C7, after the gate, Aiden's: in Grok he tells Progresser to park one stale step in his own words. The step is
  parked and the next brief cites his words.

**Files Sev owns:** `src/server/lead-commands.ts` (new), `src/server/routes/lead.ts`, `src/server/schemas.ts`,
`src/cli/lead.ts`, `src/server/repo/asks.ts`, `src/server/repo/nodes.ts`, `src/server/repo/projects.ts` (one new
function), `src/server/digest.ts` (the two ask lists only), `test/server/lead-commands.test.ts` (new),
`test/cli/lead.test.ts`, the digest's test, and any fixture typecheck then asks for.
**Do not touch:** `src/hooks/`, `claude/`, `scripts/`, `web/`, `docs/`, `src/server/db/` (no migration: entry 20 holds
every column), `src/server/lead.ts` beyond an export, `src/server/lead-text.ts`, `src/core/board.ts`,
`src/server/t3.ts`, `src/mcp/`.

## Decisions the stage plan left open

1. **Every command names its project:** `lead <command> <project> ...`, as `lead brief <project>` does. The stage
   plan's table gave `answer`, `park`, `drop` and `kept` no project; a lead acts on one project, and one form is
   harder to get wrong. The route is `POST /api/lead/:ref/<command>`. An ask or a step of another project is refused
   with `a<id> is not in this project.` or `#<id> is not in this project.`

2. **One write per command.** `write()` cannot nest (`src/server/db/tx.ts:49`), and the repo functions each open
   their own. So each command is one `write(ctx, 'lead:<name>', (record) => ...)` that reads the row again inside it,
   runs its checks, makes the change and calls `logLeadEvent`: a refused command writes nothing, and a done one
   always has its line in `lead_events`. For that, split the body of each repo function below into an exported
   in-write form and keep the old function as `write(ctx, actor, (record) => xInWrite(...))`. Behaviour must not
   change: the existing tests of those functions stay green without an edit.
   - `src/server/repo/asks.ts`: export `clearInWrite` and add a last optional parameter `via: string | null = null`,
     written to `answered_via` on the first clear only. Export
     `raiseAskInWrite(ctx: Ctx, record: RecordEvent, actor: string, input: RaiseAskInput): RaisedAsk`, the body of
     `raiseAskDetailed`.
   - `src/server/repo/nodes.ts`: export
     `updateNodeInWrite(ctx: Ctx, record: RecordEvent, actor: string, id: number, patch: NodePatch): TreeNode` and
     `parkNodeInWrite(ctx: Ctx, record: RecordEvent, actor: string, id: number, input: { reason: string; where?: string }): TreeNode`,
     the bodies of `updateNode` and `parkNode` (the second without `check`, which `parkNode` still runs first).
   - `src/server/repo/projects.ts`: new
     `setProjectIntentInWrite(ctx: Ctx, record: RecordEvent, projectId: number, intent: string): string`. It sets
     `intent`, and `intent_updated_at` and `updated_at` to `ctx.now()`, records `project.updated` with
     `changes: { intent: 'replaced' }`, and returns the time.

3. **The commands** live in `src/server/lead-commands.ts`, one exported function each:
   `leadAnswer`, `leadPark`, `leadDrop`, `leadPromise`, `leadKept`, `leadIntent`, all
   `(ctx: Ctx, ref: string, as: string, instructions: number, input) => { text: string } & more`. Each starts with
   `requireLead(ctx, ref, as, instructions, true)`, uses the stored name (`project.lead`) in the actor
   `lead:<name>` and in the event, and runs the checks below inside its write, in the order given. A refusal is
   `conflict(<sentence>)` unless it says 400. `text` is the one sentence the CLI prints; steps are named with
   `stepRef`, asks with `askTag`.

   | Command and input | Checks, in order | Change | Event | `text` |
   |---|---|---|---|---|
   | `leadAnswer` `{ askId, aidenWords }` | in this project; a promise of the lead's: `a<id> is the lead's own promise. Clear it with kept.`; not a question: the stage plan's sentence; cleared: `Already answered: "<answer, cut to 120>".`, or `a<id> is already cleared, with no answer.` | `clearInWrite(ctx, record, actor, ask, aidenWords, true, 'lead')` | `answer`, `askId`, `nodeId`, `aidenWords` | `Answered a<id> with Aiden's words.` |
   | `leadPark` `{ stepId, reason?, aidenWords? }` | in this project; already parked: `#<id> is already parked.`; origin `me` or `asked` with no words: the stage plan's sentence | `parkNodeInWrite` with reason `reason`, else his words, else `Parked by <name>.` | `park`, `nodeId`, `text` the reason used, `aidenWords` | `Parked <step>.` |
   | `leadDrop` `{ stepId, reason, aidenWords? }` | in this project; done or dropped: `#<id> is <status>.`; the origin rule as for park | `updateNodeInWrite(..., { status: 'dropped' })` | `drop`, `nodeId`, `text` the reason, `aidenWords` | `Dropped <step>.` |
   | `leadPromise` `{ text, dueAt, stepId? }` | `stepId` in this project, else the project's root step; `dueAt` not after now: `The due time is in the past.` | `raiseAskInWrite` with kind `review`, owner `lead`, `dueAt` | `promise`, `askId`, `nodeId`, `text`; none when the ask was joined | `Promised a<id>, due <stamp(dueAt)>.`, or `Already promised: a<id>.` when joined |
   | `leadKept` `{ askId, note? }` | in this project; Aiden's: `a<id> is Aiden's. The lead clears only its own promises.`; cleared: `a<id> is already cleared.` | `clearInWrite(ctx, record, actor, ask, '', false)`: no answer text, so no session is owed one | `kept`, `askId`, `nodeId`, `text` the note | `Kept a<id>.` |
   | `leadIntent` `{ intent }` | `intentHeadlines(intent)` has an empty goal or phase: 400 `The intent record needs a line under a Goal heading and a line under a Phase heading.` | `setProjectIntentInWrite` | `intent`, `text` the whole intent | `Intent record replaced (<n> characters).` |

   A refusal the repo function itself makes (the project's root, a done step being parked) passes through as it is.
   A drop's reason is kept in the lead's log only: a step has no field for it.

4. **Schemas** (`src/server/schemas.ts`), each `.strict()`, each with `as: z.string().min(1).max(200)` and
   `instructions: z.number().int().min(0)` as `leadSeenBody` has: `leadAnswerBody` (`askId` a positive int,
   `aidenWords` trimmed, 1 to 2,000), `leadParkBody` (`stepId`, `reason` trimmed 1 to 500 optional, `aidenWords`
   optional), `leadDropBody` (`reason` required), `leadPromiseBody` (`text` trimmed 1 to 500, `dueAt`
   `z.string().datetime()`, `stepId` optional), `leadKeptBody` (`askId`, `note` trimmed, at most 500, optional),
   `leadIntentBody` (`intent` 1 to 8,000).

5. **Routes** (`src/server/routes/lead.ts`): six `POST /api/lead/:ref/<command>` with `{ onRequest: requireToken }`,
   as `seen` has. Each parses its body, calls its command and answers what it returns.

6. **The CLI** (`src/cli/lead.ts`). Every command takes `--as <name> --instructions <n>`, as `brief` does:

       lead answer <project> <ask id> --aiden <words>
       lead park <project> <step id> [--reason <text>] [--aiden <words>]
       lead drop <project> <step id> --reason <text> [--aiden <words>]
       lead promise <project> <text> --due <iso time> [--step <id>]
       lead kept <project> <ask id> [--note <text>]
       lead intent <project> <file>

   An ask id is `a7` or `7`; a step id is `#42` or `42` (unquoted, a shell reads `#42` as a comment, so the plain
   number must work). `--aiden`, `--reason` and `--note` take `-` to read stdin, and `intent`'s file is a path or
   `-`; at most one `-` per command. `runLead(rest, out, conn, io?)` gains
   `io: { stdin: () => Promise<string>; readFile: (path: string) => string }`, defaulting to the real ones, so a
   test passes its own. On success it prints `text` and exits 0. A refusal prints its sentence and exits 1. Bad
   arguments print `LEAD_USAGE`, now one line per command, and exit 1. Like `brief`, a command starts the server
   when it is down, once its arguments are good.

7. **The digest** (`src/server/digest.ts:293-304`): the line of a lead-owned ask in "Asks raised" and in "Asks
   cleared" carries ` (the lead's)` after its tag.

## Tests

`test/server/lead-commands.test.ts`, seeded as `setup()` in `test/server/lead-brief.test.ts` seeds (a project led by
`Progresser`, steps of each origin, a question, a review and a permission of Aiden's, a session that asked). The
stage plan's step 1, plus:

- **answer:** the row is cleared with his words, `cleared_by` `lead:Progresser`, `answered_via` `lead`; one
  `lead_events` row with the kind, `ask_id`, `node_id`, the instructions version and his words;
  `undeliveredAnswers` for the asking session holds it; `readLeadBrief(...).saidInAidensName[0]` is the answer with
  ref `a<id>` and his words.
- **answer, twice (Review Focus 2):** `clearAsk(ctx, 'window', id, 'Mine.')` first, then `leadAnswer`: refused with
  `Already answered: "Mine."`, the answer is still `Mine.`, `answered_via` is null, no `lead_events` row.
- **answer refused** on a review and on a permission (the stage plan's sentence), on a promise of the lead's, on an
  ask of another project. Each time `maxEventId` and the `lead_events` count are unchanged.
- **park:** a `proposed` step parks with no words; an `asked` step without words is refused with the sentence and
  stays as it was; with words it parks, the reason is his words when none was given, and the event holds them; a
  parked step is refused; its open asks are cleared as a park from the window clears them.
- **drop:** the same origin rule; the step is dropped and its open asks cleared; the event's text is the reason.
- **promise:** an ask with owner `lead`, kind `review` and `due_at` as an ISO time, on the root step when no step is
  given; a past due time is refused; a text of 501 characters is a 400; the brief lists it under For the lead;
  `listProjectSummaries(...).openAsks` does not move; the same promise twice is one ask and one event.
- **kept:** clears a promise with an empty answer; `deriveBoard(...)` puts no `answer_waiting` on its step and
  `undeliveredAnswers` is empty; refused for an ask of Aiden's and for a cleared one.
- **intent:** stored, with `intent_updated_at`; the brief's goal and phase come from it; no line under Phase is a
  400 and nothing is written; 8,001 characters is a 400; the event's text is the whole record.
- **every command (Review Focus 1):** a project with no lead answers 409 with `noLeadNamed`; `instructions: 0`
  answers 409 with `outOfDate(0)`; an archived project 409; no bearer token 401. Nothing is written in any of them.
- **routes:** `answer` and `park` through `app.inject`: the status and `{ text }`.

`test/cli/lead.test.ts`: each command prints the server's sentence and exits 0; `--aiden -` and `intent <project> -`
read the stdin the test passes; `5` and `#5` name the same step, `7` and `a7` the same ask; a refusal prints its
sentence and exits 1; bad arguments print the usage. The digest's test: the label on a lead's ask in both lists.

## Checks

`npm run typecheck`, `npm test`, `npm run test:slow`, `npm run test:smoke`, from the worktree, all green before the
report. Report the files changed, anything decided beyond this plan, and the raw last lines of each command.

## Carried to later steps

- #729: raise `LEAD_INSTRUCTIONS_VERSION` when instructions v1 land, so rules pasted before them can read and not
  write. The answer Aiden gets is ten lines or fewer, what needs him first (logged on #729).
- #727: when the T3 link is unavailable, the brief says so near the top, not in its last line.
