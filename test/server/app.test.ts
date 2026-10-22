import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppOptions } from '../../src/server/app';
import { makeCtx } from '../helpers';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };
/** The window's own pages send this Origin: the scheme and the Host (inject's default Host is localhost:80). */
const SAME_ORIGIN = { origin: 'http://localhost:80' };

function setup(extra: Partial<AppOptions> = {}) {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test', ...extra });
  return { ctx, app };
}

/** Store a resource with this path on the node, then ask the UI route to open it. */
async function openStoredPath(app: FastifyInstance, nodeId: number, path: string) {
  const resource = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId, kind: 'doc', title: 'Doc', path } })).json();
  return app.inject({ method: 'POST', url: '/api/ui/open', headers: { ...SAME_ORIGIN, 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: resource.id } });
}

describe('guards', () => {
  it('serves health and rejects foreign Host headers', async () => {
    const { app } = setup();
    const ok = await app.inject({ url: '/api/health' });
    expect(ok.json()).toMatchObject({ ok: true, app: 'inprogress', version: 'test' });
    const bad = await app.inject({ url: '/api/health', headers: { host: 'evil.example:4317' } });
    expect(bad.statusCode).toBe(403);
  });

  it('names the running build in health, or null when it is unknown', async () => {
    const build = { sha: 'abc1234', dirty: false, builtAt: '2026-10-02T12:00:00.000Z' };
    const known = buildApp({ ctx: makeCtx(), token: 'tok', uiToken: 'u', version: 'test', build });
    expect((await known.inject({ url: '/api/health' })).json()).toMatchObject({ build });
    const unknown = buildApp({ ctx: makeCtx(), token: 'tok', uiToken: 'u', version: 'test' });
    expect((await unknown.inject({ url: '/api/health' })).json()).toMatchObject({ build: null });
  });

  it('accepts loopback names on any port and refuses look-alike hosts', async () => {
    const { app } = setup();
    for (const host of ['localhost:1234', 'localhost', 'LOCALHOST:4317', '127.0.0.1:65535', '[::1]', '[::1]:4399']) {
      expect((await app.inject({ url: '/api/health', headers: { host } })).statusCode, host).toBe(200);
    }
    for (const host of ['evil.com', 'evil.com:4317', '127.0.0.1.evil.com', '127.0.0.1.evil.com:4317', 'localhost.evil.com']) {
      const res = await app.inject({ url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(403);
      expect(res.json()).toEqual({ error: 'Forbidden host' });
    }
  });

  it('refuses a wrong bearer token of the right length', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` }, payload: { name: 'X' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Missing or invalid InProgress token' });
  });

  it('answers an oversized body with 413 and malformed JSON with 400, in the usual error shape', async () => {
    const { app } = setup();
    const json = { ...auth, 'content-type': 'application/json' };
    const big = await app.inject({ method: 'POST', url: '/api/projects', headers: json, payload: `{"name":"${'x'.repeat(8 * 1024 * 1024)}"}` });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: 'Request body is too large' });
    const broken = await app.inject({ method: 'POST', url: '/api/projects', headers: json, payload: '{"name":' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toEqual({ error: expect.stringContaining('not valid JSON') });
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

  it('refuses to build without both tokens', () => {
    expect(() => setup({ token: '' })).toThrow('needs a non-empty token and uiToken');
    expect(() => setup({ uiToken: '' })).toThrow('needs a non-empty token and uiToken');
  });

  it('records an empty actor header as system', async () => {
    const { ctx, app } = setup();
    await app.inject({ method: 'POST', url: '/api/projects', headers: { ...auth, 'x-inprogress-actor': '' }, payload: { name: 'P' } });
    expect(ctx.db.prepare('SELECT DISTINCT actor FROM events').all()).toEqual([{ actor: 'system' }]);
  });

  it('accepts only http(s) resource urls', async () => {
    const { app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'P' } })).json();
    const addLink = (link: string) =>
      app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: p.rootNodeId, kind: 'link', title: 'Link', url: link } });
    const bad = await addLink('javascript:alert(1)');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().hint).toContain('url must start with http:// or https://');
    const good = await addLink('https://example.com/docs');
    expect(good.statusCode).toBe(201);
    const patched = await app.inject({ method: 'PATCH', url: `/api/resources/${good.json().id}`, headers: auth, payload: { url: 'javascript:alert(1)' } });
    expect(patched.statusCode).toBe(400);
  });
});

describe('logging', () => {
  it('logs server errors but not every request', async () => {
    const lines: string[] = [];
    const { app } = setup({ logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } });
    app.get('/api/test-boom', async () => {
      throw new Error('boom');
    });
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/nowhere' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/test-boom' })).statusCode).toBe(500);
    expect(lines.filter((l) => /incoming request|request completed|request errored|not found/.test(l))).toEqual([]);
    expect(lines.filter((l) => JSON.parse(l).msg === 'boom')).toHaveLength(1);
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
    expect(outline.body).toContain(`#${tests.id} Run tests · NEEDS YOU [r${res.id}]`);
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

describe('type labels over HTTP', () => {
  const SET = 'ui, server, data, integration, ops, docs, fix, refactor, research';

  it('takes a label on add, nested steps too, and on patch, where null clears it', async () => {
    const { app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InProgress' } })).json();
    const added = await app.inject({
      method: 'POST', url: '/api/nodes', headers: auth,
      payload: { parentId: p.rootNodeId, nodes: [{ title: 'Type labels', kind: 'phase', children: [{ title: 'Migration 3', label: 'data' }, { title: 'Glyph chip', label: 'ui' }] }] },
    });
    expect(added.statusCode).toBe(201);
    const [phase, migration] = added.json();
    expect(added.json().map((n: { label: string | null }) => n.label)).toEqual([null, 'data', 'ui']);
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/nodes/${migration.id}`, headers: auth, payload });
    expect((await patch({ label: 'fix' })).json().label).toBe('fix');
    expect((await patch({ status: 'active' })).json().label).toBe('fix');
    expect((await patch({ label: null })).json().label).toBeNull();
    expect((await app.inject({ url: `/api/nodes/${phase.id}` })).json().node.label).toBeNull();
  });

  it('refuses an unknown label with a hint that lists the set', async () => {
    const { app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InProgress' } })).json();
    const nested = await app.inject({
      method: 'POST', url: '/api/nodes', headers: auth,
      payload: { parentId: p.rootNodeId, nodes: [{ title: 'Phase', children: [{ title: 'Step', label: 'frontend' }] }] },
    });
    expect(nested.statusCode).toBe(400);
    expect(nested.json().hint).toBe(`nodes.0.children.0.label: Unknown label "frontend". Use one of: ${SET}.`);
    const [n] = (await app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { parentId: p.rootNodeId, nodes: [{ title: 'Step' }] } })).json();
    const patched = await app.inject({ method: 'PATCH', url: `/api/nodes/${n.id}`, headers: auth, payload: { label: 'UI' } });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().hint).toBe(`label: Unknown label "UI". Use one of: ${SET}.`);
  });
});

describe('what, why and origin over HTTP', () => {
  it('refuses origin me and a 501-character why on add, and takes origin me on update', async () => {
    const { app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InProgress' } })).json();
    const add = (node: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { parentId: p.rootNodeId, nodes: [{ title: 'Step', ...node }] } });
    expect((await add({ origin: 'me' })).statusCode).toBe(400);
    expect((await add({ why: 'x'.repeat(501) })).statusCode).toBe(400);
    const ok = await add({ what: ' Does it. ', why: 'y'.repeat(500), origin: 'proposed' });
    expect(ok.statusCode).toBe(201);
    const [n] = ok.json();
    expect(n).toMatchObject({ what: 'Does it.', origin: 'proposed' });
    const patched = await app.inject({ method: 'PATCH', url: `/api/nodes/${n.id}`, headers: auth, payload: { origin: 'me', why: ' Because. ' } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ origin: 'me', why: 'Because.', what: 'Does it.' });
    expect((await app.inject({ method: 'PATCH', url: `/api/nodes/${n.id}`, headers: auth, payload: { origin: 'other' } })).statusCode).toBe(400);
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

  it('accepts cwd and branch on a prompt and tracks an unseen session in a bound folder', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } });
    await app.inject({ method: 'POST', url: '/api/projects/ingame/bindings', headers: auth, payload: { path: 'C:/personal/InGame' } });
    const body = { event: 'prompt', cwd: 'C:\\personal\\InGame', branch: null, title: 'Late', transcriptPath: 'C:/t.jsonl', mentionsInProgress: false, asksStatus: false };
    const res = await app.inject({ method: 'POST', url: '/api/sessions/p1/hook', headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tracked: true, context: expect.stringContaining('tracked in project "InGame" (slug ingame). Session id: p1.') });
    const elsewhere = await app.inject({ method: 'POST', url: '/api/sessions/p2/hook', headers: auth, payload: { ...body, cwd: 'C:/elsewhere', branch: 'main' } });
    expect(elsewhere.json()).toEqual({ tracked: false });
  });

  it('accepts stopHookActive on a stop, and only as a boolean', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } });
    await app.inject({ method: 'POST', url: '/api/sessions/s1/enroll', headers: auth, payload: { project: 'ingame' } });
    const stop = (stopHookActive: unknown) => app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload: { event: 'stop', stopHookActive } });
    expect((await stop(true)).statusCode).toBe(200);
    expect((await stop(false)).statusCode).toBe(200);
    expect((await stop('yes')).statusCode).toBe(400);
  });

  it('ignores an unknown key on a hook body, so a hook newer than the running server is not rejected', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } });
    await app.inject({ method: 'POST', url: '/api/sessions/s1/enroll', headers: auth, payload: { project: 'ingame' } });
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload });
    const plain = await post({ event: 'stop' });
    const extra = await post({ event: 'stop', someFutureField: 'x' });
    expect(extra.statusCode).toBe(200);
    expect(extra.json()).toEqual(plain.json());
    // Also inside a list entry, where a newer hook may add a field the same way.
    const nested = await post({ event: 'stop', background: [{ taskId: 't1', type: 'shell', someFutureField: 1 }] });
    expect(nested.statusCode).toBe(200);
    expect((await post({ event: 'prompt', notice: true, tasks: [{ taskId: 't1', status: 'completed', someFutureField: 1 }] })).statusCode).toBe(200);
    // Field-level validation is unchanged: a known key with a bad value is still a 400.
    expect((await post({ event: 'stop', stopHookActive: 'yes', someFutureField: 'x' })).statusCode).toBe(400);
  });

  it("reads a session's claimed step for the status line, without a token, and null for no step or no session", async () => {
    const { app } = setup();
    const step = (id: string) => app.inject({ url: `/api/sessions/${id}/step` });
    expect((await step('nobody')).statusCode).toBe(200);
    expect((await step('nobody')).json()).toEqual({ step: null });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } })).json();
    await app.inject({ method: 'POST', url: '/api/sessions/s1/enroll', headers: auth, payload: { project: 'ingame' } });
    expect((await step('s1')).json()).toEqual({ step: null });
    const [node] = (await app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { parentId: p.rootNodeId, nodes: [{ title: 'Show titles next to ids' }] } })).json();
    await app.inject({ method: 'POST', url: '/api/sessions/s1/claim', headers: auth, payload: { nodeId: node.id } });
    expect((await step('s1')).json()).toEqual({ step: { id: node.id, title: 'Show titles next to ids', status: 'active' } });
    await app.inject({ method: 'DELETE', url: `/api/nodes/${node.id}`, headers: auth });
    expect((await step('s1')).json()).toEqual({ step: null });
  });
});

describe('live work routes', () => {
  async function planned() {
    const { app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } })).json();
    const nodes = (await app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { parentId: p.rootNodeId, nodes: [{ title: 'Tabs' }, { title: 'Guide' }, { title: 'Polish' }] } })).json();
    await app.inject({ method: 'POST', url: '/api/sessions/s1/enroll', headers: auth, payload: { project: 'ingame' } });
    return { app, p, ids: nodes.map((n: { id: number }) => n.id) as number[] };
  }

  it('sets the queue, which the snapshot and the outline show', async () => {
    const { app, ids: [tabs, guide] } = await planned();
    const res = await app.inject({ method: 'POST', url: '/api/projects/ingame/queue', headers: auth, payload: { nodes: [guide, tabs] } });
    expect(res.statusCode).toBe(200);
    const unowned = [{ nodeId: guide, sessionId: null }, { nodeId: tabs, sessionId: null }];
    expect(res.json()).toMatchObject({ slug: 'ingame', queue: unowned });
    expect((await app.inject({ url: '/api/projects/ingame' })).json().project.queue).toEqual(unowned);
    const lines = (await app.inject({ url: '/api/projects/ingame/outline' })).body.split('\n');
    expect(lines.slice(0, 2)).toEqual(['Project InGame (slug ingame)', `Up next: later: #${guide} → #${tabs}`]);
    // A session's own steps lead, under its title.
    await app.inject({ method: 'POST', url: '/api/projects/ingame/queue', headers: auth, payload: { nodes: [tabs], session: 's1' } });
    expect((await app.inject({ url: '/api/projects/ingame/outline' })).body.split('\n')[1]).toBe(`Up next: "Session s1": #${tabs} | later: #${guide}`);
    await app.inject({ method: 'POST', url: '/api/projects/ingame/queue', headers: auth, payload: { nodes: [], session: 's1' } });
    await app.inject({ method: 'POST', url: '/api/projects/ingame/queue', headers: auth, payload: { nodes: [] } });
    expect((await app.inject({ url: '/api/projects/ingame/outline' })).body).not.toContain('Up next');
  });

  it("writes a session's own entries with session, and the unowned ones without it or with unowned: true", async () => {
    const { app, ids: [tabs, guide, polish] } = await planned();
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/projects/ingame/queue', headers: auth, payload });
    await post({ nodes: [tabs], session: 's1' });
    await post({ nodes: [polish], session: 's1', unowned: true });
    expect((await post({ nodes: [guide, polish], unowned: true })).json().queue).toEqual([
      { nodeId: tabs, sessionId: 's1' }, { nodeId: guide, sessionId: null }, { nodeId: polish, sessionId: null },
    ]);
    const stranger = await post({ nodes: [tabs], session: 'nobody' });
    expect(stranger.statusCode).toBe(400);
    expect(stranger.json()).toEqual({ error: 'Session nobody is not tracked in project ingame', hint: expect.stringContaining('enroll_session') });
    expect((await post({ nodes: [tabs], session: '' })).statusCode).toBe(400);
    expect((await post({ nodes: [tabs], session: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await post({ nodes: [tabs], unowned: 'yes' })).statusCode).toBe(400);
  });

  it('refuses a queue with a node of another project, an unknown project, or no token', async () => {
    const { app, ids } = await planned();
    const other = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Other' } })).json();
    const bad = await app.inject({ method: 'POST', url: '/api/projects/ingame/queue', headers: auth, payload: { nodes: [ids[0], other.rootNodeId] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: `#${other.rootNodeId} is not in project ingame`, hint: 'Use get_outline to find the right #id.' });
    expect((await app.inject({ method: 'POST', url: '/api/projects/nope/queue', headers: auth, payload: { nodes: [] } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/projects/ingame/queue', payload: { nodes: [] } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/projects/ingame/queue', headers: auth, payload: { nodes: ['#1'] } })).statusCode).toBe(400);
  });

  it("replaces a session's working tasks on a node, which the snapshot shows", async () => {
    const { app, ids: [tabs] } = await planned();
    const tasks = [{ subject: 'Build the tab strip', status: 'in_progress' }, { subject: 'Wire the hash route', status: 'pending' }];
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s1/tasks', headers: auth, payload: { nodeId: tabs, tasks } });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodeId).toBe(tabs);
    expect(res.json().tasks.map((t: { subject: string; status: string }) => [t.subject, t.status])).toEqual([['Build the tab strip', 'in_progress'], ['Wire the hash route', 'pending']]);
    const snap = (await app.inject({ url: '/api/projects/ingame' })).json();
    expect(snap.workItems).toEqual([
      expect.objectContaining({ nodeId: tabs, sessionId: 's1', agentId: '', subject: 'Build the tab strip', status: 'in_progress', blocks: [] }),
      expect.objectContaining({ nodeId: tabs, sessionId: 's1', agentId: '', subject: 'Wire the hash route', status: 'pending', blocks: [] }),
    ]);
    const untracked = await app.inject({ method: 'POST', url: '/api/sessions/nobody/tasks', headers: auth, payload: { nodeId: tabs, tasks } });
    expect(untracked.statusCode).toBe(400);
    expect(untracked.json().error).toBe('Session nobody is not tracked');
    const badStatus = await app.inject({ method: 'POST', url: '/api/sessions/s1/tasks', headers: auth, payload: { nodeId: tabs, tasks: [{ subject: 'x', status: 'deleted' }] } });
    expect(badStatus.statusCode).toBe(400);
  });

  it("puts the tasks on the session's focus when no step is named, and refuses with a hint when it has none", async () => {
    const { app, ids: [, guide] } = await planned();
    const tasks = [{ subject: 'Draft the guide', status: 'in_progress' }];
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/sessions/s1/tasks', headers: { ...auth, 'x-inprogress-actor': 'session:s1' }, payload });
    const unfocused = await post({ tasks });
    expect(unfocused.statusCode).toBe(400);
    expect(unfocused.json()).toEqual({ error: 'This session has no focus', hint: 'Name the step: tasks <id> …' });
    await app.inject({ method: 'POST', url: '/api/sessions/s1/focus', headers: auth, payload: { nodeId: guide } });
    const focused = await post({ tasks });
    expect(focused.statusCode).toBe(200);
    expect(focused.json()).toMatchObject({ nodeId: guide, tasks: [{ nodeId: guide, subject: 'Draft the guide', status: 'in_progress' }] });
  });

  it('takes the live-work fields on the hook route, drops unknown ones and refuses bad values', async () => {
    const { app } = await planned();
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload });
    for (const payload of [
      { event: 'agent-dispatch', toolUseId: 'toolu_1', agentType: 'Explore', description: 'Map the hooks', model: 'sonnet', purpose: `${'p'.repeat(199)}…` },
      { event: 'subagent-start', agentId: 'a1', agentType: 'Explore' },
      { event: 'agent-launched', toolUseId: 'toolu_1', agentId: 'a1', model: 'sonnet-5' },
      { event: 'task-created', taskKey: '1', subject: 'Write it' },
      { event: 'task-updated', taskKey: '1', status: 'in_progress', subject: 'Write it now', addBlocks: ['2'], addBlockedBy: [], agentId: 'a1' },
    ]) {
      expect((await post(payload)).json(), payload.event).toEqual({ tracked: true });
    }
    // An unknown key such as a whole prompt is dropped at parse, so the handler never sees it.
    expect((await post({ event: 'task-created', taskKey: '2', subject: 'x', prompt: 'never sent' })).json()).toEqual({ tracked: true });
    expect((await post({ event: 'task-updated', taskKey: '2', status: 'archived' })).statusCode).toBe(400);
    expect((await post({ event: 'task-created', taskKey: '3', subject: 'x'.repeat(301) })).statusCode).toBe(400);
    expect((await post({ event: 'agent-dispatch', toolUseId: 'toolu_2', agentType: 'Explore', description: 'x', purpose: 'p'.repeat(201) })).statusCode).toBe(400);
  });
});

describe('outline', () => {
  it('heads the outline with the project playbook when there is one', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame', playbook: 'Planning docs live in docs/planning.\r\nTickets are VCAD-###.\n' } });
    const lines = (await app.inject({ url: '/api/projects/ingame/outline' })).body.split('\n');
    expect(lines.slice(0, 3)).toEqual(['Project InGame (slug ingame)', 'Playbook:', '  Planning docs live in docs/planning.']);
    expect(lines[3]).toBe('  Tickets are VCAD-###.');
    expect(lines[4]).toMatch(/^#\d+ InGame · active$/);
    await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Plain', playbook: '  \n' } });
    const plain = (await app.inject({ url: '/api/projects/plain/outline' })).body;
    expect(plain).not.toContain('Playbook:');
    expect(plain.split('\n')[1]).toMatch(/^#\d+ Plain · active$/);
  });
});

describe('ui routes', () => {
  it('opens only a stored resource path, and only with the UI token', async () => {
    const opened: string[] = [];
    const { app } = setup({ openPath: async (p) => { opened.push(p); } });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'P' } })).json();
    const file = join(tempDir('ip-open-'), 'suite.md');
    writeFileSync(file, '# x');
    const withPath = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: p.rootNodeId, kind: 'doc', title: 'Doc', path: file } })).json();
    const noPath = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: p.rootNodeId, kind: 'doc', title: 'Inline', content: 'x' } })).json();
    expect((await app.inject({ method: 'POST', url: '/api/ui/open', headers: SAME_ORIGIN, payload: { resourceId: withPath.id } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { ...SAME_ORIGIN, 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: withPath.id } });
    expect(ok.statusCode).toBe(200);
    expect(opened).toEqual([file]);
    const none = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { ...SAME_ORIGIN, 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: noPath.id } });
    expect(none.statusCode).toBe(400);
  });

  it('refuses UNC and device paths before touching them', async () => {
    const opened: string[] = [];
    const { app } = setup({ openPath: async (p) => { opened.push(p); } });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'P' } })).json();
    const file = join(tempDir('ip-open-'), 'suite.md');
    writeFileSync(file, '# x');
    // The \\?\ form names a real file, so only the local-path check can refuse it.
    for (const path of [`\\\\?\\${file}`, '\\\\.\\C:\\suite.md', '\\\\127.0.0.1\\share\\suite.md', '//127.0.0.1/share/suite.md']) {
      const res = await openStoredPath(app, p.rootNodeId, path);
      expect(res.statusCode, path).toBe(400);
      expect(res.json().error).toBe(`Not a local absolute path: ${path}`);
    }
    expect(opened).toEqual([]);
  });

  it('refuses a UI token of the right length that does not match', async () => {
    const opened: string[] = [];
    const { app } = setup({ openPath: async (p) => { opened.push(p); } });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'P' } })).json();
    const file = join(tempDir('ip-open-'), 'suite.md');
    writeFileSync(file, '# x');
    const resource = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: p.rootNodeId, kind: 'doc', title: 'Doc', path: file } })).json();
    for (const token of ['ui-tokeN', 'ui-token-longer', '']) {
      const res = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { ...SAME_ORIGIN, 'x-ip-ui-token': token }, payload: { resourceId: resource.id } });
      expect(res.statusCode, token).toBe(401);
      expect(res.json()).toEqual({ error: 'Missing or invalid UI token' });
    }
    expect(opened).toEqual([]);
  });

  it('reports a missing file', async () => {
    const opened: string[] = [];
    const { app } = setup({ openPath: async (p) => { opened.push(p); } });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'P' } })).json();
    const dir = tempDir('ip-open-');
    const missing = join(dir, 'gone.md');
    const res = await openStoredPath(app, p.rootNodeId, missing);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: `File not found: ${missing}` });
    // A path that runs through a file (ENOTDIR on POSIX) is just as missing.
    const file = join(dir, 'real.md');
    writeFileSync(file, 'x');
    const nested = await openStoredPath(app, p.rootNodeId, join(file, 'child.md'));
    expect(nested.json()).toEqual({ error: `File not found: ${join(file, 'child.md')}` });
    expect(opened).toEqual([]);
  });

  it('refuses a folder path', async () => {
    const opened: string[] = [];
    const { app } = setup({ openPath: async (p) => { opened.push(p); } });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'P' } })).json();
    const dir = tempDir('ip-open-');
    const res = await openStoredPath(app, p.rootNodeId, dir);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(`Not a file: ${dir}`);
    expect(opened).toEqual([]);
  });

  it('reports an unbuilt UI, and injects the UI token into a built one', async () => {
    expect((await setup().app.inject({ url: '/' })).statusCode).toBe(503);
    const webDir = tempDir('ip-web-');
    writeFileSync(join(webDir, 'index.html'), '<html><head><meta name="ip-ui-token" content="" /></head><body></body></html>');
    const res = await setup({ webDir }).app.inject({ url: '/' });
    expect(res.body).toContain('<meta name="ip-ui-token" content="ui-token">');
  });

  it('serves the UI under a Content-Security-Policy', async () => {
    const webDir = tempDir('ip-web-');
    writeFileSync(join(webDir, 'index.html'), '<html><head><meta name="ip-ui-token" content="" /></head><body></body></html>');
    const res = await setup({ webDir }).app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('injects the UI token literally', async () => {
    const webDir = tempDir('ip-web-');
    writeFileSync(join(webDir, 'index.html'), '<html><head><meta name="ip-ui-token" content="" /></head><body></body></html>');
    const res = await setup({ webDir, uiToken: 'a$&b' }).app.inject({ url: '/' });
    expect(res.body).toContain('<meta name="ip-ui-token" content="a$&b">');
  });

  it('refuses a built index.html without the token meta tag', () => {
    const webDir = tempDir('ip-web-');
    writeFileSync(join(webDir, 'index.html'), '<html><head></head><body></body></html>');
    expect(() => setup({ webDir })).toThrow('index.html has no ip-ui-token meta tag');
  });

  it('shuts down on request', async () => {
    const onShutdown = vi.fn();
    const { app } = setup({ onShutdown });
    expect((await app.inject({ method: 'POST', url: '/api/admin/shutdown', headers: auth })).statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(onShutdown).toHaveBeenCalledOnce();
  });
});

describe('ui/open-url', () => {
  it('hands an http(s) link to the default browser, and refuses other schemes and a missing UI token', async () => {
    const opened: string[] = [];
    const { app } = setup({ openUrl: async (u) => { opened.push(u); } });
    const post = (url: unknown, token = 'ui-token') =>
      app.inject({ method: 'POST', url: '/api/ui/open-url', headers: { ...SAME_ORIGIN, 'x-ip-ui-token': token }, payload: { url } });
    expect((await post('https://github.com/acme/repo/pull/7')).statusCode).toBe(200);
    expect((await post('http://localhost:3000/x?a=1&b=2')).statusCode).toBe(200);
    expect(opened).toEqual(['https://github.com/acme/repo/pull/7', 'http://localhost:3000/x?a=1&b=2']);
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'C:/notes.md', 'not a url', '', `https://x.com/${'a'.repeat(2100)}`, 7]) {
      expect((await post(bad)).statusCode, String(bad).slice(0, 40)).toBe(400);
    }
    expect((await post('https://example.com', 'wrong')).statusCode).toBe(401);
    expect(opened).toHaveLength(2);
  });
});

describe('window routes', () => {
  const UI = { ...SAME_ORIGIN, 'x-ip-ui-token': 'ui-token' };
  const ACTIONS = ['archive', 'unarchive', 'delete', 'restore'] as const;

  /** InGame, bound to C:/personal/InGame, with a live session there. */
  async function withProject() {
    const { ctx, app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } })).json();
    await app.inject({ method: 'POST', url: `/api/projects/${p.slug}/bindings`, headers: auth, payload: { path: 'C:/personal/InGame' } });
    await app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload: { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' } });
    const act = (action: string, body: unknown = { slug: p.slug }, headers: Record<string, string> = UI) =>
      app.inject({ method: 'POST', url: `/api/ui/projects/${p.id}/${action}`, headers, payload: body as object });
    return { ctx, app, p, act };
  }

  it('archives, deletes, restores and unarchives a project as the window', async () => {
    const { ctx, app, p, act } = await withProject();
    const archived = await act('archive');
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ project: { id: p.id, slug: 'ingame', status: 'archived' }, endedSessions: 1 });
    const lastEvent = () => ctx.db.prepare('SELECT type, actor FROM events ORDER BY id DESC LIMIT 1').get();
    expect(lastEvent()).toEqual({ type: 'project.updated', actor: 'window' });
    // Twice is the same as once, and records nothing more.
    const events = ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get();
    expect((await act('archive')).json()).toMatchObject({ project: { status: 'archived' }, endedSessions: 0 });
    expect(ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(events);

    const deleted = await act('delete');
    expect(deleted.statusCode).toBe(200);
    const { deletedAt, purgeAt } = deleted.json();
    expect(deleted.json()).toEqual({ id: p.id, slug: 'ingame', deletedAt: expect.any(String), purgeAt: expect.any(String) });
    expect(Date.parse(purgeAt) - Date.parse(deletedAt)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(lastEvent()).toEqual({ type: 'project.deleted', actor: 'window' });
    expect((await app.inject({ url: '/api/deleted-projects' })).json()).toEqual([{ id: p.id, slug: 'ingame', name: 'InGame', deletedAt, purgeAt }]);
    expect((await app.inject({ url: '/api/projects' })).json()).toEqual([]);
    // A stale #/p/ link never paints it.
    const stale = await app.inject({ url: '/api/projects/ingame' });
    expect(stale.statusCode).toBe(404);
    expect(stale.json()).toEqual({ error: 'Project "ingame" not found', hint: `It was deleted; restore it from Recently deleted in the window before ${purgeAt.slice(0, 10)}.` });
    expect((await act('delete')).statusCode).toBe(409);
    // Deleted is hidden: unarchive it only after a restore.
    expect((await act('unarchive')).statusCode).toBe(404);

    const restored = await act('restore');
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ project: { id: p.id, status: 'archived' } });
    expect(lastEvent()).toEqual({ type: 'project.restored', actor: 'window' });
    expect((await app.inject({ url: '/api/deleted-projects' })).json()).toEqual([]);
    expect((await act('restore')).json()).toMatchObject({ error: 'Project ingame is not deleted' });

    const back = await act('unarchive');
    expect(back.statusCode).toBe(200);
    expect(back.json()).toEqual({ project: expect.objectContaining({ id: p.id, status: 'active' }) });
    expect((await act('unarchive')).statusCode).toBe(200);
  });

  it('deletes an active project in one step, ending its live session, and a restore brings it back under Archived', async () => {
    const { ctx, app, p, act } = await withProject();
    const mark = ctx.db.prepare('SELECT MAX(id) FROM events').pluck().get();
    const deleted = await act('delete');
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: p.id, slug: 'ingame', deletedAt: expect.any(String), purgeAt: expect.any(String) });
    // The archive's events, then the delete's, all as the window.
    expect(ctx.db.prepare('SELECT type, entity_id AS entityId, actor FROM events WHERE id > ? ORDER BY id').all(mark)).toEqual([
      { type: 'session.updated', entityId: 's1', actor: 'window' },
      { type: 'project.updated', entityId: String(p.id), actor: 'window' },
      { type: 'project.deleted', entityId: String(p.id), actor: 'window' },
    ]);
    expect(ctx.db.prepare("SELECT state FROM sessions WHERE id = 's1'").pluck().get()).toBe('ended');
    expect((await app.inject({ url: '/api/projects' })).json()).toEqual([]);
    expect((await app.inject({ url: '/api/deleted-projects' })).json()).toEqual([{ id: p.id, slug: 'ingame', name: 'InGame', deletedAt: deleted.json().deletedAt, purgeAt: deleted.json().purgeAt }]);
    // Already deleted is still a conflict.
    const again = await act('delete');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'Project ingame is already deleted', hint: 'Restore it from Recently deleted in the window.' });
    const restored = await act('restore');
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ project: { id: p.id, status: 'archived' } });
    expect((await app.inject({ url: '/api/projects' })).json()).toMatchObject([{ id: p.id, status: 'archived', activeSessions: 0 }]);
  });

  it('answers 409 when the id now names another project, and 404 for an id that is gone', async () => {
    const { ctx, app, p, act } = await withProject();
    for (const action of [...ACTIONS, 'rename']) {
      const body = action === 'rename' ? { name: 'Renamed' } : {};
      const res = await act(action, { slug: 'old-site', ...body });
      expect(res.statusCode, action).toBe(409);
      expect(res.json(), action).toEqual({ error: 'This project changed; reload', hint: 'Reload the window: another project has this id now.' });
      const gone = await app.inject({ method: 'POST', url: `/api/ui/projects/${p.id + 100}/${action}`, headers: UI, payload: { slug: p.slug, ...body } });
      expect(gone.statusCode, action).toBe(404);
    }
    expect(ctx.db.prepare('SELECT name FROM projects WHERE id = ?').pluck().get(p.id)).toBe('InGame');
  });

  it('takes only { slug }', async () => {
    const { act } = await withProject();
    for (const body of [{}, { slug: '' }, { slug: 'x'.repeat(201) }, { slug: 'ingame', status: 'active' }, { slug: 7 }]) {
      expect((await act('archive', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('renames a project as the window: the name and its root step change, the slug and bindings stay', async () => {
    const { ctx, app, p, act } = await withProject();
    const mark = ctx.db.prepare('SELECT MAX(id) FROM events').pluck().get();
    const res = await act('rename', { slug: p.slug, name: '  InGame: Season 2  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ project: expect.objectContaining({ id: p.id, slug: 'ingame', name: 'InGame: Season 2', status: 'active' }) });
    expect(ctx.db.prepare('SELECT type, actor, data FROM events WHERE id > ? ORDER BY id').all(mark)).toEqual([
      // The root step's title first, so the activity strip's newest line is the rename.
      { type: 'node.updated', actor: 'window', data: JSON.stringify({ changes: { title: { from: 'InGame', to: 'InGame: Season 2' } } }) },
      { type: 'project.updated', actor: 'window', data: JSON.stringify({ changes: { name: { from: 'InGame', to: 'InGame: Season 2' } } }) },
    ]);
    // The slug is the address: the old link and the binding still find it, under its new name.
    expect((await app.inject({ url: '/api/projects/ingame' })).json()).toMatchObject({ project: { id: p.id, name: 'InGame: Season 2' } });
    expect((await app.inject({ url: '/api/projects' })).json()).toMatchObject([{ id: p.id, slug: 'ingame', name: 'InGame: Season 2' }]);
    expect(ctx.db.prepare('SELECT path FROM bindings WHERE project_id = ?').pluck().all(p.id)).toEqual(['C:/personal/InGame']);
    // The same name again records nothing more.
    const events = ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get();
    expect((await act('rename', { slug: p.slug, name: 'InGame: Season 2' })).statusCode).toBe(200);
    expect(ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(events);
  });

  it('renames an archived project, and refuses a deleted one', async () => {
    const { app, p, act } = await withProject();
    await act('archive');
    expect((await act('rename', { slug: p.slug, name: 'Shelved' })).json()).toMatchObject({ project: { name: 'Shelved', status: 'archived' } });
    await act('delete');
    const res = await act('rename', { slug: p.slug, name: 'Gone' });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/deleted-projects' })).json()).toMatchObject([{ id: p.id, name: 'Shelved' }]);
  });

  it('takes only { slug, name }, the name trimmed to 1 to 120 characters', async () => {
    const { ctx, act } = await withProject();
    const events = ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get();
    for (const body of [{ slug: 'ingame' }, { name: 'X' }, { slug: 'ingame', name: '' }, { slug: 'ingame', name: '   ' }, { slug: 'ingame', name: 'x'.repeat(121) }, { slug: 'ingame', name: 7 }, { slug: 'ingame', name: 'X', status: 'archived' }]) {
      expect((await act('rename', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(events);
    expect((await act('rename', { slug: 'ingame', name: ` ${'x'.repeat(120)} ` })).statusCode).toBe(200);
  });

  it('lists recently deleted projects without any token, as /api/projects does', async () => {
    const { app } = setup();
    const res = await app.inject({ url: '/api/deleted-projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('requireUi: every UI write', () => {
  const routes = (id: number) => [
    ...['archive', 'unarchive', 'delete', 'restore'].map((a) => ({ url: `/api/ui/projects/${id}/${a}`, payload: { slug: 'ingame' } })),
    { url: `/api/ui/projects/${id}/rename`, payload: { slug: 'ingame', name: 'Renamed' } },
    { url: `/api/ui/projects/${id}/queue`, payload: { slug: 'ingame', op: { kind: 'remove', node: 1 } } },
    { url: `/api/ui/projects/${id}/nodes`, payload: { slug: 'ingame', title: 'X', parent: null } },
    { url: '/api/ui/asks/1/clear', payload: {} },
    { url: '/api/ui/events', payload: { name: 'view', projectId: null } },
    { url: '/api/ui/open', payload: { resourceId: 1 } },
    { url: '/api/ui/open-url', payload: { url: 'https://example.com' } },
  ];

  async function guarded() {
    const opened: string[] = [];
    const { ctx, app } = setup({ openPath: async (p) => { opened.push(p); }, openUrl: async (u) => { opened.push(u); } });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } })).json();
    return { ctx, app, p, opened, events: () => ctx.db.prepare('SELECT COUNT(*) FROM events').pluck().get() };
  }

  it('refuses a request without an Origin, or from another one, first: before the token or the body is looked at', async () => {
    const { app, p, opened, events } = await guarded();
    const before = events();
    for (const { url, payload } of routes(p.id)) {
      for (const origin of [undefined, 'http://evil.example', 'http://localhost:4317', 'https://localhost:80', 'null', 'http://localhost:80.evil.example']) {
        const headers: Record<string, string> = { 'x-ip-ui-token': 'ui-token', ...(origin ? { origin } : {}) };
        for (const res of [
          await app.inject({ method: 'POST', url, headers, payload }),
          // No token and a form body: still the origin that refuses it.
          await app.inject({ method: 'POST', url, headers: { ...(origin ? { origin } : {}), 'content-type': 'application/x-www-form-urlencoded' }, payload: 'slug=ingame' }),
        ]) {
          expect(res.statusCode, `${url} ${origin}`).toBe(403);
          expect(res.json()).toEqual({ error: 'Forbidden origin' });
        }
      }
    }
    expect(events()).toBe(before);
    expect(opened).toEqual([]);
  });

  it('accepts the Origin whatever the case of its host, as the Host header has it', async () => {
    const { app, p } = await guarded();
    const res = await app.inject({ method: 'POST', url: `/api/ui/projects/${p.id}/archive`, headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'x-ip-ui-token': 'ui-token' }, payload: { slug: 'ingame' } });
    expect(res.statusCode).toBe(200);
    const upper = await app.inject({ method: 'POST', url: `/api/ui/projects/${p.id}/unarchive`, headers: { host: 'LOCALHOST:4317', origin: 'http://localhost:4317', 'x-ip-ui-token': 'ui-token' }, payload: { slug: 'ingame' } });
    expect(upper.statusCode).toBe(200);
  });

  it('takes only a JSON body: text/plain and form bodies, the ones a cross-site form can send, get 415', async () => {
    const { app, p, opened, events } = await guarded();
    const before = events();
    for (const { url, payload } of routes(p.id)) {
      for (const [type, body] of [['text/plain', JSON.stringify(payload)], ['text/plain;charset=UTF-8', JSON.stringify(payload)], ['application/x-www-form-urlencoded', 'slug=ingame'], ['multipart/form-data; boundary=x', '--x--']]) {
        const res = await app.inject({ method: 'POST', url, headers: { ...SAME_ORIGIN, 'x-ip-ui-token': 'ui-token', 'content-type': type }, payload: body });
        expect(res.statusCode, `${url} ${type}`).toBe(415);
        expect(res.json()).toEqual({ error: 'Send the body as application/json' });
      }
    }
    expect(events()).toBe(before);
    expect(opened).toEqual([]);
  });

  it('needs the UI token, checked last, so only the window itself ever sees its 401', async () => {
    const { app, p, opened, events } = await guarded();
    const before = events();
    for (const { url, payload } of routes(p.id)) {
      for (const token of [undefined, '', 'ui-tokeN', 'ui-token-longer']) {
        const res = await app.inject({ method: 'POST', url, headers: { ...SAME_ORIGIN, ...(token === undefined ? {} : { 'x-ip-ui-token': token }) }, payload });
        expect(res.statusCode, `${url} ${token}`).toBe(401);
        expect(res.json()).toEqual({ error: 'Missing or invalid UI token' });
      }
    }
    expect(events()).toBe(before);
    expect(opened).toEqual([]);
  });

  it('lets the window through with all three, a charset on the JSON type included', async () => {
    const { app, p } = await guarded();
    const res = await app.inject({
      method: 'POST', url: `/api/ui/projects/${p.id}/archive`,
      headers: { ...SAME_ORIGIN, 'x-ip-ui-token': 'ui-token', 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ slug: 'ingame' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ project: { status: 'archived' }, endedSessions: 0 });
  });

  it('leaves the bearer routes as they were: the scribe archives with its token and no Origin', async () => {
    const { app } = await guarded();
    const res = await app.inject({ method: 'PATCH', url: '/api/projects/ingame', headers: auth, payload: { status: 'archived' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'archived' });
  });
});

describe('ask routes', () => {
  async function withStep() {
    const { app, ctx } = setup();
    const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Asks' } })).json();
    const [step] = (await app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { parentId: project.rootNodeId, nodes: [{ title: 'Step' }] } })).json();
    return { app, ctx, step };
  }
  const raise = (app: FastifyInstance, nodeId: number, payload: unknown, headers: Record<string, string> = auth) =>
    app.inject({ method: 'POST', url: `/api/nodes/${nodeId}/asks`, headers, payload: payload as Record<string, unknown> });

  it('raises an ask and returns it, and raising it twice returns the same id', async () => {
    const { app, step } = await withStep();
    const first = await raise(app, step.id, { kind: 'question', text: 'Which port?' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ nodeId: step.id, kind: 'question', text: 'Which port?', clearedAt: null });
    const second = await raise(app, step.id, { kind: 'question', text: 'Which port?' });
    expect(second.json().id).toBe(first.json().id);
  });

  it('clears an ask and returns the cleared ask', async () => {
    const { app, step } = await withStep();
    const ask = (await raise(app, step.id, { kind: 'review', text: 'Look' })).json();
    const res = await app.inject({ method: 'POST', url: `/api/asks/${ask.id}/clear`, headers: auth, payload: { answer: 'Fine' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ask.id, answer: 'Fine', clearedBy: 'scribe:s1' });
    expect(res.json().clearedAt).not.toBeNull();
  });

  it('clears an ask with no body at all', async () => {
    const { app, step } = await withStep();
    const ask = (await raise(app, step.id, { kind: 'review', text: 'Look' })).json();
    const res = await app.inject({ method: 'POST', url: `/api/asks/${ask.id}/clear`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().clearedAt).not.toBeNull();
  });

  it('answers 404 for an unknown ask', async () => {
    const { app } = await withStep();
    const res = await app.inject({ method: 'POST', url: '/api/asks/999/clear', headers: auth, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('answers 401 without a token', async () => {
    const { app, step } = await withStep();
    expect((await raise(app, step.id, { kind: 'question', text: 'Q' }, {})).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/asks/1/clear', payload: {} })).statusCode).toBe(401);
  });

  it('answers 400 for a bad body', async () => {
    const { app, step } = await withStep();
    expect((await raise(app, step.id, { kind: 'release', text: 'Q' })).statusCode).toBe(400);
    expect((await raise(app, step.id, { kind: 'question', text: '  ' })).statusCode).toBe(400);
    expect((await raise(app, step.id, { kind: 'question', text: 'Q', extra: 1 })).statusCode).toBe(400);
    const ask = (await raise(app, step.id, { kind: 'question', text: 'Q' })).json();
    expect((await app.inject({ method: 'POST', url: `/api/asks/${ask.id}/clear`, headers: auth, payload: { answer: 5 } })).statusCode).toBe(400);
  });
});
