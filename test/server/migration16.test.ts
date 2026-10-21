import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

const T = '2026-10-01T00:00:00.000Z';

/** A database at schema 15 with one project and one session, then migrated to 16. */
function at15() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 15)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '15') ON CONFLICT(key) DO UPDATE SET value = '15'").run();
  // Foreign keys stay off while seeding: the project row names its root node before the node exists.
  db.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', '', 'active', 'claude', '', ?, ?)").run(T, T);
  db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', 1, 'idle', ?, ?)").run(T, T);
  migrate(db);
  return db;
}

describe('migration 16', () => {
  it('adds title_channel (nudge on old rows) and title_asked (NULL), and keeps min_reader_version 1', () => {
    const db = at15();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(16);
    expect(db.prepare('SELECT title_channel FROM projects WHERE id = 1').pluck().get()).toBe('nudge');
    const columns = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('title_asked');
    expect(db.prepare("SELECT title_asked FROM sessions WHERE id = 's1'").pluck().get()).toBeNull();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });
});
