import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

const T = '2026-10-01T00:00:00.000Z';

/** A database at schema 13 with one session, then migrated to 14. */
function at13() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 13)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '13') ON CONFLICT(key) DO UPDATE SET value = '13'").run();
  db.prepare("INSERT INTO sessions (id, state, started_at, last_seen_at) VALUES ('s1', 'idle', ?, ?)").run(T, T);
  migrate(db);
  return db;
}

describe('migration 14', () => {
  it('adds last_prompt_at, leaves existing rows NULL and keeps min_reader_version 1', () => {
    const db = at13();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(14);
    const columns = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('last_prompt_at');
    expect(db.prepare("SELECT last_prompt_at FROM sessions WHERE id = 's1'").pluck().get()).toBeNull();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });
});
