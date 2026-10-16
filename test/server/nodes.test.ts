import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/server/repo/projects';
import { write } from '../../src/server/db/tx';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addLog } from '../../src/server/repo/logs';
import { addNodes, deleteNode, insertPositions, listNodes, moveNode, patchNode, requireNode, setDriver, updateNode } from '../../src/server/repo/nodes';
import { addResource } from '../../src/server/repo/resources';
import { makeCtx } from '../helpers';

function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'P' });
  return { ctx, project, root: project.rootNodeId };
}

describe('insertPositions', () => {
  const sibs = [{ id: 1, position: 1 }, { id: 2, position: 2 }];
  it('appends, prepends, and inserts between', () => {
    expect(insertPositions([], 'end', 2)).toEqual([1, 2]);
    expect(insertPositions(sibs, 'end', 2)).toEqual([3, 4]);
    expect(insertPositions(sibs, 'start', 2)).toEqual([-1, 0]);
    expect(insertPositions(sibs, 1, 1)).toEqual([1.5]);
  });
  it('rejects an after id that is not a sibling', () => {
    expect(() => insertPositions(sibs, 9, 1)).toThrow('#9 is not a child of this parent');
    expect(() => insertPositions([], 9, 1)).toThrow('#9 is not a child of this parent');
  });
});

describe('nodes', () => {
  it('adds a nested plan in pre-order with defaults, and one event', () => {
    const { ctx, root } = setup();
    const created = addNodes(ctx, 'scribe:s1', {
      parentId: root,
      nodes: [{ title: 'Road to market', kind: 'phase', status: 'active', children: [{ title: 'iOS cert', status: 'done' }, { title: 'Run tests', assignee: 'me' }] }],
    });
    expect(created.map((n) => n.title)).toEqual(['Road to market', 'iOS cert', 'Run tests']);
    expect(created[1]).toMatchObject({ kind: 'task', status: 'done', assignee: 'claude', parentId: created[0].id });
    expect(created[1].completedAt).not.toBeNull();
    expect(created[2]).toMatchObject({ status: 'todo', assignee: 'me', completedAt: null });
    const ev = ctx.db.prepare("SELECT data FROM events WHERE type = 'node.created' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(ev.data)).toEqual({ ids: created.map((n) => n.id), parentId: root });
  });

  it('inserts after a sibling', () => {
    const { ctx, root } = setup();
    const [a, b] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A' }, { title: 'B' }] });
    addNodes(ctx, 't', { parentId: root, after: a.id, nodes: [{ title: 'A2' }] });
    const kids = listNodes(ctx, a.projectId).filter((n) => n.parentId === root).sort((x, y) => x.position - y.position);
    expect(kids.map((n) => n.title)).toEqual(['A', 'A2', 'B']);
    expect(b.title).toBe('B');
  });

  it('renumbers siblings once repeated inserts squeeze the gap below 1e-6', () => {
    const { ctx, root } = setup();
    const [a, b] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A' }, { title: 'B' }] });
    for (let i = 0; i < 25; i++) addNodes(ctx, 't', { parentId: root, after: a.id, nodes: [{ title: `x${i}` }] });
    const kids = listNodes(ctx, a.projectId).filter((n) => n.parentId === root).sort((x, y) => x.position - y.position);
    expect(kids.map((n) => n.title)).toEqual(['A', ...Array.from({ length: 25 }, (_, i) => `x${24 - i}`), 'B']);
    // Each insert halves the gap after A; the 20th leaves 2^-20 < 1e-6, which renumbers the 22 siblings 1..22.
    expect(requireNode(ctx, b.id).position).toBe(22);
  });

  it('updates fields, maintains completed_at, and records the diff', () => {
    const { ctx, root } = setup();
    const [n] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'Step' }] });
    const done = updateNode(ctx, 't', n.id, { status: 'done', outcome: 'Shipped' });
    expect(done.completedAt).not.toBeNull();
    const reopened = updateNode(ctx, 't', n.id, { status: 'active' });
    expect(reopened.completedAt).toBeNull();
    const ev = ctx.db.prepare("SELECT data FROM events WHERE type = 'node.updated' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(ev.data)).toEqual({ changes: { status: { from: 'done', to: 'active' } } });
    expect(() => updateNode(ctx, 't', root, { kind: 'task' })).toThrow('project root');
  });

  it('labels steps as they are added, nested ones too, and leaves the rest unlabelled', () => {
    const { ctx, root } = setup();
    const created = addNodes(ctx, 't', {
      parentId: root,
      nodes: [{ title: 'Live work', kind: 'phase', children: [{ title: 'Working-task rows', label: 'ui' }, { title: 'Mirror the task tools', label: 'integration' }] }, { title: 'Spike', label: null }],
    });
    expect(created.map((n) => [n.title, n.label])).toEqual([['Live work', null], ['Working-task rows', 'ui'], ['Mirror the task tools', 'integration'], ['Spike', null]]);
    expect(requireNode(ctx, created[1].id).label).toBe('ui');
    expect(requireNode(ctx, root).label).toBeNull();
  });

  it('sets, changes and clears a label, each change in node.updated', () => {
    const { ctx, root } = setup();
    const [n] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'Faster cold start' }] });
    const lastChanges = () => JSON.parse((ctx.db.prepare("SELECT data FROM events WHERE type = 'node.updated' ORDER BY id DESC LIMIT 1").get() as { data: string }).data).changes;
    expect(updateNode(ctx, 't', n.id, { label: 'research' }).label).toBe('research');
    expect(lastChanges()).toEqual({ label: { from: null, to: 'research' } });
    expect(updateNode(ctx, 't', n.id, { label: 'fix', status: 'active' })).toMatchObject({ label: 'fix', status: 'active' });
    expect(lastChanges()).toEqual({ label: { from: 'research', to: 'fix' }, status: { from: 'todo', to: 'active' } });
    // Leaving label out keeps it; null clears it.
    expect(updateNode(ctx, 't', n.id, { outcome: 'Halved' }).label).toBe('fix');
    expect(updateNode(ctx, 't', n.id, { label: null }).label).toBeNull();
    expect(lastChanges()).toEqual({ label: { from: 'fix', to: null } });
  });

  it('refuses title and body edits on the root, which mirror the project', () => {
    const { ctx, root } = setup();
    expect(() => updateNode(ctx, 't', root, { title: 'X' })).toThrow('project root');
    expect(() => updateNode(ctx, 't', root, { body: 'Y' })).toThrow('project root');
    expect(updateNode(ctx, 't', root, { status: 'done' })).toMatchObject({ status: 'done', title: 'P', body: '' });
  });

  it('moves within a project, never under its own descendant, never the root', () => {
    const { ctx, root } = setup();
    const [a, child] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A', children: [{ title: 'A.1' }] }] });
    const [b] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'B' }] });
    expect(moveNode(ctx, 't', child.id, { parentId: b.id }).parentId).toBe(b.id);
    expect(() => moveNode(ctx, 't', b.id, { parentId: child.id })).toThrow('under its own descendant');
    expect(() => moveNode(ctx, 't', root, { parentId: a.id })).toThrow('cannot be moved');
    const other = createProject(ctx, 't', { name: 'Other' });
    expect(() => moveNode(ctx, 't', a.id, { parentId: other.rootNodeId })).toThrow('different project');
  });

  it('refuses to place a node after itself', () => {
    const { ctx, root } = setup();
    const [a] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A' }, { title: 'B' }] });
    expect(() => moveNode(ctx, 't', a.id, { parentId: root, after: a.id })).toThrow(`Cannot place #${a.id} after itself`);
  });

  it('deletes leaves, requires cascade for subtrees, protects the root', () => {
    const { ctx, root } = setup();
    const [a, a1] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A', children: [{ title: 'A.1' }] }] });
    expect(() => deleteNode(ctx, 't', a.id)).toThrow('has 1 descendant');
    expect(deleteNode(ctx, 't', a.id, true).ids.sort()).toEqual([a.id, a1.id].sort());
    expect(() => requireNode(ctx, a1.id)).toThrow(`Node #${a1.id} not found`);
    expect(() => deleteNode(ctx, 't', root)).toThrow('project root');
  });

  it('rejects unknown parents with a hint', () => {
    const { ctx } = setup();
    expect(() => addNodes(ctx, 't', { parentId: 999, nodes: [{ title: 'X' }] })).toThrow('Node #999 not found');
  });
});

describe('patchNode, the update inside an open write', () => {
  it("applies updateNode's rules in the caller's write: one node.updated with the diff, completedAt, the root guards", () => {
    const { ctx, root } = setup();
    const [n] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'Step' }] });
    const mark = maxEventId(ctx);
    const done = write(ctx, 'scribe:s1', (record) => patchNode(ctx, record, requireNode(ctx, n.id), { status: 'done' }));
    expect(done).toMatchObject({ status: 'done', completedAt: expect.any(String) });
    expect(done.updatedAt > n.updatedAt).toBe(true);
    expect(listEventsSince(ctx, mark)).toMatchObject([{ type: 'node.updated', actor: 'scribe:s1', entityId: String(n.id), data: { changes: { status: { from: 'todo', to: 'done' } } } }]);
    expect(() => write(ctx, 't', (record) => patchNode(ctx, record, requireNode(ctx, root), { title: 'X' }))).toThrow('project root');
    expect(() => write(ctx, 't', (record) => patchNode(ctx, record, requireNode(ctx, root), { kind: 'task' }))).toThrow('project root');
  });

  it("leaves a step's updatedAt alone on a log entry or a resource, so a needs-you age keeps counting", () => {
    const { ctx, root } = setup();
    const [n] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'Merge PRs', assignee: 'me' }] });
    addLog(ctx, 'scribe:s1', n.id, 'Not yet: Aiden reviews them tomorrow.');
    addResource(ctx, 't', { nodeId: n.id, kind: 'doc', title: 'PR list', content: 'x' });
    expect(requireNode(ctx, n.id).updatedAt).toBe(n.updatedAt);
  });

  it('clears the driver when a step goes done or dropped', () => {
    const { ctx, root } = setup();
    const [a, b] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A', status: 'active' }, { title: 'B', status: 'active' }] });
    write(ctx, 't', (record) => setDriver(ctx, record, requireNode(ctx, a.id), 's1'));
    write(ctx, 't', (record) => setDriver(ctx, record, requireNode(ctx, b.id), 's2'));
    expect(requireNode(ctx, a.id).driverSessionId).toBe('s1');
    expect(updateNode(ctx, 't', a.id, { status: 'done' }).driverSessionId).toBeNull();
    expect(updateNode(ctx, 't', b.id, { status: 'dropped' }).driverSessionId).toBeNull();
  });

  it('keeps the driver on a status change that is not done or dropped', () => {
    const { ctx, root } = setup();
    const [n] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A', status: 'active' }] });
    write(ctx, 't', (record) => setDriver(ctx, record, requireNode(ctx, n.id), 's1'));
    expect(updateNode(ctx, 't', n.id, { status: 'blocked' }).driverSessionId).toBe('s1');
  });

  it('setDriver records node.updated and leaves updatedAt alone', () => {
    const { ctx, root } = setup();
    const [n] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A', status: 'active' }] });
    const mark = maxEventId(ctx);
    write(ctx, 'scribe:s1', (record) => setDriver(ctx, record, requireNode(ctx, n.id), 's1'));
    const after = requireNode(ctx, n.id);
    expect(after.driverSessionId).toBe('s1');
    expect(after.updatedAt).toBe(n.updatedAt);
    expect(listEventsSince(ctx, mark)).toMatchObject([
      { type: 'node.updated', entity: 'node', entityId: String(n.id), data: { changes: { driverSessionId: { from: null, to: 's1' } } } },
    ]);
    const unchanged = maxEventId(ctx);
    write(ctx, 't', (record) => setDriver(ctx, record, requireNode(ctx, n.id), 's1'));
    expect(listEventsSince(ctx, unchanged)).toEqual([]);
  });
});
