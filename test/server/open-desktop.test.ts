import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app';
import { desktopAppRunning, desktopLink, desktopSessionDirs, findAppSession, openInDesktop, resumeCommand, usableCwd, type DesktopSession, type OpenDesktopResult } from '../../src/server/open-desktop';
import { openUrl } from '../../src/server/open-path';
import { makeCtx } from '../helpers';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };
const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui-token' };
const ID = '0b9d1a52-3c3e-4a43-9f43-2d7c6e1f8a10';
const APP = 'local_83cd7f8d-e5cb-414e-a3c9-a6e6e9fd1213';
const NOT_IN_APP = "This session is not in the Claude desktop app, so it can't open there. Run this in a terminal to resume it.";

const DIR = mkdtempSync(join(tmpdir(), 'ip-open-desktop-'));
const FILE = join(DIR, 'not-a-dir.txt');
writeFileSync(FILE, '');
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** A folder that does not exist on this machine (C:/personal/InGame may). */
const GONE = join(DIR, 'gone-project');

/** A fresh sessions folder laid out as the desktop app keeps it: <root>/<account>/<org>/local_<uuid>.json. */
let roots = 0;
function sessionsRoot(files: Record<string, unknown>): string {
  const root = join(DIR, `sessions-${roots++}`);
  const org = join(root, 'account-uuid', 'org-uuid');
  mkdirSync(org, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(org, name), typeof body === 'string' ? body : JSON.stringify(body));
  return root;
}

const entry = (sessionId: string, cliSessionId: string, extra: Record<string, unknown> = {}) => ({ sessionId, cliSessionId, title: 'A session', cwd: 'C:\\work', ...extra });

async function setup(openDesktop: (session: DesktopSession) => Promise<OpenDesktopResult>, cwd = GONE) {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test', openDesktop });
  await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } });
  await app.inject({ method: 'POST', url: '/api/projects/ingame/bindings', headers: auth, payload: { path: cwd } });
  await app.inject({ method: 'POST', url: `/api/sessions/${ID}/hook`, headers: auth, payload: { event: 'start', source: 'startup', cwd } });
  const post = (id: string, headers: Record<string, string> = UI) => app.inject({ method: 'POST', url: `/api/ui/sessions/${id}/open-desktop`, headers, payload: {} });
  return { post };
}

describe('POST /api/ui/sessions/:id/open-desktop', () => {
  it('answers ok when the desktop app was asked to open it, and passes the session id', async () => {
    const open = vi.fn(async (): Promise<OpenDesktopResult> => ({ ok: true }));
    const { post } = await setup(open);
    const res = await post(ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith({ id: ID });
  });

  it('answers ok false with the bare resume command, and names the folder in the reason, when the cwd is not a folder here', async () => {
    const { post } = await setup(async () => ({ ok: false, reason: NOT_IN_APP }));
    const res = await post(ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, command: `claude --resume ${ID}`, reason: `${NOT_IN_APP} Start it from ${GONE}.` });
  });

  it('answers ok false with a cd into the session folder first when that folder exists', async () => {
    const { post } = await setup(async () => ({ ok: false, reason: 'why' }), DIR);
    expect((await post(ID)).json()).toEqual({ ok: false, command: `cd "${DIR}"; claude --resume ${ID}`, reason: 'why' });
  });

  it('answers 400 for an id that is not a UUID, without opening anything', async () => {
    const open = vi.fn(async (): Promise<OpenDesktopResult> => ({ ok: true }));
    const { post } = await setup(open);
    expect((await post('s1')).statusCode).toBe(400);
    expect((await post('not%20a%20uuid')).statusCode).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });

  it('answers 404 for a session that does not exist, without opening anything', async () => {
    const open = vi.fn(async (): Promise<OpenDesktopResult> => ({ ok: true }));
    const { post } = await setup(open);
    expect((await post('11111111-2222-4333-8444-555555555555')).statusCode).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a request from another origin, one without the UI token, and one with a bearer token only', async () => {
    const open = vi.fn(async (): Promise<OpenDesktopResult> => ({ ok: true }));
    const { post } = await setup(open);
    expect((await post(ID, { ...UI, origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await post(ID, { origin: UI.origin })).statusCode).toBe(401);
    expect((await post(ID, { ...auth, origin: UI.origin })).statusCode).toBe(401);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('openInDesktop', () => {
  // #473: `claude --desktop --resume` refuses to run without a terminal, and the server has none, so it failed every
  // time. The desktop app's own link opens the session with no CLI involved.
  it("opens the desktop app's own link for the session, found through the app's session files, without running claude", async () => {
    const openUrl = vi.fn(async () => {});
    const dirs = [sessionsRoot({ [`${APP}.json`]: entry(APP, ID) })];
    expect(await openInDesktop({ id: ID }, { dirs, openUrl })).toEqual({ ok: true });
    expect(openUrl).toHaveBeenCalledWith(`claude://claude.ai/epitaxy/${APP}`);
  });

  it('says in words why, without opening anything, when the desktop app has no session for it', async () => {
    const openUrl = vi.fn(async () => {});
    const other = 'local_11111111-1111-4111-8111-111111111111';
    const dirs = [sessionsRoot({ [`${other}.json`]: entry(other, '22222222-2222-4222-8222-222222222222') }), join(DIR, 'no-such-root')];
    expect(await openInDesktop({ id: ID }, { dirs, openUrl })).toEqual({ ok: false, reason: NOT_IN_APP });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("says it could not find the app's session files when no file reads as one, rather than that the session is not there", async () => {
    const openUrl = vi.fn(async () => {});
    const dirs = [sessionsRoot({ 'local_11111111-1111-4111-8111-111111111111.json': '{"format":"changed"}' }), join(DIR, 'no-such-root')];
    expect(await openInDesktop({ id: ID }, { dirs, openUrl })).toEqual({ ok: false, reason: "InProgress could not find the Claude desktop app's session files, so it can't open the session there. Run this in a terminal to resume it." });
    expect(await openInDesktop({ id: ID }, { dirs: [], openUrl })).toMatchObject({ ok: false });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('says why when handing the link to the system fails', async () => {
    const openUrl = vi.fn(async () => {
      throw new Error('spawn explorer.exe ENOENT');
    });
    const dirs = [sessionsRoot({ [`${APP}.json`]: entry(APP, ID) })];
    expect(await openInDesktop({ id: ID }, { dirs, openUrl })).toEqual({ ok: false, reason: 'The Claude desktop app could not be opened: spawn explorer.exe ENOENT' });
  });
});

describe('findAppSession', () => {
  it('takes the most recently active app session when several point at one CLI session, across roots', async () => {
    const older = 'local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newer = 'local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const a = sessionsRoot({ [`${older}.json`]: entry(older, ID, { lastActivityAt: 100 }) });
    const b = sessionsRoot({ [`${newer}.json`]: entry(newer, ID, { lastActivityAt: 200 }) });
    expect(await findAppSession(ID, [a, b])).toBe(newer);
    expect(await findAppSession(ID, [b, a])).toBe(newer);
  });

  it('prefers an app session that is not archived', async () => {
    const live = 'local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const archived = 'local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const root = sessionsRoot({ [`${live}.json`]: entry(live, ID, { lastActivityAt: 100 }), [`${archived}.json`]: entry(archived, ID, { lastActivityAt: 200, isArchived: true }) });
    expect(await findAppSession(ID, [root])).toBe(live);
  });

  it('skips files that are not app sessions: bad JSON, another name, a missing or odd id', async () => {
    const root = sessionsRoot({
      'local_cccccccc-cccc-4ccc-8ccc-cccccccccccc.json': `{"cliSessionId":"${ID}",`,
      'notes.json': entry(APP, ID),
      'local_dddddddd-dddd-4ddd-8ddd-dddddddddddd.json': entry('', ID),
      'local_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.json': entry('local_x"; calc', ID),
      'local_ffffffff-ffff-4fff-8fff-ffffffffffff.json': { sessionId: 'local_ffffffff-ffff-4fff-8fff-ffffffffffff' },
    });
    expect(await findAppSession(ID, [root])).toBeUndefined();
  });

  it('reads a file again once it changes', async () => {
    const root = sessionsRoot({ [`${APP}.json`]: entry(APP, '22222222-2222-4222-8222-222222222222') });
    const file = join(root, 'account-uuid', 'org-uuid', `${APP}.json`);
    expect(await findAppSession(ID, [root])).toBeUndefined();
    writeFileSync(file, JSON.stringify(entry(APP, ID)));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(await findAppSession(ID, [root])).toBe(APP);
  });
});

describe('desktopAppRunning', () => {
  it("reads the app as running only when a data folder's lockfile is held, and asks no further once one is", () => {
    const appData = join(DIR, 'app-data');
    mkdirSync(join(appData, 'claude-code-sessions'), { recursive: true });
    const sessions = join(appData, 'claude-code-sessions');
    const lock = join(appData, 'lockfile');
    const held = vi.fn(() => true);
    expect(desktopAppRunning([sessions], held)).toBe(false);
    expect(held).not.toHaveBeenCalled();
    writeFileSync(lock, '');
    expect(desktopAppRunning([sessions], held)).toBe(true);
    expect(held).toHaveBeenCalledWith(lock);
    expect(desktopAppRunning([sessions], () => false)).toBe(false);
    // The real check: a lockfile nobody holds opens, so the app is not running.
    expect(desktopAppRunning([sessions])).toBe(false);
  });
});

describe('the helpers', () => {
  it('desktopLink is the link the desktop app hands out for a session', () => {
    expect(desktopLink(APP)).toBe(`claude://claude.ai/epitaxy/${APP}`);
  });

  it("desktopSessionDirs looks where the desktop app keeps its sessions: Roaming, the Store install's cache, or macOS's Application Support", () => {
    const local = join(DIR, 'local');
    mkdirSync(join(local, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true });
    mkdirSync(join(local, 'Packages', 'Microsoft.Other'), { recursive: true });
    expect(desktopSessionDirs({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: local }, 'win32', 'C:\\Users\\a')).toEqual([
      join('C:\\Users\\a\\AppData\\Roaming', 'Claude', 'claude-code-sessions'),
      join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'),
    ]);
    expect(desktopSessionDirs({}, 'darwin', '/Users/a')).toEqual([join('/Users/a', 'Library', 'Application Support', 'Claude', 'claude-code-sessions')]);
    expect(desktopSessionDirs({}, 'linux', '/home/a')).toEqual([]);
  });

  it('usableCwd keeps only an absolute path to a folder that exists', () => {
    expect(usableCwd(DIR)).toBe(DIR);
    expect(usableCwd(null)).toBeNull();
    expect(usableCwd('relative/dir')).toBeNull();
    expect(usableCwd(join(DIR, 'gone'))).toBeNull();
    expect(usableCwd(FILE)).toBeNull();
  });

  it('resumeCommand cds into a known folder first, and is bare without one or for a folder it cannot quote', () => {
    expect(resumeCommand(ID, null)).toBe(`claude --resume ${ID}`);
    expect(resumeCommand(ID, 'C:\\work\\My App')).toBe(`cd "C:\\work\\My App"; claude --resume ${ID}`);
    expect(resumeCommand(ID, 'C:\\personal\\Caf\u00e9 (old)\\.claude\\worktrees\\x-1')).toBe(`cd "C:\\personal\\Caf\u00e9 (old)\\.claude\\worktrees\\x-1"; claude --resume ${ID}`);
    expect(resumeCommand(ID, '/home/a/my-app')).toBe(`cd "/home/a/my-app"; claude --resume ${ID}`);
    for (const odd of ['/a/$HOME', '/a/`x`', '/a/"q"', 'C:\\work\\[draft]', 'C:\\work\\a]b', 'C:\\work\\', '\\\\server\\share\\app', 'C:\\work\\the \u201cbig\u201d app', 'C:\\work\\a\u201eb', 'C:\\work\\a\u2019b', 'C:\\work\\hi!', 'C:\\work\\a;b']) {
      expect(resumeCommand(ID, odd)).toBe(`claude --resume ${ID}`);
    }
  });
});

describe('openUrl', () => {
  const systemRoot = process.env.SystemRoot;
  afterEach(() => {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  });

  it.runIf(process.platform === 'win32')('rejects when the opener cannot start, so the window hears why', async () => {
    process.env.SystemRoot = join(DIR, 'no-windows');
    await expect(openUrl(desktopLink(APP))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
