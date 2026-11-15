# The lead record and the brief: build plan

Sigmund's plan for task 1 of `2026-11-14-lead-stage-1-reads-and-talks.md`. Read that task first: its SQL, its
`LeadBrief` type, its refusal texts and the brief's exact text are the contract, and are not repeated here. Labels:
data and server. Worktree `.claude/worktrees/lead-brief`, branch `lead-brief`.

**Criteria.** C1: a project with no lead refuses `lead brief` with the plan's sentence. C2: with a lead, the brief
prints the plan's shape, and twice running differs only in its times. C3: a lead-owned ask adds nothing to "need
you". C4, after the gate: Aiden asks Progresser "where are we" and gets the brief.

**Files Sev owns:** `src/core/lead.ts`, `src/server/lead.ts`, `src/server/lead-text.ts`, `src/server/routes/lead.ts`,
`src/cli/lead.ts` (all new); `src/server/db/schema.ts` (append entry 20 only); `src/core/types.ts` (`Project`,
`Ask`); `src/server/repo/projects.ts`; `src/server/repo/asks.ts`; `src/core/board.ts` (the `openAsks` map only);
`src/server/schemas.ts`; `src/server/routes/window.ts` (one route); `src/server/app.ts` (register the routes);
`src/cli/commands.ts` (`USAGE` and one `case`); the tests below, and any fixture that typecheck then asks for.
**Do not touch:** `src/hooks/`, `claude/`, `scripts/`, `web/`, `docs/`, `src/server/t3.ts`, the briefing.

## Decisions the stage plan left open

1. **Where things live.** `src/core/lead.ts` holds the constants and types only. `renderLeadBrief` and
   `intentHeadlines` live in `src/server/lead-text.ts`, beside the helpers they reuse: `stamp` and `clip` (as
   `formatDigest` uses them in `src/server/digest.ts`), `spanAgo` (as `src/server/briefing-scoped.ts:61` uses it),
   `askTag` and `stepRef`. Import them; export one from its file if it is not exported. Do not copy them.
2. **`renderLeadBrief(b: LeadBrief): string`** computes every age against `b.at`, never against the clock, so the
   same brief always renders the same text.
3. **Setting a lead.** `setProjectLead(ctx: Ctx, actor: string, ref: string, name: string | null): Project` in
   `src/server/repo/projects.ts`: trims the name, 1 to 40 characters or `null`, writes `projects.lead`, and records
   the change the way `updateProject` records one. The only route that calls it is
   `POST /api/ui/projects/:id/lead` (body `name: string | null`) in `src/server/routes/window.ts`, written like the rename route beside it, behind
   the same guard as that file's archive route. The CLI and the MCP server get no way to call it.
4. **One place hides a lead-owned ask from the board.** In `deriveBoard` (`src/core/board.ts:126-127`) the
   `openAsks` map is built from asks with `clearedAt === null` and `owner !== 'lead'`. That keeps them out of
   `waiting`, out of `taskBoxes`' needs list and out of the `stale_ask` and `answered_in_chat` marks. In
   `listProjectSummaries` (`src/server/repo/projects.ts:528-542`) the `open_asks` subquery gains
   `AND a.owner = 'aiden'`.
5. **`readLeadBrief(ctx, ref, yours, now)`** builds from what is there:
   - the project from `resolveProject`, the snapshot from `getProjectSnapshot`, as `readDigest` does
     (`src/server/digest.ts:93-97`). Never call it inside a `write()`.
   - `inFlight`: `readProjectSessions(ctx, project.id)`, newest first; `title` is the focus step's title, or
     `no step claimed`; `stepId` is `focusNodeId`.
   - `waitingOnAiden`: the snapshot's asks with `clearedAt === null` and owner `aiden`, oldest first.
   - `aidenOpenAcrossProjects`: the sum of `openAsks` over `listProjectSummaries` rows whose status is `active`.
   - `forTheLead`: open asks with owner `lead`, soonest `dueAt` first, those with none last; `overdue` when
     `dueAt` is before `now`.
   - `nextUp`: the project's queue (`toProject` already resolves it with `liveQueue`), in order.
   - `stale`: `deriveBoard(snapshot, now.getTime()).marked`, in the order it returns.
   - `landedSince`: the snapshot's `done` steps with `completedAt` at or after `since`, newest first, where `since`
     is `project.leadSeenAt`, or seven days before `now` when it is `null`.
   - `saidInAidensName`: `lead_events` of the project with `aiden_words` not null and `at` at or after `since`,
     newest first; `ref` is `a<ask id>` when `ask_id` is set, else `#<node id>`.
   - `links`: `{ t3: 'not checked', t3At: null, lastSeenAt: project.leadSeenAt }`. Task 3 fills in T3.
   - `instructions`: `{ current: LEAD_INSTRUCTIONS_VERSION, yours }`.
   The JSON holds every row. Only `renderLeadBrief` cuts a list to `LEAD_LIST_CAP`.
6. **`requireLead(ctx, ref, as, instructions, write)`** compares names without regard to case, after trimming.
7. **The brief route.** `GET /api/lead/:ref/brief` takes `as`, `instructions` and `mark` in a strict zod query.
   With `as`: `requireLead(..., write: false)`, then `readLeadBrief` with `yours` set to `instructions`, then, when
   `mark` is `1`, `markLeadSeen` after the brief is built. Without `as` (the window): no lead check, `yours` null,
   never marks, and `mark` is ignored. It answers `{ brief, text }`. `GET /api/lead/:ref/events` answers
   `{ events }`, the last 100, newest first, each `{ id, at, lead, instructions, kind, nodeId, askId, sessionId,
   text, aidenWords }`.
8. **The CLI.** `runLead(rest, out, { baseUrl, token })` in `src/cli/lead.ts`, dispatched by `case 'lead'` in
   `src/cli/commands.ts` the way `digest` is. This change builds one subcommand:
   `lead brief <project> --as <name> --instructions <n> [--mark] [--json]`. It prints `text`, or with `--json` the
   brief as JSON. A missing `--as` or `--instructions`, or any other subcommand, prints `LEAD_USAGE` and exits
   non-zero. A refusal from the server prints its sentence and exits non-zero. `USAGE` gains `lead`.
9. **Types.** `Project` gains `lead: string | null`, `leadSeenAt: string | null`, `intent: string`,
   `intentUpdatedAt: string | null`. `Ask` gains `owner: AskOwner`, `dueAt: string | null`,
   `answeredVia: string | null`. `raiseAskDetailed`'s input gains optional `owner` and `dueAt`; the HTTP and MCP
   bodies do not change in this task. An unknown stored owner reads as `aiden`.

## Tests

As listed in the stage plan's task 1, step 1, plus:

- `test/server/lead-brief.test.ts`: seeded as `test/server/asks.test.ts:11-20` seeds a project, a step and an ask,
  with a session started by `handleHookEvent` as `test/server/agent-watch.test.ts:30-38` does. `setProjectLead`
  then `requireLead` passes for `progresser` and `Progresser `, and throws for `Rich`. The route with `as` on a
  project with no lead answers 409 and writes nothing; without `as` it answers the brief. `mark=1` sets
  `lead_seen_at`, and the next brief's `landedSince` starts from it. The window route sets and clears the lead.
- `test/core/board-lead-asks.test.ts`: a step whose only open ask is lead-owned has no `waiting`, no `stale_ask`
  mark, and is not in `taskBoxes(...).needs`.
- `test/server/lead-text.test.ts`: the full fixture renders, line for line, the text in the stage plan; the same
  brief renders the same text twice.

## Checks

`npm run typecheck`, `npm test`, `npm run test:slow`, `npm run test:smoke`, from the worktree, all green before the
report. Report the files changed, anything decided, and the raw last lines of each command.

## Fixes after Murr (round 1)

Scope grows for these: `web/src/App.tsx`, `web/src/panels/Details.tsx`, `web/src/project/projectOutline.ts` (one
filter each), `src/server/briefing.ts`, `src/server/briefing-scoped.ts`, `src/core/title.ts`,
`src/server/title-channel.ts`, `src/server/project-lifecycle.ts` only if F1 needs it, and `src/mcp/` for F3's label.

- **F1, the purge.** `lead_events.project_id` is `REFERENCES projects(id) ON DELETE CASCADE` (entry 20 is unshipped:
  edit it in place). Without it, purging a deleted project that has a lead event throws and stops every purge after
  it. Test: a purge of a deleted project with a `lead_events` row succeeds and the row is gone.
- **F2, one open ask per owner.** In entry 20: `DROP INDEX asks_open_once;` then
  `CREATE UNIQUE INDEX asks_open_once ON asks (node_id, kind, text, owner) WHERE cleared_at IS NULL;`. The re-select
  in `raiseAskDetailed` adds `AND owner = ?`. The entry's rollback note says an older build still inserts and joins
  correctly against the wider index. Test: a lead ask and an Aiden ask with the same kind and text on one step are
  two rows, and re-raising either joins its own.
- **F3, one predicate.** `export function isAidens(a: { owner: AskOwner }): boolean` in `src/core/lead.ts`
  (`a.owner !== 'lead'`), and one SQL fragment for the same test in `src/server/repo/asks.ts`. Use them at every
  reader, replacing the hand-written filters: `src/core/board.ts:128`; `src/server/briefing.ts:112`, `:177` and the
  scoped status line near `:427`; `src/server/briefing-scoped.ts:57-59` (both the open and the cleared list);
  `asksToRemind` (`src/server/repo/asks.ts:237`); the asks behind the expected title prefix (`src/core/title.ts:33`,
  `src/server/title-channel.ts:36`); `open_asks` (`src/server/repo/projects.ts:563`, as `owner != 'lead'`, so an
  owner this build does not know still counts as Aiden's); `web/src/App.tsx:125`; `web/src/panels/Details.tsx:206`;
  `web/src/project/projectOutline.ts:66`. In `src/mcp/`, wherever `get_node` or `search` print a step's asks, a
  lead-owned one is kept and labelled `(the lead's)`; report where that is, or that they print no asks.
  Tests: a lead-owned ask is absent from the scoped step block and the scoped status line, is not reminded by
  `asksToRemind`, does not make the expected title `BLOCKED` or `REVIEW`, and does not count in the window title.
- **F4, a lead's ask.** `raiseAskDetailed` stores `session_id` NULL for owner `lead` whatever `sessionId` says. A
  `dueAt` that does not parse as a date is a `badRequest` (`The due time is not a date`, hint `Send an ISO time.`);
  a good one is stored as `new Date(dueAt).toISOString()`.
- **F5, marking is a guarded write.** Remove `mark` from the GET. New `POST /api/lead/:ref/seen` with the strict
  body `{ as, instructions }`, behind the bearer token guard the other write routes use: `requireLead` (write false),
  then `markLeadSeen`, answering `{ seenAt }`. With `--mark` the CLI prints the brief, then posts `seen`; a failure
  there prints its sentence and exits 1.
- **F6, shelved asks.** `waitingOnAiden` leaves out an ask on a shelved step (`shelvedIds(buildIndex(nodes))`,
  `src/core/tree.ts:56`), as the need-you count does.
- **F7, the server.** `lead brief` starts the server when it is down, as `open` does (`ensure` in
  `src/cli/commands.ts`), once its arguments are good; one that will not start prints `InProgress did not start. See
  <server.log>` and exits 1. (This item first said "as `digest` does", which was wrong: `digest` only reports a stopped
  server. Sev stopped on it, and Sigmund built it inline.)
- **F8, next up.** Call `deriveBoard` once. `nextUp` is its `next` rows, in the Board's order; `stale` comes from the
  same result.
- **F9, stale means stale.** `export const LEAD_STALE_MARKS = ['ended_open', 'stale_ask', 'done_focus', 'stalled',
  'answer_waiting', 'answered_in_chat'] as const` in `src/core/lead.ts`. The Stale section lists only rows that carry
  one of them and prints only those marks. `no_outcome`, `no_why` and `deep` are housekeeping and stay out.
- **F10, archived.** `requireLead` refuses a project whose status is `archived` with a 409:
  `This project is archived, so it has no lead.`
- **F11, headings.** `intentHeadlines` matches a heading with `/^#{1,6}\s*goal\s*:?\s*#*$/i` (and `phase`), and a
  paragraph ends at any line that starts with `#`. `renderLeadBrief` prints
  `Goal: The intent record has no Goal heading.` when `intent.updatedAt` is set and the goal is empty.
- **F12, one line stays one line.** In `renderLeadBrief` every piece of free text (the project name, titles, ask
  text, outcomes, Aiden's words, goal, phase) has C0 and C1 control characters and newlines replaced by a space, then
  is cut. Test: a project named `InGame\nv2` and an ask holding an escape character each stay on one line.
- **F13, tests.** The "twice running" test renders the same project at two different `now` values and compares the
  texts with the times masked.

Built inline by Sigmund on top of Sev's round, each with its test:

- **F5, the gap.** `seen` takes an optional `at`, the time of the brief the lead read, and the CLI sends it: a step
  that lands between the brief and the post is in the next brief. A time ahead of the clock counts as now, and the
  look never moves back (`markLeadSeen` answers the look on record).
- **F11, step lines.** A paragraph ends at `/^#{1,6}(?!\d)/`, not at any `#`: a wrapped line that opens with a step
  (`#729, in order.`) is text.
- **F12, separators.** U+2028 and U+2029 are cleaned too.

For #726: the digest's "Asks raised" and "Asks cleared" lists (`src/server/digest.ts:293-303`) read every owner, so
once `promise` exists a lead's ask needs its label there. And `kept` must clear a lead's ask without answer text, or the `answer_waiting` mark and the delivery of
answers (`src/core/board.ts:132`, `src/server/repo/asks.ts:201-227`) will treat it as owed to a session.
