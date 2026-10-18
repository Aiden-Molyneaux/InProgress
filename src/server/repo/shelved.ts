import type { Ctx } from '../db/tx';

/** The ids among `ids` that are shelved: parked, or under a parked ancestor. One recursive walk up `parent_id`. */
export function shelvedAmong(ctx: Ctx, ids: number[]): Set<number> {
  if (!ids.length) return new Set();
  return new Set(
    ctx.db
      .prepare(
        `WITH RECURSIVE up(start, id) AS (
           SELECT id, id FROM nodes WHERE id IN (${ids.map(() => '?').join(', ')})
           UNION ALL
           SELECT up.start, n.parent_id FROM up JOIN nodes n ON n.id = up.id WHERE n.parent_id IS NOT NULL
         )
         SELECT DISTINCT up.start FROM up JOIN nodes p ON p.id = up.id WHERE p.status = 'parked'`,
      )
      .pluck()
      .all(...ids) as number[],
  );
}

/** The nearest parked step above `id` (not `id` itself), or null when none is. */
export function parkedAncestor(ctx: Ctx, id: number): number | null {
  const row = ctx.db
    .prepare(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT parent_id, 1 FROM nodes WHERE id = ? AND parent_id IS NOT NULL
         UNION ALL
         SELECT n.parent_id, up.depth + 1 FROM up JOIN nodes n ON n.id = up.id WHERE n.parent_id IS NOT NULL
       )
       SELECT up.id FROM up JOIN nodes p ON p.id = up.id WHERE p.status = 'parked' ORDER BY up.depth LIMIT 1`,
    )
    .pluck()
    .get(id) as number | undefined;
  return row ?? null;
}

/** Step `id` and every step under it, `id` first. */
export function subtreeIds(ctx: Ctx, id: number): number[] {
  return ctx.db
    .prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub')
    .pluck()
    .all(id) as number[];
}
