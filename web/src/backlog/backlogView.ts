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

/** How many open steps (todo, active, blocked) lie below `id`, at every depth. */
export function openInside(nodes: TreeNode[], id: number): number {
  const children = new Map<number, TreeNode[]>();
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const list = children.get(n.parentId);
    if (list) list.push(n);
    else children.set(n.parentId, [n]);
  }
  let count = 0;
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (OPEN.has(n.status)) count++;
    stack.push(...(children.get(n.id) ?? []));
  }
  return count;
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
 * A pending (deleting) row is passed over. Null when the row is in no Backlog or All done view.
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
