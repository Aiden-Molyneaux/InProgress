import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../../src/core/types';
import { backlogMeta, openInsideIndex, phaseTabs } from '../../web/src/backlog/backlogView';

const node = (id: number, parentId: number | null, status: TreeNode['status'], kind: TreeNode['kind'] = 'task', title = `n${id}`): TreeNode =>
  ({ id, projectId: 1, parentId, position: id, kind, title, status }) as unknown as TreeNode;
const entry = (n: TreeNode, crumb: TreeNode[]) => ({ row: { node: n, crumb } });

describe('backlogMeta', () => {
  it('says open and parked', () => {
    expect(backlogMeta(5, 5, 2, false)).toEqual([{ value: 5, label: 'OPEN' }, { value: 2, label: 'PARKED' }]);
  });
  it('says how many of the open ones show while filtering', () => {
    expect(backlogMeta(5, 2, 2, true)).toEqual([{ value: 2, label: 'OF 5 SHOWN' }, { value: 2, label: 'PARKED' }]);
  });
});

describe('phaseTabs', () => {
  const p1 = node(2, 1, 'active', 'phase', 'Alpha');
  const p2 = node(3, 1, 'active', 'phase', 'A phase with a very long title indeed');
  const open = [entry(node(4, 2, 'todo'), [p1]), entry(node(5, 2, 'todo'), [p1]), entry(node(6, 1, 'todo'), [])];
  it('counts open entries per phase, with All first and a 0 for an empty phase', () => {
    const tabs = phaseTabs([{ value: 2, title: 'Alpha' }, { value: 3, title: p2.title }, { value: 'none', title: 'No phase' }], open);
    expect(tabs.map((t) => [t.id, t.count])).toEqual([['all', 3], ['2', 2], ['3', 0], ['none', 1]]);
  });
  it('cuts a label over 24 characters to 23 and an ellipsis', () => {
    const tabs = phaseTabs([{ value: 3, title: p2.title }], open);
    expect(tabs[1]!.label).toBe(`${p2.title.slice(0, 23)}…`);
    expect([...tabs[1]!.label]).toHaveLength(24);
  });
});

describe('openInsideIndex', () => {
  const nodes = [node(1, null, 'active'), node(2, 1, 'todo'), node(3, 2, 'blocked'), node(4, 3, 'active'), node(5, 2, 'done'), node(6, 1, 'dropped'), node(7, 1, 'parked')];
  it('counts todo, active and blocked below a step at every depth', () => {
    expect(openInsideIndex(nodes)(1)).toBe(3);
    expect(openInsideIndex(nodes)(2)).toBe(2);
  });
  it('is 0 for a step with no children', () => {
    expect(openInsideIndex(nodes)(4)).toBe(0);
  });
});
