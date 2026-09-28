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
let server: ChildProcess;

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
afterAll(() => {
  // Stop from a fresh process. This one can still hold keep-alive sockets to the first server, which claude-install
  // reset while spawnSync blocked the event loop: a shutdown POST sent on one fails with ECONNRESET and would leave
  // the server that `start` spawned running.
  spawnSync(process.execPath, ['dist/cli/main.js', 'stop'], { env });
  server.kill();
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

  it('MCP server answers over stdio', async () => {
    const client = new Client({ name: 'smoke', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/mcp/main.js'], env: env as Record<string, string> }));
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
    expect(res.content[0].text).toContain('smoke');
    await client.close();
  });

  it('CLI installs into a temp Claude dir and doctor passes', () => {
    expect(spawnSync(process.execPath, ['dist/cli/main.js', 'claude-install'], { env, encoding: 'utf8' }).status).toBe(0);
    // claude-install stopped the server; start it again for doctor.
    expect(spawnSync(process.execPath, ['dist/cli/main.js', 'start'], { env, encoding: 'utf8' }).status).toBe(0);
    const doc = spawnSync(process.execPath, ['dist/cli/main.js', 'doctor'], { env, encoding: 'utf8' });
    expect(doc.stdout).not.toContain('✗');
    expect(doc.status).toBe(0);
  });
});
