import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** The tested build: `npm run test:smoke` builds into .build, so the live dist/ is never touched. */
const BUILD = process.env.INPROGRESS_BUILD_ROOT ?? '.build';
const bin = (entry: string) => join(BUILD, 'dist', entry);

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const home = tempDir('ip-smoke-wait-');
const claude = tempDir('ip-smoke-wait-claude-');
const cwd = tempDir('ip-smoke-wait-cwd-');
const envFor = (port: number): NodeJS.ProcessEnv => ({ ...process.env, INPROGRESS_HOME: home, INPROGRESS_PORT: String(port), INPROGRESS_CLAUDE_DIR: claude });
const sessionStart = (sessionId: string) => JSON.stringify({ session_id: sessionId, cwd, source: 'startup' });
const briefing = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;

/** A port nothing is listening on (never 4317: the ephemeral range starts far above it). */
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

/** Runs a hook without blocking this process, which may be playing the server the hook talks to. */
function runHook(script: string, name: string, input: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, name], { env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

/** A stand-in InProgress server in this process: health answers at once, a hook POST after `postDelayMs`. */
async function slowPostServer(port: number, postDelayMs: number, context: string): Promise<Server> {
  const server = createHttpServer((req, res) => {
    const json = (body: unknown) => {
      if (!res.destroyed) res.setHeader('content-type', 'application/json').end(JSON.stringify(body));
    };
    if (req.url === '/api/health') return json({ ok: true, app: 'inprogress' });
    req.resume();
    setTimeout(() => json({ tracked: true, context }), postDelayMs);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

describe('hook waits (built hook)', () => {
  it('session-start waits up to 5 s for a server it had to start', async () => {
    // After a reboot a cold start took longer than the 2 s the hook used to wait. A copy of the built hook spawns
    // its dist/server/main.js: here a stand-in that starts listening 3 s after the spawn, answers the hook, and exits.
    const kit = tempDir('ip-smoke-slow-kit-');
    mkdirSync(join(kit, 'dist', 'hooks'), { recursive: true });
    mkdirSync(join(kit, 'dist', 'server'), { recursive: true });
    writeFileSync(join(kit, 'package.json'), '{ "type": "module" }\n');
    copyFileSync(bin('hooks/hook.js'), join(kit, 'dist', 'hooks', 'hook.js'));
    const pidFile = join(kit, 'stand-in.pid');
    writeFileSync(
      join(kit, 'dist', 'server', 'main.js'),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { createServer } from 'node:http';",
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        'setTimeout(() => process.exit(0), 10000);',
        'setTimeout(() => {',
        '  createServer((req, res) => {',
        "    res.setHeader('content-type', 'application/json');",
        "    if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, app: 'inprogress' }));",
        '    req.resume();',
        "    res.end(JSON.stringify({ tracked: true, context: 'Briefing from a server that took 3 s to start' }), () => setTimeout(() => process.exit(0), 100));",
        "  }).listen(Number(process.env.INPROGRESS_PORT), '127.0.0.1');",
        '}, 3000);',
        '',
      ].join('\n'),
    );
    try {
      const r = await runHook(join(kit, 'dist', 'hooks', 'hook.js'), 'session-start', sessionStart('slow-start'), envFor(await freePort()));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(briefing(r.stdout)).toEqual({ hookEventName: 'SessionStart', additionalContext: 'Briefing from a server that took 3 s to start' });
      expect(r.ms).toBeGreaterThanOrEqual(3000);
    } finally {
      // On a failure the stand-in may still be waiting to listen: stop it, so it never outlives the test.
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, 'utf8')));
        } catch {
          // already gone
        }
      }
    }
  });

  it('session-start gives the briefing POST 2 s', async () => {
    const port = await freePort();
    const server = await slowPostServer(port, 1500, 'Briefing after a slow answer');
    try {
      const r = await runHook(bin('hooks/hook.js'), 'session-start', sessionStart('slow-post'), envFor(port));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(briefing(r.stdout)).toEqual({ hookEventName: 'SessionStart', additionalContext: 'Briefing after a slow answer' });
    } finally {
      await closeServer(server);
    }
  });

  it('other hooks still give their POST only 500 ms', async () => {
    const port = await freePort();
    const server = await slowPostServer(port, 1500, 'Context nobody waits for');
    try {
      const r = await runHook(bin('hooks/hook.js'), 'prompt-submit', JSON.stringify({ session_id: 'slow-prompt', cwd, prompt: 'where are we?' }), envFor(port));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(readFileSync(join(home, 'hooks.log'), 'utf8')).toMatch(/prompt-submit: InProgress server unreachable at .+ \(The operation was aborted due to timeout\)/);
    } finally {
      await closeServer(server);
    }
  });
});
