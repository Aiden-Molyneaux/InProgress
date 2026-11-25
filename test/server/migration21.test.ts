import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { schemaVersion } from '../../src/server/db/connection';

const T = '2026-11-01T00:00:00.000Z';

const NEW_TABLES = ['desk_items', 'lead_turns', 'lead_decisions', 'lead_sends', 'usage_readings'];
const NEW_INDEXES = [
  'desk_items_open_once',
  'desk_items_project_state',
  'desk_items_kind_ref',
  'lead_events_switch',
  'lead_turns_applied_once',
  'lead_turns_live_once',
  'lead_turns_project_leased',
  'lead_turns_item',
  'lead_decisions_project',
  'lead_decisions_item',
  'lead_decisions_turn',
  'lead_sends_retry_once',
  'lead_sends_project_state',
  'lead_sends_item',
  'usage_readings_at',
  'usage_readings_turn',
  'usage_readings_import_once',
];

/**
 * A database at schema 20 with one project, one step, one ask and one lead_events row, then migration 21 alone applied,
 * as the runner applies it: so a later migration that raises min_reader_version leaves this test standing.
 */
function at20() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 20)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '20') ON CONFLICT(key) DO UPDATE SET value = '20'").run();
  db.prepare("INSERT INTO projects (id, slug, name, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', 0, ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (2, 1, 1, 1, 'task', 'Step', ?, ?)").run(T, T);
  db.prepare("INSERT INTO asks (project_id, node_id, kind, text, raised_at) VALUES (1, 2, 'question', 'Which port?', ?)").run(T);
  db.prepare("INSERT INTO lead_events (id, project_id, at, lead, instructions, kind, text) VALUES (1, 1, ?, 'Progresser', 6, 'answer', 'Port 4317')").run(T);
  const before = {
    projects: db.prepare('SELECT * FROM projects').all(),
    nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all(),
    asks: db.prepare('SELECT * FROM asks').all(),
    leadEvents: db.prepare('SELECT * FROM lead_events').all(),
  };
  db.transaction(() => {
    db.exec(MIGRATIONS[20]);
    db.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run();
  })();
  return { db, before };
}

/** One row in every new table, all on project 1, with the decision on lead_events row 1. */
function fill(db: Database.Database) {
  db.prepare("INSERT INTO desk_items (id, project_id, kind, ref, created_at) VALUES (1, 1, 'question', 'a1', ?)").run(T);
  db.prepare("INSERT INTO lead_turns (id, item_id, project_id, way, leased_at, lease_until) VALUES (1, 1, 1, 'headless', ?, ?)").run(T, T);
  db.prepare("INSERT INTO lead_decisions (event_id, project_id, item_id, turn_id, kind, line, said_at) VALUES (1, 1, 1, 1, 'technical', 'Port 4317', ?)").run(T);
  db.prepare("INSERT INTO lead_sends (project_id, item_id, kind, target, created_at) VALUES (1, 1, 'relay', 'thread-1', ?)").run(T);
  db.prepare("INSERT INTO usage_readings (at, source, turn_id) VALUES (?, 'turn', 1)").run(T);
}

describe('migration 21', () => {
  it('migrates to v21 and keeps min_reader_version 1', () => {
    const { db } = at20();
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(21);
    expect(schemaVersion(db)).toBe(21);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });

  it('adds the five tables and every index', () => {
    const { db } = at20();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    expect(tables).toEqual(expect.arrayContaining(NEW_TABLES));
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").pluck().all();
    expect(indexes).toEqual(expect.arrayContaining(NEW_INDEXES));
  });

  it('leaves the existing rows unchanged', () => {
    const { db, before } = at20();
    expect(db.prepare('SELECT * FROM projects').all()).toEqual(before.projects);
    expect(db.prepare('SELECT * FROM nodes ORDER BY id').all()).toEqual(before.nodes);
    expect(db.prepare('SELECT * FROM asks').all()).toEqual(before.asks);
    expect(db.prepare('SELECT * FROM lead_events').all()).toEqual(before.leadEvents);
  });

  it('fills the defaults: an item opens, a turn is leased, a send is intended with an empty body, a decision is no product ruling', () => {
    const { db } = at20();
    fill(db);
    expect(db.prepare('SELECT state FROM desk_items').pluck().get()).toBe('open');
    expect(db.prepare('SELECT state FROM lead_turns').pluck().get()).toBe('leased');
    expect(db.prepare('SELECT state, body FROM lead_sends').get()).toEqual({ state: 'intended', body: '' });
    expect(db.prepare('SELECT product_ruling FROM lead_decisions').pluck().get()).toBe(0);
  });

  it('refuses a decision with no said_at', () => {
    const { db } = at20();
    expect(() => db.prepare("INSERT INTO lead_decisions (event_id, project_id, kind, line) VALUES (1, 1, 'technical', 'x')").run()).toThrow(/NOT NULL/);
  });

  it('cascades a purged project to every new table that has a project_id, and leaves the account-wide readings', () => {
    const { db } = at20();
    db.pragma('foreign_keys = ON');
    fill(db);
    db.exec('DELETE FROM asks; DELETE FROM nodes WHERE parent_id IS NOT NULL;');
    db.prepare('DELETE FROM projects WHERE id = 1').run();
    for (const table of ['desk_items', 'lead_turns', 'lead_decisions', 'lead_sends']) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(0);
    }
    // The reading stays, its turn set to none.
    expect(db.prepare('SELECT turn_id FROM usage_readings').all()).toEqual([{ turn_id: null }]);
  });

  it('deletes a decision with its lead_events row', () => {
    const { db } = at20();
    db.pragma('foreign_keys = ON');
    fill(db);
    db.prepare('DELETE FROM lead_events WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) FROM lead_decisions').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM desk_items').pluck().get()).toBe(1);
  });
});
