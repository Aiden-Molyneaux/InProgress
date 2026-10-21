import { describe, expect, it } from 'vitest';
import type { BackupStatus } from '../../src/core/backups';
import { backupRows, formatSize, restoreCommands, worstLevel, worstNote } from '../../web/src/chrome/backupsLogic';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

function status(over: Partial<BackupStatus> = {}): BackupStatus {
  return {
    backupsDir: '/h/backups',
    offsiteDir: '/h/offsite',
    snapshot: { name: 'inprogress-20261021-100000.db', at: iso(2), level: 'ok' },
    setUp: true,
    pushed: { at: iso(5), level: 'ok' },
    drill: { at: iso(24), ok: true, detail: 'fine', level: 'ok' },
    repoBytes: 12.3 * 1024 * 1024,
    repoLevel: 'ok',
    busy: false,
    warnings: [],
    fail: false,
    check: { name: 'Backups', ok: true, detail: '' },
    ...over,
  };
}

describe('backupRows', () => {
  it('words each row with its age and size', () => {
    expect(backupRows(status(), NOW)).toEqual([
      { label: 'Snapshot', value: 'inprogress-20261021-100000.db · 2 h ago', level: 'ok', note: undefined },
      { label: 'Pushed', value: '5 h ago', level: 'ok', note: undefined },
      { label: 'Drill', value: 'passed · 1 d ago', level: 'ok', note: undefined },
      { label: 'Repo', value: '12.3 MB', level: 'ok', note: undefined },
    ]);
  });

  it('says FAILED for a failed drill and carries the server notes', () => {
    const rows = backupRows(status({ drill: { at: iso(3), ok: false, detail: 'resource a differs', level: 'warn', note: 'the last drill failed' } }), NOW);
    expect(rows[2]).toMatchObject({ label: 'Drill', value: 'FAILED (resource a differs) · 3 h ago', level: 'warn', note: 'the last drill failed' });
  });

  it('is one Pushed row with the init hint when the copy is not set up', () => {
    const rows = backupRows(status({ setUp: false, pushed: null, drill: null, repoBytes: null }), NOW);
    expect(rows.map((r) => r.label)).toEqual(['Snapshot', 'Pushed']);
    expect(rows[1]).toMatchObject({ value: 'not set up', level: 'warn' });
    expect(rows[1].note).toContain('inprogress backup --init <remote url>');
  });

  it('reads set up with nothing pushed, no drill and no snapshot as warnings', () => {
    const rows = backupRows(status({ snapshot: null, pushed: null, drill: null }), NOW);
    expect(rows.slice(0, 3).map((r) => [r.value, r.level])).toEqual([['none yet', 'warn'], ['nothing pushed yet', 'warn'], ['no drill yet', 'warn']]);
  });

  it('formats sizes in MB', () => {
    expect(formatSize(0)).toBe('0.0 MB');
    expect(formatSize(1024 * 1024 * 512)).toBe('512.0 MB');
  });
});

describe('worstLevel and worstNote', () => {
  it('is ok for a healthy status and has no note', () => {
    expect(worstLevel(status())).toBe('ok');
    expect(worstNote(status())).toBeUndefined();
  });

  it('takes the worst row, fail over warn, and names it', () => {
    const s = status({ snapshot: { name: 'x', at: iso(30), level: 'warn', note: 'the newest snapshot is over 26 hours old' }, pushed: { at: iso(200), level: 'fail', note: 'the newest pushed commit is over 7 days old' } });
    expect(worstLevel(s)).toBe('fail');
    expect(worstNote(s)).toBe('the newest pushed commit is over 7 days old');
    expect(worstLevel(status({ setUp: false, pushed: null }))).toBe('warn');
  });
});

describe('restoreCommands', () => {
  it('lists stop, restore naming the newest snapshot, and restore --from the offsite path', () => {
    const [stop, restore, from] = restoreCommands(status());
    expect(stop.command).toBe('inprogress stop');
    expect(restore).toEqual({ command: 'inprogress restore', detail: 'restores inprogress-20261021-100000.db' });
    expect(from.command).toBe('inprogress restore --from /h/offsite');
  });

  it('quotes an offsite path with a space', () => {
    expect(restoreCommands(status({ offsiteDir: 'C:\\Users\\A B\\.inprogress\\offsite' }))[2].command).toBe('inprogress restore --from "C:\\Users\\A B\\.inprogress\\offsite"');
  });
});
