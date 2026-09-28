import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildApp, type AppOptions } from '../../src/server/app';
import { makeCtx } from '../helpers';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };

function setup(extra: Partial<AppOptions> = {}) {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test', ...extra });
  return { ctx, app };
}

describe('guards', () => {
  it('serves health and rejects foreign Host headers', async () => {
    const { app } = setup();
    const ok = await app.inject({ url: '/api/health' });
    expect(ok.json()).toMatchObject({ ok: true, app: 'inprogress', version: 'test' });
    const bad = await app.inject({ url: '/api/health', headers: { host: 'evil.example:4317' } });
    expect(bad.statusCode).toBe(403);
  });

  it('requires the token for writes and explains validation and lookup errors', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'X' } })).statusCode).toBe(401);
    const invalid = await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: '', extra: 1 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().hint).toContain('name');
    const missing = await app.inject({ url: '/api/projects/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'Project "nope" not found' });
  });
});

describe('project lifecycle over HTTP', () => {
  it('creates, binds, plans, updates, moves, attaches, logs, searches and outlines', async () => {
    const { app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame', description: 'Game app' } })).json();
    expect(p.slug).toBe('ingame');
    const b = await app.inject({ method: 'POST', url: '/api/projects/ingame/bindings', headers: auth, payload: { path: 'C:\\personal\\InGame' } });
    expect(b.statusCode).toBe(201);
    expect((await app.inject({ url: '/api/bindings' })).json()).toHaveLength(1);
    const nodes = (await app.inject({
      method: 'POST', url: '/api/nodes', headers: auth,
      payload: { parentId: p.rootNodeId, nodes: [{ title: 'Road to market', kind: 'phase', status: 'active', children: [{ title: 'iOS cert' }, { title: 'Run tests', assignee: 'me' }] }] },
    })).json();
    expect(nodes.map((n: { title: string }) => n.title)).toEqual(['Road to market', 'iOS cert', 'Run tests']);
    const [road, ios, tests] = nodes;
    expect((await app.inject({ method: 'PATCH', url: `/api/nodes/${ios.id}`, headers: auth, payload: { status: 'done', outcome: 'Cert installed' } })).json().status).toBe('done');
    const moved = await app.inject({ method: 'POST', url: `/api/nodes/${tests.id}/move`, headers: auth, payload: { parentId: road.id, after: 'start' } });
    expect(moved.statusCode).toBe(200);
    const res = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: tests.id, kind: 'test-suite', title: 'Signing suite', content: '# Signing tests' } })).json();
    expect((await app.inject({ url: `/api/resources/${res.id}` })).json().content).toBe('# Signing tests');
    expect((await app.inject({ method: 'PATCH', url: `/api/resources/${res.id}`, headers: auth, payload: { title: 'Suite v2' } })).json().title).toBe('Suite v2');
    expect((await app.inject({ method: 'POST', url: `/api/nodes/${road.id}/log`, headers: auth, payload: { text: 'Detour: sandbox wedge' } })).statusCode).toBe(201);
    const detail = (await app.inject({ url: `/api/nodes/${road.id}` })).json();
    expect(detail.log[0].text).toBe('Detour: sandbox wedge');
    expect((await app.inject({ url: '/api/search?project=ingame&q=signing' })).json().resources[0].title).toBe('Suite v2');
    const outline = await app.inject({ url: '/api/projects/ingame/outline' });
    expect(outline.headers['content-type']).toContain('text/plain');
    expect(outline.body).toContain(`#${tests.id} Run tests — NEEDS YOU [r${res.id}]`);
    const snap = (await app.inject({ url: '/api/projects/ingame' })).json();
    expect(snap.nodes).toHaveLength(4);
    expect(snap.lastEvent.type).toBe('log.created');
    expect((await app.inject({ method: 'DELETE', url: `/api/nodes/${road.id}`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/nodes/${road.id}?cascade=1`, headers: auth })).json().ids).toHaveLength(3);
    expect((await app.inject({ method: 'DELETE', url: `/api/resources/${res.id}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/api/projects/ingame', headers: auth, payload: { status: 'archived' } })).json().status).toBe('archived');
    expect((await app.inject({ url: '/api/projects' })).json()[0].slug).toBe('ingame');
  });
});

describe('session routes', () => {
  it('handles hook events, enrollment and focus', async () => {
    const { app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } })).json();
    const untracked = await app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload: { event: 'start', source: 'startup', cwd: 'C:/x' } });
    expect(untracked.json()).toEqual({ tracked: false });
    const enrolled = (await app.inject({ method: 'POST', url: '/api/sessions/s1/enroll', headers: auth, payload: { project: 'ingame', title: 'Launch' } })).json();
    expect(enrolled.briefing).toContain('Session id: s1');
    const focus = await app.inject({ method: 'POST', url: '/api/sessions/s1/focus', headers: auth, payload: { nodeId: p.rootNodeId } });
    expect(focus.json().focusNodeId).toBe(p.rootNodeId);
    const bad = await app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload: { event: 'nonsense' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('ui routes', () => {
  it('opens only a stored resource path, and only with the UI token', async () => {
    const opened: string[] = [];
    const { app } = setup({ openPath: async (p) => { opened.push(p); } });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'P' } })).json();
    const file = join(mkdtempSync(join(tmpdir(), 'ip-open-')), 'suite.md');
    writeFileSync(file, '# x');
    const withPath = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: p.rootNodeId, kind: 'doc', title: 'Doc', path: file } })).json();
    const noPath = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: p.rootNodeId, kind: 'doc', title: 'Inline', content: 'x' } })).json();
    expect((await app.inject({ method: 'POST', url: '/api/ui/open', payload: { resourceId: withPath.id } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: withPath.id } });
    expect(ok.statusCode).toBe(200);
    expect(opened).toEqual([file]);
    const none = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: noPath.id } });
    expect(none.statusCode).toBe(400);
  });

  it('reports an unbuilt UI, and injects the UI token into a built one', async () => {
    expect((await setup().app.inject({ url: '/' })).statusCode).toBe(503);
    const webDir = mkdtempSync(join(tmpdir(), 'ip-web-'));
    writeFileSync(join(webDir, 'index.html'), '<html><head><meta name="ip-ui-token" content="" /></head><body></body></html>');
    const res = await setup({ webDir }).app.inject({ url: '/' });
    expect(res.body).toContain('<meta name="ip-ui-token" content="ui-token">');
  });

  it('shuts down on request', async () => {
    const onShutdown = vi.fn();
    const { app } = setup({ onShutdown });
    expect((await app.inject({ method: 'POST', url: '/api/admin/shutdown', headers: auth })).statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(onShutdown).toHaveBeenCalledOnce();
  });
});
