import { describe, expect, it } from 'vitest';
import type { TaskBox } from '../../src/core/taskState';
import type { TreeNode } from '../../src/core/types';
import { UNLABELLED, backlogSections, filterEntries, phaseOf, sortFlat } from '../../web/src/board/backlogOrder';

const node = (id: number, title = `Step ${id}`) => ({ id, title }) as unknown as TreeNode;
const box = (id: number, crumb: TreeNode[] = []) => ({ row: { node: node(id), crumb } }) as unknown as TaskBox;
const ids = (boxes: TaskBox[]) => boxes.map((b) => b.row!.node.id);
const phase = (id: number, title: string) => ({ ...node(id, title), kind: 'phase' }) as unknown as TreeNode;
const task = (id: number, title: string) => ({ ...node(id, title), kind: 'task' }) as unknown as TreeNode;

describe('phaseOf', () => {
  it('phaseOf is the nearest phase ancestor, null for a root task', () => {
    const outer = phase(1, 'Outer');
    const inner = phase(2, 'Inner');
    expect(phaseOf({ crumb: [outer, task(3, 'Group'), inner, task(4, 'Sub')] })?.id).toBe(2);
    expect(phaseOf({ crumb: [outer, task(3, 'Group')] })?.id).toBe(1);
    expect(phaseOf({ crumb: [task(3, 'Group')] })).toBeNull();
    expect(phaseOf({ crumb: [] })).toBeNull();
  });
});

describe('age sort', () => {
  const aged = (id: number, createdAt: string) => ({ row: { node: { ...node(id), createdAt }, crumb: [] } }) as unknown as TaskBox;
  const list = [aged(7, '2026-10-03T00:00:00Z'), aged(3, '2026-10-01T00:00:00Z'), aged(9, '2026-10-02T00:00:00Z'), aged(2, '2026-10-01T00:00:00Z')];
  it('age sort orders by createdAt, oldest first, ties by id, and reverse flips it', () => {
    const up = backlogSections(list, { by: 'age', reverse: false });
    expect(up).toHaveLength(1);
    expect(up[0].flat).toBe(true);
    expect(ids(up[0].boxes)).toEqual([2, 3, 9, 7]);
    expect(ids(backlogSections(list, { by: 'age', reverse: true })[0].boxes)).toEqual([7, 9, 3, 2]);
    expect(ids(sortFlat(list, { by: 'age', reverse: false }))).toEqual([2, 3, 9, 7]);
  });
  it('does not reorder what it was given', () => {
    sortFlat(list, { by: 'age', reverse: true });
    expect(ids(list)).toEqual([7, 3, 9, 2]);
  });
});

describe('sortFlat', () => {
  const list = [box(12), box(5), box(21), box(11), box(30)];
  it('keeps the given (tree) order for phase and flips it in reverse; id sorts by id', () => {
    expect(ids(sortFlat(list, { by: 'phase', reverse: false }))).toEqual([12, 5, 21, 11, 30]);
    expect(ids(sortFlat(list, { by: 'phase', reverse: true }))).toEqual([30, 11, 21, 5, 12]);
    expect(ids(sortFlat(list, { by: 'id', reverse: false }))).toEqual([5, 11, 12, 21, 30]);
  });
});

describe('filterEntries', () => {
  const pa = phase(10, 'Phase A');
  const pb = phase(20, 'Phase B');
  const make = (id: number, label: string | null, crumb: TreeNode[]) => ({ row: { node: { ...node(id), label }, crumb } }) as unknown as TaskBox;
  const list = [make(1, 'fix', [pa]), make(2, null, [pb]), make(3, 'ui', []), make(4, 'fix', []), make(5, null, [pa])];
  const none = new Set<string>();
  it('label chips match any chosen label and unlabelled', () => {
    expect(ids(filterEntries(list, { query: '', phase: null, labels: new Set(['fix']) }))).toEqual([1, 4]);
    expect(ids(filterEntries(list, { query: '', phase: null, labels: new Set(['fix', 'ui']) }))).toEqual([1, 3, 4]);
    expect(ids(filterEntries(list, { query: '', phase: null, labels: new Set([UNLABELLED]) }))).toEqual([2, 5]);
    expect(ids(filterEntries(list, { query: '', phase: null, labels: new Set(['ui', UNLABELLED]) }))).toEqual([2, 3, 5]);
    expect(filterEntries(list, { query: '', phase: null, labels: none })).toHaveLength(5);
  });
  it('the phase filter is one choice: a phase, No phase, or all', () => {
    expect(ids(filterEntries(list, { query: '', phase: 10, labels: none }))).toEqual([1, 5]);
    expect(ids(filterEntries(list, { query: '', phase: 'none', labels: none }))).toEqual([3, 4]);
    expect(filterEntries(list, { query: '', phase: null, labels: none })).toHaveLength(5);
  });
  it('text, phase and label combine with AND', () => {
    expect(ids(filterEntries(list, { query: 'phase a', phase: 10, labels: new Set(['fix']) }))).toEqual([1]);
    expect(ids(filterEntries(list, { query: 'phase b', phase: 10, labels: none }))).toEqual([]);
  });
});
