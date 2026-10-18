# Parked steps and the Backlog view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `parked` status for work set aside on purpose, a Board Backlog preview by phase, and a full Backlog view with filters and a Parked group.

**Architecture:** `parked` joins `NODE_STATUSES`; migration 13 rebuilds `nodes` to widen its status CHECK and add three columns. A step is *shelved* when it or an ancestor is parked; every open/closed reader treats shelved steps as neither open work nor finished. The window gets park/unpark writes, a preview that replaces the Backlog fold, and a full view built like All done.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, zod, React, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-17-parked-steps-and-loose-tasks-design.md` (read it first; it is the authority on behaviour and copy).

**Steps:** Tasks 1 to 3 are #485 (data), Task 4 is #486 (integration), Task 5 is #487 (ui), Task 6 is #488 (docs). #489 (the #41 cleanup) is a scribe brief after deploy, not code. One branch, `parked-steps`, one commit per task at least.

## Global Constraints

- No em dashes (U+2014) or their entities in any file (`test/repo/no-em-dash.test.ts`).
- `min_reader_version` stays `'1'` in migration 13 (only a widened CHECK and defaulted or nullable columns; a v12 build reads and writes the result).
- The migration never runs with foreign keys on: `DROP TABLE nodes` with foreign keys on would cascade-delete every resource, log, ask and work item.
- UI verification only on ports 4410 to 4419 (Sev) or 4400 to 4409 (Parvati); never 4317 or 4399.
- Copy is the spec's, verbatim: "parked #id: <reason>", "unparked #id", "#id is parked", "Nothing in <phase>", "Backlog · N", "Parked · n", "No phase", "‹ Board", "Park…", "Unpark", "to Next".
- `parked_reason` max 2000 characters, `parked_where` max 500, both trimmed.

## Review Focus

1. Unparking a step that was in Next before it was parked: it must come back to the Backlog, not silently reappear in Next (park removes it from the stored queue). Test in Task 3.
2. Parking a phase whose child is in Next, or is driven by a live session: the child leaves Next and the briefing's Ready to claim; the child's own status is untouched. Tests in Tasks 3 and 4.
3. A second database open racing the first-ever migration 13, or a crash mid-rebuild: the runner must leave the old table intact (one transaction) and foreign keys back on. Test in Task 2.
4. The preview's remembered phase finishing or being parked: the preview falls back to the default instead of showing "Nothing in" forever. Test in Task 5.
5. `status: "parked"` sent through MCP or REST with an empty or whitespace reason, or a `parked_reason` sent without the status: refused with a message naming the field. Test in Task 3.

---

### Task 1: Core types and the shelved set (#485)

**Files:**
- Modify: `src/core/types.ts:14` (statuses), `src/core/types.ts:158-182` (TreeNode)
- Modify: `src/core/tree.ts:47-51` (progress), add `shelvedIds`
- Test: `test/core/tree.test.ts`

**Interfaces:**
- Produces: `NODE_STATUSES = ['todo', 'active', 'done', 'blocked', 'dropped', 'parked']`; `TreeNode.parkedReason: string`, `TreeNode.parkedWhere: string`, `TreeNode.parkedAt: string | null`; `shelvedIds(index: TreeIndex): Set<number>` (every node whose status is `parked` or that has a parked ancestor; the root is never parked) in `src/core/tree.ts`.

- [ ] **Step 1: Failing tests** in `test/core/tree.test.ts`: `shelvedIds holds a parked step and its whole subtree` (parked #2 with child #3 and grandchild #4: set is {2, 3, 4}; sibling #5 absent); `progress leaves parked children out of the total` (kids done, todo, parked, dropped: `{ done: 1, total: 2 }`). Build fixtures the way the file's existing tests do, with the three new fields defaulted (`''`, `''`, `null`).
- [ ] **Step 2:** `npx vitest run test/core/tree.test.ts`: FAIL (`shelvedIds` not exported).
- [ ] **Step 3:** Add the status, the fields and `shelvedIds`; `progress` filters `status !== 'dropped' && status !== 'parked'`. Fix every fixture or factory that builds a `TreeNode` (`npm run typecheck` lists them).
- [ ] **Step 4:** `npm run typecheck` and `npx vitest run test/core`: PASS.
- [ ] **Step 5:** Commit `feat(core): parked status, its fields and the shelved set (#485)`.

### Task 2: Migration 13, the nodes table rebuild (#485)

**Files:**
- Modify: `src/server/db/schema.ts` (append migration 13; export `REBUILDS`)
- Modify: `src/server/db/connection.ts` (`migrate` runs a rebuild with foreign keys off; `openDb` copies the file first)
- Test: `test/server/migration13.test.ts` (new, modelled on `test/server/migration12.test.ts`)

**Interfaces:**
- Produces: `export const REBUILDS: ReadonlySet<number> = new Set([12])` in `schema.ts` (0-based indexes into `MIGRATIONS` that rebuild a table); `migrate(db: DB, opts?: { beforeRebuild?: (toVersion: number) => void }): void`.

Migration 13 SQL, in this order: `CREATE TABLE nodes_new` with every current column (`schema.ts:23-37` plus `label` with its CHECK from `:143`, `board_state`, `state_since`, `hue`, `driver_session_id`), the status CHECK widened to `('todo','active','done','blocked','dropped','parked')`, `parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE` (the final name, not `nodes_new`), and `parked_reason TEXT NOT NULL DEFAULT ''`, `parked_where TEXT NOT NULL DEFAULT ''`, `parked_at TEXT`; `INSERT INTO nodes_new (<every old column>) SELECT <same> FROM nodes`; `DROP TABLE nodes`; `ALTER TABLE nodes_new RENAME TO nodes`; recreate `nodes_project` and `nodes_parent` exactly as `schema.ts:38-39`; set `min_reader_version` `'1'` with the file's usual comment.

Runner rules (`migrate`): before each step, read the version; when `REBUILDS.has(version)`, call `opts.beforeRebuild?.(version + 1)`, then `db.pragma('foreign_keys = OFF')` (outside the transaction, where SQLite honours it). Inside the transaction, for a rebuild index: throw if `db.pragma('foreign_keys', { simple: true })` is not `0` (the guard against a race that read a different version), exec, then throw if `db.pragma('foreign_key_check')` returns any row. After the step, in a `finally`, `db.pragma('foreign_keys = ON')`.

`openDb(file)`: when `file !== ':memory:'`, pass `beforeRebuild: (v) => { mkdirSync(join(dirname(file), 'backups'), { recursive: true }); db.exec(\`VACUUM INTO '<dir>/backups/inprogress-pre-v${v}-${timestamp()}.db'\`) }` (`timestamp` from `src/server/backup.ts`; escape single quotes in the path). The rotation in `backupDb` only matches `inprogress-\d{8}-\d{6}\.db`, so this copy is kept.

- [ ] **Step 1: Failing tests** in `test/server/migration13.test.ts`, seeding a v12 database (`MIGRATIONS.slice(0, 12)`, schema_version `'12'`, foreign keys off while seeding) with a project, root, a labelled active step with a driver and `board_state`/`hue`, a child, a resource, a log entry, an ask, a work item and a session focused on the step:
  - `migration 13 keeps every node column and every row that points at nodes` (all node values equal before and after; resource, log, ask, work item and session focus still present).
  - `migration 13 allows parked and still refuses an unknown status` (UPDATE to `'parked'` succeeds; to `'bogus'` throws `CHECK constraint failed`).
  - `migration 13 adds the parked columns with their defaults` (`''`, `''`, `NULL`).
  - `migration 13 keeps min_reader_version 1, the node indexes, and foreign keys on afterwards` (`pragma foreign_keys` is 1; `nodes_project`, `nodes_parent` in `sqlite_master`; `foreign_key_check` empty).
  - `deleting a node after migration 13 still cascades to its resources` (proves the FKs re-resolved to the new table).
  - `beforeRebuild runs once, with 13, and not on a database already at 13` (spy; migrate a second time).
  - `a fresh database migrates from 0 through 13` (`openDb(':memory:')`, schema version equals `MIGRATIONS.length`).
- [ ] **Step 2:** `npx vitest run test/server/migration13.test.ts`: FAIL.
- [ ] **Step 3:** Implement as above. Map the three columns in the node row reader in `src/server/repo/nodes.ts` (wherever rows become `TreeNode`).
- [ ] **Step 4:** `npx vitest run test/server`: PASS (migration10/12 tests and db.test.ts included).
- [ ] **Step 5:** Commit `feat(db): migration 13 rebuilds nodes for the parked status (#485)`.

### Task 3: Park and unpark: repo rules, MCP, REST and window writes (#485)

**Files:**
- Modify: `src/server/repo/nodes.ts` (NodePatch, `patchNode`, `patchWithAsks`, add `parkNode`, `unparkNode`, `shelvedAmong`)
- Modify: `src/server/repo/projects.ts:74-89` (`openSteps`), `:375-381` (`applyQueueOp`); export a no-write helper `appendUnowned(ctx: Ctx, record: RecordEvent, projectId: number, nodeId: number): void` and `dropFromQueue(ctx: Ctx, record: RecordEvent, projectId: number, ids: number[]): void`, each recording `project.updated` with `changes.queue` and `data.op` (`'unpark'`, `'park'`) when the stored queue changes
- Modify: `src/server/repo/nodes.ts` add-nodes path: refuse `status: 'parked'` on create
- Modify: `src/server/schemas.ts:47` (`updateNodeBody` gains `parkedReason`, `parkedWhere`), `src/mcp/server.ts:147-153` (`update_node` gains `parked_reason`, `parked_where`, and its description says: Status "parked" needs parked_reason (why it is set aside) and takes an optional parked_where (branch, worktree or commit).)
- Modify: `src/server/routes/window.ts` (two routes)
- Test: `test/server/nodes.test.ts`, `test/server/projects.test.ts`, `test/server/window-routes.test.ts`, `test/mcp/server.test.ts`

**Interfaces:**
- Consumes: Task 1's fields; Task 2's columns.
- Produces: `NodePatch.parkedReason?: string`, `NodePatch.parkedWhere?: string`; `shelvedAmong(ctx: Ctx, ids: number[]): Set<number>` (a recursive CTE up `parent_id`: the ids that are parked or have a parked ancestor); `parkNode(ctx, actor, id, { reason: string; where?: string }, check: (before: TreeNode) => void): TreeNode`; `unparkNode(ctx, actor, id, toNext: boolean, check: (before: TreeNode) => void): TreeNode`; routes `POST /api/ui/projects/:id/nodes/:node/park` body `{ reason: string, where?: string }` and `POST /api/ui/projects/:id/nodes/:node/unpark` body `{ toNext?: boolean }`, both `guarded`, actor `window`, slug-checked like `.../delete` at `window.ts:128-140`, answering the node.

Rules in `patchNode` (all in the one UPDATE): entering `parked` requires a trimmed non-empty reason (`badRequest('parked_reason is required to park a step', 'Say why it is set aside.')`), refuses the root and a done or dropped step (`#id is done; only an open step can be parked`), sets `parked_at` to now and clears the driver. Staying parked may edit reason and where, keeping `parked_at`. Any other status clears all three fields. `parkedReason` or `parkedWhere` on a step that is not parked and is not being parked: `badRequest('parked_reason only goes with status "parked"')`. `patchWithAsks` clears asks on entering `parked`, as for `dropped`. Entering `parked` calls `dropFromQueue` with the step and every shelved descendant (`shelvedAmong` over its subtree ids). `openSteps` excludes `parked` and `shelvedAmong` ids; `applyQueueOp` refuses a shelved node with `badRequest('not open', '#id is parked.')`. `unparkNode` sets `todo` and, with `toNext`, calls `appendUnowned`, in one write; it refuses a step that is not parked.

- [ ] **Step 1: Failing tests:**
  - nodes: `parking needs a reason` (empty and whitespace refused; message names parked_reason); `parking sets parked_at, clears the driver and the open asks`; `parking refuses the root and a done step`; `leaving parked clears the parked fields`; `parked_reason without status parked is refused`; `add_nodes refuses status parked`.
  - projects: `parking takes the step and its shelved children out of the stored queue` and `unparking does not bring them back to Next`; `unpark with toNext appends to the unowned queue`; `a queue move refuses a step under a parked phase`.
  - window-routes: `POST park parks with reason and where`; `POST unpark toNext answers the node todo and queued`; `park refuses another project's step`.
  - mcp: `update_node parks with parked_reason and parked_where`.
- [ ] **Step 2:** Run those files: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm run typecheck` and `npm test`: PASS.
- [ ] **Step 5:** Commit `feat(server): park and unpark steps (#485)`.

### Task 4: Shelved steps in the Board model, briefing, outline and claims (#486)

**Files:**
- Modify: `src/core/board.ts:53` and `:130-133` (skip shelved nodes as rows, as dropped; add `parked`), `src/core/layout.ts` (a parked node folds its subtree, as a finished branch does), `src/core/tree.ts:204-212` (outline line), `src/mcp/format.ts:69`
- Modify: `src/server/briefing.ts`, `src/server/briefing-scoped.ts` (Ready to claim, Up next, the focused-on-parked line), `src/server/session-flow.ts:406` and `:490` (no driver for a shelved step; claim refusal), `src/server/repo/work.ts:59` (`isClosed` includes parked), `src/server/repo/asks.ts` (raising an ask on a shelved step is refused as on a dropped one)
- Test: `test/core/board.test.ts`, `test/core/layout.test.ts`, `test/core/tree.test.ts`, `test/server/briefing-scoped.test.ts`, `test/server/claim.test.ts`, `test/mcp/server.test.ts`

**Interfaces:**
- Consumes: `shelvedIds` (Task 1), `shelvedAmong` (Task 3).
- Produces: `Board.parked: ParkedRow[]` with `export interface ParkedRow { node: TreeNode; crumb: TreeNode[]; openInside: number }` (open descendants), ordered by tree order; parked rows are never in `byId`, so the task-state reconcile skips them as it skips dropped steps.

Every reader keys on `status === 'parked'` or `shelvedIds`/`shelvedAmong`, never on `parkedAt` or `parkedReason` being set: a rollback build can change a parked step's status and leave the fields behind (Murr, #485).

Copy: outline line `· parked: <reason>`; briefing line for a session focused on a parked step `#id is parked: <reason>`; claim refusal `badRequest('#id is parked', 'Unpark it first, or claim another step.')`, and for a shelved descendant `badRequest('#id is under parked #p', 'Unpark #p first, or claim another step.')`.

- [ ] **Step 1: Failing tests:** board: `a parked step and its subtree are no rows; the parked step is in parked with its open count`; `a phase whose only open child is parked is not a group`. layout: `a parked step folds its subtree`. tree: `the outline line of a parked step names its reason`. briefing-scoped: `Ready to claim and Up next leave out a step under a parked phase`; `a session focused on a parked step is told it is parked`. claim: `claiming a parked step is refused`; `claiming a step under a parked phase names the phase`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement. Sweep every open/closed test the spec's Readers list names; `search.ts` keeps finding parked steps.
- [ ] **Step 4:** `npm run typecheck`, `npm test`, `npm run test:smoke`: PASS.
- [ ] **Step 5:** Commit `feat: shelved steps leave the Board, briefing and claims (#486)`.

### Task 5: Backlog preview, full Backlog view, Park and Unpark in the window (#487)

**Files:**
- Modify: `web/src/board/NextColumn.tsx:34-37, 138-145, 241-248` (the fold becomes the preview), `web/src/board/Backlog.tsx` (rows gain Park…; reused by the full view), `web/src/board/backlogOrder.ts` (`BacklogSort` gains `'age'`; `phaseOf(row): TreeNode | null` = nearest ancestor of kind phase; phase and label filters)
- Create: `web/src/backlog/BacklogList.tsx` (the full view, modelled on `web/src/done/DoneList.tsx`), `web/src/backlog/backlogPreview.ts` (`previewPhase(board, nodes, stored: number | 'none' | null): number | 'none'` with the spec's default chain, and its localStorage key `ip.backlogPreview.<projectId>`)
- Modify: `web/src/App.tsx:285-288` (a `backlogOpen` flag beside `doneOpen`), `web/src/api.ts` (`parkStep(projectId, slug, node, reason, where?)`, `unparkStep(projectId, slug, node, toNext)`), `web/src/panels/Details.tsx:307` (parked block and Park…/Unpark), `web/src/marker.css:5, 21-29` and `web/src/Marker.tsx` (`m-parked`: muted, dashed, no hue), `web/src/describe.ts:48-56` (event copy), `web/src/project/projectOutline.ts:28` (OPEN set excludes shelved)
- Test: `test/web/` units for `backlogOrder` and `backlogPreview`; `test/e2e/ui.spec.ts` two tests

**Interfaces:**
- Consumes: `Board.parked`, `ParkedRow` (Task 4); the park/unpark routes (Task 3).

Behaviour and copy are the spec's sections "The Board's Backlog preview" and "The full Backlog view". Keep today's sort persistence (`ip.backlogOrder`) and filter rules; the filter now lives in the full view's state and clears on leaving it. The narrow layout shows the same preview at the foot of the Next band. Unpark with `toNext` records `node.updated` then `project.updated` with `data.op: 'unpark'`; `describe.ts` words that queue event "unparked #id" so the activity strip's newest line reads right. Park and Unpark are idempotent (a repeat answers the node as it stands), but the forms still disable while a write is in flight.

- [ ] **Step 1: Failing unit tests:** `previewPhase falls back when the stored phase has no entries` (stored phase finished: the latest completed step's phase); `previewPhase picks No phase when no phase has entries`; `phaseOf is the nearest phase ancestor, null for a root task`; `age sort orders by createdAt, oldest first`; `label chips match any chosen label and unlabelled`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Units PASS; e2e tests in `test/e2e/ui.spec.ts`: `the Backlog preview shows the picked phase and opens the full view` and `a step parked from the full Backlog view returns to Next with to Next`, run as `npm run test:e2e` does, narrowed with `-g`, `INPROGRESS_E2E_PORT` in 4410 to 4419: PASS.
- [ ] **Step 5:** Commit `feat(ui): Backlog preview, full Backlog view, park and unpark (#487)`.

### Task 6: Guide and Board spec (#488)

**Files:**
- Modify: the InProgress guide (the HTML guide from #46; find it with `git ls-files | grep -i guide`): a short section on parked steps and No phase, and the new Backlog.
- Modify: `docs/superpowers/specs/2026-10-12-board-and-asks-design.md:207-216` (Backlog bullet), section 2.3's Backlog fold sentence, section 2.5's Create entry points: point at the new spec for the preview and full view.

- [ ] **Step 1:** Edit both; `npx vitest run test/repo/no-em-dash.test.ts`: PASS.
- [ ] **Step 2:** Commit `docs: parked steps and the new Backlog in the guide and Board spec (#488)`.
