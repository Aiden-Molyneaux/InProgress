import type { BackupLevel, BackupRow, BackupStatus } from '../../../src/core/backups';

/** The panel's rows exactly as the server worded and levelled them (backup-status.ts holds doctor's thresholds). */
export const backupRows = (status: BackupStatus): BackupRow[] => status.rows;

/** The worst level doctor's Backups check reports: a push over 7 days old fails, any other warning warns. */
export function worstLevel(status: BackupStatus): BackupLevel {
  if (status.fail) return 'fail';
  return status.warnings.length ? 'warn' : 'ok';
}

/** The first warning, for the footer button's title; nothing while all is ok. */
export const worstNote = (status: BackupStatus): string | undefined => status.warnings[0];

export interface RestoreCommand {
  command: string;
  /** What the command restores from, when that is worth naming. */
  detail?: string;
}

/** The three commands that go back to a backup, run in the CLI with InProgress stopped. The path is always quoted: Git Bash strips the backslashes of an unquoted one. */
export function restoreCommands(status: BackupStatus): RestoreCommand[] {
  return [
    { command: 'inprogress stop' },
    { command: 'inprogress restore', detail: status.snapshot ? `restores ${status.snapshot.name}` : 'no snapshot to restore yet' },
    { command: `inprogress restore --from "${status.offsiteDir}"`, detail: 'restores the off-machine copy' },
  ];
}
