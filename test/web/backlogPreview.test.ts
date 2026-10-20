import { describe, expect, it } from 'vitest';
import type { Board, BoardRow } from '../../src/core/board';
import { deriveBoard, type BoardInput } from '../../src/core/board';
import { taskBoxes } from '../../src/core/taskState';
import type { TreeNode } from '../../src/core/types';
import { PREVIEW_SIZE, backlogPhases, formatPreview, parsePreview, phaseCounts, previewKey, previewPhase, previewRows, previewState } from '../../web/src/backlog/backlogPreview';

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

describe('phaseCounts', () => {
  const entry = (id: number, crumb: TreeNode[]) => ({ row: row(id, crumb) }) as unknown as { row: Pick<BoardRow, 'node' | 'crumb'> };
  it('counts the entries of each phase, No phase included, and leaves out a phase with none', () => {
    const list = [entry(1, [pa]), entry(2, [pb]), entry(3, [pa]), entry(4, [])];
    const counts = phaseCounts(list);
    expect(counts.get(10)).toBe(2);
    expect(counts.get(20)).toBe(1);
    expect(counts.get('none')).toBe(1);
    expect(counts.get(99)).toBeUndefined();
    expect(phaseCounts([]).size).toBe(0);
  });
});

describe('previewState', () => {
  const T = '2026-10-13T11:00:00.000Z';
  const NOW = Date.parse('2026-10-13T12:00:00.000Z');
  const n = (id: number, parentId: number | null, o: Partial<TreeNode> = {}): TreeNode =>
    ({ id, projectId: 1, parentId, position: id, kind: 'task', title: `S${id}`, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null, createdAt: T, updatedAt: T, completedAt: null, driverSessionId: null, boardState: null, stateSince: null, hue: null, parkedReason: '', parkedWhere: '', parkedAt: null, ...o }) as TreeNode;
  // Phase B holds only a step with an open question: the Board's backlog lists it, the Backlog cell (it sits in Needs me) does not.
  const input: BoardInput = {
    project: { id: 1, slug: 'p', name: 'P', description: '', playbook: '', status: 'active', rootNodeId: 1, createdAt: T, updatedAt: T, queue: [], briefingMode: 'full', titleChannel: 'nudge' },
    nodes: [n(1, null, { kind: 'phase' }), n(10, 1, { kind: 'phase' }), n(20, 1, { kind: 'phase' }), n(11, 10), n(21, 20)],
    sessions: [], pastSessions: [], resources: [],
    asks: [{ id: 1, projectId: 1, nodeId: 21, kind: 'question', text: 'Q', sessionId: null, raisedAt: T, clearedAt: null, clearedBy: null, answer: '', answerDeliveredAt: null }],
  };
  const dboard = deriveBoard(input, NOW);
  const cell = taskBoxes(dboard, input, NOW).backlog;

  it('feeds the picker and the default from the Backlog cell, like the rows and the count', () => {
    expect(dboard.backlog.map((r) => r.node.id)).toContain(21);
    expect(cell.map((b) => b.row!.node.id)).toEqual([11]);
    const { choices, phase } = previewState(cell, dboard, input.nodes, 20);
    expect(choices.map((c) => c.value)).toEqual([10, 'none']);
    // The stored phase 20 has nothing in the cell, so it falls back.
    expect(phase).toBe(10);
  });
});
