import { describe, expect, it } from 'vitest';
import type { TaskBox } from '../../src/core/taskState';
import type { TreeNode } from '../../src/core/types';
import { filterWords, groupByParent, parentTitle } from '../../web/src/board/backlogOrder';

const node = (id: number, title = `Step ${id}`) => ({ id, title }) as unknown as TreeNode;
const box = (id: number, crumb: TreeNode[] = []) => ({ row: { node: node(id), crumb } }) as unknown as TaskBox;
const ids = (boxes: TaskBox[]) => boxes.map((b) => b.row!.node.id);

const a = node(10, 'Phase A');
const b = node(20, 'Phase B');
// Tree order, as the core hands the Backlog over: under A, a top-level step, under B, then A again deeper.
const boxes = [box(12, [a]), box(5), box(21, [b]), box(11, [a]), box(30)];

describe('groupByParent', () => {
  it('puts the top level (No phase) last, after parents in order of first appearance', () => {
    const groups = groupByParent(boxes);
    expect(groups.map((g) => g.parent?.id ?? null)).toEqual([10, 20, null]);
    expect(groups.map((g) => ids(g.boxes))).toEqual([[12, 11], [21], [5, 30]]);
  });
});

describe('parentTitle', () => {
  it('is the immediate parent, or null at the top level', () => {
    expect(parentTitle(box(1, [a, b]))).toBe('Phase B');
    expect(parentTitle(box(2))).toBeNull();
  });
});

describe('filterWords', () => {
  it('splits on spaces, lowercased, and is empty for a blank field', () => {
    expect(filterWords('  Beta   CRASH ')).toEqual(['beta', 'crash']);
    expect(filterWords('   ')).toEqual([]);
  });
});
