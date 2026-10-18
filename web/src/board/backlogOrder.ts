import type { TreeNode } from '../../../src/core/types';

/** How the Backlog orders its rows (#452): by phase (grouped under each parent), by id, or by age (the last two one flat list). */
export type BacklogSort = 'phase' | 'id' | 'age';
export interface BacklogOrder {
  by: BacklogSort;
  reverse: boolean;
}

/** Anything the Backlog lists: an open box or a parked row. Both carry the step and its ancestors. */
export interface Entry {
  row: { node: TreeNode; crumb: TreeNode[] } | null;
}

/** Where the choice is kept, per browser, like All done's order. */
export const ORDER_KEY = 'ip.backlogOrder';

/** Reads a stored order; anything unknown is phase, forward. */
export function parseOrder(raw: string | null): BacklogOrder {
  const [by, dir] = (raw ?? '').split('-');
  return { by: by === 'id' ? 'id' : by === 'age' ? 'age' : 'phase', reverse: dir === 'rev' };
}

export function orderKey(order: BacklogOrder): string {
  return `${order.by}${order.reverse ? '-rev' : ''}`;
}

const parentOf = (box: Entry): TreeNode | null => {
  const crumb = box.row!.crumb;
  return crumb[crumb.length - 1] ?? null;
};

/** A step's phase: its nearest ancestor of kind phase; null for a step with none (it has No phase). */
export function phaseOf(row: { crumb: TreeNode[] }): TreeNode | null {
  for (let i = row.crumb.length - 1; i >= 0; i--) if (row.crumb[i].kind === 'phase') return row.crumb[i];
  return null;
}

/** Backlog boxes grouped by parent, in the order the parents first appear; boxes at the top level come last (No phase). */
export function groupByParent<T extends Entry>(boxes: T[]): { parent: TreeNode | null; boxes: T[] }[] {
  const groups = new Map<number, { parent: TreeNode | null; boxes: T[] }>();
  for (const box of boxes) {
    const parent = parentOf(box);
    const key = parent?.id ?? 0;
    const group = groups.get(key) ?? { parent, boxes: [] };
    group.boxes.push(box);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === 0 ? 1 : 0) - (b === 0 ? 1 : 0)).map(([, g]) => g);
}

/**
 * One flat list in an order: phase keeps the order given (tree order), id sorts by id, age by createdAt, oldest first
 * (ties by id); reverse flips any of them. Does not touch the list it was given.
 */
export function sortFlat<T extends Entry>(boxes: T[], order: BacklogOrder): T[] {
  const sign = order.reverse ? -1 : 1;
  if (order.by === 'phase') return order.reverse ? [...boxes].reverse() : [...boxes];
  if (order.by === 'id') return [...boxes].sort((a, b) => sign * (a.row!.node.id - b.row!.node.id));
  return [...boxes].sort((a, b) => sign * (a.row!.node.createdAt.localeCompare(b.row!.node.createdAt) || a.row!.node.id - b.row!.node.id));
}

/**
 * The Backlog's sections for an order. Phase: the parent groups of `groupByParent`, parents in
 * order of first arrival, then the top level (No phase) last, like the preview's picker (tree order, except a step sent back from Next lands last in its group until the snapshot
 * settles), and reverse flips both the groups and the rows in each. Id and age: one flat section, oldest or lowest first, or the reverse.
 */
export function backlogSections<T extends Entry>(boxes: T[], order: BacklogOrder): { parent: TreeNode | null; flat: boolean; boxes: T[] }[] {
  if (order.by !== 'phase') return [{ parent: null, flat: true, boxes: sortFlat(boxes, order) }];
  const groups = groupByParent(boxes).map((g) => ({ ...g, flat: false }));
  return order.reverse ? groups.reverse().map((g) => ({ ...g, boxes: [...g.boxes].reverse() })) : groups;
}

/** The parent's title, for a box in a flat list, which has no group line above it. */
export function parentTitle(box: Entry): string | null {
  return parentOf(box)?.title ?? null;
}

/** The words of a Backlog filter (#453), lowercased; none when the field is blank. */
export function filterWords(query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? q.split(/\s+/) : [];
}

/**
 * The boxes a Backlog filter keeps (#453): every word must appear in the box's "#id", title, label or parent title, any
 * case. A blank filter keeps every box; the order of the boxes is unchanged, so either order can run after it.
 */
export function filterBoxes<T extends Entry>(boxes: T[], query: string): T[] {
  const words = filterWords(query);
  if (words.length === 0) return boxes;
  return boxes.filter((box) => {
    const { node } = box.row!;
    const text = `#${node.id} ${node.title} ${node.label ?? ''} ${parentTitle(box) ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The label chip for steps with no label. */
export const UNLABELLED = 'unlabelled';

/** The full view's filter: text, one phase (or No phase, or null for all) and any number of label chips. All combine with AND. */
export interface BacklogFilter {
  query: string;
  phase: number | 'none' | null;
  labels: ReadonlySet<string>;
}

export function filterEntries<T extends Entry>(entries: T[], f: BacklogFilter): T[] {
  return filterBoxes(entries, f.query).filter((e) => {
    const { node } = e.row!;
    if (f.phase !== null) {
      const phase = phaseOf(e.row!);
      if (f.phase === 'none' ? phase !== null : phase?.id !== f.phase) return false;
    }
    return f.labels.size === 0 || f.labels.has(node.label ?? UNLABELLED);
  });
}
