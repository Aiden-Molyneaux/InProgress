import { join } from 'node:path';
import { BACKUP_BUSY, type BackUpNowResult } from '../core/backups';
import { snapshotDb } from './backup';
import type { DB } from './db/connection';
import { lockHeld, offsiteDir, runOffsite, tickOffsite, type OffsiteLog } from './offsite';

export type { BackUpNowResult };

export interface BackupRunner {
  /** Whether a tick, the startup run or Back up now is working. */
  running(): boolean;
  /** The off-machine copy and the drill at startup, in the background. */
  startup(): void;
  /** The server's timer tick: snapshot, maintenance, off-machine copy. Does nothing while a run is in progress. */
  tick(): Promise<void>;
  /** The window's Back up now: the same work as `inprogress backup --push`. */
  backUpNow(): Promise<BackUpNowResult>;
}

/**
 * Serializes every backup the server runs through one flag: a push that takes minutes must not overlap the next tick's
 * snapshot or copy, nor a click on Back up now. tickOffsite and runOffsite never throw.
 */
export function createBackupRunner(o: { db: DB; home: string; log: OffsiteLog; maintenance: () => void }): BackupRunner {
  const { db, home, log } = o;
  const backups = join(home, 'backups');
  let busy = false;

  /** The snapshot first, so the newest one still holds a project the purge in maintenance is about to remove; then the off-machine copy. Never throws. */
  const cycle = async (): Promise<void> => {
    await snapshotDb(db, backups).catch((err: Error) => log.error(err.message));
    try {
      o.maintenance();
    } catch (err) {
      log.error(`Could not run the maintenance: ${(err as Error).message}`);
    }
    await tickOffsite(db, home, log);
  };

  return {
    running: () => busy,
    startup() {
      // A run already going covers the startup work: the flag is only ever set by one of these.
      if (busy) return;
      busy = true;
      void cycle().finally(() => {
        busy = false;
      });
    },
    async tick() {
      if (busy) return;
      busy = true;
      try {
        await cycle();
      } finally {
        busy = false;
      }
    },
    async backUpNow() {
      // The lock covers another process (the CLI's `backup --push`) working on the same repo.
      if (busy || lockHeld(offsiteDir(home))) return { status: 'busy', message: BACKUP_BUSY };
      busy = true;
      try {
        let snapshot: 'written' | 'unchanged' | 'failed';
        let snapshotError = '';
        try {
          snapshot = (await snapshotDb(db, backups)).skipped ? 'unchanged' : 'written';
        } catch (err) {
          snapshot = 'failed';
          snapshotError = (err as Error).message;
          log.error(snapshotError);
        }
        let lastError = '';
        const capture: OffsiteLog = {
          info: (message) => log.info(message),
          error: (message) => {
            lastError = message;
            log.error(message);
          },
        };
        const outcome = await runOffsite(db, home, capture, { force: true });
        const offsite =
          outcome === 'ok'
            ? 'Backed up and pushed.'
            : outcome === 'busy'
              ? BACKUP_BUSY
              : outcome === 'not set up'
                ? 'The off-machine copy is not set up: run inprogress backup --init <remote url>'
                : lastError || 'The off-machine backup failed: see server.log';
        if (snapshot === 'failed') return { status: 'failed', snapshot, message: `The snapshot failed: ${snapshotError}. ${offsite}` };
        if (outcome === 'not set up') return { status: outcome, snapshot, message: `Took a snapshot. ${offsite}` };
        return { status: outcome, snapshot, message: offsite };
      } finally {
        busy = false;
      }
    },
  };
}
