import { describe, expect, it } from 'vitest';
import { deriveBoard, type BoardInput } from '../../src/core/board';
import type { Ask, PastSession, ResourceMeta, Session, TreeNode } from '../../src/core/types';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const T = '2026-10-13T11:00:00.000Z';
const DAYS = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function n(id: number, parentId: number | null, o: Partial<TreeNode> = {}): TreeNode {
  return { id, projectId: 1, parentId, position: id, kind: 'task', title: `S${id}`, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null, createdAt: T, updatedAt: T, completedAt: null, driverSessionId: null, ...o };
}
function s(id: string, o: Partial<Session> = {}): Session {
  return { id, projectId: 1, title: id, cwd: null, branch: null, transcriptPath: null, state: 'working', focusNodeId: null, promptsSinceUpdate: 0, startedAt: T, lastSeenAt: T, endedAt: null, slot: 0, subagents: [], commands: [], role: 'worker', ...o };
}
function ask(id: number, nodeId: number, o: Partial<Ask> = {}): Ask {
  return { id, projectId: 1, nodeId, kind: 'question', text: 'Q', sessionId: null, raisedAt: T, clearedAt: null, clearedBy: null, answer: '', answerDeliveredAt: null, ...o };
}
function input(o: Partial<BoardInput> & { queue?: { nodeId: number; sessionId: string | null }[] }): BoardInput {
  return {
    project: { id: 1, slug: 'p', name: 'P', description: '', playbook: '', status: 'active', rootNodeId: 1, createdAt: T, updatedAt: T, queue: o.queue ?? [], briefingMode: 'full' },
    nodes: o.nodes ?? [n(1, null)], sessions: o.sessions ?? [], pastSessions: o.pastSessions ?? [], resources: o.resources ?? [], asks: o.asks ?? [],
  };
}
const col = (b: ReturnType<typeof deriveBoard>, id: number) => b.byId.get(id)?.column;

describe('deriveBoard', () => {
  it('places by the rules, first match wins', () => {
    const b = deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T }), n(3, 1, { status: 'dropped' }), n(4, 1), n(5, 1), n(6, 1), n(7, 1, { assignee: 'me', status: 'active' })],
      sessions: [s('a', { focusNodeId: 4 })],
      queue: [{ nodeId: 5, sessionId: null }],
    }), NOW);
    expect([col(b, 1), col(b, 2), col(b, 3), col(b, 4), col(b, 5), col(b, 6), col(b, 7)]).toEqual([undefined, 'done', undefined, 'now', 'next', 'backlog', 'now']);
  });

  it('done but still queued is Done; the queue entry is not a Next row', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T })], queue: [{ nodeId: 2, sessionId: null }] }), NOW);
    expect(col(b, 2)).toBe('done');
    expect(b.next).toEqual([]);
  });

  it('two sessions on one step: one Now row, working before idle', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1)], sessions: [s('i', { focusNodeId: 2, state: 'idle', slot: 0 }), s('w', { focusNodeId: 2, state: 'working', slot: 1 })] }), NOW);
    expect(b.now).toHaveLength(1);
    expect(b.now[0].sessions.map((x) => x.id)).toEqual(['w', 'i']);
  });

  it('an open ask and no session: Next or Backlog, not ready in Next', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1), n(3, 1)], queue: [{ nodeId: 2, sessionId: null }], asks: [ask(1, 2), ask(2, 3)] }), NOW);
    expect(b.byId.get(2)).toMatchObject({ column: 'next', ready: false });
    expect(b.byId.get(3)).toMatchObject({ column: 'backlog', ready: false });
  });

  it('a live focus on a done step: Done with done_focus', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T, outcome: 'ok' })], sessions: [s('a', { focusNodeId: 2 })] }), NOW);
    expect(b.byId.get(2)).toMatchObject({ column: 'done', marks: ['done_focus'] });
  });

  it('ended_open: a step its last session left open without a newer handoff', () => {
    const past: PastSession[] = [{ id: 'old', title: null, focusNodeId: 2, startedAt: DAYS(2), endedAt: DAYS(1) }];
    const left = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'active' })], pastSessions: past }), NOW);
    expect(left.byId.get(2)).toMatchObject({ column: 'backlog', marks: ['ended_open'] });
    const handoff: ResourceMeta = { id: 9, projectId: 1, nodeId: 2, kind: 'doc', title: 'h', path: null, url: null, contentLength: 1, sessionId: 'old', createdAt: DAYS(1.5), updatedAt: DAYS(1.5), purpose: 'handoff' };
    const clean = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'active' })], pastSessions: past, resources: [handoff] }), NOW);
    expect(clean.byId.get(2)?.marks).toEqual([]);
    expect(clean.byId.get(2)?.handoff?.id).toBe(9);
  });

  it('ended_open never on a Now row, and not past the trail', () => {
    const past: PastSession[] = [{ id: 'old', title: null, focusNodeId: 2, startedAt: DAYS(9), endedAt: DAYS(8) }];
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'active' }), n(3, 1)], pastSessions: [...past, { id: 'o2', title: null, focusNodeId: 3, startedAt: DAYS(2), endedAt: DAYS(1) }], sessions: [s('a', { focusNodeId: 3 })] }), NOW);
    expect(b.byId.get(2)?.marks).toEqual([]);
    expect(b.byId.get(3)).toMatchObject({ column: 'now', marks: [] });
  });

  it('no_outcome, stale_ask and deep', () => {
    const b = deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T }), n(3, 1), n(4, 3), n(5, 4), n(6, 5), n(7, 6)],
      asks: [ask(1, 3, { raisedAt: DAYS(8) })],
    }), NOW);
    expect(b.byId.get(2)?.marks).toEqual(['no_outcome']);
    expect(b.byId.get(6)?.marks ?? []).toEqual([]); // depth 4 but a group (open child 7)
    expect(b.byId.get(7)?.marks).toEqual(['deep']); // depth 5
    expect(b.groups.has(3)).toBe(true);
    // node 3 is a group, so its stale ask shows on no row; a stale ask on a row:
    const c = deriveBoard(input({ nodes: [n(1, null), n(2, 1)], asks: [ask(1, 2, { raisedAt: DAYS(8) })] }), NOW);
    expect(c.byId.get(2)?.marks).toEqual(['stale_ask']);
  });

  it('stale_ask also marks a Done row with an old open review ask', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T, outcome: 'ok' })], asks: [ask(1, 2, { kind: 'review', raisedAt: DAYS(10) })] }), NOW);
    expect(b.byId.get(2)).toMatchObject({ column: 'done', marks: ['stale_ask'] });
  });

  it('a session not heard from within 12 hours is not live', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1)], sessions: [s('old', { focusNodeId: 2, lastSeenAt: new Date(NOW - 13 * 3_600_000).toISOString() })] }), NOW);
    expect(b.byId.get(2)).toMatchObject({ column: 'backlog', sessions: [] });
  });

  it('a group with all children done falls to Backlog; a queued group is a Next row', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1), n(3, 2, { status: 'done', completedAt: T }), n(4, 1), n(5, 4)], queue: [{ nodeId: 4, sessionId: null }] }), NOW);
    expect(col(b, 2)).toBe('backlog');
    expect(col(b, 4)).toBe('next');
  });

  it('orders Next: unowned by queue number, then live owners; ignores an ended owner', () => {
    const b = deriveBoard(input({
      nodes: [n(1, null), n(2, 1), n(3, 1), n(4, 1), n(5, 1)],
      sessions: [s('a', { slot: 0 }), s('gone', { slot: 1, state: 'ended', endedAt: T })],
      queue: [{ nodeId: 4, sessionId: 'a' }, { nodeId: 5, sessionId: 'gone' }, { nodeId: 3, sessionId: null }, { nodeId: 2, sessionId: null }],
    }), NOW);
    expect(b.next.map((r) => [r.node.id, r.queueNumber, r.owner?.id ?? null])).toEqual([[3, 1, null], [2, 2, null], [4, null, 'a']]);
    expect(col(b, 5)).toBe('backlog');
  });

  it('done rows newest first; crumb is the ancestors below the root', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1), n(3, 2, { status: 'done', completedAt: DAYS(2) }), n(4, 2, { status: 'done', completedAt: DAYS(1) }), n(5, 2)] }), NOW);
    expect(b.done.map((r) => r.node.id)).toEqual([4, 3]);
    expect(b.byId.get(5)?.crumb.map((c) => c.id)).toEqual([2]);
  });
});
