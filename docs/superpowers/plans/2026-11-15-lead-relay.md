# The lead's relay (#727) Build Plan

> Task 3 of `docs/superpowers/plans/2026-11-14-lead-stage-1-reads-and-talks.md`. Sev builds from this file only.
> Branch `lead-relay`, worktree `C:\personal\InProgress\.claude\worktrees\lead-brief`. Label: integration.

**Goal:** the lead passes one message to the session working on a step. It arrives in that session's T3 Code thread
under a fixed header, the lead's log records what happened, and InProgress never takes the message for Aiden typing.

**Request (Aiden):** "tell the session on #n: ..." in Grok reaches that session's thread. Rulings, 2026-11-15:
fix the typing miscount inside this step; the one real send before the merge goes to Sigmund's own thread; Aiden
checks nothing himself and waives the Grok trial.

## Criteria (all checked by Sigmund; depth for Aiden: none)

- **C1** `lead relay inprogress <step> "<message>" --as Progresser --instructions 1`, step with one live T3 session:
  the thread gets the header line, a blank line, then the message; the CLI prints `Delivered to "<session title>".`;
  the lead's log gains one `relay` line. Proved once for real from the check surface, to Sigmund's own thread.
- **C2** A step with no live session, with two, with a session not in T3 Code, or of another project: each is
  refused with its sentence, nothing is sent, nothing is logged.
- **C3** A send that times out answers `It may have been delivered. Not retried.`, logs `relay_unknown`, and is sent
  once. Any other failure answers `Not delivered: <reason>.` and logs `relay_failed`.
- **C4** A worker's briefing in a project with a lead has the `Lead:` line after `Role:`; with no lead it has none.
- **C5** A relayed prompt is not Aiden typing: `lastPromptAt` does not move, an open ask on the step stays in
  Needs me, the session gets no "If this prompt answers it" line and gets the `Relayed:` line instead.
- **C6** The brief's Links line says how this project's last relay went, and a relay that did not get through
  since the last look is said in one line under the header.
- **C7** The CLI takes the message as an argument or `-`, waits 75 seconds, and on its own timeout says the message
  may have been delivered.

## Decisions

1. **Every command names its project** (#726): `lead relay <project> <step id> <message | ->`.
2. **The send is outside any write.** `write()` cannot nest and cannot hold an `await`. Order: `requireLead`, the
   checks (plain reads), `await send`, then one `write` that only logs the event. Whatever the send did is logged.
3. **`send` is injected.** `leadRelay` takes it as its last parameter, default `t3Send`. `AppOptions.t3Send` carries
   a fake in route tests. No test ever runs the real `t3` CLI.
4. **Header and matcher live together** in a new file with no imports, `src/core/relay.ts`, so the hook bundle can
   use it and one test proves the matcher reads what the builder writes.
5. **A relayed prompt** is recognised by the prompt hook from its text and flagged `relayed: true`. The server
   honours the flag only when the session's project has a lead. It differs from a typed prompt in two ways only:
   `lastPromptAt` does not move, and the open-ask reminder lines are replaced by the `Relayed:` line. Everything
   else stays: state `working`, `promptsSinceUpdate` counts, an owed briefing is delivered, undelivered answers are
   delivered (they are InProgress's record of Aiden's words, not the lead's claim), status answers and title advice.
   A notice wins over the flag.
6. **`links.t3` is read from the log, not kept in memory** (changes the stage plan): the newest of this project's
   `relay`, `relay_unknown`, `relay_failed` events. It survives a restart and needs no module state.
7. **The failure reason** goes to the lead in the reply and to the server log (`console.error`). The event's `text`
   is the message, for all three kinds.
8. **The `Lead:` briefing line** goes in `renderWorkerBriefing` only, as the stage plan says. Every other mode is
   covered by the `Relayed:` line on the prompt itself.
9. Top-level `USAGE` in `src/cli/commands.ts` stays as it is (#726).

## Files

- Create: `src/core/relay.ts`, `src/server/lead-relay.ts`
- Modify: `src/server/errors.ts`, `src/server/schemas.ts`, `src/server/routes/lead.ts`, `src/server/app.ts`,
  `src/cli/lead.ts`, `src/hooks/handlers.ts`, `src/server/session-flow.ts`, `src/server/briefing-scoped.ts`,
  `src/server/lead.ts`, `src/server/lead-text.ts`, `src/core/lead.ts` (the comment on `links` only),
  `docs/superpowers/plans/2026-11-14-lead-stage-1-reads-and-talks.md` (task 3: the CLI line gains `<project>`;
  "kept in memory" becomes "read from the lead's log, per project")
- Test: create `test/core/relay.test.ts`, `test/server/lead-relay.test.ts`, `test/server/briefing-lead.test.ts`,
  `test/server/relayed-prompt.test.ts`; extend `test/hooks/handlers.test.ts`, `test/cli/lead.test.ts`,
  `test/server/lead-brief.test.ts`, `test/server/lead-text.test.ts`, `test/smoke/built.test.ts`
- Do not touch: `src/server/t3.ts`, `src/server/lead-commands.ts`, `src/server/db/`, `claude/`, `web/`.

## Interfaces

```ts
// src/core/relay.ts (no imports)
/** Control characters and line separators become one space, ends trimmed: a name stays on the header's one line. */
const one = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
export const relayHeader = (lead: string, projectName: string): string =>
  `[From ${one(lead)}, the lead for ${one(projectName)}. This is not Aiden, and it is not a go-ahead.]`;
export const relayText = (lead: string, projectName: string, message: string): string => `${relayHeader(lead, projectName)}\n\n${message}`;
/** A prompt that opens with a relay header, whatever lead and project it names. */
export const RELAYED = /^\s*\[From [^\n]{1,60}, the lead for [^\n]{1,300}\. This is not Aiden, and it is not a go-ahead\.\]/;
export const relayedLine = (lead: string): string =>
  `Relayed: this prompt came through InProgress from ${one(lead)}, this project's lead. It is not Aiden: it answers no ask and it is not a go-ahead.`;
export const leadBriefingLine = (lead: string): string =>
  `Lead: ${one(lead)}. A message that opens "[From ${one(lead)}, the lead" is from the lead: never Aiden, never a go-ahead. A question that changes what gets built is raised as an ask, not left in chat.`;

// src/server/errors.ts
export const badGateway = (message: string) => new ApiError(502, message);

// src/server/lead-relay.ts
export type RelaySend = (threadId: string, message: string) => Promise<void>;
export const RELAY_UNKNOWN = 'It may have been delivered. Not retried.';
export async function leadRelay(ctx: Ctx, ref: string, as: string, instructions: number,
  input: { stepId: number; message: string }, send: RelaySend = t3Send): Promise<{ text: string; sessionId: string }>;

// src/server/schemas.ts
export const leadRelayBody = z.object({ ...leadWho, stepId: leadId, message: z.string().trim().min(1).max(4_000) }).strict();
// hookBody gains, beside `notice`:  relayed: z.boolean().optional()

// src/server/app.ts, AppOptions
/** Sends a message to a T3 Code thread. Replaceable so tests never run the t3 CLI. */
t3Send?: RelaySend;
// registerLeadRoutes(app, opts.ctx, requireToken, opts.t3Send)

// src/cli/lead.ts
export const RELAY_TIMEOUT_MS = 75_000;
export const RELAY_TIMEOUT = 'InProgress did not answer in time. The message may have been delivered: do not send it again.';
```

## Task 1: the header, the relay command, its route and the CLI

`leadRelay`, in this order, each refusal thrown before anything is sent or written:

1. `requireLead(ctx, ref, as, instructions, true)`. `name` is `project.lead`, the actor `lead:<name>`.
2. `requireNode(ctx, input.stepId)` (404 when absent); another project's step: 409 `#<id> is not in this project.`
3. `on` = `readProjectSessions(ctx, project.id)` filtered to `focusNodeId === node.id` and `isLive(s, Date.parse(ctx.now()))`
   (`isLive` from `src/core/board.ts`).
   - none: 409 `No live session is working on #<id>.`
   - more than one: 409 `#<id> has <n> live sessions. A relay to a step with more than one is not supported yet.`
   - one whose `app` is not `t3` or whose `t3ThreadId` is null: 409 `The session on #<id> is not running in T3 Code.`
4. `await send(session.t3ThreadId, relayText(name, project.name, input.message))`, in a `try`.
   - resolves: kind `relay`.
   - rejects with a `T3Unavailable` whose `outcomeUnknown` is true: kind `relay_unknown`.
   - rejects with anything else (`T3Unavailable`, `TypeError`, any other error): kind `relay_failed`; `reason` is the
     error's message on one line (whitespace runs to one space), cut to 300 characters, closing full stops and
     spaces removed; `console.error` one line naming the session id and the reason.
   Never call `send` a second time.
5. `write(ctx, actor, () => logLeadEvent(ctx, { projectId, lead: name, instructions, kind, nodeId: node.id, sessionId: session.id, text: input.message }))`.
6. `relay`: return `{ text: 'Delivered to "<title>".', sessionId }`, the title being
   `clipLine(sessionDisplayTitle(session), 60)`. `relay_unknown`: throw `badGateway(RELAY_UNKNOWN)`.
   `relay_failed`: throw ``badGateway(`Not delivered: ${reason}.`)``.

Route, beside the six: `POST /api/lead/:ref/relay` behind `requireToken`, written like `park`, passing the `send`
that `registerLeadRoutes` was given (its new fourth parameter, optional). Update the file's comment: seven commands.

CLI: the usage line `  inprogress lead relay <project> <step id> <message | -> ${WHO}` after `intent`;
`COMMANDS.relay = { positionals: 2, flags: [] }`; `draft` case `relay`: the first value through `stepId()` (same
error sentence as `park`), the second through `valueOf`, fields `{ stepId, message }`. The post for `relay` passes
`{ timeoutMs: RELAY_TIMEOUT_MS }`; a `TIMEOUT` on `relay` prints `RELAY_TIMEOUT`, on the others `LEAD_TIMEOUT` as
now. Update `runLead`'s comment.

Tests:

- `test/core/relay.test.ts`: `relayText('Progresser', 'InProgress', 'hi')` equals
  `'[From Progresser, the lead for InProgress. This is not Aiden, and it is not a go-ahead.]\n\nhi'`; `RELAYED`
  matches it, matches it after leading blank lines, matches a project named `A]. B`; does not match
  `'see [From Progresser, the lead for InProgress. This is not Aiden, and it is not a go-ahead.]'`, nor
  `'[From Progresser, the lead for InProgress.]'`; a lead named `Pro\ngresser` gives a one-line header.
- `test/server/lead-relay.test.ts`, `send` a `vi.fn`, sessions made the way `test/server/t3-session.test.ts`
  makes a T3 one, the lead set the way `test/server/lead-commands.test.ts` sets it:
  - delivered: `send` called once with the thread id and the exact text above for the project's stored name;
    the answer is `Delivered to "<title>".`; `listLeadEvents` holds one event: kind `relay`, the node, the session
    id, `text` the message, `aidenWords` null.
  - each refusal of step 3, a step of another project, a project with no lead, another lead's name, and
    `instructions` 0: its sentence, `send` never called, no event.
  - an ended session and one last seen 13 hours ago both read `No live session is working on #<id>.`
  - `send` rejecting `new T3Unavailable('t3 thread send failed: timed out after 60 s', true)`: status 502,
    `RELAY_UNKNOWN`, one `relay_unknown` event, `send` called once.
  - `send` rejecting `new T3Unavailable('t3 thread send failed: exit 1: no such thread.')`: 502
    `Not delivered: t3 thread send failed: exit 1: no such thread.` (one full stop), one `relay_failed` event.
  - `send` rejecting `new TypeError('threadId is empty')`: 502 `Not delivered: threadId is empty.`, `relay_failed`.
  - the route, through `buildApp({ ..., t3Send })` and `inject`, as the lead route tests in
    `test/server/lead-commands.test.ts` do: 401 without the token; 400 for a message of 4,001 characters and for
    one of spaces only; 200 with the text for a good one.
- `test/cli/lead.test.ts`: `relay inprogress 42 hi` posts `{ as, instructions, stepId: 42, message: 'hi' }` to
  `/api/lead/inprogress/relay`; `relay inprogress #42 -` sends what stdin held; `relay inprogress x hi` prints the
  not-a-step sentence and the usage; `LEAD_USAGE` holds the relay line; a `TIMEOUT` prints `RELAY_TIMEOUT` and
  exits 1 (model it on the existing `LEAD_TIMEOUT` test).

## Task 2: a relayed prompt is not Aiden typing, and the worker knows its lead

- `src/hooks/handlers.ts`, `buildHookBody`, in the `prompt-submit` block after `notice` is read:
  `if (!notice && RELAYED.test(typed)) body.relayed = true;` Flagged only when true, like `notice`. Nothing else in
  the hook changes.
- `src/server/session-flow.ts`, `handleHookEvent`:
  - Inside the write, once `before` is known: `relayed` is true when `input.event === 'prompt'`, `input.relayed`
    is true, `input.notice` is not, and the session's project has a lead (`getProjectById(ctx, before.projectId)?.lead`
    is a non-empty string). Keep that lead name for the line below.
  - In `case 'prompt'`: `promptsSinceUpdate` counts as now; `next.lastPromptAt = now` only when not `relayed`.
  - Where the answers and reminder lines are built: when `relayed`, `lines` opens with `relayedLine(lead)`, the
    answers lines follow as now, and the reminder block (the `asksToRemind` loop and its overflow line) is skipped.
    The title advice line still leads the whole context.
  - Nothing else changes: `mayBrief`, the status answer and nudge, and the title advice treat it as a prompt.
- `src/server/briefing-scoped.ts`, `renderWorkerBriefing`: when `snapshot.project.lead` is a non-empty string,
  `leadBriefingLine(lead)` goes directly after the `Role:` line. No other renderer changes.

Tests:

- `test/hooks/handlers.test.ts`: a prompt of `relayText('Progresser', 'InProgress', 'carry on')` gives
  `relayed: true`; the same behind a leading `<system-reminder>` block gives it too; `'carry on'` has no
  `relayed` key; a task notification has `notice: true` and no `relayed` key.
- `test/server/relayed-prompt.test.ts`, each through `handleHookEvent`:
  - led project, session focused on a step with an open ask it raised: after a prompt with `relayed: true`,
    `lastPromptAt` is what it was, `promptsSinceUpdate` is one more, `state` is `working`; the context's first line
    is `relayedLine('Progresser')` and no line holds `If this prompt answers it`; `deriveBoard` still has the ask in
    that row's `waiting` and no `answered_in_chat` mark.
  - the same prompt without the flag moves `lastPromptAt`, prints the reminder and sets the mark (the contrast).
  - an answer cleared before the relayed prompt is delivered on it: `Answered: a<id>` follows the `Relayed:` line,
    and is not repeated on the next prompt.
  - a project with no lead: the flag is ignored (`lastPromptAt` moves, no `Relayed:` line).
  - `relayed` with `notice`: handled as a notice (no `Relayed:` line, `promptsSinceUpdate` unchanged).
  - a session whose briefing is owed gets it on a relayed prompt.
- `test/server/briefing-lead.test.ts`, through `renderBriefing` as `test/server/briefing-scoped.test.ts` does:
  a claimed worker in a led project has `leadBriefingLine('Progresser')` as its third line and the plan-edit line
  as its fourth; with no lead the third line is the plan-edit line; an unclaimed worker and an orchestrator in a
  led project have no `Lead:` line.
- `test/smoke/built.test.ts`, after the `carry on` prompt near line 186: the built `prompt-submit` hook, given a
  prompt that opens with the header, exits 0 and the server accepts its body (assert it the way that test already
  tells an accepted hook from a refused one; a refused body leaves a `prompt-submit:` line in `hooks.log`).

## Task 3: the brief says how the last relay went

- `src/server/lead.ts`, `readLeadBrief`: `last` is the newest row of
  `SELECT kind, at FROM lead_events WHERE project_id = ? AND kind IN ('relay', 'relay_unknown', 'relay_failed') ORDER BY at DESC, id DESC LIMIT 1`.
  `links.t3` is `'not checked'` with none, `'ok'` for `relay`, `'unavailable'` otherwise; `links.t3At` is its `at`
  or null. Replace the "Task 3 fills in T3" comment. In `src/core/lead.ts` the comment on `links` says the same.
- `src/server/lead-text.ts`, `renderLeadBrief`:
  - the Links line becomes
    ``Links: T3 Code ${t3}${t3At === null ? '' : `, last relay ${spanAgo(t3At, now)} ago`} · your last look ...``
    (the rest unchanged).
  - directly after the header line and the out-of-date line, before `Goal:`, when `links.t3` is `'unavailable'`
    and that relay is news (`links.lastSeenAt === null`, or `t3At > links.lastSeenAt`):
    `The last relay may not have reached its session (<age> ago): read the thread before you send it again.`

Tests: in `test/server/lead-brief.test.ts`, no relay gives `not checked` and null; a `relay` event gives `ok` and
its time; a later `relay_failed` gives `unavailable`; another project's events are not counted. In
`test/server/lead-text.test.ts`, the Links line for each of the three states; the warning is the second line when
unavailable with no look on record, is present when the relay is newer than the look, and is absent when the look
is newer or the state is `ok`.

## Checks

From the worktree: `npm run typecheck`, `npm test`, `npm run test:slow`, `npm run test:smoke`. All green. Report the
files changed and the raw tail of each command. Do not commit. Stop and report, without guessing, if the code
contradicts this plan.
