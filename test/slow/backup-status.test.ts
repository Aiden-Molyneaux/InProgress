import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { timestamp } from '../../src/server/backup';
import { backupsCheck, backupStatus } from '../../src/server/backup-status';
import { openDb } from '../../src/server/db/connection';
import { lockHeld } from '../../src/server/offsite';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

const now = new Date(2026, 9, 19, 12, 0, 0);
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
// core.hooksPath points at a folder that does not exist, so the user's global hooks never run (docs/known-issues.md).
const git = (cwd: string, args: string[], date?: Date) =>
  execFileSync('git', ['-c', `core.hooksPath=${join(cwd, '.git', 'no-hooks')}`, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date.toISOString(), GIT_AUTHOR_DATE: date.toISOString() } : {}) },
  }).trim();

/** A home with a database, a snapshot from `snapshotHoursAgo`, and a backup repo whose origin/main is the commit `pushedHoursAgo` old. */
function homeWith(o: { snapshotHoursAgo?: number; pushedHoursAgo?: number; drill?: { at: Date; ok: boolean; detail: string } }): string {
  const dir = tempDir('ip-bak-status-');
  const db = openDb(join(dir, 'inprogress.db'));
  if (o.drill) db.prepare("INSERT INTO meta (key, value) VALUES ('backup_drill', ?)").run(JSON.stringify({ ...o.drill, at: o.drill.at.toISOString(), commit: null }));
  db.close();
  if (o.snapshotHoursAgo !== undefined) {
    mkdirSync(join(dir, 'backups'));
    const snapshot = join(dir, 'backups', `inprogress-${timestamp(hoursAgo(o.snapshotHoursAgo))}.db`);
    writeFileSync(snapshot, 'x');
    // The status reads the mtime too: a fixture written now must look as old as its name.
    utimesSync(snapshot, hoursAgo(o.snapshotHoursAgo), hoursAgo(o.snapshotHoursAgo));
  }
  if (o.pushedHoursAgo !== undefined) {
    const repo = join(dir, 'offsite');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'manifest.json'), '{}');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'b'], hoursAgo(o.pushedHoursAgo));
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }
  return dir;
}
const goodDrill = { at: hoursAgo(24), ok: true, detail: 'fine' };

describe('Backups doctor check', { timeout: 60_000 }, () => {
  it('is ok with a fresh snapshot, a recent push and a recent drill, and names each', async () => {
    const check = await backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 5, drill: goodDrill }), true, now);
    expect(check).toMatchObject({ name: 'Backups', ok: true });
    expect(check.detail).toMatch(/newest snapshot inprogress-\d{8}-\d{6}\.db \(2 h ago\); newest pushed commit 5 h ago; last drill passed 1 d ago; repo \d+\.\d MB/);
  });

  it('counts a snapshot a skipped tick touched as current', async () => {
    const dir = homeWith({ snapshotHoursAgo: 30, pushedHoursAgo: 5, drill: goodDrill });
    const [file] = readdirSync(join(dir, 'backups'));
    expect((await backupsCheck(dir, true, now)).detail).toContain('the newest snapshot is over 26 hours old');
    utimesSync(join(dir, 'backups', file), hoursAgo(1), hoursAgo(1));
    const check = await backupsCheck(dir, true, now);
    expect(check).toMatchObject({ ok: true });
    expect(check.detail).toContain('(1 h ago)');
  });

  it('warns at a 4-day-old push', async () => {
    const check = await backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 4 * 24, drill: goodDrill }), true, now);
    expect(check).toMatchObject({ ok: false, warnOnly: true });
    expect(check.detail).toContain('the newest pushed commit is over 3 days old');
  });

  it('fails at an 8-day-old push', async () => {
    const check = await backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 8 * 24, drill: goodDrill }), true, now);
    expect(check.ok).toBe(false);
    expect(check.warnOnly).toBeFalsy();
    expect(check.detail).toContain('over 7 days old');
  });

  it('warns that the off-machine copy is not set up', async () => {
    const check = await backupsCheck(homeWith({ snapshotHoursAgo: 2 }), true, now);
    expect(check).toMatchObject({ ok: false, warnOnly: true });
    expect(check.detail).toContain('not set up: run inprogress backup --init <remote url>');
  });

  it('warns about a failed drill, a drill over 14 days old, and a snapshot over 26 hours old only while the server is up', async () => {
    const failed = await backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 5, drill: { at: hoursAgo(24), ok: false, detail: 'resource a differs' } }), true, now);
    expect(failed).toMatchObject({ ok: false, warnOnly: true });
    expect(failed.detail).toContain('the last drill failed');
    const old = await backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 5, drill: { ...goodDrill, at: hoursAgo(15 * 24) } }), true, now);
    expect(old.detail).toContain('the last drill is over 14 days old');
    const stale = homeWith({ snapshotHoursAgo: 30, pushedHoursAgo: 5, drill: goodDrill });
    expect((await backupsCheck(stale, true, now)).detail).toContain('the newest snapshot is over 26 hours old');
    expect(await backupsCheck(stale, false, now)).toMatchObject({ ok: true });
  });
});

describe('backupStatus rows', { timeout: 60_000 }, () => {
  it('words the rows as the panel shows them, with doctor floored ages', async () => {
    const home = homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 6 * 24 + 5, drill: { at: hoursAgo(3), ok: false, detail: 'resource a differs' } });
    const { rows } = await backupStatus(home, { serverUp: true, now });
    expect(rows.map((r) => r.label)).toEqual(['Snapshot', 'Pushed', 'Drill', 'Repo']);
    expect(rows[0]).toMatchObject({ level: 'ok', value: expect.stringMatching(/^inprogress-\d{8}-\d{6}\.db · 2 h ago$/) });
    expect(rows[1]).toEqual({ label: 'Pushed', value: '6 d ago', level: 'warn', note: 'the newest pushed commit is over 3 days old' });
    expect(rows[2]).toEqual({ label: 'Drill', value: 'FAILED (resource a differs) · 3 h ago', level: 'warn', note: 'the last drill failed' });
    expect(rows[3]).toMatchObject({ label: 'Repo', value: expect.stringMatching(/^\d+\.\d MB$/), level: 'ok' });
  });

  it('words the empty cases, and has no drill or repo row without the off-machine copy', async () => {
    const none = await backupStatus(homeWith({}), { serverUp: true, now });
    expect(none.rows).toEqual([
      { label: 'Snapshot', value: 'none yet', level: 'warn', note: 'no snapshot yet' },
      { label: 'Pushed', value: 'not set up', level: 'warn', note: 'Run inprogress backup --init <remote url>' },
    ]);
    const unpushed = homeWith({ snapshotHoursAgo: 2 });
    mkdirSync(join(unpushed, 'offsite'));
    git(join(unpushed, 'offsite'), ['init', '-q']);
    const rows = (await backupStatus(unpushed, { serverUp: true, now, drill: null })).rows;
    expect(rows.slice(1, 3)).toEqual([
      { label: 'Pushed', value: 'nothing pushed yet', level: 'warn', note: 'nothing is pushed yet' },
      { label: 'Drill', value: 'no drill yet', level: 'warn', note: 'the backup has never been drilled' },
    ]);
  });

  it('prints doctor Backups line exactly', async () => {
    const check = await backupsCheck(homeWith({ snapshotHoursAgo: 30, pushedHoursAgo: 4 * 24, drill: { at: hoursAgo(15 * 24), ok: true, detail: 'fine' } }), true, now);
    const detail = check.detail.replace(/inprogress-\d{8}-\d{6}\.db/, 'SNAP').replace(/repo \d+\.\d MB/, 'repo N MB');
    expect(detail).toBe(
      'the newest snapshot is over 26 hours old; the newest pushed commit is over 3 days old; the last drill is over 14 days old ' +
        '(newest snapshot SNAP (1 d ago); newest pushed commit 4 d ago; last drill passed 15 d ago; repo N MB)',
    );
    expect(check).toMatchObject({ name: 'Backups', ok: false, warnOnly: true });
  });

  it('gives each row its level, age and the warning it raised', async () => {
    const home = homeWith({ snapshotHoursAgo: 30, pushedHoursAgo: 4 * 24, drill: { ...goodDrill, at: hoursAgo(15 * 24) } });
    const status = await backupStatus(home, { serverUp: true, now });
    expect(status.setUp).toBe(true);
    expect(status.snapshot).toMatchObject({ level: 'warn', note: 'the newest snapshot is over 26 hours old' });
    expect(status.snapshot!.name).toMatch(/^inprogress-\d{8}-\d{6}\.db$/);
    expect(Math.round((now.getTime() - Date.parse(status.snapshot!.at)) / 3_600_000)).toBe(30);
    expect(status.pushed).toMatchObject({ level: 'warn', note: 'the newest pushed commit is over 3 days old' });
    expect(status.drill).toMatchObject({ ok: true, level: 'warn', note: 'the last drill is over 14 days old' });
    expect(status.repoLevel).toBe('ok');
    expect(status.repoBytes).toEqual(expect.any(Number));
    expect(status.fail).toBe(false);
    expect(status.busy).toBe(false);
    expect(status.warnings).toHaveLength(3);
    expect(status.backupsDir).toBe(join(home, 'backups'));
    expect(status.offsiteDir).toBe(join(home, 'offsite'));
  });

  it('marks a push over 7 days fail, and everything else ok when it is fresh', async () => {
    const old = await backupStatus(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 8 * 24, drill: goodDrill }), { serverUp: true, now });
    expect(old).toMatchObject({ fail: true, pushed: { level: 'fail' } });
    const fresh = await backupStatus(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 5, drill: goodDrill }), { serverUp: true, now });
    expect(fresh.snapshot!.level).toBe('ok');
    expect(fresh.pushed).toMatchObject({ level: 'ok', note: undefined });
    expect(fresh.drill).toMatchObject({ ok: true, level: 'ok' });
    expect(fresh.warnings).toEqual([]);
  });

  it('has no pushed, drill or size rows when the off-machine copy is not set up', async () => {
    const status = await backupStatus(homeWith({ snapshotHoursAgo: 2 }), { serverUp: true, now });
    expect(status).toMatchObject({ setUp: false, pushed: null, drill: null, repoBytes: null, busy: false });
  });

  it('takes the drill it is given: none, or the stored one', async () => {
    const home = homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 5, drill: goodDrill });
    expect((await backupStatus(home, { serverUp: true, now, drill: null })).drill).toBeNull();
    const given = await backupStatus(home, { serverUp: true, now, drill: { at: hoursAgo(1).toISOString(), ok: false, detail: 'x' } });
    expect(given.drill).toMatchObject({ ok: false, level: 'warn', note: 'the last drill failed' });
    expect((await backupStatus(home, { serverUp: true, now })).drill).toMatchObject({ ok: true });
  });

  it('reports busy while a fresh lock file exists', async () => {
    const home = homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 5, drill: goodDrill });
    writeFileSync(join(home, 'offsite', '.git', 'inprogress-backup.lock'), 'nonce');
    expect((await backupStatus(home, { serverUp: true, now })).busy).toBe(true);
  });
});

describe('lockHeld', () => {
  it('is true for a lock under 10 minutes old, false for none or an older one', () => {
    const dir = tempDir('ip-lock-');
    mkdirSync(join(dir, '.git'));
    expect(lockHeld(dir)).toBe(false);
    const lock = join(dir, '.git', 'inprogress-backup.lock');
    writeFileSync(lock, 'n');
    expect(lockHeld(dir)).toBe(true);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
    expect(lockHeld(dir)).toBe(false);
  });
});
