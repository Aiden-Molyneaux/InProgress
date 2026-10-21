import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { raiseAsk } from '../../src/server/repo/asks';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes, applyRankOp, parkNode, requireNode, unparkNode, updateNode } from '../../src/server/repo/nodes';
import { applyQueueOp, getProjectById, setQueue } from '../../src/server/repo/projects';
import { bandOrder, listStepTouches } from '../../src/server/repo/rank';
import { claimStep } from '../../src/server/session-flow';
import type { RankOp } from '../../src/core/types';
import { makeCtx } from '../helpers';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };
const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui-token' };

/** A project with steps A to E, all in Soon with no rank, as the R8 backfill leaves them, and one live session s1. */
async function setup() {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test' });
  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } })).json();
  await app.inject({ method: 'POST', url: `/api/projects/${p.slug}/bindings`, headers: auth, payload: { path: 'C:/personal/InGame' } });
  await app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload: { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' } });
  const [a, b, c, d, e] = addNodes(ctx, 'test', { parentId: p.rootNodeId, nodes: ['A', 'B', 'C', 'D', 'E'].map((title) => ({ title })) }).map((n) => n.id);
  ctx.db.prepare("UPDATE nodes SET rank_band = 'soon' WHERE id IN (?, ?, ?, ?, ?)").run(a, b, c, d, e);
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: UI, payload: payload as object });
  const rank = (op: RankOp, slug: string = p.slug) => post(`/api/ui/projects/${p.id}/rank`, { slug, op });
  const band = (name: 'soon' | 'someday') => bandOrder(ctx, p.id, name).map((m) => m.id);
  const of = (id: number) => ctx.db.prepare('SELECT rank_band AS band, rank, updated_at AS updatedAt FROM nodes WHERE id = ?').get(id) as { band: string | null; rank: number | null; updatedAt: string };
  const unowned = () => getProjectById(ctx, p.id)!.queue.filter((q) => q.sessionId === null).map((q) => q.nodeId);
  return { ctx, app, p, a, b, c, d, e, post, rank, band, of, unowned };
}

describe('the rank write (spec section 3)', () => {
  it('a step a session adds (MCP, API) lands unranked, even when the body names a band', async () => {
    const { app, p } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { parentId: p.rootNodeId, nodes: [{ title: 'From Claude' }] } });
    expect(res.statusCode).toBe(201);
    expect(res.json()[0]).toMatchObject({ rankBand: null, rank: null });
    const banded = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { parentId: p.rootNodeId, band: 'soon', nodes: [{ title: 'Sneaky' }] } });
    if (banded.statusCode === 201) expect(banded.json()[0].rankBand).toBeNull();
    else expect(banded.statusCode).toBe(400);
  });

  it("a step Aiden adds in the window lands at the bottom of Soon, the unranked ones given ranks first in tree order", async () => {
    const { post, p, band, of, a, b, c, d, e } = await setup();
    const before = [a, b, c, d, e].map((id) => of(id).updatedAt);
    const res = await post(`/api/ui/projects/${p.id}/nodes`, { slug: p.slug, title: 'Mine', parent: null, band: 'soon' });
    expect(res.statusCode).toBe(200);
    const mine = res.json().node.id;
    expect(band('soon')).toEqual([a, b, c, d, e, mine]);
    expect([a, b, c, d, e, mine].map((id) => of(id).rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // Materialising writes the rank only: the other steps do not read as touched.
    expect([a, b, c, d, e].map((id) => of(id).updatedAt)).toEqual(before);
    // Without a band (Details' "Add a step under #id"), it stays unranked.
    const plain = await post(`/api/ui/projects/${p.id}/nodes`, { slug: p.slug, title: 'Child', parent: a });
    expect(of(plain.json().node.id).band).toBeNull();
  });

  it('To Next goes to the end of the unowned queue, or where dropped, and keeps the band', async () => {
    const { rank, unowned, of, a, b, c } = await setup();
    expect((await rank({ node: a, to: 'next', before: null })).statusCode).toBe(200);
    expect((await rank({ node: b, to: 'next', before: null })).statusCode).toBe(200);
    const res = await rank({ node: c, to: 'next', before: b });
    expect(res.json().project.queue.map((q: { nodeId: number }) => q.nodeId)).toEqual([a, c, b]);
    expect(unowned()).toEqual([a, c, b]);
    expect(of(c).band).toBe('soon');
  });

  it('Back to Backlog returns a step to its own band and rank, or unranked when it had none', async () => {
    const { ctx, p, rank, band, of, unowned, a, b, c, d } = await setup();
    await rank({ node: c, to: 'soon', before: a });
    const placed = of(c).rank;
    await rank({ node: c, to: 'next', before: null });
    applyQueueOp(ctx, 'window', p.id, { kind: 'remove', node: c });
    expect(unowned()).toEqual([]);
    expect(of(c)).toMatchObject({ band: 'soon', rank: placed });
    expect(band('soon')).toEqual([c, a, b, d, expect.any(Number)]);
    // A triage step sent to Next and back stays unranked.
    ctx.db.prepare('UPDATE nodes SET rank_band = NULL WHERE id = ?').run(d);
    await rank({ node: d, to: 'next', before: null });
    applyQueueOp(ctx, 'window', p.id, { kind: 'remove', node: d });
    expect(of(d).band).toBeNull();
  });

  it('the Band select on a Next up row, or a drag out of it, takes it out of the queue to the place chosen', async () => {
    const { ctx, p, rank, band, unowned, a, b, c, d, e } = await setup();
    setQueue(ctx, 'scribe:s1', p.id, [a], { sessionId: 's1' });
    await rank({ node: b, to: 'next', before: null });
    // Band select Someday: out of the queue, to the bottom of Someday.
    await rank({ node: b, to: 'someday', before: null });
    expect(unowned()).toEqual([]);
    expect(band('someday')).toEqual([b]);
    // Drag out of Next up onto a Soon row: out of its owner's queue too, before the row dropped on.
    const mark = maxEventId(ctx);
    await rank({ node: a, to: 'soon', before: e });
    expect(getProjectById(ctx, p.id)!.queue).toEqual([]);
    expect(band('soon')).toEqual([c, d, a, e]);
    // The queue's change is recorded first, then one node.updated.
    expect(listEventsSince(ctx, mark).map((ev) => [ev.type, (ev.data as { op?: string }).op ?? null])).toEqual([
      ['project.updated', 'rank'],
      ['node.updated', null],
    ]);
  });

  it('the Band select puts the step at the bottom of the band chosen, and moves updated_at', async () => {
    const { rank, band, of, a, b, c, d, e } = await setup();
    const was = of(a).updatedAt;
    await rank({ node: a, to: 'someday', before: null });
    await rank({ node: b, to: 'someday', before: null });
    expect(band('someday')).toEqual([a, b]);
    expect(of(a).updatedAt > was).toBe(true);
    await rank({ node: a, to: 'soon', before: null });
    expect(band('soon')).toEqual([c, d, e, a]);
  });

  it('Move to top puts it first in its own band, and first in the queue for a Next up row', async () => {
    const { rank, band, unowned, a, b, c, d, e } = await setup();
    await rank({ node: d, to: 'soon', before: a });
    expect(band('soon')).toEqual([d, a, b, c, e]);
    await rank({ node: a, to: 'next', before: null });
    await rank({ node: b, to: 'next', before: null });
    await rank({ node: b, to: 'next', before: a });
    expect(unowned()).toEqual([b, a]);
  });

  it('a drag within or across Soon and Someday lands before the row dropped on', async () => {
    const { rank, band, a, b, c, d, e } = await setup();
    await rank({ node: e, to: 'soon', before: b });
    expect(band('soon')).toEqual([a, e, b, c, d]);
    await rank({ node: a, to: 'someday', before: null });
    await rank({ node: c, to: 'someday', before: a });
    expect(band('someday')).toEqual([c, a]);
    await rank({ node: a, to: 'soon', before: d });
    expect(band('soon')).toEqual([e, b, a, d]);
  });

  it('a dense gap renormalises the band to 1..n and keeps its order', async () => {
    const { ctx, rank, band, of, a, b, c, d, e } = await setup();
    const set = ctx.db.prepare('UPDATE nodes SET rank = ? WHERE id = ?');
    [[a, 1], [b, 1 + 1e-7], [c, 2], [d, 3], [e, 4]].forEach(([id, r]) => set.run(r, id));
    await rank({ node: e, to: 'soon', before: b });
    expect(band('soon')).toEqual([a, e, b, c, d]);
    expect([a, b, c, d].map((id) => of(id).rank)).toEqual([1, 2, 3, 4]);
    expect(of(e).rank).toBe(1.5);
  });

  it('Park clears the band and rank, its shelved children keep theirs, and Unpark leaves it unranked', async () => {
    const { ctx, rank, of, unowned, a, b } = await setup();
    const [child] = addNodes(ctx, 'test', { parentId: a, nodes: [{ title: 'Kid' }] });
    ctx.db.prepare("UPDATE nodes SET rank_band = 'someday', rank = 3 WHERE id = ?").run(child.id);
    parkNode(ctx, 'window', a, { reason: 'later' }, () => {});
    expect(of(a)).toMatchObject({ band: null, rank: null });
    expect(of(child.id)).toMatchObject({ band: 'someday', rank: 3 });
    unparkNode(ctx, 'window', a, false, () => {});
    expect(of(a)).toMatchObject({ band: null, rank: null });
    // update_node with status parked clears it too; Unpark with toNext appends to the queue.
    await rank({ node: b, to: 'soon', before: null });
    updateNode(ctx, 'scribe:s1', b, { status: 'parked', parkedReason: 'blocked upstream' });
    expect(of(b)).toMatchObject({ band: null, rank: null });
    unparkNode(ctx, 'window', b, true, () => {});
    expect(of(b).band).toBeNull();
    expect(unowned()).toEqual([b]);
  });

  it('a step claimed by a session keeps its band, so it returns to its place', async () => {
    const { ctx, rank, of, band, a, b } = await setup();
    await rank({ node: b, to: 'soon', before: a });
    const placed = of(b);
    claimStep(ctx, 'scribe:s1', 's1', b);
    expect(requireNode(ctx, b).status).toBe('active');
    expect(of(b)).toMatchObject({ band: 'soon', rank: placed.rank });
    expect(band('soon')[0]).toBe(b);
  });

  it('done and dropped steps keep what they had, and leave the band order', async () => {
    const { ctx, rank, of, band, a, b } = await setup();
    await rank({ node: a, to: 'soon', before: null });
    updateNode(ctx, 'scribe:s1', a, { status: 'done', outcome: 'shipped' });
    updateNode(ctx, 'scribe:s1', b, { status: 'dropped' });
    expect(of(a).band).toBe('soon');
    expect(band('soon')).not.toContain(a);
    expect(band('soon')).not.toContain(b);
  });

  it('Keep is a no-op move: the rank stays and only updated_at moves', async () => {
    const { rank, of, band, a, b, c } = await setup();
    await rank({ node: b, to: 'soon', before: c });
    const was = of(b);
    const res = await rank({ node: b, to: 'soon', before: c });
    expect(res.statusCode).toBe(200);
    expect(of(b).rank).toBe(was.rank);
    expect(of(b).updatedAt > was.updatedAt).toBe(true);
    expect(band('soon').slice(0, 3)).toEqual([a, b, c]);
    // The last row of a band keeps its rank with before null.
    const last = band('soon').at(-1)!;
    const lastRank = of(last).rank;
    await rank({ node: last, to: 'soon', before: null });
    expect(of(last).rank).toBe(lastRank);
  });
});

describe('the rank write refuses (409)', () => {
  it('a step of another project, the root, a step not open, a shelved step and a group', async () => {
    const { ctx, app, p, rank, a, b, c, d } = await setup();
    const other = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Other' } })).json();
    const [stranger] = addNodes(ctx, 'test', { parentId: other.rootNodeId, nodes: [{ title: 'Elsewhere' }] });
    expect((await rank({ node: stranger.id, to: 'soon', before: null })).statusCode).toBe(409);
    expect((await rank({ node: p.rootNodeId, to: 'soon', before: null })).statusCode).toBe(409);
    updateNode(ctx, 'scribe:s1', a, { status: 'done', outcome: 'x' });
    expect((await rank({ node: a, to: 'next', before: null })).statusCode).toBe(409);
    const [kid] = addNodes(ctx, 'test', { parentId: b, nodes: [{ title: 'Kid' }] });
    // b now has an open step under it: a group, not a row.
    expect((await rank({ node: b, to: 'someday', before: null })).statusCode).toBe(409);
    parkNode(ctx, 'window', b, { reason: 'later' }, () => {});
    expect((await rank({ node: kid.id, to: 'soon', before: null })).statusCode).toBe(409);
    expect((await rank({ node: b, to: 'soon', before: null })).statusCode).toBe(409);
    // A before that is not in the band named, or is the step itself.
    expect((await rank({ node: c, to: 'someday', before: d })).statusCode).toBe(409);
    expect((await rank({ node: c, to: 'soon', before: c })).statusCode).toBe(409);
    // Nothing moved for any of them.
    expect(bandOrder(ctx, p.id, 'someday')).toEqual([]);
  });

  it('a slug that does not match the id', async () => {
    const { rank, a } = await setup();
    expect((await rank({ node: a, to: 'soon', before: null }, 'wrong')).statusCode).toBe(409);
  });

  it('applyRankOp leaves nothing behind when it refuses after materialising', async () => {
    const { ctx, p, of, a, b, e } = await setup();
    expect(() => applyRankOp(ctx, 'window', p.id, { node: a, to: 'soon', before: 999999 })).toThrow(/not in Soon/);
    expect([a, b, e].map((id) => of(id).rank)).toEqual([null, null, null]);
  });
});

describe('the label and move routes', () => {
  it('sets and clears a label, and refuses a step of another project', async () => {
    const { ctx, app, p, post, a } = await setup();
    const res = await post(`/api/ui/projects/${p.id}/nodes/${a}/label`, { slug: p.slug, label: 'data' });
    expect(res.statusCode).toBe(200);
    expect(res.json().node.label).toBe('data');
    expect((await post(`/api/ui/projects/${p.id}/nodes/${a}/label`, { slug: p.slug, label: null })).json().node.label).toBeNull();
    expect((await post(`/api/ui/projects/${p.id}/nodes/${a}/label`, { slug: p.slug, label: 'nope' })).statusCode).toBe(400);
    const other = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Other' } })).json();
    const [stranger] = addNodes(ctx, 'test', { parentId: other.rootNodeId, nodes: [{ title: 'Elsewhere' }] });
    expect((await post(`/api/ui/projects/${p.id}/nodes/${stranger.id}/label`, { slug: p.slug, label: 'ui' })).statusCode).toBe(409);
  });

  it('moves a step last under its new phase, or to No phase, keeping its rank', async () => {
    const { ctx, p, post, rank, of, a, b, c } = await setup();
    const [phase] = addNodes(ctx, 'test', { parentId: p.rootNodeId, nodes: [{ title: 'Phase', kind: 'phase', children: [{ title: 'Inside' }] }] });
    await rank({ node: a, to: 'soon', before: b });
    const placed = of(a).rank;
    const res = await post(`/api/ui/projects/${p.id}/nodes/${a}/move`, { slug: p.slug, parent: phase.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().node.parentId).toBe(phase.id);
    const kids = ctx.db.prepare('SELECT id FROM nodes WHERE parent_id = ? ORDER BY position').pluck().all(phase.id);
    expect(kids.at(-1)).toBe(a);
    expect(of(a).rank).toBe(placed);
    expect((await post(`/api/ui/projects/${p.id}/nodes/${a}/move`, { slug: p.slug, parent: null })).json().node.parentId).toBe(p.rootNodeId);
    // Under itself or a step of its own: the repo refuses.
    const [kid] = addNodes(ctx, 'test', { parentId: c, nodes: [{ title: 'Kid' }] });
    expect((await post(`/api/ui/projects/${p.id}/nodes/${c}/move`, { slug: p.slug, parent: kid.id })).statusCode).toBe(400);
  });

  it('refuses a parked, shelved or dropped parent (409)', async () => {
    const { ctx, p, post, a, b, c, d } = await setup();
    const [kid] = addNodes(ctx, 'test', { parentId: b, nodes: [{ title: 'Kid' }] });
    parkNode(ctx, 'window', b, { reason: 'later' }, () => {});
    expect((await post(`/api/ui/projects/${p.id}/nodes/${a}/move`, { slug: p.slug, parent: b })).statusCode).toBe(409);
    expect((await post(`/api/ui/projects/${p.id}/nodes/${a}/move`, { slug: p.slug, parent: kid.id })).statusCode).toBe(409);
    updateNode(ctx, 'scribe:s1', c, { status: 'dropped' });
    expect((await post(`/api/ui/projects/${p.id}/nodes/${d}/move`, { slug: p.slug, parent: c })).statusCode).toBe(409);
    expect((await post(`/api/ui/projects/${p.id}/nodes/${d}/move`, { slug: p.slug, parent: 999999 })).statusCode).toBe(409);
    expect(requireNode(ctx, a).parentId).toBe(p.rootNodeId);
  });
});

describe('listStepTouches', () => {
  it('names the newest focusing session and the newest ask of each open banded step, however old', async () => {
    const { ctx, p, a, b, c } = await setup();
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, focus_node_id, started_at, last_seen_at, ended_at) VALUES ('old', ?, 'ended', ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z')").run(p.id, a);
    raiseAsk(ctx, 'scribe:s1', { nodeId: b, kind: 'question', text: 'Which?' });
    const touches = listStepTouches(ctx, p.id);
    // An ended session counts from the earlier of its end and its last sign.
    expect(touches.find((t) => t.nodeId === a)).toEqual({ nodeId: a, sessionAt: '2026-01-02T00:00:00.000Z', askAt: null });
    expect(touches.find((t) => t.nodeId === b)?.askAt).toEqual(expect.any(String));
    expect(touches.some((t) => t.nodeId === c)).toBe(false);
  });
});
