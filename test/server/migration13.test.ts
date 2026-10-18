import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, REBUILDS } from '../../src/server/db/schema';
import { migrate, openDb, schemaVersion } from '../../src/server/db/connection';

const T = '2026-10-01T00:00:00.000Z';

const dirs: string[] = [];
// Every database is closed by its test first: Windows can't delete an open file.
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A database at schema 12 holding a step with every node column set and a row of each kind that points at nodes. */
function at12(file = ':memory:'): Database.Database {
  const db = new Database(file);
  // Foreign keys stay off while seeding: the project row names its root node before the node exists.
  db.pragma('foreign_keys = OFF');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 12)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '12') ON CONFLICT(key) DO UPDATE SET value = '12'").run();
  db.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', '', 'active', 'claude', '', ?, ?)").run(T, T);
  db.prepare('INSERT INTO sessions (id, project_id, state, focus_node_id, started_at, last_seen_at) VALUES (?, 1, ?, ?, ?, ?)').run('s-1', 'working', 2, T, T);
  db.prepare(
    `INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at, completed_at, label, board_state, state_since, hue, driver_session_id)
     VALUES (2, 1, 1, 2.5, 'phase', 'Step', 'the body', 'active', 'me', 'so far', ?, '2026-10-02T00:00:00.000Z', NULL, 'data', 'working', '2026-10-03T00:00:00.000Z', 4, 's-1')`,
  ).run(T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at, completed_at) VALUES (3, 1, 2, 1, 'task', 'Child', '', 'done', 'claude', 'shipped', ?, ?, ?)").run(T, T, T);
  db.prepare("INSERT INTO resources (id, project_id, node_id, kind, title, content, created_at, updated_at) VALUES (1, 1, 2, 'doc', 'Doc', 'text', ?, ?)").run(T, T);
  db.prepare('INSERT INTO log_entries (id, node_id, text, session_id, created_at) VALUES (1, 2, ?, ?, ?)').run('a note', 's-1', T);
  db.prepare("INSERT INTO asks (id, project_id, node_id, kind, text, session_id, raised_at) VALUES (1, 1, 2, 'question', 'Which?', 's-1', ?)").run(T);
  db.prepare("INSERT INTO work_items (id, project_id, node_id, session_id, task_key, subject, position, created_at, updated_at) VALUES (1, 1, 3, 's-1', 'k1', 'Do it', 0, ?, ?)").run(T, T);
  db.pragma('foreign_keys = ON');
  return db;
}

const nodeRows = (db: Database.Database) => db.prepare('SELECT * FROM nodes ORDER BY id').all() as Record<string, unknown>[];

describe('migration 13', () => {
  it('migration 13 keeps every node column and every row that points at nodes', () => {
    const db = at12();
    const before = nodeRows(db);
    migrate(db);
    expect(schemaVersion(db)).toBe(13);
    const after = nodeRows(db);
    expect(after.map(({ parked_reason: _r, parked_where: _w, parked_at: _a, ...rest }) => rest)).toEqual(before);
    expect(after[1]).toMatchObject({ label: 'data', board_state: 'working', hue: 4, driver_session_id: 's-1', position: 2.5 });
    expect(db.prepare('SELECT node_id FROM resources WHERE id = 1').pluck().get()).toBe(2);
    expect(db.prepare('SELECT node_id FROM log_entries WHERE id = 1').pluck().get()).toBe(2);
    expect(db.prepare('SELECT node_id FROM asks WHERE id = 1').pluck().get()).toBe(2);
    expect(db.prepare('SELECT node_id FROM work_items WHERE id = 1').pluck().get()).toBe(3);
    expect(db.prepare("SELECT focus_node_id FROM sessions WHERE id = 's-1'").pluck().get()).toBe(2);
  });

  it('migration 13 allows parked and still refuses an unknown status', () => {
    const db = at12();
    migrate(db);
    db.prepare("UPDATE nodes SET status = 'parked' WHERE id = 2").run();
    expect(db.prepare('SELECT status FROM nodes WHERE id = 2').pluck().get()).toBe('parked');
    expect(() => db.prepare("UPDATE nodes SET status = 'bogus' WHERE id = 2").run()).toThrow(/CHECK constraint failed/);
  });

  it('migration 13 adds the parked columns with their defaults', () => {
    const db = at12();
    migrate(db);
    expect(db.prepare('SELECT parked_reason, parked_where, parked_at FROM nodes WHERE id = 2').get()).toEqual({ parked_reason: '', parked_where: '', parked_at: null });
    db.prepare("INSERT INTO nodes (project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (1, 1, 9, 'task', 'New', ?, ?)").run(T, T);
    expect(db.prepare("SELECT parked_reason, parked_where, parked_at FROM nodes WHERE title = 'New'").get()).toEqual({ parked_reason: '', parked_where: '', parked_at: null });
  });

  it('migration 13 keeps min_reader_version 1, the node indexes, and foreign keys on afterwards', () => {
    const db = at12();
    migrate(db);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes' ORDER BY name").pluck().all();
    expect(indexes).toEqual(expect.arrayContaining(['nodes_parent', 'nodes_project']));
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'nodes_new'").pluck().get()).toBe(0);
  });

  it('deleting a node after migration 13 still cascades to its resources', () => {
    const db = at12();
    migrate(db);
    db.prepare('DELETE FROM nodes WHERE id = 2').run();
    expect(db.prepare('SELECT count(*) FROM resources').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM log_entries').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM asks').pluck().get()).toBe(0);
    // The child goes with its parent through the rebuilt self-reference, and its work item with it.
    expect(db.prepare('SELECT count(*) FROM nodes WHERE id = 3').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM work_items').pluck().get()).toBe(0);
    expect(db.prepare("SELECT focus_node_id FROM sessions WHERE id = 's-1'").pluck().get()).toBeNull();
  });

  it('migration 13 keeps the node id sequence, so a deleted step\'s id is never reused', () => {
    const db = at12();
    db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (40, 1, 1, 9, 'task', 'Gone', ?, ?)").run(T, T);
    db.prepare('DELETE FROM nodes WHERE id = 40').run();
    migrate(db);
    const id = Number(db.prepare("INSERT INTO nodes (project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (1, 1, 10, 'task', 'New', ?, ?)").run(T, T).lastInsertRowid);
    expect(id).toBeGreaterThan(40);
    expect(db.prepare("SELECT name FROM sqlite_sequence WHERE name LIKE 'nodes%'").pluck().all()).toEqual(['nodes']);
  });

  it('a race that read a version before the rebuild and found the rebuild inside throws, and changes nothing', () => {
    // At 11 with foreign keys on: the read outside the transaction is not a rebuild, so they stay on.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const sql of MIGRATIONS.slice(0, 11)) db.exec(sql);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '11')").run();
    db.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
    db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', '', 'active', 'claude', '', ?, ?)").run(T, T);
    db.prepare("INSERT INTO resources (id, project_id, node_id, kind, title, content, created_at, updated_at) VALUES (1, 1, 1, 'doc', 'Doc', 'x', ?, ?)").run(T, T);
    db.pragma('foreign_keys = ON');
    // Another start applies migration 12 between the outer read and BEGIN IMMEDIATE.
    let raced = false;
    const racing = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction') {
          return (fn: () => boolean) => {
            const step = target.transaction(fn);
            return {
              immediate: () => {
                if (!raced) {
                  raced = true;
                  target.exec(MIGRATIONS[11]);
                  target.prepare("UPDATE meta SET value = '12' WHERE key = 'schema_version'").run();
                }
                return step.immediate();
              },
            };
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(() => migrate(racing)).toThrow(/needs foreign keys off/);
    expect(schemaVersion(db)).toBe(12);
    expect(db.prepare("SELECT count(*) FROM pragma_table_info('nodes') WHERE name = 'parked_reason'").pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM resources').pluck().get()).toBe(1);
    expect(db.prepare('SELECT count(*) FROM nodes').pluck().get()).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('beforeRebuild runs once, with 13, and not on a database already at 13', () => {
    const db = at12();
    const spy = vi.fn();
    migrate(db, { beforeRebuild: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(13);
    migrate(db, { beforeRebuild: spy });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a fresh database migrates from 0 through 13', () => {
    const db = openDb(':memory:');
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(13);
    expect(REBUILDS.has(12)).toBe(true);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('a rebuild that leaves a broken reference rolls back, keeps the old table, and turns foreign keys back on', () => {
    const db = at12();
    // A resource pointing at a node that does not exist: foreign_key_check reports it inside the rebuild.
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO resources (id, project_id, node_id, kind, title, content, created_at, updated_at) VALUES (2, 1, 99, 'doc', 'Orphan', 'x', ?, ?)").run(T, T);
    db.pragma('foreign_keys = ON');
    expect(() => migrate(db)).toThrow(/foreign_key_check/);
    expect(schemaVersion(db)).toBe(12);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare("SELECT count(*) FROM pragma_table_info('nodes') WHERE name = 'parked_reason'").pluck().get()).toBe(0);
    expect(nodeRows(db)).toHaveLength(3);
  });

  it('openDb copies a file database aside before the rebuild, and the copy is still at 12', () => {
    const dir = mkdtempSync(join(tmpdir(), "ip-m13 o'neil-"));
    dirs.push(dir);
    const file = join(dir, 'live.db');
    at12(file).close();
    const db = openDb(file);
    expect(schemaVersion(db)).toBe(13);
    db.close();
    const copies = readdirSync(join(dir, 'backups'));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^inprogress-pre-v13-\d{8}-\d{6}\.db$/);
    const copy = new Database(join(dir, 'backups', copies[0]));
    expect(schemaVersion(copy)).toBe(12);
    expect(copy.prepare('SELECT count(*) FROM nodes').pluck().get()).toBe(3);
    copy.close();
    // Opening again at 13 makes no second copy.
    openDb(file).close();
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
  });

  it('openDb makes no second pre-rebuild copy when one is already in backups, as when the migration keeps failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-m13-again-'));
    dirs.push(dir);
    const file = join(dir, 'live.db');
    at12(file).close();
    mkdirSync(join(dir, 'backups'));
    writeFileSync(join(dir, 'backups', 'inprogress-pre-v13-20261017-000000.db'), 'an earlier copy');
    openDb(file).close();
    expect(readdirSync(join(dir, 'backups'))).toEqual(['inprogress-pre-v13-20261017-000000.db']);
  });

  it('a fresh file database makes no copy: there is nothing to keep', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-m13-fresh-'));
    dirs.push(dir);
    const spy = vi.fn();
    const raw = new Database(join(dir, 'raw.db'));
    migrate(raw, { beforeRebuild: spy });
    expect(schemaVersion(raw)).toBe(MIGRATIONS.length);
    raw.close();
    expect(spy).not.toHaveBeenCalled();
    openDb(join(dir, 'live.db')).close();
    expect(readdirSync(dir).filter((f) => f === 'backups')).toEqual([]);
  });
});
