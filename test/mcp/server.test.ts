import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../../src/lib/client';
import { createMcpServer } from '../../src/mcp/server';
import { buildApp } from '../../src/server/app';
import { makeCtx } from '../helpers';

let mcp: Client;
let base = '';
let close: () => Promise<unknown>;
const temps: string[] = [];

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

beforeAll(async () => {
  const app = buildApp({ ctx: makeCtx(), token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  mcp = await connect(createMcpServer(createClient({ baseUrl: base, token: 'tok' })));
  close = () => app.close();
});
afterAll(async () => {
  await close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ip-mcp-'));
  temps.push(dir);
  return dir;
}

async function callOn(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
}
const call = (name: string, args: Record<string, unknown> = {}) => callOn(mcp, name, args);
const ids = (text: string) => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
/** The leading #id of each line (formatCreated prints one created node per line). */
const lineIds = (text: string) => text.split('\n').map((l) => Number(/^#(\d+)/.exec(l)![1]));

/** A port nothing listens on, so a call there fails as "unreachable" (status 0). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe('scribe MCP tools', () => {
  it('lists exactly the specified tools', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_log', 'add_nodes', 'add_resource', 'bind_folder', 'create_project', 'delete_node', 'delete_resource',
      'enroll_session', 'get_node', 'get_outline', 'get_resource', 'list_projects', 'move_node', 'search',
      'set_focus', 'set_queue', 'set_tasks', 'unbind_folder', 'update_node', 'update_project', 'update_resource',
    ]);
  });

  it('tells the scribe what each ambiguous parameter means', async () => {
    const { tools } = await mcp.listTools();
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    const param = (name: string, p: string) => (tool(name).inputSchema.properties as Record<string, { description?: string }>)[p]?.description ?? '';
    expect(param('update_node', 'assignee')).toMatch(/"me" = the user .*"claude" = Claude/);
    for (const [name, p] of [['create_project', 'bind_path'], ['bind_folder', 'path'], ['add_resource', 'path'], ['update_resource', 'path']]) {
      expect(param(name, p), `${name}.${p}`).toMatch(/absolute path/i);
    }
    for (const name of ['get_resource', 'update_resource', 'delete_resource']) expect(param(name, 'id'), name).toMatch(/number after "r"/);
    for (const name of ['get_outline', 'search', 'update_project', 'bind_folder', 'enroll_session', 'set_queue']) expect(param(name, 'project'), name).toMatch(/slug, name or id/);
    expect(tool('update_resource').description).toMatch(/does not re-read the file/);
    expect(tool('set_queue').description).toMatch(/order .* plans to work in/);
    expect(tool('set_queue').description).toMatch(/Done and dropped steps leave the queue on their own/);
    expect(tool('set_tasks').description).toMatch(/task tools are absent/);
    expect(tool('get_outline').description).toMatch(/Up next/);
  });

  it('sets the queue, which get_outline prints as Up next, and the working tasks on a node', async () => {
    const created = await call('create_project', { name: 'Tabs', description: 'Project tabs', session: 'q1' });
    const rootId = ids(created.text)[0];
    const [tabs, guide] = lineIds((await call('add_nodes', { parent: rootId, nodes: [{ title: 'Tab strip' }, { title: 'Guide' }], session: 'q1' })).text);
    await call('enroll_session', { session: 'q1', project: 'tabs' });
    expect(await call('set_queue', { project: 'tabs', nodes: [guide, tabs], session: 'q1' })).toEqual({ text: `Up next in tabs: #${guide} → #${tabs}.`, isError: false });
    expect((await call('get_outline', { project: 'tabs' })).text.split('\n')[1]).toBe(`Up next: #${guide} → #${tabs}`);
    expect(await call('set_queue', { project: 'tabs', nodes: [], session: 'q1' })).toEqual({ text: 'Cleared the queue of tabs.', isError: false });
    const tasks = [{ subject: 'Build the strip', status: 'in_progress' }, { subject: 'Wire the route', status: 'pending' }, { subject: 'Sketch it', status: 'completed' }];
    expect(await call('set_tasks', { session: 'q1', node: tabs, tasks })).toEqual({ text: `Working tasks on #${tabs}: ◐ Build the strip · ○ Wire the route · ✓ Sketch it.`, isError: false });
    expect(await call('set_tasks', { session: 'q1', node: tabs, tasks: [] })).toEqual({ text: `Cleared the working tasks on #${tabs}.`, isError: false });
  });

  it('returns the specific error when a queue or task list is refused', async () => {
    const other = ids((await call('create_project', { name: 'Elsewhere', description: 'x' })).text)[0];
    await call('create_project', { name: 'Queued', description: 'x' });
    expect(await call('set_queue', { project: 'queued', nodes: [other] })).toEqual({ text: `#${other} is not in project queued. Use get_outline to find the right #id.`, isError: true });
    expect(await call('set_tasks', { session: 'nobody', node: other, tasks: [] })).toEqual({ text: 'Session nobody is not tracked. Use enroll_session first.', isError: true });
  });

  it('runs a scribe workflow end to end', async () => {
    const created = await call('create_project', { name: 'InGame', description: 'Game app', bind_path: 'C:/personal/InGame', session: 's1' });
    expect(created.text).toContain('Created project ingame');
    expect(created.text).toContain('Bound C:/personal/InGame');
    const rootId = ids(created.text)[0];

    const plan = await call('add_nodes', {
      parent: rootId, session: 's1',
      nodes: [{ title: 'Road to market', kind: 'phase', status: 'active', children: [{ title: 'Play app signing', status: 'active' }, { title: 'Run signing tests', assignee: 'me' }] }],
    });
    const [road, play, tests] = lineIds(plan.text);
    expect(plan.text).toContain('Run signing tests (task, todo, you)');

    expect((await call('update_node', { id: play, status: 'done', outcome: 'Configured', session: 's1' })).text).toBe(`#${play} Play app signing — done.`);

    const file = join(tempDir(), 'suite.md');
    writeFileSync(file, '# Signing tests\n- upload key accepted');
    const res = await call('add_resource', { node: tests, kind: 'test-suite', title: 'Signing suite', path: file, snapshot_file: true, session: 's1' });
    expect(res.text).toMatch(/^r\d+ "Signing suite" \(test-suite\) attached to #\d+ · 37 chars saved\.$/);
    const rid = Number(/^r(\d+)/.exec(res.text)![1]);
    expect((await call('get_resource', { id: rid })).text).toContain('# Signing tests');

    expect((await call('add_log', { node: road, text: 'Detour: sandbox wedge', session: 's1' })).text).toBe(`Logged on #${road}.`);
    expect((await call('enroll_session', { session: 's1', project: 'ingame', title: 'Launch' })).text).toContain('Session id: s1');
    expect((await call('set_focus', { session: 's1', node: tests })).text).toBe(`Focus → #${tests}.`);

    const outline = await call('get_outline', { project: 'ingame' });
    expect(outline.text).toContain(`#${tests} Run signing tests — NEEDS YOU [r${rid}]`);
    const node = await call('get_node', { id: road });
    expect(node.text).toContain('Detour: sandbox wedge');
    expect((await call('search', { project: 'ingame', query: 'upload key' })).text).toContain(`r${rid} Signing suite`);
    expect((await call('list_projects')).text).toMatch(/ingame — InGame \(active\) · root #\d+ · 1 need you/);
  });

  it('returns specific errors as tool errors', async () => {
    const missing = await call('update_node', { id: 99999, status: 'done' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Node #99999 not found');
    const tooBig = join(tempDir(), 'big.md');
    writeFileSync(tooBig, 'x'.repeat(210 * 1024));
    const big = await call('add_resource', { node: 1, kind: 'doc', title: 'Big', path: tooBig, snapshot_file: true });
    expect(big.isError).toBe(true);
    expect(big.text).toContain('snapshot limit is 200 KB');
  });

  it('keeps the created project when create_project cannot bind the folder, and passes on the hint', async () => {
    const res = await call('create_project', { name: 'Unbound', description: 'No folder yet', bind_path: 'relative/path', session: 's2' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Created project unbound');
    expect(res.text).toContain('Binding failed: Binding path must be absolute: relative/path. Use the full folder path, e.g. C:/personal/InGame. Use bind_folder to retry.');
    expect((await call('list_projects')).text.match(/ — Unbound \(active\)/g)).toHaveLength(1);
  });
});

describe('scribe MCP self-heal', () => {
  it('starts an unreachable server once and retries the call', async () => {
    const port = await freePort();
    const app = buildApp({ ctx: makeCtx(), token: 'tok', uiToken: 'u', version: 'test' });
    let ensures = 0;
    const ensureServer = async () => {
      ensures++;
      await app.listen({ port, host: '127.0.0.1' });
      return true;
    };
    const healing = await connect(createMcpServer(createClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'tok' }), { ensureServer }));
    try {
      expect(await callOn(healing, 'list_projects')).toEqual({ text: 'No projects yet.', isError: false });
      expect(ensures).toBe(1);
      expect(await callOn(healing, 'create_project', { name: 'Healed', description: 'After a restart' })).toMatchObject({ isError: false });
      expect(ensures).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('returns the hinted error when the server stays unreachable, after one start attempt', async () => {
    const port = await freePort();
    for (const started of [true, false]) {
      let ensures = 0;
      const ensureServer = async () => {
        ensures++;
        return started;
      };
      const stuck = await connect(createMcpServer(createClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'tok' }), { ensureServer }));
      const res = await callOn(stuck, 'get_outline', { project: 'ingame' });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(new RegExp(`^InProgress server unreachable at http://127\\.0\\.0\\.1:${port}\\b.*\\. Run \`inprogress start\`, or \`inprogress doctor\` to diagnose\\.$`));
      expect(ensures).toBe(1);
    }
  });

  it('never retries after a timeout, which may follow a write the server already applied', async () => {
    const sockets = new Set<Socket>();
    const silent = createServer((s) => sockets.add(s));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as AddressInfo).port;
    let ensures = 0;
    const ensureServer = async () => {
      ensures++;
      return true;
    };
    const hung = await connect(createMcpServer(createClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'tok', timeoutMs: 200 }), { ensureServer }));
    try {
      const res = await callOn(hung, 'create_project', { name: 'Once', description: 'Must not be sent twice' });
      expect(res.isError).toBe(true);
      expect(ensures).toBe(0);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it('never restarts the server for an error the server returned', async () => {
    let ensures = 0;
    const ensureServer = async () => {
      ensures++;
      return true;
    };
    const client = await connect(createMcpServer(createClient({ baseUrl: base, token: 'tok' }), { ensureServer }));
    expect(await callOn(client, 'update_node', { id: 99999, status: 'done' })).toMatchObject({ isError: true, text: expect.stringContaining('Node #99999 not found') });
    expect(ensures).toBe(0);
  });
});
