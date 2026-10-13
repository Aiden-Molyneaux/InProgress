import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

/** A database at schema 9 with the rows the conversion reads, then migrated to 10. */
function at9(seed: (db: Database.Database) => void) {
  const db = new Database(':memory:');
  // Foreign keys stay off while seeding: the project row names its root node before the node exists.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 9)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '9') ON CONFLICT(key) DO UPDATE SET value = '9'").run();
  seed(db);
  migrate(db);
  return db;
}

const T = '2026-10-01T00:00:00.000Z';
function seedProject(db: Database.Database) {
  db.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', '', 'active', 'claude', '', ?, ?)").run(T, T);
}
const node = (db: Database.Database, id: number, kind: string, title: string, body: string, status: string, assignee: string, updated = T) =>
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, '', ?, ?)").run(id, id, kind, title, body, status, assignee, T, updated);

describe('migration 10', () => {
  it('adds asks, role, briefing_mode and purpose, and keeps min_reader_version 1', () => {
    const db = at9(seedProject);
    expect(schemaVersion(db)).toBe(10);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
    expect(db.prepare('SELECT briefing_mode FROM projects WHERE id = 1').pluck().get()).toBe('full');
    expect(db.prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = 'role'").pluck().get()).toBe('role');
    expect(db.prepare("SELECT name FROM pragma_table_info('resources') WHERE name = 'purpose'").pluck().get()).toBe('purpose');
  });

  it('converts open question nodes of Aiden to question asks, raised at updated_at', () => {
    const db = at9((d) => { seedProject(d); node(d, 2, 'question', 'Pick a price', '', 'todo', 'me', '2026-10-05T00:00:00.000Z'); });
    expect(db.prepare('SELECT node_id, kind, text, session_id, raised_at, cleared_at, answer FROM asks').all()).toEqual([
      { node_id: 2, kind: 'question', text: 'Pick a price', session_id: null, raised_at: '2026-10-05T00:00:00.000Z', cleared_at: null, answer: '' },
    ]);
  });

  it('converts a Needs you: line to a permission ask with that line as text, CRLF bodies included', () => {
    const db = at9((d) => {
      seedProject(d);
      node(d, 3, 'task', 'Prototype', 'Intro line\r\nNeeds you: try the mod and say yes\r\nmore', 'active', 'me');
      node(d, 4, 'task', 'First line', 'Needs you: at the start', 'todo', 'me');
    });
    expect(db.prepare('SELECT node_id, kind, text FROM asks ORDER BY node_id').all()).toEqual([
      { node_id: 3, kind: 'permission', text: 'Needs you: try the mod and say yes' },
      { node_id: 4, kind: 'permission', text: 'Needs you: at the start' },
    ]);
  });

  it('leaves Aiden-owned steps without such a line, done steps and Claude steps alone', () => {
    const db = at9((d) => {
      seedProject(d);
      node(d, 5, 'task', 'Merge PR #514', 'just do it', 'todo', 'me');
      node(d, 6, 'question', 'Old answered', '', 'done', 'me');
      node(d, 7, 'question', 'Claude asks itself', '', 'todo', 'claude');
      node(d, 8, 'task', 'Mid-line', 'see Needs you: inline', 'blocked', 'me');
    });
    expect(db.prepare('SELECT COUNT(*) FROM asks').pluck().get()).toBe(0);
    expect(db.prepare('SELECT assignee FROM nodes WHERE id = 5').pluck().get()).toBe('me');
  });

  it('refuses a second open ask with the same node, kind and text, and allows it once cleared', () => {
    const db = at9((d) => { seedProject(d); node(d, 2, 'task', 'S', '', 'todo', 'claude'); });
    const ins = db.prepare("INSERT INTO asks (project_id, node_id, kind, text, raised_at) VALUES (1, 2, 'question', 'Q', ?) ON CONFLICT DO NOTHING");
    ins.run(T); ins.run(T);
    expect(db.prepare('SELECT COUNT(*) FROM asks').pluck().get()).toBe(1);
    db.prepare('UPDATE asks SET cleared_at = ?').run(T);
    ins.run(T);
    expect(db.prepare('SELECT COUNT(*) FROM asks').pluck().get()).toBe(2);
  });
});
