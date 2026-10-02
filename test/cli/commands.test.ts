import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install, nodeBinary } from '../../src/cli/claude-config';
import { runCli } from '../../src/cli/commands';
import { runChecks, type Check } from '../../src/cli/doctor';
import { edgeArgs } from '../../src/cli/open';
import { ensureToken } from '../../src/lib/home';
import { VERSION } from '../../src/lib/version';
import { buildApp } from '../../src/server/app';
import { openDb, type DB } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { createProject } from '../../src/server/repo/projects';

let base = '';
let home = '';
let db: DB;
let close: () => Promise<unknown>;
const savedEnv = { INPROGRESS_PORT: process.env.INPROGRESS_PORT, INPROGRESS_HOME: process.env.INPROGRESS_HOME };
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

beforeAll(async () => {
  home = tempDir('ip-cli-');
  const token = ensureToken(home);
  db = openDb(join(home, 'inprogress.db'));
  const ctx = createCtx(db);
  createProject(ctx, 'test', { name: 'CLI Demo' });
  const app = buildApp({ ctx, token, uiToken: 'u', version: VERSION });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  process.env.INPROGRESS_PORT = String(port);
  process.env.INPROGRESS_HOME = home;
  close = () => app.close();
});
afterAll(async () => {
  await close();
  db.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
}

/** A port nothing listens on. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A stand-in repo: the real claude/ templates plus empty built entries. Install refuses without them, doctor checks
 * that each hook's script exists, and unit tests must not depend on a build.
 */
function fixtureRepo(): string {
  const dir = tempDir('ip-repo-');
  cpSync(join(process.cwd(), 'claude'), join(dir, 'claude'), { recursive: true });
  for (const entry of ['dist/hooks/hook.js', 'dist/mcp/main.js']) {
    mkdirSync(dirname(join(dir, entry)), { recursive: true });
    writeFileSync(join(dir, entry), '');
  }
  return dir.replace(/\\/g, '/');
}

describe('runCli', () => {
  it('prints status and outlines', async () => {
    const s = capture();
    expect(await runCli(['status'], s.out)).toBe(0);
    expect(s.lines.join('\n')).toContain('cli-demo');
    const o = capture();
    expect(await runCli(['outline', 'cli-demo'], o.out)).toBe(0);
    expect(o.lines.join('\n')).toContain('Project CLI Demo (slug cli-demo)');
    const bad = capture();
    expect(await runCli(['outline'], bad.out)).toBe(1);
    expect(await runCli(['nonsense'], capture().out)).toBe(1);
  });

  it('gives a slow first health check a second before calling the server down', async () => {
    // A fresh CLI process's first request is slow on a busy machine; 300 ms once turned a running server into "not running".
    const slow = createServer((req, res) => {
      const reply = () => res.setHeader('content-type', 'application/json').end(req.url === '/api/health' ? '{"app":"inprogress"}' : '[]');
      if (req.url === '/api/health') setTimeout(reply, 500);
      else reply();
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const port = (slow.address() as AddressInfo).port;
    process.env.INPROGRESS_PORT = String(port);
    try {
      const s = capture();
      expect(await runCli(['status'], s.out)).toBe(0);
      expect(s.lines).toEqual([`InProgress at http://127.0.0.1:${port}`, '  no projects yet']);
    } finally {
      process.env.INPROGRESS_PORT = new URL(base).port;
      slow.close();
    }
  });

  it('builds the Edge app-window arguments', () => {
    expect(edgeArgs('http://127.0.0.1:4317')).toEqual(['--app=http://127.0.0.1:4317', '--window-size=520,1000']);
  });

  it('stop exits 1 when the server is still answering after 3 s', async () => {
    // The test app acknowledges the shutdown but has no onShutdown, so it keeps running.
    const s = capture();
    expect(await runCli(['stop'], s.out)).toBe(1);
    expect(s.lines).toEqual(['Asked InProgress to stop, but it is still answering after 3 s.']);
  });

  it('claude-install reports a failed stop, then installs anyway', async () => {
    const claude = tempDir('ip-cli-claude-');
    const otherHome = tempDir('ip-cli-home-');
    ensureToken(otherHome); // not the server's token, so the shutdown request gets a 401
    const savedClaude = process.env.INPROGRESS_CLAUDE_DIR;
    process.env.INPROGRESS_HOME = otherHome;
    process.env.INPROGRESS_CLAUDE_DIR = claude;
    try {
      const s = capture();
      expect(await runCli(['claude-install'], s.out, { repo: fixtureRepo() })).toBe(0);
      expect(s.lines.slice(0, 3)).toEqual([
        'Could not stop the running InProgress server: Missing or invalid InProgress token',
        `Claude directory: ${claude}`,
        `Node binary: ${nodeBinary()}`,
      ]);
      expect(s.lines.at(-1)).toBe('Next: run `inprogress doctor`, then start a new Claude session.');
      expect(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')).hooks.SessionStart).toHaveLength(1);
    } finally {
      process.env.INPROGRESS_HOME = home;
      if (savedClaude === undefined) delete process.env.INPROGRESS_CLAUDE_DIR;
      else process.env.INPROGRESS_CLAUDE_DIR = savedClaude;
    }
  });

  it('doctor says where to look when it cannot start the server', async () => {
    process.env.INPROGRESS_PORT = String(await freePort());
    try {
      const s = capture();
      expect(await runCli(['doctor'], s.out, { repo: fixtureRepo(), ensureServer: async () => false })).toBe(1);
      expect(s.lines[0]).toBe(`InProgress did not start. See ${join(home, 'server.log')}`);
      expect(s.lines).toContain('! MCP server: skipped: server check failed');
    } finally {
      process.env.INPROGRESS_PORT = new URL(base).port;
    }
  });
});

/** A temp Claude dir with InProgress installed from a stand-in repo. */
function installedClaudeDir() {
  const repo = fixtureRepo();
  const claude = tempDir('ip-doc-');
  install({ repo, claudeDir: claude, stamp: 'x' });
  return { repo, claude, settingsFile: join(claude, 'settings.json') };
}

/** Rewrite the installed SessionStart hook entry in place. */
function editSessionStartHook(settingsFile: string, edit: (hook: { command: string; args: string[] }) => void): void {
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  edit(settings.hooks.SessionStart[0].hooks[0]);
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

const checksFor = (repo: string, claude: string) => runChecks({ baseUrl: base, home, claudeDir: claude, repo, skipMcp: true });
const named = (checks: Check[], name: string) => checks.find((c) => c.name === name);

describe('doctor checks', () => {
  it('fails the server check when the running build is not the deployed one', async () => {
    const running = { sha: 'aaa1111', dirty: false, builtAt: '2026-10-02T12:00:00.000Z' };
    const app = buildApp({ ctx: createCtx(openDb(':memory:')), token: 't', uiToken: 'u', version: VERSION, build: running });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const check = async (build: typeof running | null) =>
        named(await runChecks({ baseUrl: url, home, claudeDir: tempDir('ip-doc-'), repo: fixtureRepo(), skipMcp: true, build }), 'Server');
      expect(await check(running)).toMatchObject({ ok: true, detail: expect.stringContaining('aaa1111') });
      expect(await check(null)).toMatchObject({ ok: true });
      const stale = await check({ ...running, sha: 'bbb2222' });
      expect(stale).toMatchObject({ ok: false });
      expect(stale?.detail).toMatch(/aaa1111.*bbb2222.*inprogress stop/s);
    } finally {
      await app.close();
    }
  });

  it('passes after install and reports what is missing before it', async () => {
    const claude = tempDir('ip-doc-');
    const repo = fixtureRepo();
    const before = await runChecks({ baseUrl: base, home, claudeDir: claude, repo, skipMcp: true });
    expect(before.find((c) => c.name === 'Server')).toMatchObject({ ok: true });
    expect(before.find((c) => c.name === 'Hooks')).toMatchObject({ ok: false });
    mkdirSync(join(claude, 'agents'), { recursive: true });
    install({ repo, claudeDir: claude, stamp: 'x' });
    const after = await runChecks({ baseUrl: base, home, claudeDir: claude, repo, skipMcp: true });
    const failing = after.filter((c) => !c.ok && !c.warnOnly).map((c) => `${c.name}: ${c.detail}`);
    expect(failing).toEqual([]);
  });

  it('names a fix for every failure, and skips the MCP check when the server check fails', async () => {
    // Another program on the port, a damaged database without a token, a half-written agent, no settings or skill.
    const other = createServer((_req, res) => res.end('<!doctype html><title>Some other app</title>'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const brokenHome = tempDir('ip-doc-home-');
    writeFileSync(join(brokenHome, 'inprogress.db'), 'not a database');
    const claude = tempDir('ip-doc-');
    mkdirSync(join(claude, 'agents'));
    writeFileSync(join(claude, 'agents', 'inprogress-scribe.md'), '---\nname: inprogress-scribe\n---\n');
    const repo = fixtureRepo();
    try {
      const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
      const checks = await runChecks({ baseUrl: url, home: brokenHome, claudeDir: claude, repo });
      const failing = Object.fromEntries(checks.filter((c) => !c.ok && !c.warnOnly).map((c) => [c.name, c.detail]));
      expect(failing).toEqual({
        Server: expect.stringContaining('set INPROGRESS_PORT'),
        Token: expect.stringContaining('start the server once'),
        Database: expect.stringContaining(join(brokenHome, 'backups')),
        Hooks: expect.stringContaining('run npm run claude:install'),
        'Scribe agent': expect.stringContaining('npm run claude:install'),
        Skill: expect.stringContaining('run npm run claude:install'),
        'Allow rules': expect.stringContaining('run npm run claude:install'),
      });
      expect(named(checks, 'MCP server')).toEqual({ name: 'MCP server', ok: false, warnOnly: true, detail: 'skipped: server check failed' });
      // The damaged database's handle is closed again, so its folder can be deleted.
      expect(() => rmSync(brokenHome, { recursive: true })).not.toThrow();
    } finally {
      other.close();
    }
  });

  it('fails the MCP check with a fix when its entry cannot answer', async () => {
    const { repo, claude } = installedClaudeDir();
    writeFileSync(join(repo, 'dist', 'mcp', 'main.js'), 'process.exit(3);\n');
    const checks = await runChecks({ baseUrl: base, home, claudeDir: claude, repo });
    expect(named(checks, 'Server')).toMatchObject({ ok: true });
    expect(named(checks, 'MCP server')).toMatchObject({ ok: false, detail: expect.stringContaining('run npm run deploy') });
  });

  it("fails Hooks when a hook's node binary is gone", async () => {
    const { repo, claude, settingsFile } = installedClaudeDir();
    editSessionStartHook(settingsFile, (h) => (h.command = 'C:/gone/node.exe'));
    expect(named(await checksFor(repo, claude), 'Hooks')).toEqual({
      name: 'Hooks',
      ok: false,
      detail: 'node binary C:/gone/node.exe no longer exists: rerun npm run claude:install',
    });
  });

  it('fails Hooks when a hook script is gone', async () => {
    const { repo, claude, settingsFile } = installedClaudeDir();
    editSessionStartHook(settingsFile, (h) => (h.args[0] = 'C:/moved/InProgress/dist/hooks/hook.js'));
    expect(named(await checksFor(repo, claude), 'Hooks')).toEqual({
      name: 'Hooks',
      ok: false,
      detail: 'hook script C:/moved/InProgress/dist/hooks/hook.js no longer exists: run npm run deploy, or rerun npm run claude:install if the repo moved',
    });
  });

  it('reports an unparseable settings.json instead of missing hooks', async () => {
    const { repo, claude, settingsFile } = installedClaudeDir();
    writeFileSync(settingsFile, '{ "hooks": ');
    const checks = await checksFor(repo, claude);
    for (const name of ['Hooks', 'Allow rules']) {
      expect(named(checks, name)).toMatchObject({ ok: false, detail: expect.stringMatching(/^settings\.json is not valid JSON: .+: fix /) });
    }
  });

  it('names a malformed settings.json value instead of crashing', async () => {
    const { repo, claude, settingsFile } = installedClaudeDir();
    writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: { hooks: [] } } }));
    const checks = await checksFor(repo, claude);
    for (const name of ['Hooks', 'Allow rules']) {
      expect(named(checks, name)).toMatchObject({ ok: false, detail: expect.stringMatching(/^settings\.json: "hooks\.Stop" is not an array: fix /) });
    }
  });

  it('reads a settings.json that starts with a UTF-8 BOM', async () => {
    const { repo, claude, settingsFile } = installedClaudeDir();
    writeFileSync(settingsFile, `\uFEFF${readFileSync(settingsFile, 'utf8')}`);
    const checks = await checksFor(repo, claude);
    for (const name of ['Hooks', 'Allow rules']) expect(named(checks, name), name).toMatchObject({ ok: true });
  });
});

describe('claude-check', () => {
  it('exits 3 when not installed, 0 when the kit matches, 2 naming what differs', async () => {
    const saved = process.env.INPROGRESS_CLAUDE_DIR;
    const claude = tempDir('ip-check-');
    const repo = fixtureRepo();
    process.env.INPROGRESS_CLAUDE_DIR = claude;
    try {
      const run = async () => {
        const lines: string[] = [];
        const code = await runCli(['claude-check'], (l) => lines.push(l), { repo });
        return { code, text: lines.join('\n') };
      };
      expect(await run()).toMatchObject({ code: 3, text: expect.stringContaining('not installed') });
      install({ repo, claudeDir: claude, stamp: 'c1' });
      expect(await run()).toMatchObject({ code: 0, text: expect.stringContaining('matches') });
      writeFileSync(join(claude, 'agents', 'inprogress-scribe.md'), 'edited');
      expect(await run()).toMatchObject({ code: 2, text: expect.stringContaining('agent') });
    } finally {
      if (saved === undefined) delete process.env.INPROGRESS_CLAUDE_DIR;
      else process.env.INPROGRESS_CLAUDE_DIR = saved;
    }
  });
});
