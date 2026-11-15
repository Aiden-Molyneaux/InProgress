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
   `POST /api/window/projects/:slug/lead` with `{ name: string | null }` in `src/server/routes/window.ts`, behind
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
