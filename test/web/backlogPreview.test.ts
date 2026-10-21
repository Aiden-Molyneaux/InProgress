import { describe, expect, it } from 'vitest';
import type { Backlog, BacklogRow } from '../../src/core/backlog';
import type { TaskBox } from '../../src/core/taskState';
import type { TreeNode } from '../../src/core/types';
import { PREVIEW_SIZE, backlogPhases, backlogViewKey, soonPreview } from '../../web/src/backlog/backlogPreview';

const phase = (id: number, title: string) => ({ id, title, kind: 'phase', parentId: 1, position: id }) as unknown as TreeNode;
const root = { id: 1, title: 'Root', kind: 'phase', parentId: null, position: 0 } as unknown as TreeNode;
const row = (id: number, crumb: TreeNode[]) => ({ node: { id, title: `Step ${id}`, kind: 'task', parentId: crumb.length ? crumb[crumb.length - 1].id : 1, position: id }, crumb });

const pa = phase(10, 'Phase A');
const pb = phase(20, 'Phase B');
const pc = phase(30, 'Phase C');
// Tree order: A, B, C.
const nodes = [root, pa, pb, pc];
const board = (backlog: ReturnType<typeof row>[]) => ({ backlog });

describe('backlogViewKey', () => {
  it('keeps the view per project', () => {
    expect(backlogViewKey(7)).toBe('ip.backlogView.7');
  });
});

describe('backlogPhases', () => {
  it('lists the phases that have entries in tree order, then No phase', () => {
    const b = board([row(5, [pc]), row(6, [pa]), row(7, []), row(8, [pa])]);
    expect(backlogPhases(b, nodes).map((c) => [c.value, c.title])).toEqual([[10, 'Phase A'], [30, 'Phase C'], ['none', 'No phase']]);
  });
  it('always offers No phase, even with an empty Backlog', () => {
    expect(backlogPhases(board([]), nodes).map((c) => c.value)).toEqual(['none']);
  });
});


describe('soonPreview', () => {
  const brow = (id: number, number: number | null): BacklogRow => ({ row: row(id, []) as unknown as BacklogRow['row'], band: 'soon', number, touchedAt: '' });
  const box = (id: number) => ({ row: row(id, []) }) as unknown as TaskBox;
  const backlog = (soon: BacklogRow[], triage: BacklogRow[] = []) => ({ soon, triage }) as Pick<Backlog, 'soon' | 'triage'>;

  it('keeps rank order and deriveBacklog numbers', () => {
    const p = soonPreview(backlog([brow(7, 4), brow(3, 5), brow(4, 6)]), [box(3), box(4), box(7)]);
    expect(p.rows.map((r) => [r.box.row!.node.id, r.number])).toEqual([[7, 4], [3, 5], [4, 6]]);
    expect(p.count).toBe(3);
    expect(p.more).toBe(0);
  });
  it('shows at most five and counts the rest as more', () => {
    const ids = [1, 2, 3, 4, 5, 6, 7];
    const p = soonPreview(backlog(ids.map((id) => brow(id, id))), ids.map(box));
    expect(p.rows).toHaveLength(PREVIEW_SIZE);
    expect(p.rows.map((r) => r.box.row!.node.id)).toEqual([1, 2, 3, 4, 5]);
    expect(p.count).toBe(7);
    expect(p.more).toBe(2);
  });
  it('leaves out a Soon row that is not in the Backlog cell, from rows and count', () => {
    const p = soonPreview(backlog([brow(1, 1), brow(2, 2), brow(3, 3)]), [box(1), box(3)]);
    expect(p.rows.map((r) => r.box.row!.node.id)).toEqual([1, 3]);
    expect(p.count).toBe(2);
  });
  it('triage is true only when an unranked step is in the cell', () => {
    expect(soonPreview(backlog([], [brow(9, null)]), [box(9)]).triage).toBe(true);
    expect(soonPreview(backlog([], [brow(9, null)]), []).triage).toBe(false);
    expect(soonPreview(backlog([brow(1, 1)]), [box(1)]).triage).toBe(false);
  });
});
