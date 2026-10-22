# #536 data half: What, Why and origin on steps

Step #536 Backlog notes, origin and What/Why on steps. Branch `what-why`, worktree
`.claude/worktrees/chip-worktree-handoff-681473`. Contract: spec
`docs/superpowers/specs/2026-10-20-inprogress-redesign-design.md` section 5, with Aiden's override of 2026-10-22: older
steps get a What and Why through the approved #569 sweep, which writes through `update_node`. The ui half (quick-add
notes, the proposed chip, Details order, What/Why in the inspector) is a second plan and a second merge on the same step.

Labels: data, plus `claude/` and `src/mcp/` edits, so: typecheck, unit, smoke, and the full strict gates.
`min_reader_version` stays 1: the migration only adds defaulted columns.

## Criteria

- C1 · scribe `add_nodes` with what, why and origin `proposed` · `get_node` prints the What, the Why and `proposed`.
- C2 · scribe `update_node` with what and why on a step filed before the migration · both stored, the step's other
  fields unchanged, and `node.updated` records the change.
- C3 · migrate a copy of the live database · every step has an origin; the ones a `window` `node.created` event names
  read `me`, the rest `asked`; `min_reader_version` is 1.
- C4 · an open step a session files after `WHAT_WHY_SINCE` without both fields · Reconcile lists `no_why`; filling both
  clears it; a window-filed step, a done step, or a step filed before the cutoff never carries it.

Owner check depth: none (nothing on a screen). The real proof is #569's writes.

## Decisions (Sigmund's, named in the receipt)

- `origin` is `NOT NULL DEFAULT 'asked'` with a CHECK. A rollback build's inserts land `asked`.
- The writer decides origin in `addNodes`: actor `window` is always `me`; any other actor takes the input's origin
  (`asked` or `proposed`), else its parent input's resolved origin, else `asked`. `add_nodes` cannot send `me`, so a
  session cannot dodge `no_why`. `update_node` takes all three, for corrections ("that was my idea").
- Backfill: `me` for every id in a `window` `node.created` event's `data.ids`, else `asked`. Events are pruned after
  30 days, so an older window-filed step reads `asked`; the counts make that rare (8 window adds against 163 in 14 days).
- `no_why` cutoff is a constant, `WHAT_WHY_SINCE = '2026-10-22T00:00:00.000Z'`, not a meta row: `deriveBoard` stays a
  pure function of the snapshot. Steps a session filed today before the deploy are marked until filled; #569 covers
  them.
- What and Why: trimmed, at most 500 characters each, `''` when unset.
- `no_why` applies to Board rows only (groups and the root have none) whose column is not `done`.

## Tasks

### T1 Types: `src/core/types.ts`

- `export const ORIGINS = ['me', 'asked', 'proposed'] as const; export type Origin = (typeof ORIGINS)[number];`
  next to `ASSIGNEES`, with a one-line comment: whose idea the step was.
- `export const WHAT_WHY_MAX = 500;` and `export const WHAT_WHY_SINCE = '2026-10-22T00:00:00.000Z';` (comment: steps
  created from this time on, by a session, owe a What and a Why: the `no_why` mark).
- `TreeNode`: `what: string;` `why: string;` `origin: Origin;` with doc comments in the file's style.
- `NodeInput`: `what?: string; why?: string; origin?: Exclude<Origin, 'me'>;`

### T2 Migration 18: `src/server/db/schema.ts`

Append after migration 17, as MIGRATIONS' last entry, with a comment in the file's style (number 18, #536, spec section
5, what each column holds, the backfill rule and the 30-day pruning caveat):

```sql
ALTER TABLE nodes ADD COLUMN what TEXT NOT NULL DEFAULT '';
ALTER TABLE nodes ADD COLUMN why TEXT NOT NULL DEFAULT '';
ALTER TABLE nodes ADD COLUMN origin TEXT NOT NULL DEFAULT 'asked' CHECK (origin IN ('me','asked','proposed'));
UPDATE nodes SET origin = 'me' WHERE id IN (
  SELECT CAST(j.value AS INTEGER)
  FROM events e, json_each(CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END, '$.ids') j
  WHERE e.type = 'node.created' AND e.actor = 'window'
);
-- Defaulted columns: v1 to v17 builds can still read and write this schema, so a rollback across it works.
INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

`updated_at` is left alone. REBUILDS unchanged.

### T3 Repo: `src/server/repo/nodes.ts`

- `NodeRow` and `toNode`: `what`, `why`, `origin`.
- `addNodes`: the INSERT names `what, why, origin`. `add(n, parentId, position, inherited)` resolves
  `origin = actor === 'window' ? 'me' : (n.origin ?? inherited ?? 'asked')` and passes it to its children as
  `inherited`. `what` and `why` bind as `(n.what ?? '').trim()`.
- `NodePatch`: `what?: string; why?: string; origin?: Origin;`. `patchNode` trims `what` and `why` when sent and adds
  `what = ?, why = ?, origin = ?` to its UPDATE. The diff already covers patch keys.

### T4 HTTP schemas: `src/server/schemas.ts`

- `const whatWhy = z.string().trim().max(WHAT_WHY_MAX).optional();`
- `nodeInput`: `what: whatWhy, why: whatWhy, origin: z.enum(['asked', 'proposed']).optional()`.
- `updateNodeBody`: `what: whatWhy, why: whatWhy, origin: z.enum(ORIGINS).optional()`.

### T5 MCP: `src/mcp/server.ts`, `src/mcp/format.ts`

- `nodeInputSchema`: `what` and `why` (`z.string().max(WHAT_WHY_MAX).optional()`), described as "What this step
  implements, one or two sentences written for Aiden" and "Why it is worth doing, for Aiden"; `origin`
  (`z.enum(['asked', 'proposed']).optional()`), described as "asked: work Aiden asked for (the default). proposed: a
  follow-up the session filed of its own".
- `add_nodes` description: add "Give every new step a what and a why."
- `update_node`: add `what`, `why` (same schema) and `origin` (`z.enum(ORIGINS).optional()`); its description says it
  sets what and why on any step, older ones included.
- `formatNodeDetail`: the header's parenthetical ends with the origin (`(task, data, proposed)`); after the Parent line,
  `What: <what>` and `Why: <why>` when non-empty, before Body.

### T6 The mark: `src/core/board.ts`, `web/src/board/Marks.tsx`

- `MARKS` gains `'no_why'` (after `no_outcome`).
- In `deriveBoard`, for a row whose column is not `done`: push `no_why` when `node.origin !== 'me'`,
  `node.createdAt >= WHAT_WHY_SINCE`, and `!node.what.trim() || !node.why.trim()`.
- `Marks.tsx`: `no_why: 'no What/Why'`.

### T7 Briefing and the session-side docs

- `src/server/briefing.ts:57`: the deliverable clause reads `(a new step with one label: ${labels}, a What and a Why;
  "proposed" when the step is your own follow-up, not Aiden's ask)`. Update the expectations in
  `test/server/sessions.test.ts` (around :321, :417, :447).
- `claude/agents/inprogress-scribe.md` step 3: a bullet after labels: "What and Why (`what: …`, `why: …` on an added
  step; `#57 what: … why: …`): `what` and `why` on `add_nodes` or `update_node`. A step briefed `proposed`
  (`(task, fix, proposed)`) gets `origin: "proposed"`; otherwise leave origin out." Rule 6 gains: never invent a What
  or a Why the brief does not give.
- `claude/skills/inprogress/SKILL.md`: the brief examples gain one add with a What, a Why and `proposed`, and one
  `#id what: … why: …` line; keep the file's voice.
- `claude/skills/mip-orc/SKILL.md`: beside the `no_outcome` line, a `no_why` line: propose a What and a Why from the
  step's body, handoff and log, in the batch for Aiden to approve; never from the title alone. Where Mip proposes from
  the Backlog or presents a follow-up, he quotes the step's own What and Why.

### T8 Tests

- `test/server/migration18.test.ts`, modelled on `migration17.test.ts` (seed at 17, then migrate): window
  `node.created` events (one with several `data.ids`) make those steps `me`; scribe and system events and steps with no
  event stay `asked`; an event whose data is not JSON does not stop the migration; `what`/`why` default `''`; the CHECK
  refuses `origin = 'other'`; a v17 build's INSERT and UPDATE (copy migration 17's test's statements) still work and land
  `asked`; `min_reader_version` is `'1'`.
- Repo tests (`test/server/nodes.test.ts`): a window add is `me` even when the input says `proposed`; a scribe add
  defaults to `asked`; `proposed` reaches the children that do not set their own; what and why are trimmed and stored;
  `updateNode` sets what, why and origin on an existing step and `node.updated` carries them.
- HTTP schema: `add` refuses origin `me` and a 501-character why; `update` accepts origin `me`.
- MCP: `formatNodeDetail` prints What, Why and the origin (existing format tests, if any, else a small new one).
- `test/core/board.test.ts`: `no_why` on an open `asked` step after the cutoff missing either field; not when both are
  set, not for `me`, not before the cutoff, not on a done row.
- Every TreeNode fixture factory the typecheck names (`test/core/*.test.ts`, `test/web/*.test.ts`) gains
  `what: '', why: '', origin: 'asked'`.

### Checks

From the worktree: `npm run typecheck`, `npm test`, `npm run test:smoke`. No em dashes anywhere (the repo test scans).
