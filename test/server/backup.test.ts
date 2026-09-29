import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { backupDb, timestamp, truncateIfLarge } from '../../src/server/backup';
import { openDb } from '../../src/server/db/connection';

describe('backups', () => {
  it('writes a restorable copy and keeps only the newest N', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-bak-'));
    const db = openDb(join(dir, 'live.db'));
    db.prepare("INSERT INTO meta (key, value) VALUES ('marker', 'yes')").run();
    for (let i = 1; i <= 4; i++) await backupDb(db, join(dir, 'backups'), 3, `20260927-00000${i}`);
    const files = readdirSync(join(dir, 'backups')).sort();
    expect(files).toEqual(['inprogress-20260927-000002.db', 'inprogress-20260927-000003.db', 'inprogress-20260927-000004.db']);
    const copy = openDb(join(dir, 'backups', files[2]));
    expect(copy.prepare("SELECT value FROM meta WHERE key = 'marker'").get()).toEqual({ value: 'yes' });
  });

  it('skips the backup of a damaged database, so the good backups survive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-bak-'));
    const file = join(dir, 'live.db');
    const backups = join(dir, 'backups');
    let db = new Database(file);
    try {
      db.exec('CREATE TABLE t (x TEXT)');
      const insert = db.prepare('INSERT INTO t (x) VALUES (?)');
      db.transaction(() => {
        for (let i = 0; i < 200; i++) insert.run(`row ${i} ${'y'.repeat(100)}`);
      })();
      await backupDb(db, backups, 7, '20260927-000001');
      const root = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 't'").get() as { rootpage: number }).rootpage;
      const pageSize = db.pragma('page_size', { simple: true }) as number;
      db.close();
      // Zero the b-tree page type byte of t's root page: the file still opens, but quick_check fails.
      const fd = openSync(file, 'r+');
      writeSync(fd, Buffer.from([0]), 0, 1, (root - 1) * pageSize);
      closeSync(fd);
      db = new Database(file);
      await expect(backupDb(db, backups, 1, '20260927-000002')).rejects.toThrow(/^Skipped the database backup: quick_check reported .*btreeInitPage\(\) returns error code 11$/);
      expect(readdirSync(backups)).toEqual(['inprogress-20260927-000001.db']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats timestamps and truncates large logs', () => {
    expect(timestamp(new Date(2026, 8, 27, 7, 5, 9))).toBe('20260927-070509');
    const file = join(mkdtempSync(join(tmpdir(), 'ip-log-')), 'server.log');
    writeFileSync(file, 'x'.repeat(100));
    truncateIfLarge(file, 50);
    expect(statSync(file).size).toBe(0);
    truncateIfLarge(join(tmpdir(), 'missing-ip.log'), 50);
    expect(existsSync(join(tmpdir(), 'missing-ip.log'))).toBe(false);
  });
});
