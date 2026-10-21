import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

const T = '2026-10-01T00:00:00.000Z';

/** A database at schema 16 with a root, a phase, and steps of every open and closed kind and status, then migrated. */
function at16() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 16)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '16') ON CONFLICT(key) DO UPDATE SET value = '16'").run();
  // Foreign keys stay off while seeding: the project row names its root node before the node exists.
  db.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
  const node = db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)");
  node.run(1, null, 1, 'goal', 'P', 'active', T, T);
  node.run(2, 1, 1, 'phase', 'Phase', 'active', T, T);
  node.run(3, 2, 1, 'task', 'Todo', 'todo', T, T);
  node.run(4, 2, 2, 'task', 'Active', 'active', T, T);
  node.run(5, 2, 3, 'task', 'Blocked', 'blocked', T, T);
  node.run(6, 2, 4, 'question', 'Question', 'todo', T, T);
  node.run(7, 2, 5, 'task', 'Done', 'done', T, T);
  node.run(8, 2, 6, 'task', 'Dropped', 'dropped', T, T);
  node.run(9, 2, 7, 'task', 'Parked', 'parked', T, T);
  migrate(db);
  return db;
}

describe('migration 17', () => {
  it('puts every open task or question below the root in Soon, unranked, and leaves updated_at alone', () => {
    const db = at16();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(17);
    const rows = db.prepare('SELECT id, rank_band, rank, updated_at FROM nodes ORDER BY id').all() as { id: number; rank_band: string | null; rank: number | null; updated_at: string }[];
    expect(rows.filter((r) => r.rank_band === 'soon').map((r) => r.id)).toEqual([3, 4, 5, 6]);
    expect(rows.every((r) => r.rank === null && r.updated_at === T)).toBe(true);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });

  it('refuses a band outside soon and someday', () => {
    const db = at16();
    expect(() => db.prepare("UPDATE nodes SET rank_band = 'next' WHERE id = 3").run()).toThrow(/CHECK/);
  });

  it("keeps a v16 build's writes working: its INSERT and UPDATE name no rank column (the rollback reader)", () => {
    const db = at16();
    db.prepare(
      'INSERT INTO nodes (project_id, parent_id, position, kind, title, body, status, assignee, outcome, label, created_at, updated_at, completed_at) VALUES (1, 2, 9, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('task', 'Old build', '', 'todo', 'claude', '', null, T, T, null);
    const id = db.prepare("SELECT id FROM nodes WHERE title = 'Old build'").pluck().get() as number;
    expect(db.prepare('SELECT rank_band, rank FROM nodes WHERE id = ?').get(id)).toEqual({ rank_band: null, rank: null });
    db.prepare(
      'UPDATE nodes SET title = ?, kind = ?, status = ?, assignee = ?, body = ?, outcome = ?, label = ?, updated_at = ?, completed_at = ?, driver_session_id = ?, parked_reason = ?, parked_where = ?, parked_at = ? WHERE id = ?',
    ).run('Renamed', 'task', 'todo', 'claude', '', '', null, T, null, null, '', '', null, 3);
    expect(db.prepare('SELECT title, rank_band FROM nodes WHERE id = 3').get()).toEqual({ title: 'Renamed', rank_band: 'soon' });
  });
});
