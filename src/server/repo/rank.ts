import type { RankBand, StepTouch } from '../../core/types';
import type { Ctx } from '../db/tx';
import { conflict } from '../errors';

/** One open step of a band, in the band's shown order. */
interface Member {
  id: number;
  rank: number | null;
}

/** The project's step ids in tree order (parents before children, siblings by position then id), root first. */
function treeOrder(ctx: Ctx, projectId: number): Map<number, number> {
  const rows = ctx.db.prepare('SELECT id, parent_id, position FROM nodes WHERE project_id = ? ORDER BY position, id').all(projectId) as {
    id: number;
    parent_id: number | null;
    position: number;
  }[];
  const kids = new Map<number | null, number[]>();
  for (const r of rows) kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r.id]);
  const order = new Map<number, number>();
  const stack = [...(kids.get(null) ?? [])].reverse();
  while (stack.length) {
    const id = stack.pop()!;
    order.set(id, order.size);
    stack.push(...[...(kids.get(id) ?? [])].reverse());
  }
  return order;
}

/**
 * The open steps (todo, active or blocked) of `band` in the project, in its shown order: by rank, then the unranked ones
 * in tree order. Queued, focused and grouped steps count too: the Backlog shows a subset of this order, never another.
 */
export function bandOrder(ctx: Ctx, projectId: number, band: RankBand): Member[] {
  const rows = ctx.db
    .prepare("SELECT id, rank FROM nodes WHERE project_id = ? AND rank_band = ? AND status IN ('todo', 'active', 'blocked')")
    .all(projectId, band) as Member[];
  const tree = treeOrder(ctx, projectId);
  const at = (id: number) => tree.get(id) ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => (a.rank === null ? 1 : 0) - (b.rank === null ? 1 : 0) || (a.rank ?? 0) - (b.rank ?? 0) || at(a.id) - at(b.id) || a.id - b.id);
}

/**
 * The rank for step `nodeId` placed in `band` before `before` (null: at the end), inside a write already open. Gives
 * every unranked step of the band a rank in its shown order first, and renormalises the band to 1..n when the gap it
 * would land in is under 1e-6; both write `rank` only, never `updated_at`, so only the moved step reads as touched. A
 * step that already sits there keeps its rank (Keep is a no-op move). Refuses (409) a `before` that is not an open step of
 * the band, or is the step itself. The caller stores the rank it returns.
 */
export function placeInBand(ctx: Ctx, projectId: number, nodeId: number, band: RankBand, before: number | null): number {
  if (before === nodeId) throw conflict(`#${nodeId} cannot be placed before itself`, 'Reload the window.');
  const setRank = ctx.db.prepare('UPDATE nodes SET rank = ? WHERE id = ?');
  let members = bandOrder(ctx, projectId, band);
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
              FROM sessions s WHERE s.focus_node_id = n.id) AS sessionAt,
           (SELECT MAX(a.raised_at) FROM asks a WHERE a.node_id = n.id) AS askAt
         FROM nodes n WHERE n.project_id = ? AND n.rank_band IS NOT NULL AND n.status IN ('todo', 'active', 'blocked')
       ) WHERE sessionAt IS NOT NULL OR askAt IS NOT NULL ORDER BY nodeId`,
    )
    .all(projectId) as StepTouch[]);
}
