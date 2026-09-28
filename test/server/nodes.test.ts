import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/server/repo/projects';
import { addNodes, deleteNode, insertPositions, listNodes, moveNode, requireNode, updateNode } from '../../src/server/repo/nodes';
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
