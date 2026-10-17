import { describe, expect, it } from 'vitest';
import type { TaskBox } from '../../src/core/taskState';
import type { TreeNode } from '../../src/core/types';
import { backlogSections, filterBoxes, filterWords, groupByParent, orderKey, parentTitle, parseOrder } from '../../web/src/board/backlogOrder';

const node = (id: number, title = `Step ${id}`) => ({ id, title }) as unknown as TreeNode;
const box = (id: number, crumb: TreeNode[] = []) => ({ row: { node: node(id), crumb } }) as unknown as TaskBox;
const ids = (boxes: TaskBox[]) => boxes.map((b) => b.row!.node.id);

const a = node(10, 'Phase A');
const b = node(20, 'Phase B');
// Tree order, as the core hands the Backlog over: under A, a top-level step, under B, then A again deeper.
const boxes = [box(12, [a]), box(5), box(21, [b]), box(11, [a]), box(30)];

describe('parseOrder and orderKey', () => {
  it('reads the four stored orders and round-trips them', () => {
    for (const key of ['phase', 'phase-rev', 'id', 'id-rev']) expect(orderKey(parseOrder(key))).toBe(key);
    expect(parseOrder('id-rev')).toEqual({ by: 'id', reverse: true });
    expect(parseOrder('id-')).toEqual({ by: 'id', reverse: false });
  });
  it('falls back to phase, forward, for nothing or anything unknown', () => {
    expect(parseOrder(null)).toEqual({ by: 'phase', reverse: false });
    expect(parseOrder('time-up')).toEqual({ by: 'phase', reverse: false });
    expect(parseOrder('')).toEqual({ by: 'phase', reverse: false });
    expect(parseOrder('ID')).toEqual({ by: 'phase', reverse: false });
  });
});

describe('groupByParent', () => {
  it('puts the top level first, then parents in order of first appearance', () => {
    const groups = groupByParent(boxes);
    expect(groups.map((g) => g.parent?.id ?? null)).toEqual([null, 10, 20]);
    expect(groups.map((g) => ids(g.boxes))).toEqual([[5, 30], [12, 11], [21]]);
  });
});

describe('backlogSections', () => {
  it('phase forward is the parent grouping', () => {
    const s = backlogSections(boxes, { by: 'phase', reverse: false });
    expect(s.map((g) => [g.parent?.id ?? null, g.flat, ids(g.boxes)])).toEqual([[null, false, [5, 30]], [10, false, [12, 11]], [20, false, [21]]]);
  });
  it('phase reverse flips the groups and the rows in each', () => {
    const s = backlogSections(boxes, { by: 'phase', reverse: true });
    expect(s.map((g) => [g.parent?.id ?? null, ids(g.boxes)])).toEqual([[20, [21]], [10, [11, 12]], [null, [30, 5]]]);
  });
  it('id is one flat list, low to high, or high to low in reverse', () => {
    const up = backlogSections(boxes, { by: 'id', reverse: false });
    expect(up).toHaveLength(1);
    expect(up[0].flat).toBe(true);
    expect(ids(up[0].boxes)).toEqual([5, 11, 12, 21, 30]);
    expect(ids(backlogSections(boxes, { by: 'id', reverse: true })[0].boxes)).toEqual([30, 21, 12, 11, 5]);
  });
  it('does not reorder the boxes it was given', () => {
    backlogSections(boxes, { by: 'id', reverse: true });
    backlogSections(boxes, { by: 'phase', reverse: true });
    expect(ids(boxes)).toEqual([12, 5, 21, 11, 30]);
  });
  it('is empty-safe', () => {
    expect(backlogSections([], { by: 'phase', reverse: true })).toEqual([]);
    expect(backlogSections([], { by: 'id', reverse: false })[0].boxes).toEqual([]);
  });
});

describe('parentTitle', () => {
  it('is the immediate parent, or null at the top level', () => {
    expect(parentTitle(box(1, [a, b]))).toBe('Phase B');
    expect(parentTitle(box(2))).toBeNull();
  });
});

describe('filterWords and filterBoxes', () => {
  const labelled = (id: number, title: string, label: string | null, crumb: TreeNode[] = []) =>
    ({ row: { node: { ...node(id, title), label }, crumb } }) as unknown as TaskBox;
  const list = [
    labelled(12, 'Wire up RevenueCat', 'integration', [a]),
    labelled(5, 'Store listing', null),
    labelled(21, 'Fix the beta crash', 'fix', [b]),
    labelled(130, 'Launch', 'ui', [a]),
  ];
  it('splits on spaces, lowercased, and is empty for a blank field', () => {
    expect(filterWords('  Beta   CRASH ')).toEqual(['beta', 'crash']);
    expect(filterWords('   ')).toEqual([]);
  });
  it('keeps every box, in order, for a blank filter', () => {
    expect(filterBoxes(list, ' ')).toBe(list);
  });
  it('matches the title, any case', () => {
    expect(ids(filterBoxes(list, 'revenuecat'))).toEqual([12]);
  });
  it('matches "#id" from its start, and a bare number anywhere in the id', () => {
    expect(ids(filterBoxes(list, '#12'))).toEqual([12]);
    expect(ids(filterBoxes(list, '#13'))).toEqual([130]);
    expect(ids(filterBoxes(list, '13'))).toEqual([130]);
  });
  it('matches the label and the parent title', () => {
    expect(ids(filterBoxes(list, 'integration'))).toEqual([12]);
    expect(ids(filterBoxes(list, 'phase b'))).toEqual([21]);
  });
  it('needs every word to match somewhere', () => {
    expect(ids(filterBoxes(list, 'fix beta'))).toEqual([21]);
    expect(ids(filterBoxes(list, 'fix launch'))).toEqual([]);
  });
  it('keeps the order it was given, so either Backlog order can run after it', () => {
    expect(ids(filterBoxes(list, 'phase'))).toEqual([12, 21, 130]);
  });
});
