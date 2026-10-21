import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { backupsCheck } from '../../src/cli/doctor';
import { timestamp } from '../../src/server/backup';
import { openDb } from '../../src/server/db/connection';

// Moved from test/cli/commands.test.ts: every case builds a git repo, and the check itself runs git.
const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Backups doctor check', () => {
  const now = new Date(2026, 9, 19, 12, 0, 0);
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
  const git = (cwd: string, args: string[], date?: Date) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date.toISOString(), GIT_AUTHOR_DATE: date.toISOString() } : {}) } }).trim();

  /** A home with a database, a snapshot from `snapshotHoursAgo`, and a backup repo whose origin/main is the commit `pushedHoursAgo` old. */
  function homeWith(o: { snapshotHoursAgo?: number; pushedHoursAgo?: number; drill?: { at: Date; ok: boolean; detail: string } }): string {
    const dir = tempDir('ip-doc-bak-');
    const db = openDb(join(dir, 'inprogress.db'));
    if (o.drill) db.prepare("INSERT INTO meta (key, value) VALUES ('backup_drill', ?)").run(JSON.stringify({ ...o.drill, at: o.drill.at.toISOString(), commit: null }));
    db.close();
    if (o.snapshotHoursAgo !== undefined) {
      mkdirSync(join(dir, 'backups'));
      const snapshot = join(dir, 'backups', `inprogress-${timestamp(hoursAgo(o.snapshotHoursAgo))}.db`);
      writeFileSync(snapshot, 'x');
      // Doctor reads the mtime too: a fixture written now must look as old as its name.
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

  it('is ok with a fresh snapshot, a recent push and a recent drill, and names each', () => {
    const check = backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 5, drill: goodDrill }), true, now);
    expect(check).toMatchObject({ name: 'Backups', ok: true });
    expect(check.detail).toMatch(/newest snapshot inprogress-\d{8}-\d{6}\.db \(2 h ago\); newest pushed commit 5 h ago; last drill passed 1 d ago; repo \d+\.\d MB/);
  });

  it('counts a snapshot a skipped tick touched as current', () => {
    const dir = homeWith({ snapshotHoursAgo: 30, pushedHoursAgo: 5, drill: goodDrill });
    const [file] = readdirSync(join(dir, 'backups'));
    expect(backupsCheck(dir, true, now).detail).toContain('the newest snapshot is over 26 hours old');
    utimesSync(join(dir, 'backups', file), hoursAgo(1), hoursAgo(1));
    const check = backupsCheck(dir, true, now);
    expect(check).toMatchObject({ ok: true });
    expect(check.detail).toContain('(1 h ago)');
  });

  it('warns at a 4-day-old push', () => {
    const check = backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 4 * 24, drill: goodDrill }), true, now);
    expect(check).toMatchObject({ ok: false, warnOnly: true });
    expect(check.detail).toContain('the newest pushed commit is over 3 days old');
  });

  it('fails at an 8-day-old push', () => {
    const check = backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 8 * 24, drill: goodDrill }), true, now);
    expect(check.ok).toBe(false);
    expect(check.warnOnly).toBeFalsy();
    expect(check.detail).toContain('over 7 days old');
  });

  it('warns that the off-machine copy is not set up', () => {
    const check = backupsCheck(homeWith({ snapshotHoursAgo: 2 }), true, now);
    expect(check).toMatchObject({ ok: false, warnOnly: true });
    expect(check.detail).toContain('not set up: run inprogress backup --init <remote url>');
  });

  it('warns about a failed drill, a drill over 14 days old, and a snapshot over 26 hours old only while the server is up', () => {
    const failed = backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 5, drill: { at: hoursAgo(24), ok: false, detail: 'resource a differs' } }), true, now);
    expect(failed).toMatchObject({ ok: false, warnOnly: true });
    expect(failed.detail).toContain('the last drill failed');
    const old = backupsCheck(homeWith({ snapshotHoursAgo: 2, pushedHoursAgo: 5, drill: { ...goodDrill, at: hoursAgo(15 * 24) } }), true, now);
    expect(old.detail).toContain('the last drill is over 14 days old');
    const stale = homeWith({ snapshotHoursAgo: 30, pushedHoursAgo: 5, drill: goodDrill });
    expect(backupsCheck(stale, true, now).detail).toContain('the newest snapshot is over 26 hours old');
    expect(backupsCheck(stale, false, now)).toMatchObject({ ok: true });
  });
});
