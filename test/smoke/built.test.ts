import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeBinary } from '../../src/cli/claude-config';
import { createClient } from '../../src/lib/client';
import { isServerUp } from '../../src/lib/ensure-server';
import { readToken } from '../../src/lib/home';

/** The tested build: `npm run test:smoke` builds into .build, so the live dist/ is never touched. */
const BUILD = process.env.INPROGRESS_BUILD_ROOT ?? '.build';
const bin = (entry: string) => join(BUILD, 'dist', entry);

const home = mkdtempSync(join(tmpdir(), 'ip-smoke-'));
const claude = mkdtempSync(join(tmpdir(), 'ip-smoke-claude-'));
/** A folder bound to the Smoke project by the first test. */
const bound = mkdtempSync(join(tmpdir(), 'ip-smoke-bound-'));
let base = '';
let env: NodeJS.ProcessEnv = {};
let server: ChildProcess | undefined;

const sessionStart = (sessionId: string) => JSON.stringify({ session_id: sessionId, cwd: bound, source: 'startup' });
const briefing = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;

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
  server = spawn(process.execPath, [bin('server/main.js')], { env, stdio: 'ignore' });
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
      spawnSync(process.execPath, [bin('cli/main.js'), 'stop'], { env });
      lastStop = Date.now();
    }
    await new Promise((r) => setTimeout(r, 200));
    up = await isServerUp(base, 200);
  }
  server?.kill();
  if (up) throw new Error(`An InProgress server still answers at ${base} (data dir ${home}): stop it by hand.`);
  for (const dir of [home, claude, bound]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('built artifacts', () => {
  it('session-start hook prints a briefing for a bound folder', async () => {
    const client = createClient({ baseUrl: base, token: readToken(home) });
    const p = await client.post<{ slug: string }>('/api/projects', { name: 'Smoke' });
    await client.post(`/api/projects/${p.slug}/bindings`, { path: bound });
    const r = spawnSync(process.execPath, [bin('hooks/hook.js'), 'session-start'], { input: sessionStart('smoke-1'), env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(briefing(r.stdout).hookEventName).toBe('SessionStart');
    expect(briefing(r.stdout).additionalContext).toContain('tracked in project "Smoke"');
  });

  it('hooks read stdin that starts with a UTF-8 BOM', () => {
    // PowerShell adds one when it pipes text to a program.
    const r = spawnSync(process.execPath, [bin('hooks/hook.js'), 'session-start'], { input: `\uFEFF${sessionStart('smoke-bom')}\r\n`, env, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(briefing(r.stdout).additionalContext).toContain('Session id: smoke-bom');
  });

  it('a hook whose reader has gone away exits 0 without stderr', async () => {
    const child = spawn(process.execPath, [bin('hooks/hook.js'), 'session-start'], { env, stdio: 'pipe' });
    child.stdout.destroy(); // Claude stopped reading before the briefing is written: the write fails with EPIPE.
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdin.end(sessionStart('smoke-epipe'));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('hooks exit 0 silently when the server is unreachable', () => {
    const r = spawnSync(process.execPath, [bin('hooks/hook.js'), 'stop'], { input: JSON.stringify({ session_id: 'x' }), env: { ...env, INPROGRESS_PORT: '1' }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('CLI prints the client hint under an error', () => {
    const r = spawnSync(process.execPath, [bin('cli/main.js'), 'outline', 'smoke'], { env: { ...env, INPROGRESS_PORT: '1' }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr.split(/\r?\n/).slice(0, 2)).toEqual([
      expect.stringContaining('InProgress server unreachable at http://127.0.0.1:1'),
      'Run `inprogress start`, or `inprogress doctor` to diagnose.',
    ]);
  });

  it('MCP server answers over stdio', async () => {
    const client = new Client({ name: 'smoke', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin('mcp/main.js')], env: env as Record<string, string> }));
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
    expect(res.content[0].text).toContain('smoke');
    await client.close();
  });

  it('MCP server starts InProgress again when a call finds it stopped', async () => {
    const client = new Client({ name: 'smoke', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin('mcp/main.js')], env: env as Record<string, string> }));
    try {
      const stop = spawnSync(process.execPath, [bin('cli/main.js'), 'stop'], { env, encoding: 'utf8' });
      expect(stop.stdout).toContain('Stopped the running InProgress server.');
      const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('smoke');
    } finally {
      await client.close();
      // The tests below expect a running server, even if this one failed.
      spawnSync(process.execPath, [bin('cli/main.js'), 'start'], { env });
    }
  });

  it('CLI installs into a temp Claude dir, then a session-start hook restarts the server it stopped', async () => {
    const inst = spawnSync(process.execPath, [bin('cli/main.js'), 'claude-install'], { env, encoding: 'utf8' });
    expect(inst.stdout).toContain('Stopped the running InProgress server.');
    expect(inst.stdout).toContain(`Claude directory: ${claude}\nNode binary: ${nodeBinary()}\n`);
    // The server is stopped only once the new kit is written.
    expect(inst.stdout.indexOf('Stopped the running InProgress server.')).toBeGreaterThan(inst.stdout.indexOf('Skill: '));
    expect(inst.status).toBe(0);
    // Let this process drop its keep-alive sockets to the stopped server before probing (see afterAll).
    await new Promise((r) => setTimeout(r, 200));
    expect(await isServerUp(base, 500)).toBe(false);
    // The next session in a bound folder starts the server itself, as after a real install.
    const r = spawnSync(process.execPath, [bin('hooks/hook.js'), 'session-start'], { input: sessionStart('smoke-2'), env, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(briefing(r.stdout).additionalContext).toContain('tracked in project "Smoke"');
  });

  it('doctor starts a stopped server and passes', () => {
    const stop = spawnSync(process.execPath, [bin('cli/main.js'), 'stop'], { env, encoding: 'utf8' });
    expect(stop.stdout).toContain('Stopped the running InProgress server.');
    const doc = spawnSync(process.execPath, [bin('cli/main.js'), 'doctor'], { env, encoding: 'utf8' });
    expect(doc.stdout).toContain(`Started InProgress at ${base}`);
    expect(doc.stdout).not.toContain('✗');
    expect(doc.status).toBe(0);
  });
});
