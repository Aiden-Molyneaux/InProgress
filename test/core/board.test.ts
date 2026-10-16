import { describe, expect, it } from 'vitest';
import { deriveBoard, reconcileLine, type BoardInput } from '../../src/core/board';
import { STALL_MS, type Ask, type PastSession, type ResourceMeta, type Session, type SubagentInfo, type TreeNode } from '../../src/core/types';

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
const MINS = (m: number) => new Date(NOW - m * 60_000).toISOString();
const running = (o: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId: 'x1', agentType: 'general-purpose', startedAt: MINS(1), runStartedAt: MINS(1), description: null, model: null, nodeId: null,
  endedAt: null, ordinal: 1, purpose: null, endReason: null, lastActiveAt: null, ...o,
});
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

  it('stalled: an idle driver past 30 minutes with nothing running and no open ask', () => {
    expect(STALL_MS).toBe(30 * 60_000);
    const marksFor = (o: { driver?: Partial<Session>; node?: Partial<TreeNode>; asks?: Ask[] } = {}) => deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { status: 'active', driverSessionId: 'd', ...o.node })],
      sessions: [s('d', { focusNodeId: 2, state: 'idle', lastSeenAt: MINS(31), ...o.driver })],
      asks: o.asks ?? [],
    }), NOW).byId.get(2)?.marks;
    expect(marksFor()).toContain('stalled');
    expect(marksFor({ driver: { lastSeenAt: new Date(NOW - STALL_MS).toISOString() } })).toContain('stalled');
    expect(marksFor({ driver: { lastSeenAt: MINS(29) } })).not.toContain('stalled');
    expect(marksFor({ driver: { subagents: [running()] } })).not.toContain('stalled');
    // A reader subagent is not work: still stalled.
    expect(marksFor({ driver: { subagents: [running({ agentType: 'Explore' })] } })).toContain('stalled');
    expect(marksFor({ driver: { state: 'permission' } })).not.toContain('stalled');
    expect(marksFor({ asks: [ask(1, 2)] })).not.toContain('stalled');
    expect(marksFor({ node: { assignee: 'me' } })).not.toContain('stalled');
    expect(marksFor({ node: { status: 'todo' } })).not.toContain('stalled');
  });

  it('stalled: helpers on a step whose driver is not live', () => {
    const b = deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { status: 'active', driverSessionId: 'gone' }), n(3, 1, { status: 'active' }), n(4, 1, { status: 'active', driverSessionId: 'gone' })],
      sessions: [s('gone', { state: 'ended', endedAt: T, focusNodeId: 2 }), s('h', { focusNodeId: 2, slot: 1 }), s('k', { focusNodeId: 3, slot: 2 })],
    }), NOW);
    expect(b.byId.get(2)).toMatchObject({ driver: null, marks: ['stalled'] });
    expect(b.byId.get(3)).toMatchObject({ driver: null, marks: ['stalled'] }); // driverless
    expect(b.byId.get(4)?.marks).not.toContain('stalled'); // nobody on it
  });

  it('answer_waiting: an answered, undelivered ask', () => {
    const marksFor = (o: Partial<Ask>, kind: TreeNode['kind'] = 'task') => deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { kind })],
      asks: [ask(1, 2, { clearedAt: T, clearedBy: 'window', answer: 'land it', ...o })],
    }), NOW).byId.get(2)?.marks;
    expect(marksFor({})).toEqual(['answer_waiting']);
    expect(marksFor({ answer: '' })).toEqual([]);
    expect(marksFor({ answerDeliveredAt: T })).toEqual([]);
    expect(marksFor({}, 'question')).toEqual([]);
    // A done step has no driver to deliver to, so the mark would only sit there.
    expect(deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T, outcome: 'ok' })], asks: [ask(1, 2, { clearedAt: T, answer: 'land it' })] }), NOW).byId.get(2)?.marks).toEqual([]);
    // row.asks stays the open asks only.
    expect(deriveBoard(input({ nodes: [n(1, null), n(2, 1)], asks: [ask(1, 2, { clearedAt: T, answer: 'x' })] }), NOW).byId.get(2)?.asks).toEqual([]);
  });

  it('the driver leads row.sessions and is row.driver', () => {
    const b = deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { status: 'active', driverSessionId: 'd' })],
      sessions: [s('w', { focusNodeId: 2, slot: 0 }), s('d', { focusNodeId: 2, state: 'idle', slot: 1, lastSeenAt: MINS(5) }), s('p', { focusNodeId: 2, state: 'permission', slot: 2 })],
    }), NOW);
    const row = b.byId.get(2)!;
    expect(row.driver?.id).toBe('d');
    expect(row.sessions.map((x) => x.id)).toEqual(['d', 'w', 'p']);
    expect(row.marks).not.toContain('stalled');
    // A driver not heard from within 12 hours is not live: no driver, and the row's helper is stalled.
    const c = deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { status: 'active', driverSessionId: 'd' })],
      sessions: [s('d', { focusNodeId: 2, lastSeenAt: new Date(NOW - 13 * 3_600_000).toISOString() }), s('w', { focusNodeId: 2 })],
    }), NOW).byId.get(2)!;
    expect(c.driver).toBeNull();
    expect(c.sessions.map((x) => x.id)).toEqual(['w']);
  });
});

describe('reconcileLine', () => {
  it('prints the stalled facts, and other marks as their name', () => {
    const at = (m: number) => deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { status: 'active', driverSessionId: 'd', outcome: '' })],
      sessions: [s('d', { focusNodeId: 2, state: 'idle', slot: 7, lastSeenAt: MINS(m), branch: 'cell-form', cwd: 'C:/w/cell-form' })],
    }), NOW).byId.get(2)!;
    expect(reconcileLine(at(45), 'stalled', NOW)).toBe('#2 stalled: H idle 45m · branch cell-form · cwd C:/w/cell-form');
    expect(reconcileLine(at(119), 'stalled', NOW)).toBe('#2 stalled: H idle 119m · branch cell-form · cwd C:/w/cell-form');
    expect(reconcileLine(at(150), 'stalled', NOW)).toBe('#2 stalled: H idle 2h · branch cell-form · cwd C:/w/cell-form');
    const bare = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'active', driverSessionId: 'd' })], sessions: [s('d', { focusNodeId: 2, state: 'idle', slot: null, lastSeenAt: MINS(40) })] }), NOW).byId.get(2)!;
    expect(reconcileLine(bare, 'stalled', NOW)).toBe('#2 stalled: ? idle 40m · branch ? · cwd ?');
    const helpers = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'active' })], sessions: [s('h', { focusNodeId: 2, slot: 7 }), s('k', { focusNodeId: 2, slot: 10, state: 'idle' })] }), NOW).byId.get(2)!;
    expect(reconcileLine(helpers, 'stalled', NOW)).toBe('#2 stalled: driver not live · on it: H, K');
    expect(reconcileLine(helpers, 'deep', NOW)).toBe('#2 deep');
  });
});
