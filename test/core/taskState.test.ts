import { describe, expect, it } from 'vitest';
import { deriveBoard, type BoardInput } from '../../src/core/board';
import { COLOURED, HUES, sinceFallback, TASK_STATES, taskBoxes, taskStateOf, type TaskCell, type TaskState } from '../../src/core/taskState';
import { STALE_SESSION_MS, TRAIL_MS, type Ask, type PastSession, type Session, type TreeNode } from '../../src/core/types';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const T = '2026-10-13T11:00:00.000Z';
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function n(id: number, parentId: number | null, o: Partial<TreeNode> = {}): TreeNode {
  return { id, projectId: 1, parentId, position: id, kind: 'task', title: `S${id}`, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null, createdAt: T, updatedAt: T, completedAt: null, driverSessionId: null, boardState: null, stateSince: null, hue: null, parkedReason: '', parkedWhere: '', parkedAt: null, ...o };
}
function s(id: string, o: Partial<Session> = {}): Session {
  return { id, projectId: 1, title: id, cwd: null, branch: null, transcriptPath: null, state: 'working', focusNodeId: null, promptsSinceUpdate: 0, startedAt: T, lastSeenAt: T, lastPromptAt: null, endedAt: null, slot: 0, subagents: [], commands: [], role: 'worker', ...o };
}
function ask(id: number, nodeId: number, o: Partial<Ask> = {}): Ask {
  return { id, projectId: 1, nodeId, kind: 'question', text: 'Q', sessionId: null, raisedAt: T, clearedAt: null, clearedBy: null, answer: '', answerDeliveredAt: null, ...o };
}
function past(id: string, focusNodeId: number, endedAt: string): PastSession {
  return { id, title: null, focusNodeId, startedAt: ago(TRAIL_MS * 2), endedAt };
}
function input(o: Partial<BoardInput> & { queue?: { nodeId: number; sessionId: string | null }[] }): BoardInput {
  return {
    project: { id: 1, slug: 'p', name: 'P', description: '', playbook: '', status: 'active', rootNodeId: 1, createdAt: T, updatedAt: T, queue: o.queue ?? [], briefingMode: 'full' },
    nodes: o.nodes ?? [n(1, null)], sessions: o.sessions ?? [], pastSessions: o.pastSessions ?? [], resources: o.resources ?? [], asks: o.asks ?? [],
  };
}
/** The state of step 2 (child of the root) in a snapshot. */
function stateOf2(i: BoardInput): TaskState {
  return taskStateOf(deriveBoard(i, NOW).byId.get(2)!, i, NOW);
}

describe('constants', () => {
  it('colours every state but backlog and done; seven hues', () => {
    expect([...COLOURED].sort()).toEqual(TASK_STATES.filter((x) => x !== 'backlog' && x !== 'done').sort());
    expect(HUES).toBe(7);
  });
});

describe('taskStateOf precedence', () => {
  const q = { nodeId: 2, sessionId: null };
  const cases: [string, Partial<BoardInput> & { queue?: { nodeId: number; sessionId: string | null }[] }, Partial<TreeNode>, TaskState][] = [
    ['permission session beats an open question', { sessions: [s('a', { focusNodeId: 2, state: 'permission' })], asks: [ask(1, 2)] }, {}, 'permission'],
    ['permission ask beats a working session', { sessions: [s('a', { focusNodeId: 2 })], asks: [ask(1, 2, { kind: 'permission' })] }, {}, 'permission'],
    ['oldest open ask decides question vs review', { asks: [ask(1, 2, { kind: 'review', raisedAt: ago(10 * MIN) }), ask(2, 2, { kind: 'question', raisedAt: ago(MIN) })] }, {}, 'review'],
    ['question beats done', { asks: [ask(1, 2)] }, { status: 'done', completedAt: T }, 'question'],
    ['done beats working', { sessions: [s('a', { focusNodeId: 2 })] }, { status: 'done', completedAt: T }, 'done'],
    ['working beats blocked', { sessions: [s('a', { focusNodeId: 2 })] }, { status: 'blocked' }, 'working'],
    ['blocked beats idle', { sessions: [s('a', { focusNodeId: 2, state: 'idle' })] }, { status: 'blocked' }, 'blocked'],
    ['idle beats unattended', { sessions: [s('a', { focusNodeId: 2, state: 'idle' })] }, { status: 'active', assignee: 'me' }, 'idle'],
    ['unattended beats ready', { queue: [q] }, { status: 'active', assignee: 'me' }, 'unattended'],
    ['ready in Next', { queue: [q] }, {}, 'ready'],
    ['backlog otherwise', {}, {}, 'backlog'],
    ['blocked in Next is blocked, not ready', { queue: [q] }, { status: 'blocked' }, 'blocked'],
  ];
  it.each(cases)('%s', (_name, o, node, want) => {
    expect(stateOf2(input({ ...o, nodes: [n(1, null), n(2, 1, node)] }))).toBe(want);
  });
});

describe('unattended', () => {
  const active = { status: 'active' as const };
  it('an active step assigned to me', () => {
    expect(stateOf2(input({ nodes: [n(1, null), n(2, 1, { ...active, assignee: 'me' })] }))).toBe('unattended');
  });
  it('an active step whose last session ended within TRAIL_MS', () => {
    expect(stateOf2(input({ nodes: [n(1, null), n(2, 1, active)], pastSessions: [past('p', 2, ago(TRAIL_MS - MIN))] }))).toBe('unattended');
  });
  it('an older one is not unattended', () => {
    expect(stateOf2(input({ nodes: [n(1, null), n(2, 1, active)], pastSessions: [past('p', 2, ago(TRAIL_MS + MIN))] }))).toBe('backlog');
  });
  it('uses the newest past session', () => {
    const pastSessions = [past('old', 2, ago(TRAIL_MS + MIN)), past('new', 2, ago(MIN))];
    expect(stateOf2(input({ nodes: [n(1, null), n(2, 1, active)], pastSessions }))).toBe('unattended');
  });
  it('a todo step with a recent past session is not unattended', () => {
    expect(stateOf2(input({ nodes: [n(1, null), n(2, 1)], pastSessions: [past('p', 2, ago(MIN))] }))).toBe('backlog');
  });
});

describe('taskBoxes', () => {
  const cells = (b: Record<TaskCell, { row: { node: { id: number } } | null }[]>, c: TaskCell) => b[c].map((x) => x.row?.node.id ?? null);

  it('puts each task in exactly one cell, in each cell\'s order', () => {
    const i = input({
      nodes: [n(1, null), n(2, 1), n(3, 1), n(4, 1, { status: 'done', completedAt: T }), n(5, 1), n(6, 1, { status: 'active', assignee: 'me' }), n(7, 1, { status: 'active' }), n(8, 1, { status: 'blocked' }), n(9, 1)],
      sessions: [s('w', { focusNodeId: 5 })],
      queue: [{ nodeId: 3, sessionId: null }, { nodeId: 2, sessionId: null }],
      asks: [ask(1, 9)],
      pastSessions: [past('p', 7, ago(MIN))],
    });
    const b = taskBoxes(deriveBoard(i, NOW), i, NOW);
    expect(cells(b, 'needs')).toEqual([9]);
    expect(cells(b, 'next')).toEqual([3, 2]);
    // board.now in tree order (5, 6), then the unattended row that came from Backlog (7).
    expect(cells(b, 'now')).toEqual([5, 6, 7]);
    expect(cells(b, 'done')).toEqual([4]);
    expect(cells(b, 'backlog')).toEqual([8]);
    const all = Object.values(b).flat().map((x) => x.row!.node.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(b.now.map((x) => x.state)).toEqual(['working', 'unattended', 'unattended']);
    expect(b.backlog[0].state).toBe('blocked');
  });

  it('a blocked step stays in Next, Now or Backlog as deriveBoard placed it', () => {
    const i = input({
      nodes: [n(1, null), n(2, 1, { status: 'blocked' }), n(3, 1, { status: 'blocked' }), n(4, 1, { status: 'blocked' })],
      queue: [{ nodeId: 2, sessionId: null }],
      sessions: [s('a', { focusNodeId: 3, state: 'idle' })],
    });
    const b = taskBoxes(deriveBoard(i, NOW), i, NOW);
    expect(cells(b, 'next')).toEqual([2]);
    expect(cells(b, 'now')).toEqual([3]);
    expect(cells(b, 'backlog')).toEqual([4]);
    expect([b.next[0].state, b.now[0].state, b.backlog[0].state]).toEqual(['blocked', 'blocked', 'blocked']);
  });

  it('orders Needs me by the oldest open need, then id', () => {
    const i = input({
      nodes: [n(1, null), n(2, 1), n(3, 1), n(4, 1), n(5, 1)],
      asks: [ask(1, 2, { raisedAt: ago(5 * MIN) }), ask(2, 3, { raisedAt: ago(20 * MIN) }), ask(3, 4, { raisedAt: ago(5 * MIN) }), ask(4, 5, { raisedAt: ago(MIN) }), ask(5, 5, { raisedAt: ago(30 * MIN) })],
    });
    const b = taskBoxes(deriveBoard(i, NOW), i, NOW);
    expect(cells(b, 'needs')).toEqual([5, 3, 2, 4]);
  });

  it('a permission session without an ask uses its lastSeenAt and fills TaskBox.session', () => {
    const w = s('w', { focusNodeId: 3, state: 'permission', lastSeenAt: ago(MIN) });
    const i = input({ nodes: [n(1, null), n(2, 1), n(3, 1)], sessions: [w, s('x', { focusNodeId: 3, state: 'working' })], asks: [ask(1, 2, { raisedAt: ago(5 * MIN) })] });
    const b = taskBoxes(deriveBoard(i, NOW), i, NOW);
    expect(cells(b, 'needs')).toEqual([2, 3]);
    expect(b.needs[0].session).toBeNull();
    expect(b.needs[1]).toMatchObject({ state: 'permission', session: { id: 'w' } });
  });

  it('a focusless permission wait is a box with no row, after rows of equal time', () => {
    const t = ago(5 * MIN);
    const i = input({
      nodes: [n(1, null), n(2, 1)],
      sessions: [s('zz', { state: 'permission', lastSeenAt: t }), s('aa', { state: 'permission', lastSeenAt: t }), s('idle', { state: 'idle' }), s('stale', { state: 'permission', lastSeenAt: ago(3 * 24 * 60 * MIN) })],
      asks: [ask(1, 2, { raisedAt: t })],
    });
    const b = taskBoxes(deriveBoard(i, NOW), i, NOW);
    expect(b.needs.map((x) => (x.row ? x.row.node.id : x.session!.id))).toEqual([2, 'aa', 'zz']);
    expect(b.needs[1]).toMatchObject({ row: null, cell: 'needs', state: 'permission' });
  });

  it('a done step with a review ask is in Needs me only', () => {
    const i = input({ nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T })], asks: [ask(1, 2, { kind: 'review' })] });
    const b = taskBoxes(deriveBoard(i, NOW), i, NOW);
    expect(cells(b, 'needs')).toEqual([2]);
    expect(b.done).toEqual([]);
    expect(b.needs[0].state).toBe('review');
  });

  it('Done keeps deriveBoard order (newest first)', () => {
    const i = input({ nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: ago(2 * MIN) }), n(3, 1, { status: 'done', completedAt: ago(MIN) })] });
    const b = taskBoxes(deriveBoard(i, NOW), i, NOW);
    expect(cells(b, 'done')).toEqual([3, 2]);
  });
});

describe('sinceFallback', () => {
  const node = n(2, 1, { updatedAt: ago(10 * MIN), completedAt: ago(5 * MIN) });
  const asks = [ask(1, 2, { raisedAt: ago(30 * MIN) }), ask(2, 2, { raisedAt: ago(20 * MIN) })];
  it('takes completedAt for done, updatedAt when it has none', () => {
    expect(sinceFallback(node, 'done', [])).toBe(ago(5 * MIN));
    expect(sinceFallback({ ...node, completedAt: null }, 'done', [])).toBe(ago(10 * MIN));
  });
  it('takes the oldest open ask for an ask state, updatedAt when there is none', () => {
    for (const st of ['question', 'review', 'permission'] as const) expect(sinceFallback(node, st, asks)).toBe(ago(30 * MIN));
    expect(sinceFallback(node, 'permission', [])).toBe(ago(10 * MIN));
  });
  it('takes updatedAt for every other state, even with asks', () => {
    for (const st of ['backlog', 'ready', 'working', 'idle', 'unattended', 'blocked'] as const) expect(sinceFallback(node, st, asks)).toBe(ago(10 * MIN));
  });
});

describe('taskBoxes with shelved steps', () => {
  it('a permission session focused on a shelved step still gets a Needs me box, as a focusless one does', () => {
    const w = s('w', { focusNodeId: 3, state: 'permission', lastSeenAt: ago(MIN) });
    const i = input({ nodes: [n(1, null), n(2, 1, { status: 'parked' }), n(3, 2)], sessions: [w] });
    const b = taskBoxes(deriveBoard(i, NOW), i, NOW);
    expect(b.needs).toHaveLength(1);
    expect(b.needs[0]).toMatchObject({ row: null, state: 'permission', session: { id: 'w' } });
  });
});

describe('answered in chat (#522)', () => {
  const RAISED = ago(30 * MIN);
  const BEFORE = ago(40 * MIN);
  const AFTER = ago(10 * MIN);
  const nodes = [n(1, null), n(2, 1, { status: 'active', driverSessionId: 'd' })];
  /** Step 2, with an ask a1 raised by `by` at RAISED, a driver d and `others` as the rest of the sessions. */
  const row = (sessions: Session[], asks: Ask[] = [ask(1, 2, { sessionId: 'r', raisedAt: RAISED })]) => {
    const i = input({ nodes, sessions, asks });
    const board = deriveBoard(i, NOW);
    return { i, r: board.byId.get(2)!, box: taskBoxes(board, i, NOW) };
  };
  const cellOf2 = (x: ReturnType<typeof row>) => (['needs', 'now', 'next', 'done', 'backlog'] as const).find((c) => x.box[c].some((b) => b.row?.node.id === 2));

  it('C1: a live working raiser that got a prompt after the raise: Now, marked, the ask still open', () => {
    const x = row([s('r', { focusNodeId: 2, lastPromptAt: AFTER })]);
    expect(stateOf2(x.i)).toBe('working');
    expect(cellOf2(x)).toBe('now');
    expect(x.r.marks).toContain('answered_in_chat');
    expect(x.r.asks).toHaveLength(1);
    expect(x.r.waiting).toEqual([]);
  });

  it('C1: the same with the raiser idle', () => {
    const x = row([s('r', { focusNodeId: 2, state: 'idle', lastPromptAt: AFTER })]);
    expect(stateOf2(x.i)).toBe('idle');
    expect(cellOf2(x)).toBe('now');
    expect(x.r.marks).toContain('answered_in_chat');
  });

  it('a prompt before the raise, or none: Needs me, no mark', () => {
    for (const lastPromptAt of [BEFORE, null]) {
      const x = row([s('r', { focusNodeId: 2, lastPromptAt })]);
      expect(cellOf2(x)).toBe('needs');
      expect(x.r.marks).not.toContain('answered_in_chat');
      expect(x.r.waiting).toHaveLength(1);
    }
  });

  it('C2: a second ask raised after the prompt returns the step to Needs me', () => {
    const x = row([s('r', { focusNodeId: 2, lastPromptAt: AFTER })], [ask(1, 2, { sessionId: 'r', raisedAt: RAISED }), ask(2, 2, { kind: 'review', sessionId: 'r', raisedAt: ago(5 * MIN) })]);
    expect(cellOf2(x)).toBe('needs');
    expect(stateOf2(x.i)).toBe('review');
    expect(x.r.marks).toContain('answered_in_chat');
    expect(x.r.waiting.map((a) => a.id)).toEqual([2]);
  });

  it('C3: the raiser ended and the live driver got a prompt after the raise: Now', () => {
    const x = row([s('r', { state: 'ended', endedAt: T }), s('d', { focusNodeId: 2, state: 'idle', lastPromptAt: AFTER })]);
    expect(cellOf2(x)).toBe('now');
    expect(x.r.marks).toContain('answered_in_chat');
  });

  it('C3: the driver prompted before the raise, or no live driver: Needs me', () => {
    expect(cellOf2(row([s('r', { state: 'ended', endedAt: T }), s('d', { focusNodeId: 2, state: 'idle', lastPromptAt: BEFORE })]))).toBe('needs');
    expect(cellOf2(row([s('r', { state: 'ended', endedAt: T }), s('d', { state: 'ended', endedAt: T, focusNodeId: 2, lastPromptAt: AFTER })]))).toBe('needs');
    expect(cellOf2(row([s('r', { state: 'ended', endedAt: T })]))).toBe('needs');
  });

  it('C3: a stale raiser counts as gone, so a prompted driver decides', () => {
    const stale = ago(STALE_SESSION_MS + MIN);
    const x = row([s('r', { focusNodeId: 2, state: 'idle', lastSeenAt: stale, lastPromptAt: BEFORE }), s('d', { focusNodeId: 2, state: 'idle', lastPromptAt: AFTER })]);
    expect(cellOf2(x)).toBe('now');
  });

  it('a live raiser decides over the driver: its own old prompt keeps the step in Needs me', () => {
    const x = row([s('r', { focusNodeId: 2, state: 'idle', lastPromptAt: BEFORE }), s('d', { focusNodeId: 2, state: 'idle', lastPromptAt: AFTER })]);
    expect(cellOf2(x)).toBe('needs');
  });

  it('an ask with no session (the window, a migrated one) never counts', () => {
    const x = row([s('r', { focusNodeId: 2, lastPromptAt: AFTER }), s('d', { focusNodeId: 2, lastPromptAt: AFTER })], [ask(1, 2, { sessionId: null, raisedAt: RAISED })]);
    expect(cellOf2(x)).toBe('needs');
    expect(x.r.marks).not.toContain('answered_in_chat');
  });

  it('a session in permission state on the row still shows permission', () => {
    const x = row([s('r', { focusNodeId: 2, state: 'permission', lastPromptAt: AFTER })]);
    expect(stateOf2(x.i)).toBe('permission');
    expect(cellOf2(x)).toBe('needs');
  });

  it('C5: a cleared ask carries no mark', () => {
    const x = row([s('r', { focusNodeId: 2, lastPromptAt: AFTER })], [ask(1, 2, { sessionId: 'r', raisedAt: RAISED, clearedAt: AFTER, answer: 'yes' })]);
    expect(x.r.marks).not.toContain('answered_in_chat');
    expect(x.r.asks).toEqual([]);
  });

  it('the Needs me time and the since fallback read the waiting asks only', () => {
    const x = row([s('r', { focusNodeId: 2, lastPromptAt: AFTER })], [ask(1, 2, { sessionId: 'r', raisedAt: RAISED }), ask(2, 2, { sessionId: null, raisedAt: ago(5 * MIN) })]);
    expect(x.r.waiting.map((a) => a.id)).toEqual([2]);
    expect(sinceFallback(x.r.node, 'question', x.r.waiting)).toBe(ago(5 * MIN));
  });
});
