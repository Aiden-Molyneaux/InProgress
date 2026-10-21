import { bandOrder } from '../../core/backlog';
import type { RankBand, StepTouch, TreeNode } from '../../core/types';
import type { Ctx } from '../db/tx';
import { conflict } from '../errors';

/**
 * The rank for step `nodeId` placed in `band` before `before` (null: at the end), inside a write already open, from
 * `nodes`, the project's steps as read in this write. Gives every unranked step of the band a rank in its shown order
 * (bandOrder) first, and renormalises the band to 1..n when the gap it would land in is under 1e-6; both write `rank`
 * only, never `updated_at`, so only the moved step reads as touched. A step that already sits there keeps its rank
 * (Keep is a no-op move: its `before` is keepBefore's). Refuses (409) a `before` that is not an open step of the band,
 * or is the step itself. The caller stores the rank it returns.
 */
export function placeInBand(ctx: Ctx, nodes: TreeNode[], nodeId: number, band: RankBand, before: number | null): number {
  if (before === nodeId) throw conflict(`#${nodeId} cannot be placed before itself`, 'Reload the window.');
  const setRank = ctx.db.prepare('UPDATE nodes SET rank = ? WHERE id = ?');
  let members = bandOrder(nodes, band).map((n) => ({ id: n.id, rank: n.rank }));
  if (members.some((m) => m.rank === null)) {
    let top = members.reduce((max, m) => (m.rank !== null && m.rank > max ? m.rank : max), 0);
    members = members.map((m) => {
      if (m.rank !== null) return m;
      setRank.run(++top, m.id);
      return { id: m.id, rank: top };
    });
  }
  const self = members.find((m) => m.id === nodeId);
  let others = members.filter((m) => m.id !== nodeId);
  const at = before === null ? others.length : others.findIndex((m) => m.id === before);
  if (at < 0) throw conflict(`#${before} is not in ${band === 'soon' ? 'Soon' : 'Someday'}`, 'Reload the window.');
  const bounds = () => ({ lo: others[at - 1]?.rank ?? null, hi: others[at]?.rank ?? null });
  let { lo, hi } = bounds();
  if (self?.rank != null && (lo === null || self.rank > lo) && (hi === null || self.rank < hi)) return self.rank;
  if (lo !== null && hi !== null && hi - lo < 2e-6) {
    others = others.map((m, i) => {
      setRank.run(i + 1, m.id);
      return { id: m.id, rank: i + 1 };
    });
    ({ lo, hi } = bounds());
  }
  if (lo === null) return hi === null ? 1 : hi - 1;
  return hi === null ? lo + 1 : (lo + hi) / 2;
}

/**
 * When a session or an ask last touched each open step of the project that is in a band (StepTouch), however long ago.
 * A session counts for the step it has as its focus now (or had when it ended): sessions keep no older focus.
 */
export function listStepTouches(ctx: Ctx, projectId: number): StepTouch[] {
  return (ctx.db
    .prepare(
      `SELECT * FROM (
         SELECT n.id AS nodeId,
           (SELECT MAX(CASE WHEN s.state = 'ended' THEN MIN(coalesce(s.ended_at, s.last_seen_at), s.last_seen_at) ELSE s.last_seen_at END)
              FROM sessions s WHERE s.project_id = n.project_id AND s.focus_node_id = n.id) AS sessionAt,
           (SELECT MAX(a.raised_at) FROM asks a WHERE a.node_id = n.id) AS askAt
         FROM nodes n WHERE n.project_id = ? AND n.rank_band IS NOT NULL AND n.status IN ('todo', 'active', 'blocked')
       ) WHERE sessionAt IS NOT NULL OR askAt IS NOT NULL ORDER BY nodeId`,
    )
    .all(projectId) as StepTouch[]);
}
