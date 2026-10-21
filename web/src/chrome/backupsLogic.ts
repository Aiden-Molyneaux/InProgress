import type { BackupLevel, BackupStatus } from '../../../src/core/backups';
import { relativeTime } from '../time';

export interface BackupRow {
  label: 'Snapshot' | 'Pushed' | 'Drill' | 'Repo';
  value: string;
  level: BackupLevel;
  /** Why the row is not ok. */
  note?: string;
}

const MB = 1024 * 1024;

/** A size as the panel shows it: `12.3 MB`, as doctor's repo figure. */
export const formatSize = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/**
 * The rows of the panel. Without the off-machine copy there is one Pushed row saying so: a drill and a repo size mean
 * nothing without it. Levels and notes are the server's (backup-status.ts holds doctor's thresholds); this only words them.
 */
export function backupRows(status: BackupStatus, now: number): BackupRow[] {
  const rows: BackupRow[] = [];
  rows.push(
    status.snapshot
      ? { label: 'Snapshot', value: `${status.snapshot.name} · ${relativeTime(status.snapshot.at, now)}`, level: status.snapshot.level, note: status.snapshot.note }
      : { label: 'Snapshot', value: 'none yet', level: 'warn', note: 'no snapshot yet' },
  );
  if (!status.setUp) {
    rows.push({ label: 'Pushed', value: 'not set up', level: 'warn', note: 'Run inprogress backup --init <remote url>' });
    return rows;
  }
  rows.push(
    status.pushed
      ? { label: 'Pushed', value: relativeTime(status.pushed.at, now), level: status.pushed.level, note: status.pushed.note }
      : { label: 'Pushed', value: 'nothing pushed yet', level: 'warn', note: 'nothing is pushed yet' },
  );
  rows.push(
    status.drill
      ? { label: 'Drill', value: `${status.drill.ok ? 'passed' : `FAILED (${status.drill.detail})`} · ${relativeTime(status.drill.at, now)}`, level: status.drill.level, note: status.drill.note }
      : { label: 'Drill', value: 'no drill yet', level: 'warn', note: 'the backup has never been drilled' },
  );
  if (status.repoBytes !== null) rows.push({ label: 'Repo', value: formatSize(status.repoBytes), level: status.repoLevel, note: status.repoLevel === 'ok' ? undefined : 'the backup repo is over 500 MB' });
  return rows;
}

const RANK: Record<BackupLevel, number> = { ok: 0, warn: 1, fail: 2 };

/** The worst level among the rows. */
export function worstLevel(status: BackupStatus): BackupLevel {
  return backupRows(status, 0).reduce<BackupLevel>((worst, r) => (RANK[r.level] > RANK[worst] ? r.level : worst), 'ok');
}

/** The note of the worst row, for the footer button's title; nothing while all is ok. */
export function worstNote(status: BackupStatus): string | undefined {
  const rows = backupRows(status, 0);
  const worst = rows.reduce<BackupRow | undefined>((w, r) => (r.level !== 'ok' && (!w || RANK[r.level] > RANK[w.level]) ? r : w), undefined);
  return worst?.note;
}

export interface RestoreCommand {
  command: string;
  /** What the command restores from, when that is worth naming. */
  detail?: string;
}

/** A path as the shell takes it: quoted when it holds a space. */
const shellPath = (path: string): string => (/\s/.test(path) ? `"${path}"` : path);

/** The three commands that go back to a backup, run in the CLI with InProgress stopped. */
export function restoreCommands(status: BackupStatus): RestoreCommand[] {
  return [
    { command: 'inprogress stop' },
    { command: 'inprogress restore', detail: status.snapshot ? `restores ${status.snapshot.name}` : 'no snapshot to restore yet' },
    { command: `inprogress restore --from ${shellPath(status.offsiteDir)}`, detail: 'restores the off-machine copy' },
  ];
}
