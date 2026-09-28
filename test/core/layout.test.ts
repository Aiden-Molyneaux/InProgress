import { describe, expect, it } from 'vitest';
import { BADGE_ROW, INDENT, ROW, eventTarget, findFrontier, layoutOutline, needsYouOrder } from '../../src/core/layout';
import type { EventRow, ResourceMeta, Session, TreeNode } from '../../src/core/types';

let nextId = 1;
function n(parentId: number | null, title: string, extra: Partial<TreeNode> = {}): TreeNode {
  const id = nextId++;
  return { id, projectId: 1, parentId, position: id, kind: parentId === null ? 'goal' : 'task', title, body: '', status: 'todo', assignee: 'claude', outcome: '', createdAt: 't', updatedAt: `2026-09-27T00:00:${String(id).padStart(2, '0')}Z`, completedAt: null, ...extra };
}
function session(id: string, focusNodeId: number | null, state: Session['state'], lastSeenAt = '2026-09-27T01:00:00Z'): Session {
  return { id, projectId: 1, title: id, cwd: null, branch: null, transcriptPath: null, state, focusNodeId, promptsSinceUpdate: 0, startedAt: 't', lastSeenAt, endedAt: null, subagents: [] };
}
const resource = (id: number, nodeId: number): ResourceMeta => ({ id, projectId: 1, nodeId, kind: 'doc', title: `R${id}`, path: null, url: null, contentLength: 1, sessionId: null, createdAt: 't', updatedAt: 't' });

function sample() {
  nextId = 1;
  const root = n(null, 'Root', { status: 'active' });
  const a = n(root.id, 'A', { status: 'active' });
  const a1 = n(a.id, 'A1', { status: 'active' });
  const a2 = n(a.id, 'A2', { assignee: 'me' });
  const b = n(root.id, 'B');
  const c = n(root.id, 'C');
  const d = n(root.id, 'D');
  const e = n(root.id, 'E');
  return { nodes: [root, a, a1, a2, b, c, d, e], root, a, a1, a2, b, c, d, e };
}

describe('layoutOutline', () => {
  it('stacks rows downward and indents by depth', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    const rows = l.items.map((i) => (i.kind === 'node' ? [i.id, i.x, i.y] : [i.id, i.x, i.y]));
    expect(rows).toEqual([
      [`n${t.root.id}`, 0, 0], [`n${t.a.id}`, INDENT, ROW], [`n${t.a1.id}`, 2 * INDENT, 2 * ROW], [`n${t.a2.id}`, 2 * INDENT, 3 * ROW],
      [`n${t.b.id}`, INDENT, 4 * ROW], [`n${t.c.id}`, INDENT, 5 * ROW], [`more${t.root.id}-0`, INDENT, 6 * ROW],
    ]);
    expect(l.edges).toContainEqual({ id: `e-more${t.root.id}-0`, source: `n${t.root.id}`, target: `more${t.root.id}-0` });
    expect(l.edges).toContainEqual({ id: `e-n${t.a1.id}`, source: `n${t.a.id}`, target: `n${t.a1.id}` });
    expect(l.height).toBe(7 * ROW);
  });

  it('adds a badge row under a focused node and marks the working chain', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [resource(9, t.a2.id)], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.b.id, 'ended')] });
    const badge = l.items.find((i) => i.kind === 'badge')!;
    expect(badge).toMatchObject({ id: 'bs1', sessionId: 's1', nodeId: t.a1.id, x: 3 * INDENT, y: 3 * ROW });
    expect(l.nodeItems.get(t.a2.id)).toMatchObject({ y: 3 * ROW + BADGE_ROW, needsYou: true, resourceIds: [9] });
    expect(l.nodeItems.get(t.a.id)?.working).toBe(true);
    expect(l.nodeItems.get(t.b.id)?.working).toBe(false);
    expect(l.items.filter((i) => i.kind === 'badge')).toHaveLength(1);
  });

  it('reports folded done counts and progress', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.a.id || x.id === t.a1.id ? { ...x, status: 'done' as const } : x.id === t.a2.id ? { ...x, assignee: 'claude' as const, status: 'done' as const } : x));
    const l = layoutOutline({ nodes, resources: [], sessions: [] });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ folded: true, doneCount: 2, progress: { done: 2, total: 2 } });
    expect(l.nodeItems.has(t.a1.id)).toBe(false);
  });

  it('badges the nearest visible ancestor when a manual fold hides the focus', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working')], overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(l.nodeItems.has(t.a1.id)).toBe(false);
    expect(l.items.find((i) => i.kind === 'badge')).toMatchObject({ id: 'bs1', nodeId: t.a.id, x: 2 * INDENT, y: 2 * ROW });
    expect(l.nodeItems.get(t.a.id)?.working).toBe(true);
  });
});

describe('camera helpers', () => {
  it('prefers the freshest working focus, then the latest active node, then the last row', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    expect(findFrontier(t.nodes, [session('s1', t.b.id, 'idle'), session('s2', t.a2.id, 'working')], l)).toBe(t.a2.id);
    expect(findFrontier(t.nodes, [], l)).toBe(t.a1.id);
    const idle = t.nodes.map((x) => (x.parentId === null ? x : { ...x, status: 'todo' as const }));
    expect(findFrontier(idle, [], layoutOutline({ nodes: idle, resources: [], sessions: [] }))).toBe(t.c.id);
  });

  it('orders needs-you nodes top to bottom', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.b.id ? { ...x, assignee: 'me' as const } : x));
    expect(needsYouOrder(layoutOutline({ nodes, resources: [], sessions: [] }))).toEqual([t.a2.id, t.b.id]);
  });

  it('maps events to the node the camera should visit', () => {
    const ev = (type: string, entityId: string, data: unknown): EventRow => ({ id: 1, ts: 't', projectId: 1, actor: 'x', type, entity: 'x', entityId, data });
    expect(eventTarget(ev('node.created', '5', { ids: [5, 6, 7] }))).toBe(7);
    expect(eventTarget(ev('node.updated', '4', {}))).toBe(4);
    expect(eventTarget(ev('resource.created', '9', { nodeId: 3 }))).toBe(3);
    expect(eventTarget(ev('log.created', '2', { nodeId: 8 }))).toBe(8);
    expect(eventTarget(ev('session.updated', 's1', { changed: ['focusNodeId'], focusNodeId: 11 }))).toBe(11);
    expect(eventTarget(ev('session.updated', 's1', { changed: ['state'], state: 'working' }))).toBeUndefined();
    expect(eventTarget(ev('node.deleted', '4', { ids: [4] }))).toBeUndefined();
  });
});
