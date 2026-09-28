import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../../src/lib/client';
import { createMcpServer } from '../../src/mcp/server';
import { buildApp } from '../../src/server/app';
import { makeCtx } from '../helpers';

let mcp: Client;
let close: () => Promise<unknown>;

beforeAll(async () => {
  const app = buildApp({ ctx: makeCtx(), token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const server = createMcpServer(createClient({ baseUrl: base, token: 'tok' }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(clientSide);
  close = () => app.close();
});
afterAll(() => close());

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
}
const ids = (text: string) => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
/** The leading #id of each line (formatCreated prints one created node per line). */
const lineIds = (text: string) => text.split('\n').map((l) => Number(/^#(\d+)/.exec(l)![1]));

describe('scribe MCP tools', () => {
  it('lists exactly the specified tools', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_log', 'add_nodes', 'add_resource', 'bind_folder', 'create_project', 'delete_node', 'delete_resource',
      'enroll_session', 'get_node', 'get_outline', 'get_resource', 'list_projects', 'move_node', 'search',
      'set_focus', 'unbind_folder', 'update_node', 'update_project', 'update_resource',
    ]);
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

    const file = join(mkdtempSync(join(tmpdir(), 'ip-mcp-')), 'suite.md');
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
    const tooBig = join(mkdtempSync(join(tmpdir(), 'ip-mcp-')), 'big.md');
    writeFileSync(tooBig, 'x'.repeat(210 * 1024));
    const big = await call('add_resource', { node: 1, kind: 'doc', title: 'Big', path: tooBig, snapshot_file: true });
    expect(big.isError).toBe(true);
    expect(big.text).toContain('snapshot limit is 200 KB');
  });
});
