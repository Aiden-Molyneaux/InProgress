import { describe, expect, it } from 'vitest';
import { deriveBoard, type BoardInput } from '../../src/core/board';
import type { Ask, ProjectSummary, TreeNode } from '../../src/core/types';
import { askTarget, boardFigures, clockText, footerKeys, hudFigures, serverLine } from '../../web/src/chrome/hudLogic';

const project = (id: number, over: Partial<ProjectSummary> = {}) =>
  ({ id, slug: `p${id}`, name: `Project ${id}`, status: 'active', openAsks: 0, permissionWaits: 0, busySessions: 0, ...over }) as ProjectSummary;
const order = (...ids: number[]) => ids.map((id) => ({ slug: `p${id}` }));

describe('hudFigures', () => {
  it('sums asks and permission waits, and busy sessions, over the active projects', () => {
    const f = hudFigures([project(1, { openAsks: 2, permissionWaits: 1, busySessions: 1 }), project(2, { openAsks: 1, busySessions: 2 })], order(1, 2));
    expect([f.asks, f.live]).toEqual([4, 3]);
  });

  it('leaves archived projects out of both figures and both titles', () => {
    const f = hudFigures([project(1, { openAsks: 1, busySessions: 1 }), project(2, { status: 'archived', openAsks: 5, busySessions: 5 })], order(1, 2));
    expect([f.asks, f.live]).toEqual([1, 1]);
    expect(f.asksTitle).toBe('Project 1: 1');
    expect(f.liveTitle).toBe('Project 1: 1');
  });

  it('lists one line per project with something, in tab order and not list order', () => {
    const f = hudFigures([project(1, { openAsks: 1 }), project(2), project(3, { permissionWaits: 2 })], order(3, 2, 1));
    expect(f.asksTitle).toBe('Project 3: 2\nProject 1: 1');
  });

  it('puts a project the order does not name after the others', () => {
    const f = hudFigures([project(9, { openAsks: 1 }), project(1, { openAsks: 1 })], order(1));
    expect(f.asksTitle).toBe('Project 1: 1\nProject 9: 1');
  });

  it('says so when nothing waits and nothing works', () => {
    const f = hudFigures([project(1)], order(1));
    expect([f.asks, f.live, f.asksTitle, f.liveTitle]).toEqual([0, 0, 'Nothing waits on you', 'No sessions working']);
    expect(hudFigures([], []).asksTitle).toBe('Nothing waits on you');
  });
});

describe('askTarget', () => {
  it("is 'here' when the open tab has asks, even with an earlier tab that has some", () => {
    expect(askTarget([project(1, { openAsks: 1 }), project(2, { permissionWaits: 1 })], 'p2')).toBe('here');
  });

  it('is the first active tab with asks when the open one has none', () => {
    expect(askTarget([project(1), project(2, { openAsks: 1 }), project(3, { openAsks: 4 })], 'p1')).toBe('p2');
  });

  it('skips an archived tab, even the open one', () => {
    const tabs = [project(1, { status: 'archived', openAsks: 3 }), project(2, { openAsks: 1 })];
    expect(askTarget(tabs, 'p1')).toBe('p2');
  });

  it('is null when nothing waits', () => {
    expect(askTarget([project(1), project(2)], 'p1')).toBeNull();
    expect(askTarget([], null)).toBeNull();
  });
});

describe('boardFigures', () => {
  const T = '2026-10-13T11:00:00.000Z';
  const NOW = Date.parse('2026-10-13T12:00:00.000Z');
  const node = (id: number, parentId: number | null): TreeNode => ({
    id, projectId: 1, parentId, position: id, kind: 'task', title: `S${id}`, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null,
    createdAt: T, updatedAt: T, completedAt: null, driverSessionId: null, boardState: null, stateSince: null, hue: null, parkedReason: '', parkedWhere: '', parkedAt: null,
  });
  const ask = (nodeId: number): Ask => ({ id: nodeId, projectId: 1, nodeId, kind: 'question', text: 'Q', sessionId: null, raisedAt: T, clearedAt: null, clearedBy: null, answer: '', answerDeliveredAt: null });
  const input = (queue: number[], asks: Ask[]): BoardInput => ({
    project: { id: 1, slug: 'p', name: 'P', description: '', playbook: '', status: 'active', rootNodeId: 1, createdAt: T, updatedAt: T, queue: queue.map((nodeId) => ({ nodeId, sessionId: null })), briefingMode: 'full' },
    nodes: [node(1, null), node(2, 1), node(3, 1), node(4, 1), node(5, 1)], sessions: [], pastSessions: [], resources: [], asks,
  });

  it('counts the queued steps nothing blocks as ready, and the Backlog cell as the backlog', () => {
    const i = input([2], []);
    expect(boardFigures(deriveBoard(i, NOW), i, NOW)).toEqual({ ready: 1, backlog: 3 });
  });

  it('leaves a queued step with an open ask out of ready, and a step with an ask out of the backlog', () => {
    const i = input([2, 3], [ask(3), ask(4)]);
    expect(boardFigures(deriveBoard(i, NOW), i, NOW)).toEqual({ ready: 1, backlog: 1 });
  });
});

describe('clockText', () => {
  it('writes local time on 24 hours and the date with the short month', () => {
    expect(clockText(new Date(2026, 9, 19, 9, 5))).toEqual({ time: '09:05', date: 'Oct 19, 2026' });
    expect(clockText(new Date(2026, 9, 19, 0, 7)).time).toBe('00:07');
    expect(clockText(new Date(2026, 0, 3, 23, 59))).toEqual({ time: '23:59', date: 'Jan 3, 2026' });
  });
});

describe('serverLine', () => {
  it('names the host and the build in capitals', () => {
    expect(serverLine('localhost:4317', { sha: '8b796d9', dirty: false, builtAt: '2026-10-19T10:00:00Z' })).toBe('LOCALHOST:4317 · BUILD 8b796d9');
  });

  it('adds +DIRTY to a dirty build', () => {
    expect(serverLine('localhost:4317', { sha: '8b796d9', dirty: true, builtAt: 'x' })).toBe('LOCALHOST:4317 · BUILD 8b796d9+DIRTY');
  });

  it('is the host alone with no build', () => {
    expect(serverLine('localhost:4317', null)).toBe('LOCALHOST:4317');
  });
});

describe('footerKeys', () => {
  it('always has Find', () => {
    expect(footerKeys({ tabs: 0, escapable: false })).toEqual([{ keys: ['Ctrl K'], label: 'Find' }]);
  });

  it('adds Projects from two tabs and Close while something can close', () => {
    expect(footerKeys({ tabs: 1, escapable: false }).map((k) => k.label)).toEqual(['Find']);
    expect(footerKeys({ tabs: 2, escapable: false }).map((k) => k.label)).toEqual(['Find', 'Projects']);
    expect(footerKeys({ tabs: 3, escapable: true }).map((k) => k.label)).toEqual(['Find', 'Projects', 'Close']);
  });
});
