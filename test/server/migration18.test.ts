import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

const T = '2026-10-01T00:00:00.000Z';

/**
 * A database at schema 17 with a root, a phase and six steps, and node.created events from the window (one naming several
 * ids), the scribe and the system, plus one whose data is not JSON; then migrated.
 */
function at17() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 17)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '17') ON CONFLICT(key) DO UPDATE SET value = '17'").run();
  // Foreign keys stay off while seeding: the project row names its root node before the node exists.
  db.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
  const node = db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, 'todo', ?, ?)");
  node.run(1, null, 1, 'goal', 'P', T, T);
  node.run(2, 1, 1, 'phase', 'Phase', T, T);
  for (const id of [3, 4, 5, 6, 7, 8]) node.run(id, 2, id, 'task', `S${id}`, T, T);
  const event = db.prepare("INSERT INTO events (ts, project_id, actor, type, entity, entity_id, data) VALUES (?, 1, ?, ?, 'node', ?, ?)");
  event.run(T, 'window', 'node.created', '3', JSON.stringify({ ids: [3], parentId: 2 }));
  event.run(T, 'window', 'node.created', '4', JSON.stringify({ ids: [4, 5], parentId: 2 }));
  event.run(T, 'scribe:s1', 'node.created', '6', JSON.stringify({ ids: [6], parentId: 2 }));
  event.run(T, 'system', 'node.created', '7', JSON.stringify({ ids: [7], parentId: 2 }));
  // A window event of another type naming a step, and one whose data is not JSON: neither makes a step Aiden's own.
  event.run(T, 'window', 'node.updated', '8', JSON.stringify({ ids: [8] }));
  event.run(T, 'window', 'node.created', '8', 'not json');
  migrate(db);
  return db;
}

describe('migration 18', () => {
  it('makes the steps a window node.created event names me, the rest asked, and leaves updated_at alone', () => {
    const db = at17();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(18);
    const rows = db.prepare('SELECT id, origin, what, why, updated_at FROM nodes ORDER BY id').all() as { id: number; origin: string; what: string; why: string; updated_at: string }[];
    expect(rows.filter((r) => r.origin === 'me').map((r) => r.id)).toEqual([3, 4, 5]);
    expect(rows.filter((r) => r.origin === 'asked').map((r) => r.id)).toEqual([1, 2, 6, 7, 8]);
    expect(rows.every((r) => r.what === '' && r.why === '' && r.updated_at === T)).toBe(true);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });

  it('refuses an origin outside me, asked and proposed', () => {
    const db = at17();
    expect(() => db.prepare("UPDATE nodes SET origin = 'other' WHERE id = 3").run()).toThrow(/CHECK/);
  });

  it("keeps a v17 build's writes working: its INSERT and UPDATE name no new column (the rollback reader)", () => {
    const db = at17();
    db.prepare(
      'INSERT INTO nodes (project_id, parent_id, position, kind, title, body, status, assignee, outcome, label, created_at, updated_at, completed_at) VALUES (1, 2, 9, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('task', 'Old build', '', 'todo', 'claude', '', null, T, T, null);
    const id = db.prepare("SELECT id FROM nodes WHERE title = 'Old build'").pluck().get() as number;
    expect(db.prepare('SELECT what, why, origin FROM nodes WHERE id = ?').get(id)).toEqual({ what: '', why: '', origin: 'asked' });
    db.prepare(
      'UPDATE nodes SET title = ?, kind = ?, status = ?, assignee = ?, body = ?, outcome = ?, label = ?, updated_at = ?, completed_at = ?, driver_session_id = ?, parked_reason = ?, parked_where = ?, parked_at = ?, rank_band = ?, rank = ? WHERE id = ?',
    ).run('Renamed', 'task', 'todo', 'claude', '', '', null, T, null, null, '', '', null, 'soon', null, 3);
    expect(db.prepare('SELECT title, origin FROM nodes WHERE id = 3').get()).toEqual({ title: 'Renamed', origin: 'me' });
  });
});
