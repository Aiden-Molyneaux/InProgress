import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

const T = '2026-10-01T00:00:00.000Z';

/** A database at schema 18 with one session row, then migrated. */
function at18() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 18)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '18') ON CONFLICT(key) DO UPDATE SET value = '18'").run();
  db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', NULL, 'idle', ?, ?)").run(T, T);
  migrate(db);
  return db;
}

describe('migration 19', () => {
  it("reads an existing session as app 'cli' with no thread, and keeps min_reader_version 1", () => {
    const db = at18();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(19);
    expect(db.prepare("SELECT app, t3_thread_id FROM sessions WHERE id = 's1'").get()).toEqual({ app: 'cli', t3_thread_id: null });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });
});
