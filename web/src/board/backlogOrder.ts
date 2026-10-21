import type { TreeNode } from '../../../src/core/types';

/** Anything the Backlog lists: an open box or a parked row. Both carry the step and its ancestors. */
export interface Entry {
  row: { node: TreeNode; crumb: TreeNode[] } | null;
}

const parentOf = (box: Entry): TreeNode | null => {
  const crumb = box.row!.crumb;
  return crumb[crumb.length - 1] ?? null;
};

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

/** The parent's title, for a box in a flat list, which has no group line above it. */
export function parentTitle(box: Entry): string | null {
  return parentOf(box)?.title ?? null;
}

/** The words of a Backlog filter (#453), lowercased; none when the field is blank. */
export function filterWords(query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? q.split(/\s+/) : [];
}
