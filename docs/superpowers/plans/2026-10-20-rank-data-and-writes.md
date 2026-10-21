# Plan: #541 Rank data and writes

Build step 1 of `docs/superpowers/specs/2026-10-20-ranked-backlog-design.md` (sections 2 to 4, 8 item 1). Branch
`rank-data`, worktree `.claude/worktrees/rank-data`. Label data: typecheck, unit, full strict gates,
`min_reader_version` stays 1. Built in the main session (hard-ordering list: migrations and repo transactions). Murr on
Opus. Owner's check depth: none (nothing on a screen yet; #542 to #544 put it there).

## Criteria

- C1 · migrate a copy of the live database · every open task or question below the root is in Soon with rank NULL,
  `min_reader_version` is 1, nothing else changes.
- C2 · every row of the spec's section 3 table, as a repo or route test · the rank after it is the table's.
- C3 · `deriveBacklog` on a fixture · numbering runs on across bands, NULL ranks sit after ranked ones in tree order,
  Stale reads the newest of its three times, triage is newest first.

## Tasks

1. Migration 17 (the next free number) in `src/server/db/schema.ts`: `rank_band`, `rank`, the R8 backfill,
   `min_reader_version` 1. Test `test/server/migration17.test.ts`: backfill rules, an old build's INSERT and UPDATE still
   work (rollback reader).
2. `TreeNode.rankBand` and `rank`; `RankBand`, `RankOp` and `STALE_STEP_MS` (14 days) in `src/core/types.ts`; `toNode`
   maps them. Fix TreeNode fixtures the typecheck names.
3. `src/server/repo/rank.ts`:
   - `bandOrder(ctx, projectId, band)`: open members (todo, active, blocked) of the band, by rank, NULLs after in tree
     order (a JS walk over id, parent_id, position).
   - `placeInBand(ctx, projectId, nodeId, band, before)`: materialise NULL ranks in shown order (max+1, max+2, ...,
     no `updated_at` change), then the midpoint before `before`, the end (max+1), renormalise to 1..n when a gap falls
     under 1e-6. Returns the new rank. Keeps the current rank when the step already sits there (Keep).
   - `applyRankOp(ctx, actor, projectId, op)`: one write. Refusals are 409: not in project, the root, not open, shelved,
     has open children (todo, active or blocked), `before` not an open member of the band named (or the step itself).
     `to: 'next'`: the queue move (shared with `applyQueueOp` through an exported in-write `queueMove`). Soon or someday:
     out of the queue (any owner, project.updated with op `rank`), band and rank set, `updated_at` set, one node.updated
     with `rankBand` and `rank` changes.
4. `patchNode`: parking clears `rank_band` and `rank` (diff carries them); leaving parked also leaves the band NULL.
   Shelved children keep theirs.
5. `addNodes` gains `band?: 'soon'` (window quick-add only): the new step goes to the bottom of Soon in the same write.
   `windowNodeBody` gains `band: 'soon'` optional.
6. Window routes in `src/server/routes/window.ts`: `POST .../rank` `{ slug, op }`; `POST .../nodes/:node/label`
   `{ slug, label }` through `patchNode` in one write; `POST .../nodes/:node/move` `{ slug, parent }` through `moveNode`
   with a new in-write `check` refusing a parked, shelved or dropped parent (409), placing last.
7. Snapshot: `stepTouches` (nodeId, the newest focusing session's end or last seen, the newest ask raised), read for open
   banded steps with no time limit, because `pastSessions` reaches 7 days only (spec section 9, item 4).
8. `src/core/backlog.ts` `deriveBacklog(board, { nodes, stepTouches }, now, match?)`: next (unowned numbered 1..k in
   shown order, owned unnumbered), soon and someday (numbered on), triage (newest createdAt, ties by id), stale
   (oldest touched first), parked (newest parkedAt first), and counts per view, all and shown. Tests
   `test/core/backlog.test.ts`.
9. Repo tests, one per section 3 row: `test/server/rank.test.ts`; route tests in `test/server/window-routes.test.ts`.

## Section 9 answers

- Materialise pass: `placeInBand` in `src/server/repo/rank.ts`, plain UPDATEs from a JS tree walk, no recursive SQL.
- `deriveBacklog` takes the Board (the window derives it once already).
- Row component split: #542's.
- pastSessions reaches 7 days: Stale reads `stepTouches` from the server instead.
