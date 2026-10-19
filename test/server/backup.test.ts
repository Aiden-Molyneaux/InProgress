import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { keepSnapshots, parseStamp, prunePreMigration, snapshotDb, timestamp, truncateIfLarge } from '../../src/server/backup';
import { openDb } from '../../src/server/db/connection';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
// Every database is closed by its test first: Windows can't delete an open file.
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('backups', () => {
  it('writes a restorable snapshot', async () => {
    const dir = tempDir('ip-bak-');
    const db = openDb(join(dir, 'live.db'));
    try {
      db.prepare("INSERT INTO meta (key, value) VALUES ('marker', 'yes')").run();
      const { file } = await snapshotDb(db, join(dir, 'backups'), new Date(2026, 8, 27, 0, 0, 1));
      expect(file).toBe(join(dir, 'backups', 'inprogress-20260927-000001.db'));
      // Only the snapshot: no .tmp, and no side files of the integrity check.
      expect(readdirSync(join(dir, 'backups'))).toEqual(['inprogress-20260927-000001.db']);
      const copy = openDb(file!);
      try {
        expect(copy.prepare("SELECT value FROM meta WHERE key = 'marker'").get()).toEqual({ value: 'yes' });
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });

  it('skips a snapshot when nothing changed, and writes a new one after a change', async () => {
    const dir = tempDir('ip-bak-');
    const backups = join(dir, 'backups');
    const db = openDb(join(dir, 'live.db'));
    try {
      expect((await snapshotDb(db, backups, new Date(2026, 8, 27, 1, 0, 0))).file).toBeDefined();
      expect(await snapshotDb(db, backups, new Date(2026, 8, 27, 2, 0, 0))).toEqual({ skipped: 'unchanged' });
      expect(readdirSync(backups)).toEqual(['inprogress-20260927-010000.db']);
      // The skipped tick touches the newest snapshot, so doctor can tell "unchanged" from "not running".
      expect(statSync(join(backups, 'inprogress-20260927-010000.db')).mtimeMs).toBe(new Date(2026, 8, 27, 2, 0, 0).getTime());
      db.prepare("INSERT INTO meta (key, value) VALUES ('marker', 'yes')").run();
      expect((await snapshotDb(db, backups, new Date(2026, 8, 27, 3, 0, 0))).file).toBe(join(backups, 'inprogress-20260927-030000.db'));
      expect(readdirSync(backups)).toEqual(['inprogress-20260927-010000.db', 'inprogress-20260927-030000.db']);
    } finally {
      db.close();
    }
  });

  it('skips the backup of a damaged database, so the good backups survive', async () => {
    const dir = tempDir('ip-bak-');
    const file = join(dir, 'live.db');
    const backups = join(dir, 'backups');
    let db = new Database(file);
    try {
      db.exec('CREATE TABLE t (x TEXT)');
      const insert = db.prepare('INSERT INTO t (x) VALUES (?)');
      db.transaction(() => {
        for (let i = 0; i < 200; i++) insert.run(`row ${i} ${'y'.repeat(100)}`);
      })();
      await snapshotDb(db, backups, new Date(2026, 8, 27, 0, 0, 1));
      const root = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 't'").get() as { rootpage: number }).rootpage;
      const pageSize = db.pragma('page_size', { simple: true }) as number;
      db.close();
      // Zero the b-tree page type byte of t's root page: the file still opens, but quick_check fails.
      const fd = openSync(file, 'r+');
      writeSync(fd, Buffer.from([0]), 0, 1, (root - 1) * pageSize);
      closeSync(fd);
      db = new Database(file);
      await expect(snapshotDb(db, backups, new Date(2026, 8, 27, 0, 0, 2))).rejects.toThrow(/^Skipped the database backup: quick_check reported .*btreeInitPage\(\) returns error code 11$/);
      expect(readdirSync(backups)).toEqual(['inprogress-20260927-000001.db']);
    } finally {
      db.close();
    }
  });

  it('leaves no file when the copy fails its integrity_check', async () => {
    const dir = tempDir('ip-bak-');
    const backups = join(dir, 'backups');
    const db = new Database(join(dir, 'live.db'));
    try {
      db.exec("CREATE TABLE t (x TEXT); CREATE INDEX t_x ON t (x); INSERT INTO t VALUES ('needle-value'), ('b'), ('c')");
      // A live database that is fine, whose copy comes out with its index disagreeing with its table.
      const damaging = new Proxy(db, {
        get(target, key) {
          if (key !== 'backup') {
            const value = Reflect.get(target, key) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (to: string) => {
            await target.backup(to);
            // The value sits once in the table and once in the index; changing one of the two makes them disagree.
            const bytes = readFileSync(to);
            bytes[bytes.indexOf('needle-value') + 11] = 0x78;
            writeFileSync(to, bytes);
          };
        },
      });
      await expect(snapshotDb(damaging, backups, new Date(2026, 8, 27, 0, 0, 1))).rejects.toThrow(/^Skipped the database backup: integrity_check on the copy reported /);
      expect(readdirSync(backups)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('keeps the exact tiered set over ten weeks, and reads only snapshot names', () => {
    // Monday 2026-10-19 16:00; a snapshot at 03:00 and 15:00 every day back 70 days.
    const now = new Date(2026, 9, 19, 16, 0, 0);
    const name = (m: number, d: number, h: number) => `inprogress-${timestamp(new Date(2026, m - 1, d, h, 0, 0))}.db`;
    const names: string[] = [];
    for (let day = 0; day < 70; day++) {
      for (const hour of [3, 15]) names.push(`inprogress-${timestamp(new Date(2026, 9, 19 - day, hour, 0, 0))}.db`);
    }
    const expected = [
      // the newest 8 within 48 hours: only four exist that recent, and 15:00 of each day is also a day's newest
      name(10, 19, 3),
      name(10, 18, 3),
      // the newest of each of the 14 days Oct 6 to Oct 19
      ...Array.from({ length: 14 }, (_, i) => name(10, 6 + i, 15)),
      // the newest of each earlier week (its Sunday afternoon); Oct 11 and later are already in
      name(10, 4, 15),
      name(9, 27, 15),
      name(9, 20, 15),
      name(9, 13, 15),
      name(9, 6, 15),
    ].sort();
    expect([...keepSnapshots(names, now)].sort()).toEqual(expected);
    expect(parseStamp('pre-stage1-rollout-20261013.db')).toBeUndefined();
    expect(parseStamp('inprogress-pre-restore-20261013-000000.db')).toBeUndefined();
    expect(parseStamp('inprogress-pre-v13-20261013-000000.db')).toBeUndefined();
    expect(parseStamp('inprogress-20261013-090807.db')).toEqual(new Date(2026, 9, 13, 9, 8, 7));
    // A future-dated name is kept.
    expect(keepSnapshots(['inprogress-20261101-000000.db'], now).has('inprogress-20261101-000000.db')).toBe(true);
  });

  it('thins old snapshots when it writes one, and leaves other file names alone', async () => {
    const dir = tempDir('ip-bak-');
    const backups = join(dir, 'backups');
    mkdirSync(backups);
    const strays = ['pre-stage1-rollout-20261013.db', 'inprogress-pre-restore-20260101-000000.db', 'inprogress-pre-v9-20260101-000000.db', 'notes.txt'];
    for (const f of strays) writeFileSync(join(backups, f), 'keep me');
    // Eight on one old day: only the newest of that day stays.
    for (let i = 0; i < 8; i++) writeFileSync(join(backups, `inprogress-20260901-0${i}0000.db`), 'old');
    const db = openDb(join(dir, 'live.db'));
    try {
      await snapshotDb(db, backups, new Date(2026, 8, 27, 12, 0, 0));
    } finally {
      db.close();
    }
    expect(readdirSync(backups).sort()).toEqual([...strays, 'inprogress-20260901-070000.db', 'inprogress-20260927-120000.db'].sort());
  });

  it('deletes copies in progress left by a crashed run once they are over a day old, and no others', async () => {
    const dir = tempDir('ip-bak-');
    const backups = join(dir, 'backups');
    mkdirSync(backups);
    const now = new Date(2026, 8, 27, 12, 0, 0);
    const oldTmp = join(backups, 'inprogress-20260901-000000.db.111.tmp');
    const freshTmp = join(backups, 'inprogress-20260927-110000.db.222.tmp');
    const other = join(backups, 'notes.tmp');
    for (const f of [oldTmp, freshTmp, other]) writeFileSync(f, 'x');
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(oldTmp, twoDaysAgo, twoDaysAgo);
    utimesSync(other, twoDaysAgo, twoDaysAgo);
    utimesSync(freshTmp, new Date(now.getTime() - 3600_000), new Date(now.getTime() - 3600_000));
    const db = openDb(join(dir, 'live.db'));
    try {
      await snapshotDb(db, backups, now);
    } finally {
      db.close();
    }
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('prunes pre-migration copies to the newest 3 plus any under 30 days old', () => {
    const dir = tempDir('ip-bak-');
    const now = new Date(2026, 9, 19, 12, 0, 0);
    const old = ['inprogress-pre-v12-20260101-000000.db', 'inprogress-pre-v12-20260102-000000.db', 'inprogress-pre-v13-20260103-000000.db', 'inprogress-pre-v13-20260104-000000.db'];
    const recent = 'inprogress-pre-v14-20261010-000000.db';
    const strays = ['pre-stage1-rollout-20261013.db', 'inprogress-pre-restore-20260101-000000.db', 'inprogress-20260101-000000.db'];
    for (const f of [...old, recent, ...strays]) writeFileSync(join(dir, f), 'x');
    prunePreMigration(dir, now);
    expect(readdirSync(dir).sort()).toEqual([...old.slice(2), recent, ...strays].sort());
  });

  it('formats timestamps and truncates large logs', () => {
    expect(timestamp(new Date(2026, 8, 27, 7, 5, 9))).toBe('20260927-070509');
    const file = join(tempDir('ip-log-'), 'server.log');
    writeFileSync(file, 'x'.repeat(100));
    truncateIfLarge(file, 50);
    expect(statSync(file).size).toBe(0);
    truncateIfLarge(join(tmpdir(), 'missing-ip.log'), 50);
    expect(existsSync(join(tmpdir(), 'missing-ip.log'))).toBe(false);
  });
});
