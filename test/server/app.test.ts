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

function setup(extra: Partial<AppOptions> = {}) {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test', ...extra });
  return { ctx, app };
}

/** Store a resource with this path on the node, then ask the UI route to open it. */
async function openStoredPath(app: FastifyInstance, nodeId: number, path: string) {
  const resource = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId, kind: 'doc', title: 'Doc', path } })).json();
  return app.inject({ method: 'POST', url: '/api/ui/open', headers: { 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: resource.id } });
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
    expect(res.json()).toMatchObject({ slug: 'ingame', queue: [guide, tabs] });
    expect((await app.inject({ url: '/api/projects/ingame' })).json().project.queue).toEqual([guide, tabs]);
    const lines = (await app.inject({ url: '/api/projects/ingame/outline' })).body.split('\n');
    expect(lines.slice(0, 2)).toEqual(['Project InGame (slug ingame)', `Up next: #${guide} → #${tabs}`]);
    await app.inject({ method: 'POST', url: '/api/projects/ingame/queue', headers: auth, payload: { nodes: [] } });
    expect((await app.inject({ url: '/api/projects/ingame/outline' })).body).not.toContain('Up next');
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
    expect(res.json().map((t: { subject: string; status: string }) => [t.subject, t.status])).toEqual([['Build the tab strip', 'in_progress'], ['Wire the hash route', 'pending']]);
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

  it('takes the live-work fields on the hook route, and refuses unknown ones', async () => {
    const { app } = await planned();
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload });
    for (const payload of [
      { event: 'agent-dispatch', toolUseId: 'toolu_1', agentType: 'Explore', description: 'Map the hooks', model: 'sonnet' },
      { event: 'subagent-start', agentId: 'a1', agentType: 'Explore' },
      { event: 'agent-launched', toolUseId: 'toolu_1', agentId: 'a1', model: 'sonnet-5' },
      { event: 'task-created', taskKey: '1', subject: 'Write it' },
      { event: 'task-updated', taskKey: '1', status: 'in_progress', subject: 'Write it now', addBlocks: ['2'], addBlockedBy: [], agentId: 'a1' },
    ]) {
      expect((await post(payload)).json(), payload.event).toEqual({ tracked: true });
    }
    expect((await post({ event: 'task-created', taskKey: '2', subject: 'x', prompt: 'never sent' })).statusCode).toBe(400);
    expect((await post({ event: 'task-updated', taskKey: '2', status: 'archived' })).statusCode).toBe(400);
    expect((await post({ event: 'task-created', taskKey: '3', subject: 'x'.repeat(301) })).statusCode).toBe(400);
  });
});

describe('outline', () => {
  it('heads the outline with the project playbook when there is one', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame', playbook: 'Planning docs live in docs/planning.\r\nTickets are VCAD-###.\n' } });
    const lines = (await app.inject({ url: '/api/projects/ingame/outline' })).body.split('\n');
    expect(lines.slice(0, 3)).toEqual(['Project InGame (slug ingame)', 'Playbook:', '  Planning docs live in docs/planning.']);
    expect(lines[3]).toBe('  Tickets are VCAD-###.');
    expect(lines[4]).toMatch(/^#\d+ InGame — active$/);
    await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'Plain', playbook: '  \n' } });
    const plain = (await app.inject({ url: '/api/projects/plain/outline' })).body;
    expect(plain).not.toContain('Playbook:');
    expect(plain.split('\n')[1]).toMatch(/^#\d+ Plain — active$/);
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
    expect((await app.inject({ method: 'POST', url: '/api/ui/open', payload: { resourceId: withPath.id } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: withPath.id } });
    expect(ok.statusCode).toBe(200);
    expect(opened).toEqual([file]);
    const none = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: noPath.id } });
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
      const res = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { 'x-ip-ui-token': token }, payload: { resourceId: resource.id } });
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
      app.inject({ method: 'POST', url: '/api/ui/open-url', headers: { 'x-ip-ui-token': token }, payload: { url } });
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
