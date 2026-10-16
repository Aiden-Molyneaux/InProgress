# Keep the thread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One driver per step, answers that reach a live session or stay visibly owed, a stalled mark, and a Sigmund that lives in one session and compacts instead of cutting.

**Architecture:** A nullable `nodes.driver_session_id` (migration 11) is set and moved by `applyFocus`/`claimStep` in `session-flow.ts`. `undeliveredAnswers` also routes answers to a step's driver when the asker is gone. `deriveBoard` derives `driver`, `stalled` and `answer_waiting` from the snapshot; the briefing, the reconcile output and the Now row read them. Skill and nudge text changes carry the compaction rule.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, zod, React, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-keep-the-thread-design.md`

## Global Constraints

- Worktree `C:/personal/InProgress/.claude/worktrees/keep-thread`, branch `keep-thread`. Never touch the main checkout, port 4317 or `~/.inprogress`.
- No em dashes (U+2014) or their HTML entities in any file.
- Migration 11 is add-only: `min_reader_version` stays `'1'`.
- `STALL_MS = 30 * 60 * 1000`. `autoCompactWindow` 250000.
- Exact copy, from the spec:
  - claim notes: `You drive #<id>.` · `<tag> drives #<id>; you are helping. Pass --take-over to drive.` · `You drive #<id>; took over from <tag>.`
  - answer line: `Answered: <askTag> "<answer>" (yours: act on it, or add it to your tasks)`
  - owed line on claim: `Owed: <askTag> answered "<answer>"`
  - mark words: `stalled`, `answer waiting`; role words: `drives`, `helping`.
- `<tag>` is `sessionTag(slot) || '?'`, as the existing "also claimed by" note uses.
- Every task runs `npm run typecheck` and `npm test` from the worktree before its commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage explicit paths only.

## Review Focus

1. `orchestrate()` clears focus with raw SQL (`session-flow.ts:464`): a driver that opens Mip must stop driving its step. Test in Task 2.
2. `set_focus` with `nodeId: null` from a driver clears the old step's driver. Test in Task 2.
3. A live helper raises an ask: the answer goes to the helper only, never also to the driver. Test in Task 3.
4. Old cleared asks whose askers ended long ago must not flood a driver: the driver route takes only asks cleared within `ASK_TRAIL_MS`. Test in Task 3.
5. A question node's answer is its outcome, not owed work: no `answer_waiting` on `kind: 'question'`. Test in Task 4.

---

### Task 1: Migration 11 and the driver column

**Files:**
- Modify: `src/server/db/schema.ts` (append entry 11 after line 258)
- Modify: `src/core/types.ts:154-170` (TreeNode)
- Modify: `src/server/repo/nodes.ts` (NodeRow :9-24, toNode :26, patchNode :160)
- Test: `test/server/migration11.test.ts` (new, modelled on `migration10.test.ts`), `test/server/nodes.test.ts` (or the file that already tests `updateNode` status changes)
- Modify: every test fixture that builds a `TreeNode` literal (typecheck lists them; `test/core/board.test.ts:9` `n()` is one): add `driverSessionId: null`.

**Interfaces:**
- Produces: `TreeNode.driverSessionId: string | null`; `setDriver(ctx: Ctx, record: RecordEvent, node: TreeNode, sessionId: string | null): void` in `nodes.ts`.

- [ ] **Step 1: Write the failing tests**
  - `migration11.test.ts`, `it('adds driver_session_id, keeps min_reader_version 1, and backfills active steps')`: run `MIGRATIONS.slice(0, 10)`, seed a project, an `active` node with two non-ended sessions focused on it (`last_seen_at` 10:00 and 11:00), a `todo` node with one focused session, and an `active` node whose only focused session is `ended`; then `migrate(db)`. Assert the active node's `driver_session_id` is the 11:00 session, the todo node's is null, the ended-only node's is null, and `meta.min_reader_version` is `'1'`.
  - `nodes` test, `it('clears the driver when a step goes done or dropped')`: set a driver with `setDriver`, `updateNode(... { status: 'done' })`, assert `driverSessionId === null`; same for `dropped`.
  - `it('setDriver records node.updated and leaves updatedAt alone')`.
- [ ] **Step 2: Run them, expect FAIL** (`npx vitest run test/server/migration11.test.ts test/server/nodes.test.ts`).
- [ ] **Step 3: Implement**
  - Entry 11 SQL: `ALTER TABLE nodes ADD COLUMN driver_session_id TEXT;`, then `UPDATE nodes SET driver_session_id = (SELECT s.id FROM sessions s WHERE s.focus_node_id = nodes.id AND s.state != 'ended' ORDER BY s.last_seen_at DESC LIMIT 1) WHERE status = 'active';`, then the `min_reader_version` insert copied from entry 10 (`schema.ts:257`). Comment above it in the style of entry 6: only a nullable column, older builds still read and write it.
  - `NodeRow.driver_session_id: string | null`; `toNode` maps it.
  - `patchNode`: when `next.status` is `done` or `dropped`, write `driver_session_id = NULL` in the same UPDATE.
  - `setDriver`: `UPDATE nodes SET driver_session_id = ? WHERE id = ?` (not `updated_at`), and `record({ type: 'node.updated', ..., data: { changes: { driverSessionId: { from, to } } } })`; no-op when unchanged.
- [ ] **Step 4: Run the tests, expect PASS; then typecheck and the full unit suite.**
- [ ] **Step 5: Commit** `Migration 11: nodes.driver_session_id, backfilled for active steps, cleared on done and drop (#442)`

### Task 2: Claim, focus and take-over

**Files:**
- Modify: `src/server/session-flow.ts` (`applyFocus` :369-397, `setFocus` :399, `claimStep` :418-450, `orchestrate` :464)
- Modify: `src/server/schemas.ts:141` (`claimBody`), `src/server/routes/sessions.ts:16`, `src/cli/claim.ts` (`parseClaimArgs` :49-64, `runClaim` :138-151, usage :7)
- Test: `test/server/claim.test.ts`, `test/cli/claim.test.ts` (or wherever `parseClaimArgs` is tested), `test/smoke/built.test.ts`

**Interfaces:**
- Consumes: `setDriver`, `TreeNode.driverSessionId` (Task 1); `isLive` from `src/core/board.ts`.
- Produces: `claimStep(ctx, actor, sessionId, nodeId, o?: { takeOver?: boolean }): ClaimResult`; `claimBody` = `{ nodeId, takeOver?: boolean }`; `parseClaimArgs` returns `{ session, nodeId, takeOver: boolean }`.

- [ ] **Step 1: Write the failing tests** in `claim.test.ts` (`describe('the driver')`), each with `setup()` and `join()`:
  - `claims a step with no driver and drives it`: driver is the claimer; notes include `You drive #<id>.`
  - `a second claim joins as a helper`: driver unchanged; note `<tag> drives #<id>; you are helping. Pass --take-over to drive.`
  - `--take-over moves the driver and clears the old driver's focus`: driver is the new session; old session's `focusNodeId` null, its `lastSeenAt` unchanged (advance the clock between the two claims), `briefingDue(old)` true; note `You drive #<id>; took over from <tag>.`
  - `a stale driver is replaced without the flag`: advance past `STALE_SESSION_MS`; the new claim drives.
  - `claiming your own step again changes nothing`: no driver note.
  - `a refused claim leaves the driver as it was`: claim the project root; driver of the earlier step unchanged.
  - `set_focus drives only a driverless step`: scribe `setFocus` on a driven step leaves the driver; on a driverless one makes it the driver.
  - `focus elsewhere, focus null and orchestrate all stop the driving`: three cases, each leaves the old step's `driverSessionId` null.
  - `parseClaimArgs` test: `['12', '--take-over', '--session', 's']` gives `takeOver: true`; without it `false`.
  - Smoke (`built.test.ts`, next to :170): `cli('claim', id, '--take-over', '--session', 'smoke-2')` after `smoke-1` claimed it; status 0 and output contains `took over from`.
- [ ] **Step 2: Run them, expect FAIL.**
- [ ] **Step 3: Implement**
  - `applyFocus(ctx, record, sessionId, nodeId, o: { takeOver: boolean })` returns `{ existing, projectId, drive: 'drives' | 'helping' | 'took_over' | 'same' | null, from: Session | null }`. Order inside: the existing checks; if `existing.focusNodeId` is set, differs from `nodeId`, and that node's driver is `sessionId`, `setDriver(old, null)`; then, for a non-null `nodeId`: driver is this session → `'same'`; driver null or not `isLive` → `setDriver(node, sessionId)`, `'drives'`; live and `takeOver` → clear the old driver's focus with `UPDATE sessions SET focus_node_id = NULL WHERE id = ?`, record its `session.updated` (`changed: ['focusNodeId']`), `markBriefingDue(old)`, `setDriver(node, sessionId)`, `'took_over'` with `from`; else `'helping'` with `from`.
  - `setFocus` passes `{ takeOver: false }`. `claimStep` passes `o.takeOver ?? false` and pushes the note for `drive` after the existing notes. Its "is also claimed by" note skips the session that the driver note already names.
  - `orchestrate`: before its raw UPDATE, clear the driver of the session's current focus node if the session drives it.
  - `claimBody` gains `takeOver: z.boolean().optional()`; the route passes `{ takeOver }`; `runClaim` sends `takeOver` when set; usage reads `claim <id> [--take-over] --session <id>`.
- [ ] **Step 4: Run the tests, expect PASS; typecheck, unit, then `npm run test:smoke`.**
- [ ] **Step 5: Commit** `Claim drives a driverless step, joins a driven one as a helper, --take-over moves the driver (#442)`

### Task 3: Answers reach the driver

**Files:**
- Modify: `src/server/repo/asks.ts` (`undeliveredAnswers` :139-143; new `owedAnswers`)
- Modify: `src/server/session-flow.ts:324-331` (answer line), `claimStep` (owed lines)
- Test: `test/server/asks.test.ts`, `test/server/claim.test.ts`

**Interfaces:**
- Consumes: `driverSessionId`, `applyFocus`'s `drive` (Task 2).
- Produces: `undeliveredAnswers(ctx, sessionId): Ask[]` (widened); `owedAnswers(ctx, nodeId: number, sessionId: string): Ask[]`.

- [ ] **Step 1: Write the failing tests**
  - `the driver gets an answer whose asker ended`: helper A raises an ask on the step B drives; A ends (hook `end`); clear with answer `land it`; B's next real prompt context contains `Answered: a<id> "land it" (yours: act on it, or add it to your tasks)`; a second prompt does not repeat it.
  - `a live asker gets its answer, the driver does not` (Review Focus 3).
  - `neither live: the answer stays undelivered` (`answerDeliveredAt` null).
  - `the driver route skips answers cleared over 7 days ago` (Review Focus 4).
  - `a clear with no answer is never routed to the driver`.
  - `a claim that drives prints owed answers once`: asker ended, no driver; a new session claims; `block` ends with `Owed: a<id> answered "land it"`; `answerDeliveredAt` set; a helper's claim prints no owed line.
- [ ] **Step 2: Run them, expect FAIL.**
- [ ] **Step 3: Implement**
  - `undeliveredAnswers`: keep the current branch (`session_id = ?`, any clear) OR the driver branch: `answer != ''`, `cleared_at >= <now - ASK_TRAIL_MS>`, `node_id IN (SELECT id FROM nodes WHERE driver_session_id = ?)`, and no live asker (`NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = asks.session_id AND s.state != 'ended' AND s.last_seen_at >= <now - STALE_SESSION_MS>)`). Same ordering.
  - `owedAnswers(ctx, nodeId, sessionId)`: the driver branch's conditions for one `node_id` in place of the driver subquery. The claimer is live, so its own asks fall out by the "no live asker" condition and keep arriving through its own branch; `sessionId` is unused beyond that and may be dropped if typecheck flags it.
  - The answer line adds the `(yours: ...)` suffix; the `Cleared:` line is unchanged.
  - `claimStep`: when `drive` is `'drives'` or `'took_over'`, append the owed lines to `block` and `markAnswersDelivered` them, inside the claim's write.
- [ ] **Step 4: Run the tests, expect PASS; typecheck and unit.**
- [ ] **Step 5: Commit** `An answer goes to its asker if live, else the step's driver; a driving claim prints what is owed (#442)`

### Task 4: Board marks, the driver on rows, briefing and reconcile text

**Files:**
- Modify: `src/core/types.ts` (`STALL_MS` next to `STALE_SESSION_MS`), `src/core/board.ts` (`MARKS` :5, `BoardRow`, `deriveBoard`)
- Modify: `src/server/briefing-scoped.ts` (`stepBlock` :28-61, `unclaimedLines` :67-75), `src/server/briefing.ts:52`
- Modify: `src/server/session-flow.ts:477` (reconcile lines)
- Test: `test/core/board.test.ts`, `test/server/briefing-scoped.test.ts`, `test/server/claim.test.ts` (the `orchestrate` status test)

**Interfaces:**
- Consumes: `driverSessionId` (Task 1).
- Produces: `MARKS` gains `'stalled'`, `'answer_waiting'`; `BoardRow.driver: Session | null`; `STALL_MS`.

- [ ] **Step 1: Write the failing tests** (`board.test.ts`, using `n`, `s`, `ask`, `input`; `sessionActivity` needs `state: 'idle'`):
  - `stalled: an idle driver past 30 minutes with nothing running and no open ask`: driver `lastSeenAt` 31 min before `NOW` is marked; 29 min is not; a running non-reader subagent, `state: 'permission'`, an open ask, or `assignee: 'me'` each clear it.
  - `stalled: helpers on a step whose driver is not live`: `driverSessionId` names an ended session, one live session focused on it.
  - `answer_waiting: an answered, undelivered ask`; not when `answer` is empty, not when delivered, not on `kind: 'question'` (Review Focus 5).
  - `the driver leads row.sessions and is row.driver`; `row.driver` is null when the driver is not live.
  - `stepBlock` test: a `Driver: you` line for the driver, `Driver: <tag> "<title>" (<activity>)` for another, none when driverless.
  - `orchestrate --status` test: a stalled row prints `  #<id> stalled: <tag> idle <n>m · branch <b> · cwd <c>`; the driverless case prints `  #<id> stalled: driver not live · on it: <tags>`; other marks print as today.
- [ ] **Step 2: Run them, expect FAIL.**
- [ ] **Step 3: Implement**
  - In `deriveBoard`, per row: `driver` = the live session whose id is `node.driverSessionId`; sort it to the front of `sessions`. `stalled` only for `node.status === 'active'` and `assignee !== 'me'`, by the spec's (a)/(b). `answer_waiting` for any row with a cleared ask, non-empty `answer`, null `answerDeliveredAt`, and `node.kind !== 'question'`; read cleared asks from `input.asks` (today only open ones are grouped).
  - Idle text: minutes as `<n>m` under 120, else `<n>h` (floor). `branch` and `cwd` print `?` when null.
  - `unclaimedLines`: after `Claim one:`, `Inheriting a step from a session that handed it to you: add --take-over.` `briefing.ts:52`: the claim example gains ` (add --take-over when you inherit the step)`.
- [ ] **Step 4: Run the tests, expect PASS; typecheck and unit.**
- [ ] **Step 5: Commit** `Board: the driver leads its row, stalled and answer_waiting marks, the driver in the step block and reconcile (#442)`

### Task 5: The window

**Files:**
- Modify: `web/src/board/NowColumn.tsx` (`SessionMessage` :13-31), `web/src/board/Marks.tsx:10-16`
- Test: `test/e2e/ui.spec.ts` (next to the two-session test near :1756)

**Interfaces:**
- Consumes: `BoardRow.driver`, the two new marks (Task 4).

- [ ] **Step 1: Write the failing e2e test** `the Now row names its driver and its helper`: enroll two sessions, claim one step with each through `/api/sessions/:id/claim`; the first `.ip-session` on that row contains `drives`, the second contains `helping`.
- [ ] **Step 2: Run it, expect FAIL** (`INPROGRESS_E2E_PORT=<4410-4419> npx playwright test test/e2e/ui.spec.ts -g "names its driver"`, the way `npm run test:e2e` runs).
- [ ] **Step 3: Implement**: after the state word, ` · drives` or ` · helping` when `row.driver` is set (`<span className="ip-role">`, styled like `ip-quiet`); none when it is null. `MARK_WORDS` gains `stalled: 'stalled'`, `answer_waiting: 'answer waiting'`.
- [ ] **Step 4: Run it, expect PASS; typecheck and unit.**
- [ ] **Step 5: Commit** `Now row: drives and helping on each session line, words for the new marks (#442)`

### Task 6: The nudge and the compaction backstop

**Files:**
- Modify: `scripts/context-nudge.mjs` (`LINES` :13-16, re-arm :94-98, header comment :2-7), `.claude/settings.json` (`autoCompactWindow`)
- Test: `test/scripts/context-nudge.test.ts`

- [ ] **Step 1: Write the failing tests**: at 150k the output is the spec's 150k line; at 200k the 200k line; nothing at 160k beyond the 150k line already given; after a level of 150k, a transcript at 60k prints the post-compaction line once, and a second run at 60k prints nothing.
- [ ] **Step 2: Run them, expect FAIL.**
- [ ] **Step 3: Implement**: `LINES` = `[200_000, <spec 200k line>]`, `[150_000, <spec 150k line>]`, copy verbatim from spec 4.5. In the re-arm branch, when a stored level above 0 falls below 150k, print the post-compaction line (spec 4.5) as `additionalContext` while writing 0. Update the header comment. `autoCompactWindow: 250000`.
- [ ] **Step 4: Run the tests, expect PASS; unit.**
- [ ] **Step 5: Commit** `Nudge: compact at a clean point, not cut; a reload line after compaction; autocompact at 250k (#442)`

### Task 7: Sigmund and Mip

**Files:**
- Modify: `.claude/skills/sigmund/SKILL.md` (Phase 7, Across the session :195-213)
- Modify: `claude/skills/mip-orc/SKILL.md` (Reconcile :41-53, What's next :55-57, Start a step :59-66)
- Modify: `docs/superpowers/specs/2026-10-15-keep-the-thread-design.md` 1.4 (see Step 1)

- [ ] **Step 1: Spec note.** Section 1.4's "Previous driver's next briefing" line becomes: the previous driver's next briefing is the unclaimed one (it has no focus); the activity strip shows the take-over. Nothing stores who took over, and this plan does not add it.
- [ ] **Step 2: Sigmund.** Phase 7: before stopping, brief the scribe `ask on #<id>: review, <one line on what is ready>`. Across the session, per spec 4.1 to 4.4: one step, one session; the 150k nudge means finish, commit, ask Aiden for `/compact` with a line naming the plan, branch and open findings; the list of reasons to start or hand to another session (4.2) replaces the cut bullet; the overnight bullet folds in; a handoff to a successor on the same step opens `Claim #<id> --take-over`, names `.claude/worktrees/<topic>` and lists undelivered answers; reporting to Mip is through InProgress only.
- [ ] **Step 3: Mip.** Reconcile gains `stalled` and `answer_waiting` per spec 3.3, with the `git -C <cwd> status --porcelain` and `git -C <cwd> log -1 --format=%cr` checks before any stalled or "nobody is on it" claim, and "Mip never takes over". Start a step: the stable-worktree rule. Keep the `{{...}}` placeholders as they are.
- [ ] **Step 4: Run** `npm test` (the em-dash scan and any skill-text tests), expect PASS.
- [ ] **Step 5: Commit** `Sigmund lives in one session and raises a review ask at phase 7; Mip reads stalled and answer_waiting and checks worktrees (#442)`

---

After Task 7: Sigmund reruns typecheck, unit, smoke and the e2e test, reads the whole diff, and runs Murr on Opus (risk list: `src/server/db/`, `session-flow.ts`, `briefing.ts`, `claude/`). The merge gate is a full deploy for migration 11, then `npm run claude:install`.
