import type { Backlog, BacklogMatch, BacklogView } from '../../../src/core/backlog';
import type { RankOp, TreeNode } from '../../../src/core/types';
import { filterWords } from '../board/backlogOrder';

/** The Backlog page head's meta: open and parked, or while filtering how many of the open ones show. */
export function backlogMeta(open: number, shown: number, parked: number, filtering: boolean): { label: string; value: number }[] {
  return filtering
    ? [{ value: shown, label: `OF ${open} SHOWN` }, { value: parked, label: 'PARKED' }]
    : [{ value: open, label: 'OPEN' }, { value: parked, label: 'PARKED' }];
}

const VIEWS: BacklogView[] = ['ranked', 'phase', 'triage', 'stale', 'parked'];
const VIEW_LABELS: Record<BacklogView, string> = { ranked: 'Ranked', phase: 'By Phase', triage: 'Needs Triage', stale: 'Stale', parked: 'Parked' };

/** Where the open view is kept, per project, as a plain view name. */
export const viewKey = (projectId: number): string => `ip.backlogView.${projectId}`;

/** Reads a stored view; anything unknown is Ranked. */
export function parseView(raw: string | null): BacklogView {
  return VIEWS.find((v) => v === raw) ?? 'ranked';
}

/** The views strip, shaped as the TabStrip's items: each view with the rows the filter leaves in it. */
export function viewTabs(counts: Backlog['counts']): { id: BacklogView; label: string; count: number }[] {
  return VIEWS.map((v) => ({ id: v, label: VIEW_LABELS[v], count: counts[v].shown }));
}

/**
 * The Backlog's filter as deriveBacklog takes it (#453's rule, with the phase title): every word of the query must appear
 * in the row's "#id", title, label, or the title of any ancestor (its parent and its phase). Undefined for a blank query.
 */
export function backlogMatch(query: string): BacklogMatch | undefined {
  const words = filterWords(query);
  if (words.length === 0) return undefined;
  return ({ node, crumb }) => {
    const text = `#${node.id} ${node.title} ${node.label ?? ''} ${crumb.map((c) => c.title).join(' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  };
}

/** The ids of Ranked's three lists: Next up is the unowned queue only. */
export interface RankLists {
  next: number[];
  soon: number[];
  someday: number[];
}

/** The lists the window shows at once for a rank op, before the snapshot: the step out of all three, into `op.to` before `op.before` (the end when null or not there). */
export function optimisticRank(lists: RankLists, op: RankOp): RankLists {
  const out: RankLists = { next: lists.next.filter((id) => id !== op.node), soon: lists.soon.filter((id) => id !== op.node), someday: lists.someday.filter((id) => id !== op.node) };
  const into = out[op.to];
  const at = op.before === null ? -1 : into.indexOf(op.before);
  if (at < 0) into.push(op.node);
  else into.splice(at, 0, op.node);
  return out;
}

/** The `before` for moving `id` one place within `list`: null when it goes to the end. Undefined at an end of the list, or when it is not there (no move). */
export function altMove(list: number[], id: number, dir: 'up' | 'down'): number | null | undefined {
  const at = list.indexOf(id);
  if (at < 0) return undefined;
  if (dir === 'up') return at === 0 ? undefined : list[at - 1];
  return at === list.length - 1 ? undefined : (list[at + 2] ?? null);
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
