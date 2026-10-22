import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BackUpNowResult } from '../../src/core/backups';
import { buildApp } from '../../src/server/app';
import type { BackupRunner } from '../../src/server/backup-runner';
import { makeCtx } from '../helpers';

const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui-token' };
const HOME = mkdtempSync(join(tmpdir(), 'ip-backup-routes-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function setup(over: Partial<BackupRunner> = {}) {
  const result: BackUpNowResult = { status: 'ok', snapshot: 'written', message: 'Backed up and pushed.' };
  const runner: BackupRunner = { running: () => false, startup: () => undefined, tick: async () => undefined, backUpNow: vi.fn(async () => result), ...over };
  const openFolder = vi.fn(async () => undefined);
  const app = buildApp({ ctx: makeCtx(), token: 't', uiToken: 'ui-token', version: 'test', home: HOME, backups: runner, openFolder });
  return { app, runner, openFolder, result };
}

describe('Backups routes', { timeout: 30_000 }, () => {
  it('GET /api/backups answers the status, with busy from the runner', async () => {
    const { app } = setup({ running: () => true });
    const res = await app.inject({ method: 'GET', url: '/api/backups' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ backupsDir: join(HOME, 'backups'), offsiteDir: join(HOME, 'offsite'), setUp: false, snapshot: null, pushed: null, drill: null, busy: true, fail: false });
    expect(body.check.name).toBe('Backups');
    expect(body.warnings).toContain('no snapshot yet');
  });

  it('is not served without a home and a runner', async () => {
    const app = buildApp({ ctx: makeCtx(), token: 't', uiToken: 'ui-token', version: 'test' });
    expect((await app.inject({ method: 'GET', url: '/api/backups' })).statusCode).toBe(404);
  });

  it.each(['/api/ui/backups/run', '/api/ui/backups/open-folder'])('POST %s refuses a missing UI token and a foreign origin', async (url) => {
    const { app, runner, openFolder } = setup();
    const noToken = await app.inject({ method: 'POST', url, headers: { origin: UI.origin }, payload: {} });
    expect(noToken.statusCode).toBe(401);
    const foreign = await app.inject({ method: 'POST', url, headers: { ...UI, origin: 'http://evil.example' }, payload: {} });
    expect(foreign.statusCode).toBe(403);
    expect(runner.backUpNow).not.toHaveBeenCalled();
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('POST /api/ui/backups/run answers the runner result and a fresh status', async () => {
    const { app, runner, result } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/ui/backups/run', headers: UI, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result, status: { offsiteDir: join(HOME, 'offsite') } });
    expect(runner.backUpNow).toHaveBeenCalledTimes(1);
  });

  it('answers 200 for a busy result too', async () => {
    const busy: BackUpNowResult = { status: 'busy', message: 'Another backup is running: try again in a few minutes' };
    const { app } = setup({ backUpNow: async () => busy });
    const res = await app.inject({ method: 'POST', url: '/api/ui/backups/run', headers: UI, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual(busy);
  });

  it('POST /api/ui/backups/open-folder creates the folder and opens it', async () => {
    const { app, openFolder } = setup();
    expect(existsSync(join(HOME, 'backups'))).toBe(false);
    const res = await app.inject({ method: 'POST', url: '/api/ui/backups/open-folder', headers: UI, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(existsSync(join(HOME, 'backups'))).toBe(true);
    expect(openFolder).toHaveBeenCalledWith(join(HOME, 'backups'));
  });
});
