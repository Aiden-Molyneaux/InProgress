import { describe, expect, it } from 'vitest';
import type { Board, BoardRow } from '../../src/core/board';
import type { TreeNode } from '../../src/core/types';
import { PREVIEW_SIZE, backlogPhases, formatPreview, parsePreview, previewKey, previewPhase, previewRows } from '../../web/src/backlog/backlogPreview';

const phase = (id: number, title: string) => ({ id, title, kind: 'phase', parentId: 1, position: id }) as unknown as TreeNode;
const root = { id: 1, title: 'Root', kind: 'phase', parentId: null, position: 0 } as unknown as TreeNode;
const row = (id: number, crumb: TreeNode[]) => ({ node: { id, title: `Step ${id}`, kind: 'task', parentId: crumb.length ? crumb[crumb.length - 1].id : 1, position: id }, crumb });

const pa = phase(10, 'Phase A');
const pb = phase(20, 'Phase B');
const pc = phase(30, 'Phase C');
// Tree order: A, B, C.
const nodes = [root, pa, pb, pc];
const board = (backlog: ReturnType<typeof row>[], done: ReturnType<typeof row>[] = []) => ({ backlog, done }) as unknown as Pick<Board, 'backlog' | 'done'>;

describe('previewKey, parsePreview and formatPreview', () => {
  it('keeps the choice per project', () => {
    expect(previewKey(7)).toBe('ip.backlogPreview.7');
  });
  it('round-trips a phase id and No phase; anything else is no choice', () => {
    expect(parsePreview(formatPreview(10))).toBe(10);
    expect(parsePreview(formatPreview('none'))).toBe('none');
    for (const bad of [null, '', 'x', '1.5', '-3', '0']) expect(parsePreview(bad)).toBeNull();
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

describe('previewPhase', () => {
  const b = board([row(5, [pb]), row(6, [pc]), row(7, [])], [row(40, [pc])]);
  it('keeps a stored phase that has entries', () => {
    expect(previewPhase(b, nodes, 20)).toBe(20);
    expect(previewPhase(b, nodes, 'none')).toBe('none');
  });
  it('previewPhase falls back when the stored phase has no entries', () => {
    // Phase A finished (no entries): the latest completed step's phase, C, has entries.
    expect(previewPhase(b, nodes, 10)).toBe(30);
    expect(previewPhase(board([row(5, [pb]), row(6, [pc])], [row(40, [pc])]), nodes, 'none')).toBe(30);
  });
  it("with no choice, takes the latest completed step's phase, else the first phase with entries", () => {
    expect(previewPhase(b, nodes, null)).toBe(30);
    expect(previewPhase(board([row(5, [pb]), row(6, [pc])], [row(40, [pa])]), nodes, null)).toBe(20);
    expect(previewPhase(board([row(5, [pb]), row(6, [pc])]), nodes, null)).toBe(20);
  });
  it('previewPhase picks No phase when no phase has entries', () => {
    expect(previewPhase(board([row(7, [])], [row(40, [pa])]), nodes, 10)).toBe('none');
    expect(previewPhase(board([]), nodes, null)).toBe('none');
  });
  it('a latest completed step with no phase counts as No phase when that has entries', () => {
    expect(previewPhase(board([row(5, [pb]), row(7, [])], [row(40, [])]), nodes, null)).toBe('none');
  });
});

describe('previewRows', () => {
  const entry = (id: number, crumb: TreeNode[]) => ({ row: row(id, crumb) }) as unknown as { row: Pick<BoardRow, 'node' | 'crumb'> };
  it('keeps the picked phase, in the order given, and at most five', () => {
    const list = [entry(1, [pa]), entry(2, [pb]), ...[3, 4, 5, 6, 7, 8].map((i) => entry(i, [pa])), entry(9, [])];
    expect(previewRows(list, 10).map((e) => e.row.node.id)).toEqual([1, 3, 4, 5, 6]);
    expect(previewRows(list, 10)).toHaveLength(PREVIEW_SIZE);
    expect(previewRows(list, 'none').map((e) => e.row.node.id)).toEqual([9]);
    expect(previewRows(list, 20).map((e) => e.row.node.id)).toEqual([2]);
  });
});
