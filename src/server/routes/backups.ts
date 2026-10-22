import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BackupStatus } from '../../core/backups';
import type { AppOptions, Guard } from '../app';
import { backupStatus } from '../backup-status';
import type { BackupRunner } from '../backup-runner';
import { lastDrill } from '../offsite';
import { openFolder } from '../open-path';

/** The Backups panel's routes: the status doctor reports, Back up now, and opening the backups folder. */
export function registerBackupRoutes(app: FastifyInstance, opts: AppOptions & { home: string; backups: BackupRunner }, requireUi: Guard): void {
  const { home, backups: runner } = opts;
  const guarded = { onRequest: requireUi };
  // The server is up by definition here, so a stale snapshot warns. The stored drill comes from the open database.
  const status = async (): Promise<BackupStatus> => {
    const s = await backupStatus(home, { serverUp: true, now: new Date(), drill: lastDrill(opts.ctx.db) ?? null });
    return { ...s, busy: s.busy || runner.running() };
  };

  app.get('/api/backups', async () => status());

  // 200 for every result: the request was fine, the backup may not have been (the result says which).
  app.post('/api/ui/backups/run', guarded, async () => {
    const result = await runner.backUpNow();
    return { result, status: await status() };
  });

  app.post('/api/ui/backups/open-folder', guarded, async () => {
    const dir = join(home, 'backups');
    await mkdir(dir, { recursive: true });
    await (opts.openFolder ?? openFolder)(dir);
    return { ok: true };
  });
}
