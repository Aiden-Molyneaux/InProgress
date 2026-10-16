import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app';
import { desktopCommand, findClaude, firstClaudeExe, forgetClaude, openInDesktop, usableCwd, type DesktopSession } from '../../src/server/open-desktop';
import { makeCtx } from '../helpers';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };
const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui-token' };
const ID = '0b9d1a52-3c3e-4a43-9f43-2d7c6e1f8a10';

const DIR = mkdtempSync(join(tmpdir(), 'ip-open-desktop-'));
const FILE = join(DIR, 'not-a-dir.txt');
writeFileSync(FILE, '');
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** A folder that does not exist on this machine (C:/personal/InGame may). */
const GONE = join(DIR, 'gone-project');

async function setup(openDesktop: (session: DesktopSession) => Promise<boolean>, cwd = GONE) {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test', openDesktop });
  await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } });
  await app.inject({ method: 'POST', url: '/api/projects/ingame/bindings', headers: auth, payload: { path: cwd } });
  await app.inject({ method: 'POST', url: `/api/sessions/${ID}/hook`, headers: auth, payload: { event: 'start', source: 'startup', cwd } });
  const post = (id: string, headers: Record<string, string> = UI) => app.inject({ method: 'POST', url: `/api/ui/sessions/${id}/open-desktop`, headers, payload: {} });
  return { post };
}

describe('POST /api/ui/sessions/:id/open-desktop', () => {
  it('answers ok when the launch worked, and passes the session id and its cwd', async () => {
    const open = vi.fn(async () => true);
    const { post } = await setup(open);
    const res = await post(ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith({ id: ID, cwd: GONE });
  });

  it('answers ok false with the bare command when the launch failed and the cwd is not a folder here', async () => {
    const { post } = await setup(async () => false);
    const res = await post(ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, command: `claude --desktop --resume ${ID}` });
  });

  it('answers ok false with a cd into the session folder first when that folder exists', async () => {
    const { post } = await setup(async () => false, DIR);
    expect((await post(ID)).json()).toEqual({ ok: false, command: `cd "${DIR}"; claude --desktop --resume ${ID}` });
  });

  it('answers 400 for an id that is not a UUID, without launching', async () => {
    const open = vi.fn(async () => true);
    const { post } = await setup(open);
    expect((await post('s1')).statusCode).toBe(400);
    expect((await post('not%20a%20uuid')).statusCode).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });

  it('answers 404 for a session that does not exist, without launching', async () => {
    const open = vi.fn(async () => true);
    const { post } = await setup(open);
    expect((await post('11111111-2222-4333-8444-555555555555')).statusCode).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a request from another origin, one without the UI token, and one with a bearer token only', async () => {
    const open = vi.fn(async () => true);
    const { post } = await setup(open);
    expect((await post(ID, { ...UI, origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await post(ID, { origin: UI.origin })).statusCode).toBe(401);
    expect((await post(ID, { ...auth, origin: UI.origin })).statusCode).toBe(401);
    expect(open).not.toHaveBeenCalled();
  });
});

/** A child process that does what the test says, so no real `claude` runs. */
function fakeChild(): ChildProcess & { killed: boolean } {
  const child = new EventEmitter() as ChildProcess & { killed: boolean };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

describe('openInDesktop', () => {
  it('runs claude --desktop --resume <id> without a shell, and is true on exit 0', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const result = openInDesktop({ id: ID, cwd: null }, { spawn, findClaude: () => 'claude', timeoutMs: 1000 });
    child.emit('exit', 0);
    expect(await result).toBe(true);
    const [file, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { shell: boolean; windowsHide: boolean }];
    expect(file).toBe('claude');
    expect(args).toEqual(['--desktop', '--resume', ID]);
    expect(options).toMatchObject({ shell: false, windowsHide: true });
  });

  it('is false on a non-zero exit', async () => {
    const child = fakeChild();
    const result = openInDesktop({ id: ID, cwd: null }, { spawn: () => child, findClaude: () => 'claude', timeoutMs: 1000 });
    child.emit('exit', 1);
    expect(await result).toBe(false);
  });

  it('is false on a spawn error, whether it is thrown or emitted', async () => {
    const child = fakeChild();
    const emitted = openInDesktop({ id: ID, cwd: null }, { spawn: () => child, findClaude: () => 'claude', timeoutMs: 1000 });
    child.emit('error', new Error('ENOENT'));
    expect(await emitted).toBe(false);
    const thrown = openInDesktop({ id: ID, cwd: null }, {
      findClaude: () => 'claude',
      spawn: () => {
        throw new Error('EINVAL');
      },
    });
    expect(await thrown).toBe(false);
  });

  it('is false on a timeout, and kills the child', async () => {
    const child = fakeChild();
    expect(await openInDesktop({ id: ID, cwd: null }, { spawn: () => child, findClaude: () => 'claude', timeoutMs: 20 })).toBe(false);
    expect(child.killed).toBe(true);
  });
});

describe('openInDesktop: where it runs and what it runs', () => {
  const optionsOf = (spawn: ReturnType<typeof vi.fn>) => (spawn.mock.calls[0] as unknown as [string, string[], { cwd: string }]);

  it('runs in the session folder when it is an absolute path to a folder that exists', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const result = openInDesktop({ id: ID, cwd: DIR }, { spawn, findClaude: () => 'C:/bin/claude.exe', timeoutMs: 1000 });
    child.emit('exit', 0);
    await result;
    expect(optionsOf(spawn)[0]).toBe('C:/bin/claude.exe');
    expect(optionsOf(spawn)[2].cwd).toBe(DIR);
  });

  it('falls back to the home folder for a missing, relative, absent or non-folder cwd', async () => {
    for (const cwd of [join(DIR, 'gone'), 'relative/dir', null, FILE]) {
      const child = fakeChild();
      const spawn = vi.fn(() => child);
      const result = openInDesktop({ id: ID, cwd }, { spawn, findClaude: () => 'claude', timeoutMs: 1000 });
      child.emit('exit', 0);
      await result;
      expect(optionsOf(spawn)[2].cwd).toBe(homedir());
    }
  });

  it('answers false without spawning when claude.exe cannot be found', async () => {
    const spawn = vi.fn(() => fakeChild());
    expect(await openInDesktop({ id: ID, cwd: DIR }, { spawn, findClaude: () => undefined, timeoutMs: 1000 })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('gives a second call for the same session the launch already in flight, and launches again once it settles', async () => {
    const first = fakeChild();
    const spawn = vi.fn(() => first);
    const o = { spawn, findClaude: () => 'claude', timeoutMs: 1000 };
    const a = openInDesktop({ id: ID, cwd: null }, o);
    const b = openInDesktop({ id: ID, cwd: null }, o);
    expect(b).toBe(a);
    expect(spawn).toHaveBeenCalledTimes(1);
    first.emit('exit', 0);
    expect(await a).toBe(true);
    const second = fakeChild();
    spawn.mockImplementation(() => second);
    const c = openInDesktop({ id: ID, cwd: null }, o);
    expect(c).not.toBe(a);
    expect(spawn).toHaveBeenCalledTimes(2);
    second.emit('exit', 1);
    expect(await c).toBe(false);
  });
});

describe('the helpers', () => {
  it('usableCwd keeps only an absolute path to a folder that exists', () => {
    expect(usableCwd(DIR)).toBe(DIR);
    expect(usableCwd(null)).toBeNull();
    expect(usableCwd('relative/dir')).toBeNull();
    expect(usableCwd(join(DIR, 'gone'))).toBeNull();
    expect(usableCwd(FILE)).toBeNull();
  });

  it('desktopCommand cds into a known folder first, and is bare without one or for a folder it cannot quote', () => {
    expect(desktopCommand(ID, null)).toBe(`claude --desktop --resume ${ID}`);
    expect(desktopCommand(ID, 'C:\\work\\My App')).toBe(`cd "C:\\work\\My App"; claude --desktop --resume ${ID}`);
    expect(desktopCommand(ID, 'C:\\personal\\Caf\u00e9 (old)\\.claude\\worktrees\\x-1')).toBe(`cd "C:\\personal\\Caf\u00e9 (old)\\.claude\\worktrees\\x-1"; claude --desktop --resume ${ID}`);
    expect(desktopCommand(ID, '/home/a/my-app')).toBe(`cd "/home/a/my-app"; claude --desktop --resume ${ID}`);
    for (const odd of ['/a/$HOME', '/a/`x`', '/a/"q"', 'C:\\work\\[draft]', 'C:\\work\\a]b', 'C:\\work\\', '\\\\server\\share\\app', 'C:\\work\\the \u201cbig\u201d app', 'C:\\work\\a\u201eb', 'C:\\work\\a\u2019b', 'C:\\work\\hi!', 'C:\\work\\a;b']) {
      expect(desktopCommand(ID, odd)).toBe(`claude --desktop --resume ${ID}`);
    }
  });

  beforeEach(forgetClaude);
  afterEach(forgetClaude);

  it('findClaude caches a path it found while it exists, and never caches a miss', () => {
    const exe = join(DIR, 'claude.exe');
    writeFileSync(exe, '');
    const missing = vi.fn(() => undefined);
    expect(findClaude(missing)).toBeUndefined();
    expect(findClaude(missing)).toBeUndefined();
    expect(missing).toHaveBeenCalledTimes(2);
    const found = vi.fn(() => exe);
    expect(findClaude(found)).toBe(exe);
    expect(findClaude(found)).toBe(exe);
    expect(found).toHaveBeenCalledTimes(1);
    rmSync(exe);
    const moved = join(DIR, 'moved-claude.exe');
    writeFileSync(moved, '');
    const again = vi.fn(() => moved);
    expect(findClaude(again)).toBe(moved);
    expect(again).toHaveBeenCalledTimes(1);
    forgetClaude();
  });

  it('firstClaudeExe takes the first line of where.exe that ends in claude.exe', () => {
    expect(firstClaudeExe('C:\\a\\claude\r\nC:\\b\\Claude.EXE\r\nC:\\c\\claude.exe\r\n')).toBe('C:\\b\\Claude.EXE');
    expect(firstClaudeExe('C:\\a\\claude.cmd\r\n')).toBeUndefined();
    expect(firstClaudeExe('')).toBeUndefined();
  });
});
