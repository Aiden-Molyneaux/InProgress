import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app';
import { openInDesktop } from '../../src/server/open-desktop';
import { makeCtx } from '../helpers';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };
const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui-token' };
const ID = '0b9d1a52-3c3e-4a43-9f43-2d7c6e1f8a10';

async function setup(openDesktop: (id: string) => Promise<boolean>) {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test', openDesktop });
  await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } });
  await app.inject({ method: 'POST', url: '/api/projects/ingame/bindings', headers: auth, payload: { path: 'C:/personal/InGame' } });
  await app.inject({ method: 'POST', url: `/api/sessions/${ID}/hook`, headers: auth, payload: { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' } });
  const post = (id: string, headers: Record<string, string> = UI) => app.inject({ method: 'POST', url: `/api/ui/sessions/${id}/open-desktop`, headers, payload: {} });
  return { post };
}

describe('POST /api/ui/sessions/:id/open-desktop', () => {
  it('answers ok when the launch worked, and passes the session id', async () => {
    const open = vi.fn(async () => true);
    const { post } = await setup(open);
    const res = await post(ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith(ID);
  });

  it('answers ok false with the command when the launch failed', async () => {
    const { post } = await setup(async () => false);
    const res = await post(ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, command: `claude --desktop --resume ${ID}` });
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
    const result = openInDesktop(ID, { spawn, timeoutMs: 1000 });
    child.emit('exit', 0);
    expect(await result).toBe(true);
    const [file, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { shell: boolean; windowsHide: boolean }];
    expect(file).toMatch(/^claude(\.exe)?$/);
    expect(args).toEqual(['--desktop', '--resume', ID]);
    expect(options).toMatchObject({ shell: false, windowsHide: true });
  });

  it('is false on a non-zero exit', async () => {
    const child = fakeChild();
    const result = openInDesktop(ID, { spawn: () => child, timeoutMs: 1000 });
    child.emit('exit', 1);
    expect(await result).toBe(false);
  });

  it('is false on a spawn error, whether it is thrown or emitted', async () => {
    const child = fakeChild();
    const emitted = openInDesktop(ID, { spawn: () => child, timeoutMs: 1000 });
    child.emit('error', new Error('ENOENT'));
    expect(await emitted).toBe(false);
    const thrown = openInDesktop(ID, {
      spawn: () => {
        throw new Error('EINVAL');
      },
    });
    expect(await thrown).toBe(false);
  });

  it('is false on a timeout, and kills the child', async () => {
    const child = fakeChild();
    expect(await openInDesktop(ID, { spawn: () => child, timeoutMs: 20 })).toBe(false);
    expect(child.killed).toBe(true);
  });
});
