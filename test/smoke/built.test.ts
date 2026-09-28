import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../../src/lib/client';
import { isServerUp } from '../../src/lib/ensure-server';
import { readToken } from '../../src/lib/home';

const home = mkdtempSync(join(tmpdir(), 'ip-smoke-'));
const claude = mkdtempSync(join(tmpdir(), 'ip-smoke-claude-'));
let base = '';
let env: NodeJS.ProcessEnv = {};
let server: ChildProcess | undefined;

/** A port nothing is listening on, so a stale server from an earlier run can never answer. */
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

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env, INPROGRESS_HOME: home, INPROGRESS_PORT: String(port), INPROGRESS_CLAUDE_DIR: claude };
  server = spawn(process.execPath, ['dist/server/main.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 80 && !(await isServerUp(base)); i++) await new Promise((r) => setTimeout(r, 100));
  expect(await isServerUp(base)).toBe(true);
});
afterAll(async () => {
  // No port means env is still empty, and `stop` would target port 4317 with the real ~/.inprogress token.
  if (!base) return;
  // Stop from a fresh process, once a second for up to 5 s. This one can still hold keep-alive sockets to the first
  // server, which claude-install reset while spawnSync blocked the event loop, and a request sent on one fails with
  // ECONNRESET. The pause before each probe lets the loop drop those sockets, so a probe cannot miss a live server.
  const deadline = Date.now() + 5000;
  let lastStop = 0;
  let up = true;
  while (up && Date.now() < deadline) {
    if (Date.now() - lastStop >= 1000) {
      spawnSync(process.execPath, ['dist/cli/main.js', 'stop'], { env });
      lastStop = Date.now();
    }
    await new Promise((r) => setTimeout(r, 200));
    up = await isServerUp(base, 200);
  }
  server?.kill();
  if (up) throw new Error(`An InProgress server still answers at ${base} (data dir ${home}): stop it by hand.`);
});

describe('built artifacts', () => {
  it('session-start hook prints a briefing for a bound folder', async () => {
    const client = createClient({ baseUrl: base, token: readToken(home) });
    const p = await client.post<{ slug: string }>('/api/projects', { name: 'Smoke' });
    const dir = mkdtempSync(join(tmpdir(), 'ip-smoke-bound-'));
    await client.post(`/api/projects/${p.slug}/bindings`, { path: dir });
    const r = spawnSync(process.execPath, ['dist/hooks/hook.js', 'session-start'], { input: JSON.stringify({ session_id: 'smoke-1', cwd: dir, source: 'startup' }), env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('tracked in project "Smoke"');
  });

  it('hooks exit 0 silently when the server is unreachable', () => {
    const r = spawnSync(process.execPath, ['dist/hooks/hook.js', 'stop'], { input: JSON.stringify({ session_id: 'x' }), env: { ...env, INPROGRESS_PORT: '1' }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('CLI prints the client hint under an error', () => {
    const r = spawnSync(process.execPath, ['dist/cli/main.js', 'outline', 'smoke'], { env: { ...env, INPROGRESS_PORT: '1' }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr.split(/\r?\n/).slice(0, 2)).toEqual([
      expect.stringContaining('InProgress server unreachable at http://127.0.0.1:1'),
      'Run `inprogress start`, or `inprogress doctor` to diagnose.',
    ]);
  });

  it('MCP server answers over stdio', async () => {
    const client = new Client({ name: 'smoke', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/mcp/main.js'], env: env as Record<string, string> }));
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
    expect(res.content[0].text).toContain('smoke');
    await client.close();
  });

  it('CLI installs into a temp Claude dir and doctor passes', () => {
    const inst = spawnSync(process.execPath, ['dist/cli/main.js', 'claude-install'], { env, encoding: 'utf8' });
    expect(inst.stdout).toContain('Stopped the running InProgress server.');
    expect(inst.status).toBe(0);
    // claude-install stopped the server; doctor starts it again before its checks.
    const doc = spawnSync(process.execPath, ['dist/cli/main.js', 'doctor'], { env, encoding: 'utf8' });
    expect(doc.stdout).toContain(`Started InProgress at ${base}`);
    expect(doc.stdout).not.toContain('✗');
    expect(doc.status).toBe(0);
  });
});
