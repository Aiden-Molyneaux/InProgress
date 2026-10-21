import type { TreeNode } from '../../../src/core/types';
import { phaseOf, type Entry } from '../board/backlogOrder';

/** A phase tab, shaped as the TabStrip's `TabItem`. */
export interface PhaseTab {
  id: string;
  label: string;
  count?: number;
}

/** The Backlog page head's meta: open and parked, or while filtering how many of the open ones show. */
export function backlogMeta(open: number, shown: number, parked: number, filtering: boolean): { label: string; value: number }[] {
  return filtering
    ? [{ value: shown, label: `OF ${open} SHOWN` }, { value: parked, label: 'PARKED' }]
    : [{ value: open, label: 'OPEN' }, { value: parked, label: 'PARKED' }];
}

const cut = (title: string) => ([...title].length > 24 ? `${[...title].slice(0, 23).join('')}…` : title);

/** The phase strip: All, then each phase in the order given, each with the open entries in it (not narrowed by other filters). */
export function phaseTabs(phases: { value: number | 'none'; title: string }[], open: Entry[]): PhaseTab[] {
  const counts = new Map<number | 'none', number>();
  for (const e of open) {
    if (!e.row) continue;
    const key = phaseOf(e.row)?.id ?? 'none';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [
    { id: 'all', label: 'All', count: open.length },
    ...phases.map((p) => ({ id: String(p.value), label: cut(p.title), count: counts.get(p.value) ?? 0 })),
  ];
}

const OPEN = new Set(['todo', 'active', 'blocked']);

/**
 * Builds the open-below count once for a snapshot's nodes: the returned function says how many open steps (todo, active,
 * blocked) lie below an id, at every depth.
 */
export function openInsideIndex(nodes: TreeNode[]): (id: number) => number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const counts = new Map<number, number>();
  for (const n of nodes) {
    if (!OPEN.has(n.status)) continue;
    // Walks up with a bound: a cycle in a corrupt tree must not hang the window.
    let at = n.parentId === null ? undefined : byId.get(n.parentId);
    for (let hops = 0; at && hops < nodes.length; hops++) {
      counts.set(at.id, (counts.get(at.id) ?? 0) + 1);
      at = at.parentId === null ? undefined : byId.get(at.parentId);
    }
  }
  return (id) => counts.get(id) ?? 0;
}

/** The slice of an HTMLElement that cursorAfter reads, so the helper type-checks where the DOM lib is not loaded. */
interface RowLike {
  closest(selector: string): RowLike | null;
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<unknown> & Iterable<unknown>;
  compareDocumentPosition(other: never): number;
}
const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

/**
 * Where focus goes when a row leaves its view: the next row's item, else the previous one, else the page title.
 * A pending (deleting) row is passed over. Null when the row is in no Backlog or All done view. The answer is a row's `li`,
 * or the page title (not an `li`): check `matches('li[data-node]')` before reading a step id from it.
 */
export function cursorAfter<T extends RowLike>(row: T | null): T | null {
  const view = row?.closest('.ip-backlogview, .ip-donelist') ?? null;
  if (!row || !view) return null;
  const items = Array.from(view.querySelectorAll('li[data-cursor]:not(.pending)')) as T[];
  const follows = (el: T) => (row.compareDocumentPosition(el as never) & FOLLOWING) !== 0;
  const after = items.filter((el) => el !== row && follows(el));
  const before = items.filter((el) => el !== row && !follows(el));
  return after[0] ?? before[before.length - 1] ?? (view.querySelector('.ip-page-title') as T | null);
}
