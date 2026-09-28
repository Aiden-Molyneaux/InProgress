import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install } from '../../src/cli/claude-config';
import { runCli } from '../../src/cli/commands';
import { runChecks, type Check } from '../../src/cli/doctor';
import { edgeArgs } from '../../src/cli/open';
import { ensureToken } from '../../src/lib/home';
import { VERSION } from '../../src/lib/version';
import { buildApp } from '../../src/server/app';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { createProject } from '../../src/server/repo/projects';

let base = '';
let home = '';
let close: () => Promise<unknown>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ip-cli-'));
  const token = ensureToken(home);
  const ctx = createCtx(openDb(join(home, 'inprogress.db')));
  createProject(ctx, 'test', { name: 'CLI Demo' });
  const app = buildApp({ ctx, token, uiToken: 'u', version: VERSION });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  process.env.INPROGRESS_PORT = String(port);
  process.env.INPROGRESS_HOME = home;
  close = () => app.close();
});
afterAll(() => close());

function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
}

/**
 * A stand-in repo: the real claude/ templates plus an empty dist/hooks/hook.js. Doctor checks that each hook's
 * script exists, and unit tests must not depend on a build.
 */
function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ip-repo-'));
  cpSync(join(process.cwd(), 'claude'), join(dir, 'claude'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'hooks', 'hook.js'), '');
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
    const claude = mkdtempSync(join(tmpdir(), 'ip-cli-claude-'));
    const otherHome = mkdtempSync(join(tmpdir(), 'ip-cli-home-'));
    ensureToken(otherHome); // not the server's token, so the shutdown request gets a 401
    const savedClaude = process.env.INPROGRESS_CLAUDE_DIR;
    process.env.INPROGRESS_HOME = otherHome;
    process.env.INPROGRESS_CLAUDE_DIR = claude;
    try {
      const s = capture();
      expect(await runCli(['claude-install'], s.out)).toBe(0);
      expect(s.lines[0]).toBe('Could not stop the running InProgress server: Missing or invalid InProgress token');
      expect(s.lines.at(-1)).toBe('Next: run `inprogress doctor`, then start a new Claude session.');
      expect(existsSync(join(claude, 'settings.json'))).toBe(true);
    } finally {
      process.env.INPROGRESS_HOME = home;
      if (savedClaude === undefined) delete process.env.INPROGRESS_CLAUDE_DIR;
      else process.env.INPROGRESS_CLAUDE_DIR = savedClaude;
    }
  });
});

/** A temp Claude dir with InProgress installed from a stand-in repo. */
function installedClaudeDir() {
  const repo = fixtureRepo();
  const claude = mkdtempSync(join(tmpdir(), 'ip-doc-'));
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
  it('passes after install and reports what is missing before it', async () => {
    const claude = mkdtempSync(join(tmpdir(), 'ip-doc-'));
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

  it('names a fix for every failure', async () => {
    // Another program on the port, a damaged database without a token, a half-written agent, no settings or skill,
    // and an MCP entry that exits at once.
    const other = createServer((_req, res) => res.end('<!doctype html><title>Some other app</title>'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const brokenHome = mkdtempSync(join(tmpdir(), 'ip-doc-home-'));
    writeFileSync(join(brokenHome, 'inprogress.db'), 'not a database');
    const claude = mkdtempSync(join(tmpdir(), 'ip-doc-'));
    mkdirSync(join(claude, 'agents'));
    writeFileSync(join(claude, 'agents', 'inprogress-scribe.md'), '---\nname: inprogress-scribe\n---\n');
    const repo = mkdtempSync(join(tmpdir(), 'ip-doc-repo-'));
    mkdirSync(join(repo, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'mcp', 'main.js'), 'process.exit(3);\n');
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
        'MCP server': expect.stringContaining('run npm run build'),
      });
    } finally {
      other.close();
    }
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
      detail: 'hook script C:/moved/InProgress/dist/hooks/hook.js no longer exists: run npm run build, or rerun npm run claude:install if the repo moved',
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
});
