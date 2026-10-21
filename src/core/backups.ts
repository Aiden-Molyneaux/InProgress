// Types only: the window imports them, so nothing here may pull in node modules.
export type BackupLevel = 'ok' | 'warn' | 'fail';

/** What `inprogress doctor`'s Backups check reads, as rows the window can show. */
export interface BackupStatus {
  backupsDir: string;
  offsiteDir: string;
  /** at: ISO of max(stamp, mtime), as doctor ages it. */
  snapshot: { name: string; at: string; level: BackupLevel; note?: string } | null;
  setUp: boolean; // offsite/.git exists
  pushed: { at: string; level: BackupLevel; note?: string } | null;
  drill: { at: string; ok: boolean; detail: string; level: BackupLevel; note?: string } | null;
  repoBytes: number | null;
  repoLevel: BackupLevel;
  busy: boolean;
  warnings: string[];
  fail: boolean;
  /** Doctor's Backups check, exactly as `inprogress doctor` prints it. */
  check: { name: 'Backups'; ok: boolean; warnOnly?: boolean; detail: string };
}

/** The answer to Back up now. */
export interface BackUpNowResult {
  status: 'ok' | 'busy' | 'not set up' | 'failed';
  snapshot?: 'written' | 'unchanged' | 'failed';
  message: string;
}
