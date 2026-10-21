import { describe, expect, it } from 'vitest';
import type { BackupStatus } from '../../src/core/backups';
import { backupRows, restoreCommands, worstLevel, worstNote } from '../../web/src/chrome/backupsLogic';

function status(over: Partial<BackupStatus> = {}): BackupStatus {
  return {
    backupsDir: '/h/backups',
    offsiteDir: '/h/offsite',
    snapshot: { name: 'inprogress-20261021-100000.db', at: '2026-10-21T10:00:00Z', level: 'ok' },
    setUp: true,
    pushed: { at: '2026-10-21T08:00:00Z', level: 'ok' },
    drill: null,
    rows: [{ label: 'Snapshot', value: 'inprogress-20261021-100000.db · 2 h ago', level: 'ok' }],
    repoBytes: null,
    repoLevel: 'ok',
    busy: false,
    warnings: [],
    fail: false,
    check: { name: 'Backups', ok: true, detail: '' },
    ...over,
  };
}

describe('the panel renders what the server says', () => {
  it('shows the rows as given', () => {
    const s = status();
    expect(backupRows(s)).toBe(s.rows);
  });

  it('is ok with no warnings, warn with any, fail when the server says so, and names the first warning', () => {
    expect(worstLevel(status())).toBe('ok');
    expect(worstNote(status())).toBeUndefined();
    const warned = status({ warnings: ['the last drill failed', 'the backup repo is over 500 MB'] });
    expect(worstLevel(warned)).toBe('warn');
    expect(worstNote(warned)).toBe('the last drill failed');
    expect(worstLevel(status({ warnings: ['the newest pushed commit is over 7 days old'], fail: true }))).toBe('fail');
  });
});

describe('restoreCommands', () => {
  it('lists stop, restore naming the newest snapshot, and restore --from the quoted offsite path', () => {
    const [stop, restore, from] = restoreCommands(status());
    expect(stop.command).toBe('inprogress stop');
    expect(restore).toEqual({ command: 'inprogress restore', detail: 'restores inprogress-20261021-100000.db' });
    expect(from.command).toBe('inprogress restore --from "/h/offsite"');
  });

  it('quotes a Windows path whole, backslashes and spaces kept', () => {
    expect(restoreCommands(status({ offsiteDir: 'C:\Users\A B\.inprogress\offsite' }))[2].command).toBe('inprogress restore --from "C:\Users\A B\.inprogress\offsite"');
  });

  it('says there is no snapshot to restore when there is none', () => {
    expect(restoreCommands(status({ snapshot: null }))[1].detail).toBe('no snapshot to restore yet');
  });
});
