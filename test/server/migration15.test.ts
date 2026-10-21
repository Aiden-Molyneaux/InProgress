import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

const T = '2026-10-01T00:00:00.000Z';

/** A database at schema 14 with one resource, then migrated to 15. */
function at14() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 14)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '14') ON CONFLICT(key) DO UPDATE SET value = '14'").run();
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO resources (id, project_id, node_id, kind, title, content, created_at, updated_at) VALUES (1, 1, 1, 'doc', 'R', 'x', ?, ?)").run(T, T);
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

describe('migration 15', () => {
  it('adds confirmed_sha and confirmed_at, leaves existing rows NULL and keeps min_reader_version 1', () => {
    const db = at14();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(15);
    const columns = (db.prepare('PRAGMA table_info(resources)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['confirmed_sha', 'confirmed_at']));
    expect(db.prepare('SELECT confirmed_sha, confirmed_at FROM resources WHERE id = 1').get()).toEqual({ confirmed_sha: null, confirmed_at: null });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });
});
