# Review Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to run this plan package by
> package. Steps use checkbox (`- [ ]`) syntax for tracking. Each package is one branch, one implementer brief and one
> deploy. This plan fixes the interfaces, files, tests and acceptance for each package; the implementer reads the code
> and writes it test-first.

**Goal:** Make the InProgress window truer and easier to read at a glance, by carrying out the eleven recommendations
of the 2026-10-04 product review plus per-session identity and queue ownership.

**Architecture:** Nothing structural moves. The server stays the single writer, hooks keep feeding the live layer with
no AI, and the scribe keeps the plan. The changes push more onto the hook-fed layer (task writes, subagent purpose, a
trail of ended work), give each session an identity its subagents inherit, and cut the briefing.

**Tech Stack:** Node 20, TypeScript, Fastify 5, better-sqlite3 11, zod, `@modelcontextprotocol/sdk`, React 18,
`@xyflow/react` 12, vitest, Playwright. Windows.

**Spec:** `docs/superpowers/specs/2026-10-04-review-actions-design.md`. Section numbers below (§1 to §9) refer to it.
It is the source of truth for behaviour; this plan adds files, interfaces, tests and order. Background: the review,
resource r27 on #88.

## Global Constraints

- **Design first.** Aiden's approval of the spec is the "yes" for every package. Anything a package needs that the
  spec does not say is a new design question: put it to Aiden in chat and wait.
- **One branch per package** off `main`, named as given below. Merge into `main` locally after a green
  `npm run deploy`. Never push.
- **Implementers** are Opus 5.5 subagents, each in its own git worktree, with a brief file under
  `.superpowers/iter/<date>/`. Copy the "Rules" block of `.superpowers/iter/2026-10-02/brief-type-labels.md` into
  every brief (worktree setup, never touch the live setup, files allowed, hygiene, report). Give each its own
  `INPROGRESS_E2E_PORT`. Start each Agent description with the package's step id.
- **Never touch the live setup by hand.** Nothing but `npm run deploy` writes `dist/`, `web/dist/`, `~/.claude` or
  `~/.inprogress`. Implementers never run deploy or `claude:install`, and never use port 4317.
- **Test gates by label** (from the skill): `ui` is typecheck + unit, plus one e2e test per user-visible feature, and
  no failing-test-first for styling or wording. `integration` is typecheck + unit + smoke, with full strict gates for
  hooks and the installer. `data` is typecheck + unit with full strict gates, and `min_reader_version` stays 1 when a
  migration only adds. Everything else is typecheck + unit.
- **Before an implementer finishes:** `npm run typecheck`, `npm test`, `npm run test:smoke`, and
  `INPROGRESS_E2E_PORT=<port> npm run test:e2e`.
- **Commits** end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Keep working:** tabs, Follow and the camera, the keyboard, the Details sheet, sanitised Markdown, the stale nudge,
  and the e2e DOM contract except where a package changes it on purpose.
- **Restarts.** After P1, P6 and P8 deploy, open Claude sessions must restart to load the new kit and hooks. Tell
  Aiden each time.
- **Tracking.** Each package is a step under the "Review actions" phase. Brief the scribe at start and finish, and
  attach the implementer's report.

## Order

| # | Package | Spec | Branch | Label | Size | Depends on |
|---|---|---|---|---|---|---|
| P0 | Housekeeping before any code | | none | ops | S | |
| P1 | Task writes from the main session | §1 | `feat/review-p1-task-cli` | integration | S–M | |
| P2 | Canvas at 520 px | §2 | `feat/review-p2-canvas-520` | ui | M | |
| P3 | Trail of ended work | §3 | `feat/review-p3-trail` | ui | M | P2 |
| P4 | Session identity | §4 | `feat/review-p4-identity` | data | M | P3 |
| P5 | Owned queue entries | §6 | `feat/review-p5-owned-queue` | server | M | P4 |
| P6 | Subagent purpose and readers | §5 | `feat/review-p6-agent-purpose` | integration | M | P4 |
| P7 | Honest statuses | §7 | `feat/review-p7-honest-status` | server | S–M | P5 |
| P8 | Shorter briefing, one set of rules | §8 | `feat/review-p8-briefing` | integration | S | P1, P3, P5, P7 |
| P9 | Tickets: live layer trial | §9 | none | research | S | |

P1 and P2 touch different files and may run side by side. Everything from P3 on is serial: the packages share
`src/core/types.ts`, `src/core/layout.ts`, `web/src/canvas/Canvas.tsx` and `src/server/briefing.ts`.

Migration numbers follow this order: P4 is migration 4 and P6 is migration 5. If the order changes, so do the numbers.

---

## P0: Housekeeping before any code

- [ ] Commit the spec and this plan to `main` (docs only), so implementer worktrees contain them.
- [ ] Tell Aiden to hold "#2 InProgress Dev Session" on #81. The UI overhaul waits until P8 has deployed.
- [ ] With Aiden's confirmation, brief the scribe for project `vcad-1255`: `#14 → done; outcome "Both PRs merged
      2026-10-01 (ledger, G-MERGE)"`, and close or advance #9 to match the ledger.
- [ ] Brief the scribe for project `inthink-marathon-v3`: replace the playbook with its first paragraph only (the text
      before "Keeping InProgress current"). Read the current text with the CLI `outline inthink-marathon-v3` first,
      and pass the full replacement in the brief.

---

## P1: Task writes from the main session (§1)

**Files:**
- Create: `src/cli/tasks.ts`, `test/cli/tasks.test.ts`
- Modify: `src/cli/commands.ts` (new `tasks` case, `USAGE`), `src/server/schemas.ts` (`tasksBody`),
  `src/server/repo/work.ts` (`setTasks`), `src/server/routes/sessions.ts`, `src/mcp/server.ts` (remove `set_tasks`),
  `src/mcp/format.ts`, `src/cli/claude-config.ts` (allow rules), `src/server/briefing.ts` (the tasks rule line),
  `web/src/describe.ts` (actor `session:<id>`), `claude/skills/inprogress/SKILL.md`,
  `claude/agents/inprogress-scribe.md`
- Test: `test/cli/commands.test.ts`, `test/server/work.test.ts`, `test/server/sessions.test.ts`,
  `test/mcp/server.test.ts`, `test/cli/claude-config.test.ts`, `test/smoke/built.test.ts`, `test/web/describe.test.ts`

**Interfaces (produces):**
```ts
// src/cli/tasks.ts
export interface TasksArgs { session: string; nodeId?: number; tasks: { subject: string; status: WorkStatus }[] }
/** `[#id] --session <id> [--done|--doing|--todo "<subject>"]...`, flags in list order. */
export function parseTasksArgs(args: string[]): TasksArgs | { error: string };
/** `#88: 2 done · 1 in progress · 1 pending`; zero parts left out; `#88: no tasks` when empty. */
export function formatTaskCounts(nodeId: number, tasks: Pick<WorkItem, 'status'>[]): string;

// src/server/schemas.ts: nodeId becomes optional
// src/server/repo/work.ts
export function setTasks(ctx: Ctx, actor: string, sessionId: string, nodeId: number | undefined, tasks: TaskInput[]):
  { nodeId: number; tasks: WorkItem[] };
```

- [ ] `parseTasksArgs`: unit tests first. Cover order kept across mixed flags, `#88` and `88`, a missing `--session`,
      a flag with no subject, an unknown flag, and no task flags (an empty list).
- [ ] `setTasks` with no `nodeId` uses the session's focus. With no focus it throws `badRequest('This session has no
      focus', 'Name the step: tasks #id …')`. The route returns `{ nodeId, tasks }`.
- [ ] CLI `tasks`: posts with `{ actor: 'session:<id>' }` and the token, prints `formatTaskCounts`, exits 1 with
      message and hint on an `ApiClientError`. Assert a write by `session:<id>` does not reset `promptsSinceUpdate`.
- [ ] Remove the `set_tasks` MCP tool and its formatter. Update the scribe prompt (drop the `tasks on #57` bullet)
      and the skill.
- [ ] Allow rules. Before coding, check the exact rule syntax for the Bash tool and the PowerShell tool against the
      Claude Code permissions docs (use the `claude-code-guide` agent). `ALLOW_RULES` becomes a function of the repo
      and node paths. `uninstall` and `kitStatus` must recognise the rendered rules. This is installer work: full
      strict gates.
- [ ] Briefing: the tasks rule prints the command in full, built from `process.execPath` and the `dist/cli/main.js`
      beside the running server, forward slashes, both paths quoted. Only the wording of that one rule line changes
      here; P8 rewrites the block.
- [ ] `describe.ts`: a `work.updated` event by actor `session:<id>` reads as that session's title.
- [ ] Smoke: against the built CLI, `tasks` on a tracked session sets the list and prints the counts line.

**Acceptance (live, after deploy and a session restart):** in a desktop session, running the briefing's command puts
the tasks under the focused step within a second, with no permission prompt. The scribe no longer lists `set_tasks`.

---

## P2: Canvas at 520 px (§2)

**Files:**
- Modify: `src/core/tree.ts` (`computeVisible`), `src/core/layout.ts`, `web/src/canvas/Canvas.tsx`,
  `web/src/canvas/MoreNode.tsx`, `web/src/canvas/NodeCard.tsx`, `web/src/useFoldOverrides.ts`, `web/src/styles.css`
- Test: `test/core/tree.test.ts`, `test/core/layout.test.ts`, `test/e2e/ui.spec.ts` (16 minimap references to remove
  or rewrite)

**Interfaces (produces):**
```ts
// src/core/tree.ts
export const DONE_RUN_MIN = 3;
export const DONE_RUN_AGE_MS = 24 * 60 * 60 * 1000;
export type VisibleItem =
  | { type: 'node'; node: TreeNode; depth: number; folded: boolean; hasChildren: boolean }
  | { type: 'more'; parentId: number; run: number; depth: number; hiddenIds: number[]; variant: 'tail' | 'done' };
export interface VisibleOptions {
  overrides?: FoldOverrides; noFold?: boolean; pins?: Iterable<number>;
  /** Fold runs of finished siblings. The canvas passes it; the text outline never does. */
  doneRuns?: { now: number };
}
// src/core/layout.ts
export interface LayoutMoreItem { /* as today */ variant: 'tail' | 'done' }   // id `done<parentId>-<run>` for done runs
```

- [ ] `computeVisible`: with `doneRuns`, a run is `DONE_RUN_MIN` or more consecutive children that are `done`
      (`completedAt` older than `DONE_RUN_AGE_MS`) or `dropped` (`updatedAt` older than that), not pinned, and not
      already hidden by the tail rule. Override `done:<parentId>` set to `open` shows that parent's runs. Unit tests:
      a run of 2 stays, a run of 3 folds, a step finished an hour ago splits the run, a pinned step splits it, the
      override opens it, and `renderOutline` output is unchanged.
- [ ] `layoutOutline` passes `doneRuns: { now }` and carries `variant`. `MoreNode` renders `✓ n done` for `done` and
      `+n more` for `tail`; a click toggles the matching override.
- [ ] Remove `MiniMap` from `Canvas.tsx` with `minimapColor`, `minimapClass`, the `sizes` state and its feedback, and
      the minimap pointer and wheel handlers that turn Follow off. Check first that nothing else reads `sizes`. Leave
      `onlyRenderVisibleElements` off.
- [ ] `NodeCard`: under the 720 px breakpoint (the one `web/src/canvas/sheet.ts` uses) render one `▤ n` chip inside
      the card, `title` listing the resource titles, click opening Details. At 720 px and above, today's chips.
- [ ] One e2e test: no minimap in the DOM, a seeded run of four old done steps shows as `✓ 4 done` and opens on
      click, and at 520 px a step with two resources shows `▤ 2`.

**Acceptance (live):** at 520 × 1000 the frontier's working tasks are fully readable, old done steps in "Feedback from
daily use" collapse to one row, and nothing is clipped at the right edge.

---

## P3: Trail of ended work (§3)

**Files:**
- Modify: `src/core/types.ts`, `src/server/repo/work.ts`, `src/server/repo/subagents.ts`,
  `src/server/repo/sessions.ts`, `src/server/repo/snapshot.ts`, `src/server/session-flow.ts`, `src/core/layout.ts`,
  `web/src/live.ts`, `web/src/canvas/WorkDoneRow.tsx`, `web/src/canvas/WorkRow.tsx`, `web/src/canvas/Canvas.tsx`,
  `web/src/panels/Details.tsx`, `web/src/styles.css`
- Create: `web/src/canvas/TrailAgentRow.tsx`
- Test: `test/server/work.test.ts`, `test/server/subagents.test.ts`, `test/server/sessions.test.ts`,
  `test/core/layout.test.ts`, `test/web/live.test.ts`, `test/e2e/ui.spec.ts`

**Interfaces (produces):**
```ts
// src/core/types.ts
export const TRAIL_MS = 7 * 24 * 60 * 60 * 1000;      // replaces WORK_ITEM_RETENTION_MS and the 1 h subagent retention
export interface WorkItem { /* as today */ endedAt: string | null }   // when its session ended; null while it is live
export interface TrailAgent extends SubagentInfo { sessionId: string }  // endedAt is set, more than 5 min ago
export interface PastSession { id: string; title: string | null; focusNodeId: number | null; endedAt: string }
export interface ProjectSnapshot { /* as today */ trailAgents: TrailAgent[]; pastSessions: PastSession[] }

// src/server/repo/work.ts: sessions that are live, or ended less than TRAIL_MS ago
export function listWorkItems(ctx: Ctx, projectId: number): WorkItem[];
// src/server/repo/subagents.ts
/** Session end: running subagents are marked ended, and the session's dispatches go. Replaces clearSubagents. */
export function endSubagents(ctx: Ctx, sessionId: string, at: string): void;
export function listTrailAgents(ctx: Ctx, projectId: number): TrailAgent[];
// src/server/repo/sessions.ts: ended sessions that a trail item or trail agent names
export function listPastSessions(ctx: Ctx, projectId: number): PastSession[];

// src/core/layout.ts
export interface LayoutWorkDoneItem { /* as today */ unfinished: number; agents: number }
export interface LayoutWorkItem { /* as today */ stale: boolean }      // its session has ended
export interface LayoutTrailAgentItem { kind: 'trailAgent'; id: string; sessionId: string; agentId: string; nodeId: number; x: number; y: number }
export interface LayoutInput { /* as today */ trailAgents?: TrailAgent[]; pastSessions?: PastSession[] }
// web/src/live.ts: "✓ 5 done · 2 unfinished · 2 agents", zero parts left out, "1 agent" in the singular
export function trailLabel(p: { done: number; unfinished: number; agents: number }): string;
```

- [ ] Server, tests first: an ended session's items stay in the snapshot with `endedAt` for 7 days and are gone after;
      a session ending (hook `end` and stale expiry) keeps its subagent rows and ends the running ones; rows are
      pruned 7 days after they stopped; a resumed session's items read as live again (`endedAt: null`).
- [ ] Layout, tests first: a stale completed task counts in `count`; a stale open task counts in `unfinished`, shows
      only when the row is open, and has `stale: true`; trail agents count in `agents` and show as `trailAgent` rows
      when open. A trail agent's home is its `nodeId` while that is in the tree, else its session's `focusNodeId`,
      else it is left out. Stale items never pin a step and never pulse.
- [ ] UI: `WorkDoneRow` uses `trailLabel`. `WorkRow` greys a stale task with a hollow mark. `TrailAgentRow` shows
      description, model, how long it ran and when it stopped. Details lists the trail with the past session's title.
- [ ] One e2e test: seed a session with two done tasks and one in progress, post the `end` hook, and the step shows
      `✓ 2 done · 1 unfinished`, which opens.

**Acceptance (live):** end a session that had tasks and a subagent on a step. The step keeps one folded row saying
what was done, and opening it shows the tasks and the agent.

---

## P4: Session identity (§4)

**Files:**
- Modify: `src/server/db/schema.ts` (migration 4), `src/core/types.ts`, `src/server/repo/sessions.ts`,
  `src/server/session-flow.ts`, `src/server/repo/subagents.ts`, `src/server/briefing.ts`, `web/src/App.tsx`,
  `web/src/chrome/SessionRow.tsx`, `web/src/canvas/BadgeNode.tsx`, `web/src/canvas/AgentBadge.tsx`,
  `web/src/canvas/WorkRow.tsx`, `web/src/canvas/Canvas.tsx`, `web/src/panels/Details.tsx`, `web/src/styles.css`
- Create: `web/src/family.ts`, `test/web/family.test.ts`
- Delete: `web/src/agentColors.ts`, `test/web/agentColors.test.ts`
- Test: `test/server/db.test.ts`, `test/server/sessions.test.ts`, `test/server/subagents.test.ts`,
  `test/e2e/ui.spec.ts`

**Interfaces (produces):**
```sql
-- migration 4. Only nullable columns: min_reader_version stays 1.
ALTER TABLE sessions ADD COLUMN slot INTEGER;
ALTER TABLE session_subagents ADD COLUMN ordinal INTEGER;
```
```ts
// src/core/types.ts
export interface Session { /* as today */ slot: number | null }
export interface SubagentInfo { /* as today */ ordinal: number | null }
/** 0 → "A", 25 → "Z", 26 → "AA"; "" for null. */
export function sessionTag(slot: number | null): string;
/** "a1": the session's letter in lower case and the subagent's number; "" when either is null. */
export function agentTag(slot: number | null, ordinal: number | null): string;

// src/server/repo/sessions.ts: the lowest slot no other non-ended session of the project holds
export function assignSlot(ctx: Ctx, sessionId: string, projectId: number): number;

// web/src/family.ts
export const FAMILY_COUNT = 6;
export const familyVar = (slot: number | null): string => `var(--family-${(slot ?? 0) % FAMILY_COUNT})`;
```
```css
/* web/src/styles.css */
--family-0: var(--clay); --family-1: #5856d6; --family-2: #0b7285; --family-3: #c2255c; --family-4: #8c6239; --family-5: #5c7a00;
```

- [ ] Migration 4 with the full strict gates: a v3 database upgrades with every slot and ordinal null, a v3 build
      still opens a v4 database, and `min_reader_version` stays 1. Copy the migration 3 tests.
- [ ] Slots, tests first: a new session takes the lowest free slot in its project; two live sessions never share one;
      an ended session's slot is free again; `enrollSession` to another project reassigns; a session revived from
      `ended` reassigns when its slot is taken; a live session with a null slot (it predates the migration) gets one
      on its next hook event.
- [ ] Ordinals: `startSubagent` sets `COALESCE(MAX(ordinal), 0) + 1` over the session's rows. A resumed subagent
      keeps its number.
- [ ] Web: the session chip, focus badge, subagent badges and working-task marks take `familyVar(session.slot)`. The
      chip and focus badge show `sessionTag`; subagent badges and their task rows show `agentTag`. An ended subagent
      stays grey. The permission state keeps its red outline. Remove the `agentColors` prop from `App`, `Canvas`,
      `SessionRow` and `Details`.
- [ ] Briefing: the first line ends `You are session A.` and the "Other sessions here" line leads each with its
      letter.
- [ ] One e2e test: two sessions in a project show `A` and `B` in different hues, and a subagent of B shows `b1` in
      B's hue under the step it names.

**Acceptance (live):** with two sessions on the project, every chip, badge, task mark and subagent can be traced to
its session by letter and by colour.

---

## P5: Owned queue entries (§6)

**Files:**
- Modify: `src/core/types.ts`, `src/server/repo/projects.ts`, `src/server/schemas.ts`, `src/server/routes/write.ts`,
  `src/server/routes/read.ts` (the outline's Up next line), `src/server/session-flow.ts`,
  `src/server/repo/sessions.ts`, `src/mcp/server.ts`, `src/mcp/format.ts`, `src/core/layout.ts`,
  `src/server/briefing.ts`, `web/src/chrome/UpNext.tsx`, `web/src/canvas/NodeCard.tsx`, `web/src/live.ts`,
  `web/src/App.tsx`, `web/src/styles.css`, `claude/skills/inprogress/SKILL.md`, `claude/agents/inprogress-scribe.md`
- Test: `test/server/projects.test.ts`, `test/server/sessions.test.ts`, `test/mcp/server.test.ts`,
  `test/core/layout.test.ts`, `test/e2e/ui.spec.ts`

**Interfaces (consumes):** `Session.slot`, `sessionTag`, `familyVar` from P4.

**Interfaces (produces):**
```ts
// src/core/types.ts
export interface QueueEntry { nodeId: number; sessionId: string | null }
export interface Project { /* as today */ queue: QueueEntry[] }
// stored JSON: [{ "node": 82, "session": "3fa9…" }, { "node": 79, "session": null }]; a bare number reads as unowned

// src/server/repo/projects.ts
export type QueueOwner = { sessionId: string } | 'unowned';
export function setQueue(ctx: Ctx, actor: string, ref: string | number, nodes: number[], owner: QueueOwner): Project;
/** A session ended: its entries turn unowned and move to the head of the unowned part, in order. Call inside an open write. */
export function releaseQueue(ctx: Ctx, record: RecordEvent, sessionId: string): void;   // RecordEvent: src/server/db/tx.ts

// src/server/schemas.ts
export const queueBody = z.object({
  nodes: z.array(z.number().int().positive()).max(200),
  session: z.string().max(100).optional(),
  unowned: z.boolean().optional(),
}).strict();     // session given and unowned not true: that session's entries. Otherwise: the unowned entries.

// src/core/layout.ts: replaces upNext() and queuePos
export interface QueueView { bySession: Map<string, number[]>; unowned: number[] }
/** Open steps only. A session's focus is left out of its own list. Entries of a session that is not live read as unowned. */
export function queueView(queue: readonly QueueEntry[], nodes: Pick<TreeNode, 'id' | 'status'>[], sessions: Pick<Session, 'id' | 'state' | 'focusNodeId'>[]): QueueView;
export interface LayoutNodeItem { /* as today, without queuePos */ queue: { pos: number; sessionId: string | null } | null }
export function findFrontier(nodes: TreeNode[], sessions: Session[], layout: LayoutResult, queue?: readonly QueueEntry[]): number | undefined;
```
MCP: `set_queue(project, nodes, session, unowned?)`. Text formats: `Up next: A: #82 → #78 | B: #90 | later: #79` in
the outline and tool results; `Up next (you, A): #82 → #78 · B: #90 · later: #79` in the briefing.

- [ ] Repo, tests first: both stored shapes parse; a write for session S replaces only S's entries, in place of its
      first old entry, or after the last owned entry when it had none; a node moves to whoever claims it; owned entries
      always precede unowned ones; `'unowned'` replaces only the unowned part; a session not tracked in the project is
      refused with a hint; done and dropped steps leave on read; `releaseQueue` on hook `end` and on stale expiry.
- [ ] MCP, skill and scribe: `queue: #a, #b` is the briefing session's own order and `later: #c, #d` the unowned one.
      The scribe passes `session` for `queue:` and `unowned: true` for `later:`.
- [ ] Layout and UI: markers number per owner; owned ones show `sessionTag` and `familyVar`, unowned ones are
      neutral. `UpNext` renders one line per live session that has entries, then `later`, each cut short at the
      window's edge, each step jumping to its row. Pins include every queued step, as today.
- [ ] One e2e test: two sessions queue different steps, the markers and lines show `A` and `B`, a second `queue:`
      for A leaves B's entries alone, and ending B turns its entry into a neutral `later` one.

**Acceptance (live):** two sessions brief their own `queue:` and neither overwrites the other. Closing one leaves its
steps listed under `later`.

---

## P6: Subagent purpose and readers (§5)

**Files:**
- Modify: `src/server/db/schema.ts` (migration 5), `src/hooks/handlers.ts`, `src/server/schemas.ts` (`hookBody`),
  `src/server/session-flow.ts`, `src/server/repo/subagents.ts`, `src/core/types.ts`, `src/core/layout.ts`,
  `web/src/canvas/AgentBadge.tsx`, `web/src/canvas/Canvas.tsx`, `web/src/chrome/SessionRow.tsx`,
  `web/src/panels/Details.tsx`, `web/src/canvas/TrailAgentRow.tsx`, `web/src/styles.css`,
  `docs/superpowers/specs/2026-10-02-live-work-design.md` (the "never forwards `prompt`" line)
- Create: `web/src/canvas/ReadersRow.tsx`
- Test: `test/hooks/handlers.test.ts`, `test/server/subagents.test.ts`, `test/server/db.test.ts`,
  `test/core/layout.test.ts`, `test/smoke/built.test.ts`, `test/e2e/ui.spec.ts`

**Interfaces (produces):**
```sql
-- migration 5. Only nullable columns: min_reader_version stays 1.
ALTER TABLE subagent_dispatches ADD COLUMN purpose TEXT;
ALTER TABLE session_subagents ADD COLUMN purpose TEXT;
```
```ts
// src/hooks/handlers.ts
/** The first non-blank line of the prompt, cut after its first sentence end (. ? ! then a space or the end), at most 200 characters with "…". */
export function purposeOf(prompt: string): string | undefined;      // sent as body.purpose on agent-dispatch
// src/server/schemas.ts: hookBody gains  purpose: z.string().max(200).optional()
// src/core/types.ts
export interface SubagentInfo { /* as today */ purpose: string | null }
export const READER_AGENT_TYPES = ['Explore', 'Plan', 'claude-code-guide'] as const;
export const isReader = (agentType: string): boolean => (READER_AGENT_TYPES as readonly string[]).includes(agentType);
// src/core/layout.ts
export interface LayoutReadersItem { kind: 'readers'; id: string; sessionId: string; nodeId: number; agentIds: string[]; x: number; y: number }
```

- [ ] Hooks, tests first, with the full strict gates: `purposeOf` on a multi-line prompt, a first sentence over 200
      characters, a prompt with no sentence end, and a blank prompt. The dispatch body carries `purpose`. Nothing else
      of the prompt is sent.
- [ ] Migration 5 with the same gates as migration 4. `DispatchInput.purpose` is stored, `show()` copies it to the
      subagent row through the FIFO and swap paths, and `listSubagents` and `listTrailAgents` return it.
- [ ] Layout: a running reader produces no `agent` item. Each session's running readers on a step make one `readers`
      item. An ended reader shows nowhere, and `listTrailAgents` leaves readers out.
- [ ] UI: `ReadersRow` shows `◇ a · 2 reading` in the family hue, with the descriptions as its tooltip. `AgentBadge`
      and `TrailAgentRow` use the purpose as `title`. Details shows it as a second line. The session chip's hover list
      marks readers.
- [ ] Amend the live-work note's line about the prompt.
- [ ] One e2e test: a worker's badge carries its purpose, and two Explore agents show as one `2 reading` row.

**Acceptance (live, after a session restart):** dispatch an Explore agent and a general-purpose agent. The first shows
as a small reading row; the second shows a full badge whose tooltip says what it was asked to do.

---

## P7: Honest statuses (§7)

**Files:**
- Modify: `src/server/session-flow.ts` (`setFocus`), `src/server/repo/nodes.ts` (an inner update both callers share),
  `src/core/tree.ts`, `src/core/layout.ts`, `src/server/briefing.ts`, `web/src/canvas/NodeCard.tsx`,
  `web/src/styles.css`, `claude/agents/inprogress-scribe.md`
- Test: `test/server/sessions.test.ts`, `test/core/tree.test.ts`, `test/core/layout.test.ts`, `test/e2e/ui.spec.ts`

**Interfaces (produces):**
```ts
// src/core/tree.ts
export const NEEDS_YOU_STALE_MS = 3 * 24 * 60 * 60 * 1000;
/** null under 24 h; then "1d" … "13d", then "2w" …; measured from updatedAt. */
export function needsYouAge(n: Pick<TreeNode, 'updatedAt'>, now: number): string | null;
// src/core/layout.ts
export interface LayoutNodeItem { /* as today */ paused: boolean }
// src/server/briefing.ts
export function renderBriefing(snapshot: ProjectSnapshot, sessionId: string, now?: number): string;
```

- [ ] `setFocus`, tests first: focusing a `todo` step assigned to Claude sets it `active` and records `node.updated`
      with the same actor, in the same write. A step that is blocked, done, dropped or assigned to Aiden is left alone.
      `write()` must not nest (ruling 34), so factor the status update out of `updateNode` into a function both use.
- [ ] `paused`, tests first: true for an `active` step assigned to Claude when no live session's focus is it or a
      descendant, no running subagent's home is, and no live session has a task in progress there. An idle session
      focused on the step keeps it unpaused. A parent is paused only when no descendant is occupied.
- [ ] UI: a paused step draws a hollow blue marker with "Nobody is on this. Last change <date>" as its tooltip. The
      `YOU` tag shows `needsYouAge` when it is not null.
- [ ] Briefing: needs-you entries carry their age, `#14 Merge PRs (5d)`. When any is older than `NEEDS_YOU_STALE_MS`,
      add `Check with Aiden whether these are already done, then brief the answer: #14, #45.`
- [ ] Scribe prompt: focus on a todo step makes it active, so a brief need not say both.
- [ ] One e2e test: an active step with no session shows as paused, and a four-day-old needs-you step shows
      `YOU · 4d`.

**Acceptance (live):** the VCAD and InThink tabs show which active steps nobody is on and how long each needs-you item
has waited.

---

## P8: Shorter briefing, one set of rules (§8)

**Files:**
- Modify: `src/server/briefing.ts`, `claude/skills/inprogress/SKILL.md`
- Test: `test/server/sessions.test.ts` (the briefing and `updateRules` assertions)

**Interfaces (consumes):** the task command (P1), `WorkItem.endedAt` (P3), `Session.slot` and `sessionTag` (P4),
`QueueEntry` and the Up next text format (P5), needs-you ages (P7).

**The rules block.** Wording may be tightened; every clause must stay, and the block must pass the length test.
```
Keeping InProgress current (Aiden watches it live):
- Brief the inprogress-scribe agent (Agent tool, subagent_type "inprogress-scribe", background), at most once per turn with every change batched. Never edit the tree another way, except tasks below.
- Brief when: a request with a deliverable arrives (a new step with one label: ui, server, data, integration, ops, docs, fix, refactor, research); the plan or your order changes ("queue: #a, #b"); a step starts ("focus → #id"), finishes ("#id → done; outcome …") or blocks; something goes to Aiden (assignee me) or he answers.
- Steps are plan-level with outcomes. Detours go in "log on #id: …".
- Something worth finding again is a resource: "resource on #id: <kind> "<title>", path <file>, snapshot_file". Chat-only content is first written to <resources dir>/<slug>/<yyyy-mm-dd>-<kebab-title>.md.
- Working tasks: TaskCreate/TaskUpdate mirror on their own. Without them, after each change run: <task command>. Start an Agent description with its step's #id.
- After a brief, one line in chat ("↳ InProgress: #57 done"). The scribe's notice needs no reply. Brief header: "Session: <id> · Project: <slug>". Full format: the inprogress skill.
```

- [ ] Rules: replace `updateRules` with the block above. Test: `updateRules(...).join('\n').length <= 1600` with a
      task command and resources path of real length, and each clause is present.
- [ ] Line 2 becomes: `All InProgress edits go through the inprogress-scribe agent in the background. The rules below
      are complete; the inprogress skill is for opt-in, adoption and the full brief format.`
- [ ] `Recently done:` the two steps with the latest `completedAt`, as `#87 ¶ Title — "outcome"`, outcome clipped to
      80 characters. Left out when nothing is done.
- [ ] `Left unfinished by an earlier session:` open tasks with `endedAt` set, on steps that are not done or dropped,
      as `on #86: "Review it", "Write tests"`, at most three subjects. Left out when there are none.
- [ ] `frontierLines`: when `project.queue` has any entry, no sibling `Next:` lines.
- [ ] Skill: "Tracked sessions" keeps the full brief template and points at the briefing for the rules. The label
      section keeps the set and the picking rule and loses the gate table.
- [ ] After deploy, brief the scribe: append to the `inprogress` playbook `Test gates by label: ui = typecheck + unit,
      one e2e test per user-visible feature, no failing-test-first for styling or wording; integration = typecheck +
      unit + smoke, full strict gates for hooks and installer; data = typecheck + unit, full strict gates,
      min_reader_version stays 1 when a migration only adds; everything else = typecheck + unit. Deploy still decides
      what to run from the files that changed.`

**Acceptance (live, after a session restart):** a new session's briefing is shorter than today's, names its letter,
shows the last two outcomes, and gives one answer to "what's next". The session does not load the skill unless it is
opting in or adopting.

---

## P9: Tickets, live layer trial (§9)

No code. Do this on the next Versaterm ticket.

- [ ] When the ticket's project is created, give it this playbook: `Driven by the cad-dev-loop (Sigmund, Sev, Ellie).
      The plan is the task ledger at <path>, attached as a resource on the root. Send no plan briefs for this project:
      no steps, statuses or queue. Keep focus on the root, and post working tasks. Gates are Aiden's clicks, and
      Sigmund presents them in chat.`
- [ ] Attach the ledger to the root with `snapshot_file`.
- [ ] After the ticket closes, ask Aiden one question: did he miss the plan in the window? Record the answer on the
      step. A yes opens a design for reading the ledger's gate table; a no closes the question.

---

## After the plan

Hand back to the UI overhaul (#81) with refreshed drafts, as the spec's "After this plan" section lists. Rewrite
`.superpowers/iter/2026-10-02/mockups/brief-characters.md` first: its cast gives each agent its own hue, which §4
replaces with one hue per session family. Then the taskbar icon (#82) and the one-page guide (#78).

## Not in this plan

The review's open questions that need use rather than code: how much work runs in desktop sessions, briefs per day and
a week of the scribe on a smaller model, whether the type labels are read, and how long the trail should last. Raise
them with Aiden two weeks after P8 deploys.
