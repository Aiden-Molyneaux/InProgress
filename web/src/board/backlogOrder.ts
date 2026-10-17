import type { TreeNode } from '../../../src/core/types';
import type { TaskBox as BoxData } from '../../../src/core/taskState';

/** How the open Backlog orders its rows (#452): by phase (grouped under each parent) or by id (one flat list). */
export type BacklogSort = 'phase' | 'id';
export interface BacklogOrder {
  by: BacklogSort;
  reverse: boolean;
}

/** Where the choice is kept, per browser, like All done's order. */
export const ORDER_KEY = 'ip.backlogOrder';

/** Reads a stored order; anything unknown is phase, forward. */
export function parseOrder(raw: string | null): BacklogOrder {
  const [by, dir] = (raw ?? '').split('-');
  return { by: by === 'id' ? 'id' : 'phase', reverse: dir === 'rev' };
}

export function orderKey(order: BacklogOrder): string {
  return `${order.by}${order.reverse ? '-rev' : ''}`;
}

const parentOf = (box: BoxData): TreeNode | null => {
  const crumb = box.row!.crumb;
  return crumb[crumb.length - 1] ?? null;
};

/** Backlog boxes grouped by parent, in the order the parents first appear; boxes at the top level come first with no line. */
export function groupByParent(boxes: BoxData[]): { parent: TreeNode | null; boxes: BoxData[] }[] {
  const groups = new Map<number, { parent: TreeNode | null; boxes: BoxData[] }>();
  for (const box of boxes) {
    const parent = parentOf(box);
    const key = parent?.id ?? 0;
    const group = groups.get(key) ?? { parent, boxes: [] };
    group.boxes.push(box);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === 0 ? 0 : 1) - (b === 0 ? 0 : 1)).map(([, g]) => g);
}

/**
 * The Backlog's sections for an order. Phase: the parent groups of `groupByParent`, the top level first, then parents in
 * order of first arrival (tree order, except a step sent back from Next lands last in its group until the snapshot
 * settles), and reverse flips both the groups and the rows in each. Id: one flat section by id, low to high, or high to low in reverse.
 */
export function backlogSections(boxes: BoxData[], order: BacklogOrder): { parent: TreeNode | null; flat: boolean; boxes: BoxData[] }[] {
  if (order.by === 'id') {
    const sign = order.reverse ? -1 : 1;
    return [{ parent: null, flat: true, boxes: [...boxes].sort((a, b) => sign * (a.row!.node.id - b.row!.node.id)) }];
  }
  const groups = groupByParent(boxes).map((g) => ({ ...g, flat: false }));
  return order.reverse ? groups.reverse().map((g) => ({ ...g, boxes: [...g.boxes].reverse() })) : groups;
}

/** The parent's title, for a box in the flat id list, which has no group line above it. */
export function parentTitle(box: BoxData): string | null {
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
export function filterBoxes(boxes: BoxData[], query: string): BoxData[] {
  const words = filterWords(query);
  if (words.length === 0) return boxes;
  return boxes.filter((box) => {
    const { node } = box.row!;
    const text = `#${node.id} ${node.title} ${node.label ?? ''} ${parentTitle(box) ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
