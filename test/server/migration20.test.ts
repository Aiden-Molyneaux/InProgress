import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

const T = '2026-10-01T00:00:00.000Z';

/** A database at schema 19 with one project, one step and one ask, then migrated. */
function at19() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 19)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '19') ON CONFLICT(key) DO UPDATE SET value = '19'").run();
  db.prepare("INSERT INTO projects (id, slug, name, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', 0, ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (2, 1, 1, 1, 'task', 'Step', ?, ?)").run(T, T);
  db.prepare("INSERT INTO asks (project_id, node_id, kind, text, raised_at) VALUES (1, 2, 'question', 'Which port?', ?)").run(T);
  migrate(db);
  return db;
}

describe('migration 20', () => {
  it('reads an existing ask as owner aiden, a project with no lead and no intent, and keeps min_reader_version 1', () => {
    const db = at19();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(20);
    expect(db.prepare('SELECT owner, due_at, answered_via FROM asks').get()).toEqual({ owner: 'aiden', due_at: null, answered_via: null });
    expect(db.prepare('SELECT lead, lead_seen_at, intent, intent_updated_at FROM projects').get()).toEqual({ lead: null, lead_seen_at: null, intent: '', intent_updated_at: null });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });

  it('adds the lead_events table and its index', () => {
    const db = at19();
    db.prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind) VALUES (1, ?, 'Progresser', 1, 'answer')").run(T);
    expect(db.prepare('SELECT text, aiden_words, node_id, ask_id, session_id FROM lead_events').get()).toEqual({ text: '', aiden_words: null, node_id: null, ask_id: null, session_id: null });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'lead_events_project_at'").pluck().get()).toBe('lead_events_project_at');
  });
});
