import type { Board, BoardRow, ParkedRow } from './board';
import { STALE_STEP_MS, type ProjectSnapshot, type RankBand, type TreeNode } from './types';

/** Where a Backlog row sits: next while it is queued (whatever band it keeps), else its band; null when unranked. */
export type BacklogBand = 'next' | RankBand;
export type BacklogView = 'ranked' | 'phase' | 'triage' | 'stale' | 'parked';

export interface BacklogRow {
  row: BoardRow;
  band: BacklogBand | null;
  /** Its number in Ranked, run on across bands: unowned Next up 1..k, then Soon, then Someday. Null for own-queue and unranked rows. */
  number: number | null;
  /** When it was last touched: the newest of its updatedAt, its last focusing session and its last ask (spec section 4). */
  touchedAt: string;
}

/** A view's rows before the filter (`all`) and after it (`shown`). */
export interface BacklogCount {
  all: number;
  shown: number;
}

/** The ranked Backlog's views (spec 2026-10-20-ranked-backlog-design.md section 2), each already filtered. */
export interface Backlog {
  /** The Board's Next rows in its order: unowned first, numbered, then each own queue. */
  next: BacklogRow[];
  /** Soon by rank; unranked steps of the band after the ranked ones, in tree order. */
  soon: BacklogRow[];
  /** Someday, ordered as Soon. */
  someday: BacklogRow[];
  /** Unranked rows (no band, not queued), newest created first, ties by the higher id. */
  triage: BacklogRow[];
  /** Soon and Someday rows untouched for STALE_STEP_MS, the longest untouched first. */
  stale: BacklogRow[];
  /** By Phase's rows in rank order: Next up, Soon, Someday, then unranked; the view groups them by parent. */
  phase: BacklogRow[];
  /** The Board's parked steps, newest parked first. */
  parked: ParkedRow[];
  counts: Record<BacklogView, BacklogCount>;
}

/** What deriveBacklog reads beside the Board. */
export type BacklogInput = Pick<ProjectSnapshot, 'stepTouches'>;

/** What the Backlog's filter tests: a row's step and its ancestors. */
export type BacklogMatch = (entry: { node: TreeNode; crumb: TreeNode[] }) => boolean;

const latest = (times: (string | null)[]): string =>
  times.reduce<string>((max, t) => (t !== null && Date.parse(t) > Date.parse(max) ? t : max), times[0] ?? '');

/**
 * The ranked Backlog's views from the Board (spec section 2, "Reading it"): its Next and Backlog rows (groups are not
 * rows, as on the Board) in bands, Needs Triage, Stale and Parked, with counts. `match`, when given, is the filter: the
 * lists keep the rows it passes, the counts give both, and the numbers stay those of the unfiltered list.
 */
export function deriveBacklog(board: Board, input: BacklogInput, now: number, match?: BacklogMatch): Backlog {
  const touches = new Map(input.stepTouches.map((t) => [t.nodeId, t]));
  const touched = (node: TreeNode): string => {
    const t = touches.get(node.id);
    return latest([node.updatedAt, t?.sessionAt ?? null, t?.askAt ?? null]);
  };
  const entry = (row: BoardRow, band: BacklogBand | null, number: number | null): BacklogRow => ({ row, band, number, touchedAt: touched(row.node) });

  let n = 0;
  const next = board.next.map((row) => entry(row, 'next', row.owner === null ? ++n : null));
  const tree = new Map(board.backlog.map((row, i) => [row.node.id, i]));
  const byRank = (a: BoardRow, b: BoardRow) =>
    (a.node.rank === null ? 1 : 0) - (b.node.rank === null ? 1 : 0) || (a.node.rank ?? 0) - (b.node.rank ?? 0) || tree.get(a.node.id)! - tree.get(b.node.id)!;
  const band = (name: RankBand) => board.backlog.filter((row) => row.node.rankBand === name).sort(byRank).map((row) => entry(row, name, ++n));
  const soon = band('soon');
  const someday = band('someday');
  const triage = board.backlog
    .filter((row) => row.node.rankBand === null)
    .sort((a, b) => b.node.createdAt.localeCompare(a.node.createdAt) || b.node.id - a.node.id)
    .map((row) => entry(row, null, null));
  const stale = [...soon, ...someday]
    .filter((r) => now - Date.parse(r.touchedAt) > STALE_STEP_MS)
    .sort((a, b) => Date.parse(a.touchedAt) - Date.parse(b.touchedAt) || a.row.node.id - b.row.node.id);
  const parked = [...board.parked].sort((a, b) => (b.node.parkedAt ?? '').localeCompare(a.node.parkedAt ?? '') || b.node.id - a.node.id);

  const keep = <T extends { node: TreeNode; crumb: TreeNode[] }>(list: T[]): T[] => (match ? list.filter((x) => match(x)) : list);
  const keepRows = (list: BacklogRow[]) => (match ? list.filter((r) => match(r.row)) : list);
  const count = (all: number, shown: number): BacklogCount => ({ all, shown });
  const shown = { next: keepRows(next), soon: keepRows(soon), someday: keepRows(someday), triage: keepRows(triage), stale: keepRows(stale), parked: keep(parked) };
  const phase = [...shown.next, ...shown.soon, ...shown.someday, ...shown.triage];
  return {
    ...shown,
    phase,
    counts: {
      ranked: count(next.length + soon.length + someday.length, shown.next.length + shown.soon.length + shown.someday.length),
      phase: count(next.length + soon.length + someday.length + triage.length, phase.length),
      triage: count(triage.length, shown.triage.length),
      stale: count(stale.length, shown.stale.length),
      parked: count(parked.length, shown.parked.length),
    },
  };
}
