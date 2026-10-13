import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowRules, install, nodeBinary } from '../../src/cli/claude-config';
import { runCli } from '../../src/cli/commands';
import { runTasks, TASKS_NOT_RUNNING_HINT, TASKS_TIMEOUT_HINT, TASKS_USAGE } from '../../src/cli/tasks';
import { doctor, runChecks, type Check } from '../../src/cli/doctor';
import { edgeArgs } from '../../src/cli/open';
import { isServerUp } from '../../src/lib/ensure-server';
import { ensureToken } from '../../src/lib/home';
import { VERSION } from '../../src/lib/version';
import { buildApp } from '../../src/server/app';
import { openDb, type DB } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { enrollSession, setFocus } from '../../src/server/session-flow';

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

/** A stand-in InProgress server that counts shutdown requests and stops answering after one, as the real one does. */
async function stoppableServer(): Promise<{ port: number; url: string; shutdowns: () => number; close: () => Promise<void> }> {
  let shutdowns = 0;
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/admin/shutdown') {
      shutdowns++;
      res.end('{"ok":true}', () => {
        server.close();
        server.closeAllConnections();
      });
      return;
    }
    res.end(req.url === '/api/health' ? '{"app":"inprogress"}' : '{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    shutdowns: () => shutdowns,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
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

  it('claude-install installs, then reports a failed stop', async () => {
    const claude = tempDir('ip-cli-claude-');
    const otherHome = tempDir('ip-cli-home-');
    ensureToken(otherHome); // not the server's token, so the shutdown request gets a 401
    const savedClaude = process.env.INPROGRESS_CLAUDE_DIR;
    process.env.INPROGRESS_HOME = otherHome;
    process.env.INPROGRESS_CLAUDE_DIR = claude;
    try {
      const s = capture();
      expect(await runCli(['claude-install'], s.out, { repo: fixtureRepo() })).toBe(0);
      expect(s.lines.slice(0, 2)).toEqual([`Claude directory: ${claude}`, `Node binary: ${nodeBinary()}`]);
      expect(s.lines.slice(-2)).toEqual([
        'Could not stop the running InProgress server: Missing or invalid InProgress token',
        'Next: run `inprogress doctor`, then start a new Claude session.',
      ]);
      expect(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')).hooks.SessionStart).toHaveLength(1);
    } finally {
      process.env.INPROGRESS_HOME = home;
      if (savedClaude === undefined) delete process.env.INPROGRESS_CLAUDE_DIR;
      else process.env.INPROGRESS_CLAUDE_DIR = savedClaude;
    }
  });

  it.each<[string, (repo: string, claude: string) => void, string]>([
    ['the repo is not built', (repo) => rmSync(join(repo, 'dist', 'hooks', 'hook.js')), 'Build InProgress first: npm run deploy'],
    ['settings.json is not valid JSON', (_repo, claude) => writeFileSync(join(claude, 'settings.json'), '{ "hooks": '), 'is not valid JSON'],
  ])('claude-install leaves the running server alone when it refuses because %s', async (_label, breakIt, refusal) => {
    const server = await stoppableServer();
    const claude = tempDir('ip-cli-claude-');
    const repo = fixtureRepo();
    breakIt(repo, claude);
    const savedClaude = process.env.INPROGRESS_CLAUDE_DIR;
    process.env.INPROGRESS_PORT = String(server.port);
    process.env.INPROGRESS_CLAUDE_DIR = claude;
    try {
      const s = capture();
      await expect(runCli(['claude-install'], s.out, { repo })).rejects.toThrow(refusal);
      expect(server.shutdowns()).toBe(0);
      expect(s.lines).toEqual([]);
      expect(await isServerUp(server.url)).toBe(true);
    } finally {
      process.env.INPROGRESS_PORT = new URL(base).port;
      if (savedClaude === undefined) delete process.env.INPROGRESS_CLAUDE_DIR;
      else process.env.INPROGRESS_CLAUDE_DIR = savedClaude;
      await server.close();
    }
  });

  it('claude-install stops the running server once the install has succeeded', async () => {
    const server = await stoppableServer();
    const claude = tempDir('ip-cli-claude-');
    const savedClaude = process.env.INPROGRESS_CLAUDE_DIR;
    process.env.INPROGRESS_PORT = String(server.port);
    process.env.INPROGRESS_CLAUDE_DIR = claude;
    try {
      const s = capture();
      expect(await runCli(['claude-install'], s.out, { repo: fixtureRepo() })).toBe(0);
      expect(server.shutdowns()).toBe(1);
      // The new kit is written before the old server goes, so the next hook starts the new build.
      expect(s.lines[0]).toBe(`Claude directory: ${claude}`);
      expect(s.lines).toContain(`Skill: ${join(claude, 'skills', 'inprogress')}`);
      expect(s.lines.slice(-2)).toEqual(['Stopped the running InProgress server.', 'Next: run `inprogress doctor`, then start a new Claude session.']);
    } finally {
      process.env.INPROGRESS_PORT = new URL(base).port;
      if (savedClaude === undefined) delete process.env.INPROGRESS_CLAUDE_DIR;
      else process.env.INPROGRESS_CLAUDE_DIR = savedClaude;
      await server.close();
    }
  });

  it('lists the tasks command in the usage, with the step bare', async () => {
    const s = capture();
    expect(await runCli([], s.out)).toBe(0);
    expect(s.lines.join('\n')).toContain('tasks [<step id>] --session <session id>');
    expect(s.lines.join('\n')).not.toMatch(/tasks #/);
  });

  describe('digest and usage', () => {
    it("prints the route's text, with --since and for a project that exists", async () => {
      const ctx = createCtx(db);
      const root = db.prepare("SELECT root_node_id AS r FROM projects WHERE slug = 'cli-demo'").get() as { r: number };
      const [step] = addNodes(ctx, 'test', { parentId: root.r, nodes: [{ title: 'Digest me', status: 'done', outcome: 'shipped it' }] });
      const s = capture();
      expect(await runCli(['digest', 'cli-demo', '--since', '2000-01-01T00:00:00.000Z'], s.out)).toBe(0);
      const text = s.lines.join('\n');
      expect(text).toContain('Digest for CLI Demo since');
      expect(text).toContain(`#${step.id} Digest me: "shipped it"`);
      const viaRoute = await fetch(`${base}/api/projects/cli-demo/digest?since=2000-01-01T00:00:00.000Z`).then((r) => r.json() as Promise<{ text: string }>);
      expect(text).toBe(viaRoute.text);
    });

    it('exits 1 with the usage line when the project is missing or the time is not one', async () => {
      const missing = capture();
      expect(await runCli(['digest'], missing.out)).toBe(1);
      expect(missing.lines).toEqual(['Missing <project>', 'Usage: inprogress digest <project> [--since <iso time>] [--all]']);
      const bad = capture();
      expect(await runCli(['digest', 'cli-demo', '--since', 'yesterday'], bad.out)).toBe(1);
      expect(bad.lines[0]).toBe('Not a time: yesterday');
    });

    it('says the server is not running and exits 1', async () => {
      process.env.INPROGRESS_PORT = String(await freePort());
      try {
        const s = capture();
        expect(await runCli(['digest', 'cli-demo'], s.out)).toBe(1);
        expect(s.lines).toEqual(['InProgress is not running.']);
      } finally {
        process.env.INPROGRESS_PORT = new URL(base).port;
      }
    });

    it('prints the usage table and refuses a bad --days', async () => {
      const s = capture();
      expect(await runCli(['usage', 'cli-demo', '--days', '2'], s.out)).toBe(0);
      expect(s.lines.join('\n')).toContain('Usage for CLI Demo, last 2 days:');
      const bad = capture();
      expect(await runCli(['usage', 'cli-demo', '--days', 'x'], bad.out)).toBe(1);
      expect(bad.lines[1]).toBe('Usage: inprogress usage <project> [--days <n>]');
    });
  });

  describe('tasks', () => {
    /** A session tracked in CLI Demo with a step, and its stale-update counter at 3. */
    function trackedSession(id: string) {
      const ctx = createCtx(db);
      const project = enrollSession(ctx, `scribe:${id}`, id, 'cli-demo').session.projectId!;
      const root = db.prepare('SELECT root_node_id AS r FROM projects WHERE id = ?').get(project) as { r: number };
      const [step] = addNodes(ctx, 'test', { parentId: root.r, nodes: [{ title: `Step for ${id}`, status: 'active' }] });
      db.prepare('UPDATE sessions SET prompts_since_update = 3 WHERE id = ?').run(id);
      return { ctx, step };
    }

    it("replaces the session's tasks on a step, prints the counts, and leaves the stale nudge alone", async () => {
      const { step } = trackedSession('cli-t1');
      const s = capture();
      expect(await runCli(['tasks', String(step.id), '--session', 'cli-t1', '--done', 'Write tests', '--doing', 'Make them pass', '--todo', 'Smoke', '--todo', 'Deploy'], s.out)).toBe(0);
      expect(s.lines).toEqual([`#${step.id}: 1 done · 1 in progress · 2 pending`]);
      const rows = db.prepare("SELECT subject, status FROM work_items WHERE session_id = 'cli-t1' ORDER BY position").all();
      expect(rows).toEqual([
        { subject: 'Write tests', status: 'completed' },
        { subject: 'Make them pass', status: 'in_progress' },
        { subject: 'Smoke', status: 'pending' },
        { subject: 'Deploy', status: 'pending' },
      ]);
      const event = db.prepare("SELECT actor FROM events WHERE type = 'work.updated' ORDER BY id DESC LIMIT 1").get();
      expect(event).toEqual({ actor: 'session:cli-t1' });
      // Only the scribe's writes mean the plan is current: the nudge keeps counting.
      expect(db.prepare("SELECT prompts_since_update AS n FROM sessions WHERE id = 'cli-t1'").get()).toEqual({ n: 3 });
      const cleared = capture();
      expect(await runCli(['tasks', `#${step.id}`, '--session', 'cli-t1'], cleared.out)).toBe(0);
      expect(cleared.lines).toEqual([`#${step.id}: no tasks`]);
    });

    it("uses the session's focus when no step is named, and passes on the no-focus refusal with its hint", async () => {
      const { ctx, step } = trackedSession('cli-t2');
      await expect(runCli(['tasks', '--session', 'cli-t2', '--doing', 'x'], capture().out)).rejects.toMatchObject({
        name: 'ApiClientError', status: 400, message: 'This session has no focus', hint: 'Name the step: tasks <id> …',
      });
      setFocus(ctx, 'scribe:cli-t2', 'cli-t2', step.id);
      const s = capture();
      expect(await runCli(['tasks', '--session', 'cli-t2', '--doing', 'x'], s.out)).toBe(0);
      expect(s.lines).toEqual([`#${step.id}: 1 in progress`]);
    });

    it('prints what is wrong and the usage for bad arguments, without calling the server', async () => {
      // Nothing listens on this port: a call would reject as unreachable instead of returning 1.
      process.env.INPROGRESS_PORT = String(await freePort());
      try {
        const s = capture();
        expect(await runCli(['tasks', '88', '--done', 'x'], s.out)).toBe(1);
        expect(s.lines).toEqual(['Missing --session <session id>', TASKS_USAGE]);
      } finally {
        process.env.INPROGRESS_PORT = new URL(base).port;
      }
    });

    it('never starts the server: one that is not running gets a hint a session can act on', async () => {
      process.env.INPROGRESS_PORT = String(await freePort());
      let started = 0;
      try {
        const run = runCli(['tasks', '88', '--session', 'cli-t3', '--done', 'x'], capture().out, { ensureServer: async () => (started++, true) });
        await expect(run).rejects.toMatchObject({
          name: 'ApiClientError', status: 0, code: 'ECONNREFUSED',
          hint: 'InProgress is not running. A brief to the inprogress-scribe starts it; run this command again after that.',
        });
        expect(started).toBe(0);
      } finally {
        process.env.INPROGRESS_PORT = new URL(base).port;
      }
    });

    it('says a retry is safe when the server is up but too slow to answer', async () => {
      const slow = createServer((req) => req.resume()); // takes the request, never answers
      await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
      try {
        const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
        const run = runTasks(['88', '--session', 'cli-t4', '--done', 'x'], capture().out, { baseUrl: url, token: 't', timeoutMs: 200 });
        await expect(run).rejects.toMatchObject({ name: 'ApiClientError', status: 0, code: 'TIMEOUT', hint: TASKS_TIMEOUT_HINT });
        expect(TASKS_TIMEOUT_HINT).not.toBe(TASKS_NOT_RUNNING_HINT);
      } finally {
        slow.closeAllConnections();
        slow.close();
      }
    });
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

/** Rewrite every hook entry in place (installedClaudeDir's settings hold only InProgress's). */
function editEveryHook(settingsFile: string, edit: (hook: { command: string; args: string[] }) => void): void {
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  for (const groups of Object.values(settings.hooks) as { hooks: { command: string; args: string[] }[] }[][]) for (const g of groups) g.hooks.forEach(edit);
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
    // Installed by the Node running these checks, so not even a warning.
    expect(named(after, 'Hooks')).toEqual({ name: 'Hooks', ok: true, detail: 'all installed' });
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

  it('fails Hooks for an install from before the tool hooks, until install runs again', async () => {
    const { repo, claude, settingsFile } = installedClaudeDir();
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    delete settings.hooks.PreToolUse;
    delete settings.hooks.PostToolUse;
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    expect(named(await checksFor(repo, claude), 'Hooks')).toEqual({ name: 'Hooks', ok: false, detail: 'missing: PreToolUse, PostToolUse: run npm run claude:install' });
    install({ repo, claudeDir: claude, stamp: 'again' });
    expect(named(await checksFor(repo, claude), 'Hooks')).toEqual({ name: 'Hooks', ok: true, detail: 'all installed' });
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

  it("warns, without failing, when the hooks run another Node than this shell's", async () => {
    const { repo, claude, settingsFile } = installedClaudeDir();
    // After an nvm switch the hooks keep the Node that ran install, which still exists.
    const pinned = join(tempDir('ip-node-'), 'node.exe').replace(/\\/g, '/');
    writeFileSync(pinned, '');
    editEveryHook(settingsFile, (h) => (h.command = pinned));
    const detail = `hooks run ${pinned}; this shell's node is ${nodeBinary()}: after an nvm switch, rerun npm run claude:install`;
    expect(named(await checksFor(repo, claude), 'Hooks')).toEqual({ name: 'Hooks', ok: false, warnOnly: true, detail });
    const s = capture();
    expect(await doctor({ baseUrl: base, home, claudeDir: claude, repo, skipMcp: true }, s.out)).toBe(0);
    expect(s.lines).toContain(`! Hooks: ${detail}`);
  });

  it.runIf(process.platform === 'win32')("compares the hooks' Node with this shell's regardless of case and slash direction", async () => {
    const { repo, claude, settingsFile } = installedClaudeDir();
    editEveryHook(settingsFile, (h) => (h.command = nodeBinary().toUpperCase().replace(/\//g, '\\')));
    expect(named(await checksFor(repo, claude), 'Hooks')).toEqual({ name: 'Hooks', ok: true, detail: 'all installed' });
  });

  it("checks this repo's tasks rules among the allow rules, naming a missing one", async () => {
    const { repo, claude, settingsFile } = installedClaudeDir();
    const powerShellRule = `PowerShell(node ${repo}/dist/cli/main.js tasks *)`;
    expect(named(await checksFor(repo, claude), 'Allow rules')).toEqual({ name: 'Allow rules', ok: true, detail: allowRules(repo).join(', ') });
    expect(allowRules(repo)).toContain(powerShellRule);
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    settings.permissions.allow = settings.permissions.allow.filter((r: string) => r !== powerShellRule);
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    expect(named(await checksFor(repo, claude), 'Allow rules')).toEqual({ name: 'Allow rules', ok: false, detail: `missing: ${powerShellRule}: run npm run claude:install` });
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
