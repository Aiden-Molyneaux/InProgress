import { describe, expect, it } from 'vitest';
import { deriveBoard, type BoardInput } from '../../src/core/board';
import { taskBoxes } from '../../src/core/taskState';
import { ASK_TRAIL_MS, type Ask, type Project, type TreeNode } from '../../src/core/types';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const T = '2026-11-14T11:00:00.000Z';
const OLD = new Date(NOW - ASK_TRAIL_MS - 60_000).toISOString();

const node = (id: number, parentId: number | null): TreeNode => ({
  id, projectId: 1, parentId, position: id, kind: 'task', title: `S${id}`, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null, what: '', why: '', origin: 'me',
  createdAt: T, updatedAt: T, completedAt: null, driverSessionId: null, boardState: null, stateSince: null, hue: null, parkedReason: '', parkedWhere: '', parkedAt: null, rankBand: null, rank: null,
});
const project: Project = {
  id: 1, slug: 'p', name: 'P', description: '', playbook: '', status: 'active', rootNodeId: 1, createdAt: T, updatedAt: T, queue: [{ nodeId: 2, sessionId: null }],
  briefingMode: 'full', titleChannel: 'nudge', lead: 'Progresser', leadSeenAt: null, intent: '', intentUpdatedAt: null,
};
const ask = (id: number, owner: Ask['owner'], raisedAt = T): Ask => ({
  id, projectId: 1, nodeId: 2, kind: 'question', text: 'Q', sessionId: null, raisedAt, clearedAt: null, clearedBy: null, answer: '', answerDeliveredAt: null, owner, dueAt: null, answeredVia: null,
});
const input = (asks: Ask[]): BoardInput => ({ project, nodes: [node(1, null), node(2, 1)], sessions: [], pastSessions: [], resources: [], asks });

describe('a lead-owned ask on the board', () => {
  it('leaves a step with only a lead-owned ask with no waiting, no stale_ask mark and no place in needs', () => {
    const i = input([ask(1, 'lead', OLD)]);
    const row = deriveBoard(i, NOW).byId.get(2)!;
    expect(row.waiting).toEqual([]);
    expect(row.asks).toEqual([]);
    expect(row.marks).not.toContain('stale_ask');
    expect(taskBoxes(deriveBoard(i, NOW), i, NOW).needs).toEqual([]);
  });

  it("still counts Aiden's own ask on the same step", () => {
    const i = input([ask(1, 'lead', OLD), ask(2, 'aiden', OLD)]);
    const board = deriveBoard(i, NOW);
    const row = board.byId.get(2)!;
    expect(row.waiting.map((a) => a.id)).toEqual([2]);
    expect(row.marks).toContain('stale_ask');
    expect(taskBoxes(board, i, NOW).needs.map((b) => b.row?.node.id)).toEqual([2]);
  });
});
