import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { raiseAsk } from '../../src/server/repo/asks';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes, updateNode } from '../../src/server/repo/nodes';
import { setQueue } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };
const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui-token' };

async function setup() {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test' });
  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } })).json();
  await app.inject({ method: 'POST', url: `/api/projects/${p.slug}/bindings`, headers: auth, payload: { path: 'C:/personal/InGame' } });
  await app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload: { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' } });
  const nodes = addNodes(ctx, 'test', { parentId: p.rootNodeId, nodes: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }] });
  const [a, b, c, d] = nodes.map((n) => n.id);
  const post = (url: string, payload: unknown, headers: Record<string, string> = UI) => app.inject({ method: 'POST', url, headers, payload: payload as object });
  const queue = (op: unknown, slug = p.slug) => post(`/api/ui/projects/${p.id}/queue`, { slug, op });
  const stored = () => (JSON.parse(ctx.db.prepare('SELECT queue FROM projects WHERE id = ?').pluck().get(p.id) as string) as unknown[]);
  const entries = (res: { json: () => { project: { queue: { nodeId: number; sessionId: string | null }[] } } }) => res.json().project.queue.map((e) => [e.nodeId, e.sessionId]);
  return { ctx, app, p, a, b, c, d, post, queue, stored, entries };
}

describe('queue route', () => {
  it('moves into an empty queue, and before an unowned entry', async () => {
    const { queue, entries, a, b, c } = await setup();
    expect(entries(await queue({ kind: 'move', node: a, before: null }))).toEqual([[a, null]]);
    expect(entries(await queue({ kind: 'move', node: b, before: null }))).toEqual([[a, null], [b, null]]);
    expect(entries(await queue({ kind: 'move', node: c, before: b }))).toEqual([[a, null], [c, null], [b, null]]);
    // Moving a queued node reorders it: it is in the queue once.
    expect(entries(await queue({ kind: 'move', node: b, before: a }))).toEqual([[b, null], [a, null], [c, null]]);
  });

  it('appends when before is an owned entry or no longer queued, and keeps owned entries first', async () => {
    const { ctx, p, queue, entries, a, b, c } = await setup();
    setQueue(ctx, 'scribe:s1', p.id, [a], { sessionId: 's1' });
    setQueue(ctx, 'scribe:s1', p.id, [b], 'unowned');
    // before the owned entry: not a valid place, so it appends to the unowned part
    expect(entries(await queue({ kind: 'move', node: c, before: a }))).toEqual([[a, 's1'], [b, null], [c, null]]);
    expect(entries(await queue({ kind: 'move', node: c, before: 999999 }))).toEqual([[a, 's1'], [b, null], [c, null]]);
    // before the first unowned entry: lands after the owned one
    expect(entries(await queue({ kind: 'move', node: c, before: b }))).toEqual([[a, 's1'], [c, null], [b, null]]);
  });

  it('takes a node out of a session queue, records takenFrom, and the event is project.updated with data.op', async () => {
    const { ctx, p, queue, entries, a, b } = await setup();
    setQueue(ctx, 'scribe:s1', p.id, [a, b], { sessionId: 's1' });
    const mark = maxEventId(ctx);
    expect(entries(await queue({ kind: 'move', node: a, before: null }))).toEqual([[b, 's1'], [a, null]]);
    const [event] = listEventsSince(ctx, mark);
    expect(event).toMatchObject({ actor: 'window', type: 'project.updated', entity: 'project', data: { op: 'move', node: a, takenFrom: 's1', changes: { queue: {} } } });
    expect(Object.keys((event.data as { changes: object }).changes)).toEqual(['queue']);
  });

  it('removes a node, and a remove of a node not queued records nothing', async () => {
    const { ctx, queue, entries, a, b } = await setup();
    await queue({ kind: 'move', node: a, before: null });
    await queue({ kind: 'move', node: b, before: null });
    const mark = maxEventId(ctx);
    expect(entries(await queue({ kind: 'remove', node: a }))).toEqual([[b, null]]);
    expect(listEventsSince(ctx, mark)).toHaveLength(1);
    expect(entries(await queue({ kind: 'remove', node: a }))).toEqual([[b, null]]);
    expect(listEventsSince(ctx, mark)).toHaveLength(1);
  });

  it('refuses a done or dropped node, a node of another project, and allows a step with an open ask', async () => {
    const { ctx, app, queue, a, b, c, stored } = await setup();
    updateNode(ctx, 'test', a, { status: 'done' });
    updateNode(ctx, 'test', b, { status: 'dropped' });
    const done = await queue({ kind: 'move', node: a, before: null });
    expect(done.statusCode).toBe(400);
    expect(done.json().error).toBe('not open');
    expect((await queue({ kind: 'remove', node: b })).statusCode).toBe(400);
    const other = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Other' } })).json();
    const [foreign] = addNodes(ctx, 'test', { parentId: other.rootNodeId, nodes: [{ title: 'Foreign' }] });
    expect((await queue({ kind: 'move', node: foreign.id, before: null })).statusCode).toBe(400);
    raiseAsk(ctx, 'scribe:s1', { nodeId: c, kind: 'question', text: 'Which?' });
    expect((await queue({ kind: 'move', node: c, before: null })).statusCode).toBe(200);
    expect(stored()).toHaveLength(1);
  });

  it('answers 409 on a wrong slug and rejects a malformed operation', async () => {
    const { queue, post, p, a, stored } = await setup();
    const res = await queue({ kind: 'move', node: a, before: null }, 'old-site');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('This project changed; reload');
    expect((await queue({ kind: 'swap', node: a })).statusCode).toBe(400);
    expect((await post(`/api/ui/projects/${p.id}/queue`, { slug: p.slug, op: { kind: 'move', node: a } })).statusCode).toBe(400);
    expect(stored()).toEqual([]);
  });
});

describe('nodes route (quick-add)', () => {
  it('creates a todo step with no label under the root, and under a group', async () => {
    const { ctx, p, post } = await setup();
    const root = await post(`/api/ui/projects/${p.id}/nodes`, { slug: p.slug, title: '  Polish the menu  ', parent: null });
    expect(root.statusCode).toBe(200);
    expect(root.json().node).toMatchObject({ title: 'Polish the menu', status: 'todo', label: null, parentId: p.rootNodeId, projectId: p.id });
    const [group] = addNodes(ctx, 'test', { parentId: p.rootNodeId, nodes: [{ title: 'Group', kind: 'phase' }] });
    const child = await post(`/api/ui/projects/${p.id}/nodes`, { slug: p.slug, title: 'Inside', parent: group.id });
    expect(child.json().node).toMatchObject({ title: 'Inside', parentId: group.id });
    expect(ctx.db.prepare("SELECT actor FROM events WHERE type = 'node.created' ORDER BY id DESC").pluck().get()).toBe('window');
  });

  it('refuses a dropped parent (400) and allows a done one', async () => {
    const { ctx, p, post, a, b } = await setup();
    updateNode(ctx, 'test', a, { status: 'dropped' });
    updateNode(ctx, 'test', b, { status: 'done' });
    const url = `/api/ui/projects/${p.id}/nodes`;
    const dropped = await post(url, { slug: p.slug, title: 'X', parent: a });
    expect(dropped.statusCode).toBe(400);
    expect(dropped.json().error).toBe(`#${a} is dropped`);
    expect((await post(url, { slug: p.slug, title: 'Y', parent: b })).statusCode).toBe(200);
  });

  it('refuses a parent of another project (400), an empty title, a wrong slug', async () => {
    const { ctx, app, p, post } = await setup();
    const other = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Other' } })).json();
    const [foreign] = addNodes(ctx, 'test', { parentId: other.rootNodeId, nodes: [{ title: 'Foreign' }] });
    const url = `/api/ui/projects/${p.id}/nodes`;
    expect((await post(url, { slug: p.slug, title: 'X', parent: foreign.id })).statusCode).toBe(400);
    expect((await post(url, { slug: p.slug, title: 'X', parent: 999999 })).statusCode).toBe(400);
    expect((await post(url, { slug: p.slug, title: '   ', parent: null })).statusCode).toBe(400);
    expect((await post(url, { slug: 'nope', title: 'X', parent: null })).statusCode).toBe(409);
    expect(ctx.db.prepare('SELECT COUNT(*) FROM nodes WHERE project_id = ? AND title = ?').pluck().get(p.id, 'X')).toBe(0);
  });
});

describe('ask clear route', () => {
  it('clears with and without an answer, and twice', async () => {
    const { ctx, post, a, b } = await setup();
    const one = raiseAsk(ctx, 'scribe:s1', { nodeId: a, kind: 'permission', text: 'Ship it?' });
    const two = raiseAsk(ctx, 'scribe:s1', { nodeId: b, kind: 'permission', text: 'Rename it?' });
    const plain = await post(`/api/ui/asks/${one.id}/clear`, {});
    expect(plain.statusCode).toBe(200);
    expect(plain.json().ask).toMatchObject({ id: one.id, answer: '', clearedBy: 'window' });
    expect(plain.json().ask.clearedAt).not.toBeNull();
    const again = await post(`/api/ui/asks/${one.id}/clear`, {});
    expect(again.json().ask).toEqual(plain.json().ask);
    const answered = await post(`/api/ui/asks/${two.id}/clear`, { answer: ' Yes, ship ' });
    expect(answered.json().ask).toMatchObject({ answer: 'Yes, ship', clearedBy: 'window' });
    const twice = await post(`/api/ui/asks/${two.id}/clear`, { answer: 'Different' });
    expect(twice.json().ask.answer).toBe('Yes, ship');
    expect(ctx.db.prepare("SELECT COUNT(*) FROM events WHERE type = 'ask.cleared'").pluck().get()).toBe(2);
  });

  it('answers 404 for an unknown ask and 400 for an answer over 2000 characters', async () => {
    const { ctx, post, a } = await setup();
    expect((await post('/api/ui/asks/9999/clear', {})).statusCode).toBe(404);
    const ask = raiseAsk(ctx, 'scribe:s1', { nodeId: a, kind: 'permission', text: 'Ship it?' });
    expect((await post(`/api/ui/asks/${ask.id}/clear`, { answer: 'x'.repeat(2001) })).statusCode).toBe(400);
  });
});

describe('events route (measurements)', () => {
  it('stores window.<name> quietly, keeps only the named keys, and the SSE replay skips it', async () => {
    const { ctx, p, post } = await setup();
    const heard: string[] = [];
    ctx.bus.on('event', (e: { type: string }) => heard.push(e.type));
    const mark = maxEventId(ctx);
    const res = await post('/api/ui/events', { name: 'first_action', projectId: p.id, data: { area: 'now', action: 'clear', gapMs: 3600000, title: 'secret content', node: 7 } });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    const row = ctx.db.prepare("SELECT actor, type, project_id AS projectId, data FROM events WHERE type LIKE 'window.%'").get() as { actor: string; type: string; projectId: number; data: string };
    expect(row).toMatchObject({ actor: 'window', type: 'window.first_action', projectId: p.id });
    expect(JSON.parse(row.data)).toEqual({ area: 'now', action: 'clear', gapMs: 3600000, node: 7 });
    expect(listEventsSince(ctx, mark)).toEqual([]);
    expect(heard).toEqual([]);
    expect((await post('/api/ui/events', { name: 'view', projectId: null })).statusCode).toBe(204);
    expect(ctx.db.prepare("SELECT type FROM events WHERE type = 'window.view'").all()).toHaveLength(1);
  });

  it('rejects an unknown name and a nested data value', async () => {
    const { p, post } = await setup();
    expect((await post('/api/ui/events', { name: 'typed', projectId: p.id })).statusCode).toBe(400);
    expect((await post('/api/ui/events', { name: 'view', projectId: p.id, data: { view: { a: 1 } } })).statusCode).toBe(400);
  });
});

describe('requireUi on the new routes', () => {
  it('refuses a request that is not from the window, and writes nothing', async () => {
    const { ctx, p, a, post } = await setup();
    const before = ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get();
    const routes: [string, object][] = [
      [`/api/ui/projects/${p.id}/queue`, { slug: p.slug, op: { kind: 'move', node: a, before: null } }],
      [`/api/ui/projects/${p.id}/nodes`, { slug: p.slug, title: 'X', parent: null }],
      ['/api/ui/asks/1/clear', {}],
      ['/api/ui/events', { name: 'view', projectId: p.id }],
    ];
    for (const [url, payload] of routes) {
      for (const headers of [{} as Record<string, string>, { origin: 'http://evil.example', 'x-ip-ui-token': 'ui-token' }, { origin: 'http://localhost:80' }, { origin: 'http://localhost:80', 'x-ip-ui-token': 'wrong' }, auth]) {
        expect([401, 403], url).toContain((await post(url, payload, headers)).statusCode);
      }
    }
    expect(ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(before);
  });
});

describe('a deleted project', () => {
  it('is not found (404) by the queue and create routes, and nothing is written', async () => {
    const { ctx, p, post, queue, a, stored } = await setup();
    const gone = await post(`/api/ui/projects/${p.id}/delete`, { slug: p.slug });
    expect(gone.statusCode).toBe(200);
    expect((await queue({ kind: 'move', node: a, before: null })).statusCode).toBe(404);
    expect(stored()).toEqual([]);
    const before = ctx.db.prepare('SELECT COUNT(*) FROM nodes WHERE project_id = ?').pluck().get(p.id);
    expect((await post(`/api/ui/projects/${p.id}/nodes`, { slug: p.slug, title: 'Late', parent: null })).statusCode).toBe(404);
    expect(ctx.db.prepare('SELECT COUNT(*) FROM nodes WHERE project_id = ?').pluck().get(p.id)).toBe(before);
  });
});
