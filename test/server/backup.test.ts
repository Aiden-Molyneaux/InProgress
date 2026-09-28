import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
