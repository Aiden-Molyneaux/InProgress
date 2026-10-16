import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

/** A database at schema 10 with the rows the backfill reads, then migrated to 11. */
function at10(seed: (db: Database.Database) => void) {
  const db = new Database(':memory:');
  // Foreign keys stay off while seeding: the project row names its root node before the node exists.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 10)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '10') ON CONFLICT(key) DO UPDATE SET value = '10'").run();
  seed(db);
  migrate(db);
  return db;
}

const T = '2026-10-01T00:00:00.000Z';
const node = (db: Database.Database, id: number, status: string) =>
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (?, 1, 1, ?, 'task', 'S', '', ?, 'claude', '', ?, ?)").run(id, id, status, T, T);
const session = (db: Database.Database, id: string, focus: number, state: string, lastSeen: string) =>
  db.prepare('INSERT INTO sessions (id, project_id, state, focus_node_id, started_at, last_seen_at) VALUES (?, 1, ?, ?, ?, ?)').run(id, state, focus, T, lastSeen);

describe('migration 11', () => {
  it('adds driver_session_id, keeps min_reader_version 1, and backfills active steps', () => {
    const db = at10((d) => {
      d.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
      d.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', '', 'active', 'claude', '', ?, ?)").run(T, T);
      node(d, 2, 'active');
      session(d, 's-ten', 2, 'idle', '2026-10-01T10:00:00.000Z');
      session(d, 's-eleven', 2, 'working', '2026-10-01T11:00:00.000Z');
      node(d, 3, 'todo');
      session(d, 's-todo', 3, 'working', '2026-10-01T12:00:00.000Z');
      node(d, 4, 'active');
      session(d, 's-ended', 4, 'ended', '2026-10-01T13:00:00.000Z');
    });
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const driver = db.prepare('SELECT driver_session_id FROM nodes WHERE id = ?').pluck();
    expect(driver.get(2)).toBe('s-eleven');
    expect(driver.get(3)).toBeNull();
    expect(driver.get(4)).toBeNull();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });

  it('gives the active root no driver even with a session focused on it, and breaks a last-seen tie by the higher id', () => {
    const db = at10((d) => {
      d.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
      d.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', '', 'active', 'claude', '', ?, ?)").run(T, T);
      session(d, 's-root', 1, 'working', '2026-10-01T10:00:00.000Z');
      node(d, 2, 'active');
      session(d, 's-a', 2, 'working', '2026-10-01T11:00:00.000Z');
      session(d, 's-b', 2, 'working', '2026-10-01T11:00:00.000Z');
    });
    const driver = db.prepare('SELECT driver_session_id FROM nodes WHERE id = ?').pluck();
    expect(driver.get(1)).toBeNull();
    expect(driver.get(2)).toBe('s-b');
  });
});
