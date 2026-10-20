import type { BoardRow } from '../../../src/core/board';
import type { TreeNode } from '../../../src/core/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The local calendar day of a time, as a number that orders and compares by day. */
const dayKey = (d: Date) => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();

/** "14:02": the local clock time of an ISO timestamp. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Oct 13", or "Oct 13, 2025" when the year is not the current one. Local time. */
export function shortDate(iso: string, now: number): string {
  const d = new Date(iso);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

function dayHeading(iso: string, now: number): string {
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const key = dayKey(new Date(iso));
  if (key === dayKey(today)) return 'Today';
  if (key === dayKey(yesterday)) return 'Yesterday';
  return shortDate(iso, now);
}

/** Rows (newest first) grouped by the local day they finished; steps with no finish time go last under "Undated". */
export function byTime(rows: BoardRow[], now: number): { heading: string; rows: BoardRow[] }[] {
  const groups: { heading: string; key: number; rows: BoardRow[] }[] = [];
  const undated: BoardRow[] = [];
  for (const row of rows) {
    const at = row.node.completedAt;
    if (!at) {
      undated.push(row);
      continue;
    }
    const key = dayKey(new Date(at));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ heading: dayHeading(at, now), key, rows: [row] });
  }
  const out = groups.map(({ heading, rows: r }) => ({ heading, rows: r }));
  if (undated.length > 0) out.push({ heading: 'Undated', rows: undated });
  return out;
}

/**
 * Rows (newest first) grouped by their immediate parent step, groups in order of their newest row. The path names the
 * project's root and every step down to the parent, each with its id: "#26 InProgress › #495 Port the window" (a
 * top-level step has just the root).
 */
export function byPhase(rows: BoardRow[], root: TreeNode | null): { parent: TreeNode | null; path: string; rows: BoardRow[] }[] {
  const groups = new Map<number | null, { parent: TreeNode | null; path: string; rows: BoardRow[] }>();
  for (const row of rows) {
    const parent = row.crumb.length > 0 ? row.crumb[row.crumb.length - 1] : null;
    const id = parent ? parent.id : null;
    let group = groups.get(id);
    if (!group) {
      group = { parent, path: (root ? [root, ...row.crumb] : row.crumb).map((n) => `#${n.id} ${n.title}`).join(' › '), rows: [] };
      groups.set(id, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}
