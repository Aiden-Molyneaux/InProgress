import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { raiseAsk } from '../../src/server/repo/asks';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes, updateNode } from '../../src/server/repo/nodes';
import { setQueue } from '../../src/server/repo/projects';
import type { Ctx } from '../../src/server/db/tx';
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

describe('node delete route', () => {
  const exists = (ctx: { db: { prepare: (sql: string) => { pluck: () => { get: (...a: unknown[]) => unknown } } } }, id: number) =>
    ctx.db.prepare('SELECT COUNT(*) FROM nodes WHERE id = ?').pluck().get(id) === 1;

  it('deletes a leaf and answers its ids', async () => {
    const { ctx, p, post, a, b } = await setup();
    const res = await post(`/api/ui/projects/${p.id}/nodes/${a}/delete`, { slug: p.slug });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ids: [a] });
    expect(exists(ctx, a)).toBe(false);
    expect(exists(ctx, b)).toBe(true);
  });

  it('refuses a step with steps under it', async () => {
    const { ctx, p, post, a } = await setup();
    const [child] = addNodes(ctx, 'test', { parentId: a, nodes: [{ title: 'Child' }] });
    const res = await post(`/api/ui/projects/${p.id}/nodes/${a}/delete`, { slug: p.slug });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(`#${a} has steps under it`);
    expect(exists(ctx, a)).toBe(true);
    expect(exists(ctx, child.id)).toBe(true);
  });

  it('refuses a step of another project, and the root', async () => {
    const { ctx, app, p, post } = await setup();
    const other = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Other' } })).json();
    const [foreign] = addNodes(ctx, 'test', { parentId: other.rootNodeId, nodes: [{ title: 'Foreign' }] });
    const res = await post(`/api/ui/projects/${p.id}/nodes/${foreign.id}/delete`, { slug: p.slug });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(`#${foreign.id} is not in this project`);
    expect(exists(ctx, foreign.id)).toBe(true);
    expect((await post(`/api/ui/projects/${p.id}/nodes/${p.rootNodeId}/delete`, { slug: p.slug })).statusCode).toBe(400);
    expect(exists(ctx, p.rootNodeId)).toBe(true);
  });

  it('refuses a done or dropped step', async () => {
    const { ctx, p, post, a, b } = await setup();
    updateNode(ctx, 'test', a, { status: 'done' });
    updateNode(ctx, 'test', b, { status: 'dropped' });
    const done = await post(`/api/ui/projects/${p.id}/nodes/${a}/delete`, { slug: p.slug });
    expect([done.statusCode, done.json().error]).toEqual([400, `#${a} is done`]);
    const dropped = await post(`/api/ui/projects/${p.id}/nodes/${b}/delete`, { slug: p.slug });
    expect([dropped.statusCode, dropped.json().error]).toEqual([400, `#${b} is dropped`]);
    expect(exists(ctx, a) && exists(ctx, b)).toBe(true);
  });

  it('refuses a step a live session is focused on, but not one only a stale or ended session held', async () => {
    const { ctx, p, post, a, b, c } = await setup();
    ctx.db.prepare('UPDATE sessions SET focus_node_id = ? WHERE id = ?').run(a, 's1');
    const res = await post(`/api/ui/projects/${p.id}/nodes/${a}/delete`, { slug: p.slug });
    expect([res.statusCode, res.json().error]).toEqual([400, `#${a} is being worked on`]);
    expect(exists(ctx, a)).toBe(true);
    ctx.db.prepare("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = 's1'").run();
    expect((await post(`/api/ui/projects/${p.id}/nodes/${a}/delete`, { slug: p.slug })).statusCode).toBe(200);
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, focus_node_id, started_at, last_seen_at, ended_at) VALUES ('old', ?, 'ended', ?, ?, ?, ?)").run(p.id, b, ctx.now(), ctx.now(), ctx.now());
    expect((await post(`/api/ui/projects/${p.id}/nodes/${b}/delete`, { slug: p.slug })).statusCode).toBe(200);
    expect(exists(ctx, c)).toBe(true);
  });

  it('refuses an active step assigned to me', async () => {
    const { ctx, p, post, a } = await setup();
    updateNode(ctx, 'test', a, { status: 'active', assignee: 'me' });
    const res = await post(`/api/ui/projects/${p.id}/nodes/${a}/delete`, { slug: p.slug });
    expect([res.statusCode, res.json().error]).toEqual([400, `#${a} is being worked on`]);
    expect(exists(ctx, a)).toBe(true);
  });

  it('refuses a step in the queue', async () => {
    const { ctx, p, post, queue, a } = await setup();
    await queue({ kind: 'move', node: a, before: null });
    const res = await post(`/api/ui/projects/${p.id}/nodes/${a}/delete`, { slug: p.slug });
    expect([res.statusCode, res.json().error]).toEqual([400, `#${a} is in Next`]);
    expect(exists(ctx, a)).toBe(true);
  });

  it('answers 409 for a wrong slug, 404 for a missing step, and refuses a request not from the window', async () => {
    const { ctx, p, post, a } = await setup();
    const url = `/api/ui/projects/${p.id}/nodes/${a}/delete`;
    expect((await post(url, { slug: 'nope' })).statusCode).toBe(409);
    expect((await post(`/api/ui/projects/${p.id}/nodes/999999/delete`, { slug: p.slug })).statusCode).toBe(404);
    for (const headers of [{} as Record<string, string>, { origin: 'http://evil.example', 'x-ip-ui-token': 'ui-token' }, { origin: 'http://localhost:80', 'x-ip-ui-token': 'wrong' }, auth]) {
      expect([401, 403]).toContain((await post(url, { slug: p.slug }, headers)).statusCode);
    }
    expect(exists(ctx, a)).toBe(true);
  });
});

describe('node done route', () => {
  const row = (ctx: Ctx, id: number) =>
    ctx.db.prepare('SELECT status, outcome, completed_at AS completedAt, driver_session_id AS driver FROM nodes WHERE id = ?').get(id) as {
      status: string;
      outcome: string;
      completedAt: string | null;
      driver: string | null;
    };
  const url = (p: { id: number }, id: number) => `/api/ui/projects/${p.id}/nodes/${id}/done`;

  it('marks a step done with its outcome, as the window, in one node.updated event', async () => {
    const { ctx, p, post, a } = await setup();
    ctx.db.prepare("UPDATE nodes SET status = 'active', driver_session_id = 's1' WHERE id = ?").run(a);
    const mark = maxEventId(ctx);
    const res = await post(url(p, a), { slug: p.slug, outcome: ' Shipped it ', driver: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().node).toMatchObject({ id: a, status: 'done', outcome: 'Shipped it' });
    expect(row(ctx, a)).toMatchObject({ status: 'done', outcome: 'Shipped it', driver: null });
    expect(row(ctx, a).completedAt).not.toBeNull();
    const events = listEventsSince(ctx, mark).filter((e) => e.type === 'node.updated');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'window', entityId: String(a) });
  });

  it('leaves the outcome empty for an empty or whitespace one', async () => {
    const { ctx, p, post, a, b } = await setup();
    expect((await post(url(p, a), { slug: p.slug, driver: null })).statusCode).toBe(200);
    expect((await post(url(p, b), { slug: p.slug, outcome: '   ', driver: null })).statusCode).toBe(200);
    expect(row(ctx, a)).toMatchObject({ status: 'done', outcome: '' });
    expect(row(ctx, b)).toMatchObject({ status: 'done', outcome: '' });
  });

  it('answers a step already done as it stands, writing nothing', async () => {
    const { ctx, p, post, a } = await setup();
    const first = await post(url(p, a), { slug: p.slug, outcome: 'First', driver: null });
    const mark = maxEventId(ctx);
    const again = await post(url(p, a), { slug: p.slug, outcome: 'Second', driver: 'someone' });
    expect(again.statusCode).toBe(200);
    expect(again.json().node).toEqual(first.json().node);
    expect(row(ctx, a).outcome).toBe('First');
    expect(listEventsSince(ctx, mark)).toEqual([]);
  });

  it('refuses a step of another project, a dropped step and the root, and answers 409 for a wrong slug', async () => {
    const { ctx, app, p, post, a, b } = await setup();
    const other = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Other' } })).json();
    const [foreign] = addNodes(ctx, 'test', { parentId: other.rootNodeId, nodes: [{ title: 'Foreign' }] });
    const away = await post(url(p, foreign.id), { slug: p.slug, driver: null });
    expect([away.statusCode, away.json().error]).toEqual([400, `#${foreign.id} is not in this project`]);
    updateNode(ctx, 'test', b, { status: 'dropped' });
    const dropped = await post(url(p, b), { slug: p.slug, driver: null });
    expect([dropped.statusCode, dropped.json().error]).toEqual([400, `#${b} is dropped`]);
    const root = await post(url(p, p.rootNodeId), { slug: p.slug, driver: null });
    expect([root.statusCode, root.json().error]).toEqual([400, `#${p.rootNodeId} is the project root`]);
    expect((await post(url(p, a), { slug: 'nope', driver: null })).statusCode).toBe(409);
    expect(row(ctx, a).status).toBe('todo');
    expect(row(ctx, foreign.id).status).toBe('todo');
  });

  it('refuses a step with open steps under it, naming them; a done or dropped one does not block', async () => {
    const { ctx, p, post, a } = await setup();
    const [one, two, three] = addNodes(ctx, 'test', { parentId: a, nodes: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] });
    updateNode(ctx, 'test', two.id, { status: 'done' });
    const refused = await post(url(p, a), { slug: p.slug, driver: null });
    expect([refused.statusCode, refused.json().error]).toEqual([400, `#${a} has open steps under it: #${one.id}, #${three.id}`]);
    expect(row(ctx, a).status).toBe('todo');
    updateNode(ctx, 'test', one.id, { status: 'done' });
    updateNode(ctx, 'test', three.id, { status: 'dropped' });
    expect((await post(url(p, a), { slug: p.slug, driver: null })).statusCode).toBe(200);
    expect(row(ctx, a).status).toBe('done');
  });

  it('refuses when a live session drives the step and the window did not name it; done with it named, the session keeps its focus', async () => {
    const { ctx, p, post, a } = await setup();
    ctx.db.prepare("UPDATE nodes SET status = 'active', driver_session_id = 's1' WHERE id = ?").run(a);
    ctx.db.prepare('UPDATE sessions SET focus_node_id = ? WHERE id = ?').run(a, 's1');
    const refused = await post(url(p, a), { slug: p.slug, driver: null });
    expect([refused.statusCode, refused.json().error]).toEqual([409, `A session is driving #${a} now`]);
    expect(row(ctx, a).status).toBe('active');
    expect((await post(url(p, a), { slug: p.slug, driver: 'other' })).statusCode).toBe(409);
    expect((await post(url(p, a), { slug: p.slug, driver: 's1' })).statusCode).toBe(200);
    expect(row(ctx, a)).toMatchObject({ status: 'done', driver: null });
    expect(ctx.db.prepare("SELECT focus_node_id FROM sessions WHERE id = 's1'").pluck().get()).toBe(a);
  });

  it('does not count a stale driver as live', async () => {
    const { ctx, p, post, a } = await setup();
    ctx.db.prepare("UPDATE nodes SET status = 'active', driver_session_id = 's1' WHERE id = ?").run(a);
    ctx.db.prepare("UPDATE sessions SET focus_node_id = ?, last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = 's1'").run(a);
    expect((await post(url(p, a), { slug: p.slug, driver: null })).statusCode).toBe(200);
  });

  it('answers the open ask of a question step with the outcome', async () => {
    const { ctx, p, post, a } = await setup();
    updateNode(ctx, 'test', a, { kind: 'question' });
    const ask = raiseAsk(ctx, 'scribe:s1', { nodeId: a, kind: 'question', text: 'Which way?' });
    expect((await post(url(p, a), { slug: p.slug, outcome: 'The left one', driver: null })).statusCode).toBe(200);
    const cleared = ctx.db.prepare('SELECT answer, cleared_by AS clearedBy FROM asks WHERE id = ?').get(ask.id);
    expect(cleared).toEqual({ answer: 'The left one', clearedBy: 'window' });
  });

  it('is refused for a request not from the window, a missing driver field and an unknown step; nothing is written', async () => {
    const { ctx, p, post, a } = await setup();
    const before = ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get();
    for (const headers of [{} as Record<string, string>, { origin: 'http://evil.example', 'x-ip-ui-token': 'ui-token' }, { origin: 'http://localhost:80', 'x-ip-ui-token': 'wrong' }, auth]) {
      expect([401, 403]).toContain((await post(url(p, a), { slug: p.slug, driver: null }, headers)).statusCode);
    }
    expect((await post(url(p, a), { slug: p.slug })).statusCode).toBe(400);
    expect((await post(url(p, 999999), { slug: p.slug, driver: null })).statusCode).toBe(404);
    expect(ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(before);
    expect(row(ctx, a).status).toBe('todo');
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
