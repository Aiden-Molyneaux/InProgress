import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDb, schemaVersion } from '../../src/server/db/connection';
import { MIGRATIONS } from '../../src/server/db/schema';
import { write } from '../../src/server/db/tx';
import { NODE_LABELS, type EventRow } from '../../src/core/types';
import { maxEventId } from '../../src/server/repo/events';
import { makeCtx } from '../helpers';

describe('database', () => {
  it('migrates to the latest schema with foreign keys on', () => {
    const ctx = makeCtx();
    expect(schemaVersion(ctx.db)).toBe(MIGRATIONS.length);
    const tables = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining([
      'projects', 'bindings', 'nodes', 'resources', 'log_entries', 'sessions', 'session_subagents', 'events', 'meta', 'work_items', 'subagent_dispatches',
    ]));
    expect(ctx.db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('migrates a database at v1 with data to the latest schema and keeps every row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-migrate-v1-'));
    const file = join(dir, 'inprogress.db');
    // The database Aiden has today: migration 1 only, with a project, a plan, a session and a running subagent.
    const v1 = new Database(file);
    v1.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    v1.exec(MIGRATIONS[0]);
    v1.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    v1.prepare("INSERT INTO projects (id, slug, name, root_node_id, created_at, updated_at) VALUES (1, 'ingame', 'InGame', 1, 't', 't')").run();
    v1.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'InGame', 'active', 't', 't')").run();
    v1.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, created_at, updated_at) VALUES (2, 1, 1, 1, 'task', 'Play app signing', 'active', 't', 't')").run();
    v1.prepare("INSERT INTO sessions (id, project_id, state, focus_node_id, started_at, last_seen_at) VALUES ('s1', 1, 'working', 2, 't', 't')").run();
    v1.prepare("INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at) VALUES ('s1', 'a1', 'Explore', 't')").run();
    v1.prepare("INSERT INTO events (ts, project_id, actor, type, entity, entity_id, data) VALUES ('t', 1, 'system', 'project.created', 'project', '1', '{}')").run();
    v1.close();
    const db = openDb(file);
    try {
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT id, slug, queue FROM projects').all()).toEqual([{ id: 1, slug: 'ingame', queue: '[]' }]);
      expect(db.prepare('SELECT id, title FROM nodes ORDER BY id').all()).toEqual([{ id: 1, title: 'InGame' }, { id: 2, title: 'Play app signing' }]);
      expect(db.prepare('SELECT id, focus_node_id FROM sessions').all()).toEqual([{ id: 's1', focus_node_id: 2 }]);
      expect(db.prepare('SELECT * FROM session_subagents').all()).toEqual([
        { session_id: 's1', agent_id: 'a1', agent_type: 'Explore', started_at: 't', description: null, model: null, node_id: null, tool_use_id: null, ended_at: null, ordinal: null, purpose: null },
      ]);
      expect((db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(1);
      // The new tables take rows, and their foreign keys follow the node: work items go with it, a subagent forgets it.
      db.prepare("INSERT INTO work_items (project_id, node_id, session_id, agent_id, task_key, subject, status, blocks, position, created_at, updated_at) VALUES (1, 2, 's1', '', '1', 'Write it', 'pending', '[]', 1, 't', 't')").run();
      db.prepare("INSERT INTO subagent_dispatches (session_id, tool_use_id, agent_type, description, model, node_id, created_at) VALUES ('s1', 'toolu_1', 'Explore', 'Look around', 'sonnet', 2, 't')").run();
      db.prepare("UPDATE session_subagents SET node_id = 2 WHERE agent_id = 'a1'").run();
      db.prepare('DELETE FROM nodes WHERE id = 2').run();
      expect((db.prepare('SELECT COUNT(*) AS c FROM work_items').get() as { c: number }).c).toBe(0);
      expect(db.prepare('SELECT node_id FROM session_subagents').all()).toEqual([{ node_id: null }]);
      expect(db.prepare('SELECT node_id FROM subagent_dispatches').all()).toEqual([{ node_id: null }]);
      expect(() => db.prepare("INSERT INTO work_items (project_id, node_id, session_id, agent_id, task_key, subject, status, blocks, position, created_at, updated_at) VALUES (1, 1, 's1', '', '1', 'x', 'deleted', '[]', 1, 't', 't')").run()).toThrow(/CHECK/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reuses the id of a deleted node', () => {
    const { db } = makeCtx();
    const projectId = db.prepare("INSERT INTO projects (slug, name, created_at, updated_at) VALUES ('p', 'P', 'x', 'x')").run().lastInsertRowid;
    const insertNode = db.prepare("INSERT INTO nodes (project_id, position, kind, title, created_at, updated_at) VALUES (?, 1, 'task', 't', 'x', 'x')");
    insertNode.run(projectId);
    const deleted = Number(insertNode.run(projectId).lastInsertRowid);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(deleted);
    expect(Number(insertNode.run(projectId).lastInsertRowid)).toBeGreaterThan(deleted);
  });

  it('never reuses the id of a deleted event, so an SSE cursor only moves forward', () => {
    const ctx = makeCtx();
    const recordOne = () => write(ctx, 'test', (record) => record({ projectId: null, type: 'demo', entity: 'demo', entityId: 1 }));
    recordOne();
    recordOne();
    const newest = maxEventId(ctx);
    ctx.db.prepare('DELETE FROM events WHERE id = ?').run(newest);
    recordOne();
    expect(maxEventId(ctx)).toBeGreaterThan(newest);
  });

  it('finds the work done when another first start migrates the same file first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-migrate-'));
    const file = join(dir, 'inprogress.db');
    const late = new Database(file);
    try {
      // The other process migrates after this connection has looked at the fresh file, before it writes.
      const transaction = late.transaction.bind(late);
      let raced = false;
      late.transaction = ((fn: () => unknown) => {
        if (!raced) {
          raced = true;
          openDb(file).close();
        }
        return transaction(fn);
      }) as typeof late.transaction;
      expect(() => migrate(late)).not.toThrow();
      expect(raced).toBe(true);
      expect(schemaVersion(late)).toBe(MIGRATIONS.length);
    } finally {
      late.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to migrate a database created by a newer build', () => {
    const { db } = makeCtx();
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    // A newer build that did not declare this one able to read its schema.
    db.prepare("DELETE FROM meta WHERE key = 'min_reader_version'").run();
    expect(() => migrate(db)).toThrow(`InProgress database schema v99 is newer than this build (v${MIGRATIONS.length}); update InProgress`);
  });

  it('opens a newer database whose migrations say this build can still read it, so a rollback keeps working', () => {
    const { db } = makeCtx();
    const setMeta = (key: string, value: string) =>
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    setMeta('schema_version', '99');
    setMeta('min_reader_version', String(MIGRATIONS.length));
    expect(() => migrate(db)).not.toThrow();
    expect(schemaVersion(db)).toBe(99);
    setMeta('min_reader_version', String(MIGRATIONS.length + 1));
    expect(() => migrate(db)).toThrow(/is newer than this build/);
  });

  it('marks migration 2 readable by v1 builds, since it only adds tables and columns', () => {
    const { db } = makeCtx();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
  });

  /** A database file as the v2 build leaves it: migrations 1 and 2, with a project and a small plan. */
  function v2Database(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ip-migrate-v2-'));
    const file = join(dir, 'inprogress.db');
    const v2 = new Database(file);
    v2.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    v2.exec(MIGRATIONS[0]);
    v2.exec(MIGRATIONS[1]);
    v2.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run();
    v2.prepare("INSERT INTO projects (id, slug, name, root_node_id, created_at, updated_at, queue) VALUES (1, 'inprogress', 'InProgress', 1, 't', 't', '[2]')").run();
    v2.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'InProgress', 'active', 't', 't')").run();
    v2.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, created_at, updated_at) VALUES (2, 1, 1, 1, 'phase', 'Live work', 'active', 't', 't')").run();
    v2.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, created_at, updated_at) VALUES (3, 1, 2, 1, 'task', 'Working-task rows', 'done', 't', 't')").run();
    v2.close();
    return { dir, file };
  }

  it('migrates a database at v2 with data to v3, every step unlabelled', () => {
    const { dir, file } = v2Database();
    const db = openDb(file);
    try {
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT id, title, status, label FROM nodes ORDER BY id').all()).toEqual([
        { id: 1, title: 'InProgress', status: 'active', label: null },
        { id: 2, title: 'Live work', status: 'active', label: null },
        { id: 3, title: 'Working-task rows', status: 'done', label: null },
      ]);
      expect(db.prepare('SELECT queue FROM projects').pluck().get()).toBe('[2]');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes only a label from the set, or none', () => {
    const { db } = makeCtx();
    db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 't', 't')").run();
    const insert = db.prepare("INSERT INTO nodes (project_id, position, kind, title, label, created_at, updated_at) VALUES (1, 1, 'task', 't', ?, 't', 't')");
    for (const label of [...NODE_LABELS, null]) expect(() => insert.run(label), String(label)).not.toThrow();
    for (const label of ['frontend', 'UI', '']) expect(() => insert.run(label), label).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE nodes SET label = 'colour'").run()).toThrow(/CHECK/);
  });

  it('marks migration 3 readable by v1 builds, so a v2 build still opens a v3 database', () => {
    const { db } = makeCtx();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
    // This build as the v2 build sees the schema: two migrations.
    const shipped = MIGRATIONS.splice(2);
    try {
      expect(() => migrate(db)).not.toThrow();
      expect(schemaVersion(db)).toBe(2 + shipped.length);
      // The v2 build's own writes, which never name the label: a new step is unlabelled, an edit keeps the label.
      db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 't', 't')").run();
      const v2Insert = db.prepare('INSERT INTO nodes (project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      const id = Number(v2Insert.run(1, null, 1, 'task', 'From v2', '', 'todo', 'claude', '', 't', 't', null).lastInsertRowid);
      expect(db.prepare('SELECT label FROM nodes WHERE id = ?').pluck().get(id)).toBeNull();
      db.prepare("UPDATE nodes SET label = 'ui' WHERE id = ?").run(id);
      db.prepare('UPDATE nodes SET title = ?, kind = ?, status = ?, assignee = ?, body = ?, outcome = ?, updated_at = ?, completed_at = ? WHERE id = ?')
        .run('From v2, edited', 'task', 'active', 'claude', '', '', 't', null, id);
      expect(db.prepare('SELECT label FROM nodes WHERE id = ?').pluck().get(id)).toBe('ui');
    } finally {
      MIGRATIONS.push(...shipped);
    }
  });

  /** A database file as the v3 build leaves it: migrations 1 to 3, with a project, a live session and its subagent. */
  function v3Database(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ip-migrate-v3-'));
    const file = join(dir, 'inprogress.db');
    const v3 = new Database(file);
    v3.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const m of MIGRATIONS.slice(0, 3)) v3.exec(m);
    v3.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run();
    v3.prepare("INSERT INTO projects (id, slug, name, root_node_id, created_at, updated_at) VALUES (1, 'inprogress', 'InProgress', 1, 't', 't')").run();
    v3.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, label, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'InProgress', 'active', NULL, 't', 't')").run();
    v3.prepare("INSERT INTO sessions (id, project_id, state, focus_node_id, started_at, last_seen_at) VALUES ('s1', 1, 'working', 1, 't', 't')").run();
    v3.prepare("INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at, description) VALUES ('s1', 'a1', 'general-purpose', 't', 'Write the tests')").run();
    v3.close();
    return { dir, file };
  }

  it('migrates a database at v3 with data to v4, every slot and ordinal null', () => {
    const { dir, file } = v3Database();
    const db = openDb(file);
    try {
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT id, state, focus_node_id, slot FROM sessions').all()).toEqual([{ id: 's1', state: 'working', focus_node_id: 1, slot: null }]);
      expect(db.prepare('SELECT agent_id, description, ordinal FROM session_subagents').all()).toEqual([{ agent_id: 'a1', description: 'Write the tests', ordinal: null }]);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks migration 4 readable by v1 builds, so a v3 build still opens a v4 database and its own writes work', () => {
    const { db } = makeCtx();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
    // This build as the v3 build sees the schema: three migrations.
    const shipped = MIGRATIONS.splice(3);
    try {
      expect(() => migrate(db)).not.toThrow();
      expect(schemaVersion(db)).toBe(3 + shipped.length);
      db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 't', 't')").run();
      // The v3 build's own writes, which never name the new columns: a new session has no slot, a new subagent no
      // ordinal, and an update keeps what the newer build gave.
      db.prepare('INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('s1', 1, 'idle', 't', 't');
      db.prepare('INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at) VALUES (?, ?, ?, ?)').run('s1', 'a1', 'general-purpose', 't');
      expect(db.prepare("SELECT slot FROM sessions WHERE id = 's1'").pluck().get()).toBeNull();
      expect(db.prepare("SELECT ordinal FROM session_subagents WHERE agent_id = 'a1'").pluck().get()).toBeNull();
      db.prepare("UPDATE sessions SET slot = 1 WHERE id = 's1'").run();
      db.prepare("UPDATE session_subagents SET ordinal = 2 WHERE agent_id = 'a1'").run();
      db.prepare('UPDATE sessions SET project_id = ?, title = ?, cwd = ?, branch = ?, transcript_path = ?, state = ?, focus_node_id = ?, prompts_since_update = ?, last_seen_at = ?, ended_at = ? WHERE id = ?')
        .run(1, 'From v3', null, null, null, 'working', null, 1, 't2', null, 's1');
      db.prepare('UPDATE session_subagents SET description = ?, model = ?, node_id = ?, tool_use_id = ? WHERE session_id = ? AND agent_id = ?').run('Edited by v3', null, null, null, 's1', 'a1');
      db.prepare('UPDATE session_subagents SET ended_at = ? WHERE session_id = ? AND agent_id = ? AND ended_at IS NULL').run('t3', 's1', 'a1');
      expect(db.prepare("SELECT title, state, slot FROM sessions WHERE id = 's1'").get()).toEqual({ title: 'From v3', state: 'working', slot: 1 });
      expect(db.prepare("SELECT description, ended_at, ordinal FROM session_subagents WHERE agent_id = 'a1'").get()).toEqual({ description: 'Edited by v3', ended_at: 't3', ordinal: 2 });
    } finally {
      MIGRATIONS.push(...shipped);
    }
  });

  /** A database file as the v4 build leaves it: migrations 1 to 4, with a live session, its subagent and an open dispatch. */
  function v4Database(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ip-migrate-v4-'));
    const file = join(dir, 'inprogress.db');
    const v4 = new Database(file);
    v4.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const m of MIGRATIONS.slice(0, 4)) v4.exec(m);
    v4.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
    v4.prepare("INSERT INTO projects (id, slug, name, root_node_id, created_at, updated_at) VALUES (1, 'inprogress', 'InProgress', 1, 't', 't')").run();
    v4.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, label, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'InProgress', 'active', NULL, 't', 't')").run();
    v4.prepare("INSERT INTO sessions (id, project_id, state, focus_node_id, started_at, last_seen_at, slot) VALUES ('s1', 1, 'working', 1, 't', 't', 0)").run();
    v4.prepare("INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at, description, ordinal) VALUES ('s1', 'a1', 'general-purpose', 't', 'Write the tests', 1)").run();
    v4.prepare("INSERT INTO subagent_dispatches (session_id, tool_use_id, agent_type, description, model, node_id, created_at) VALUES ('s1', 'toolu_1', 'Explore', 'Map the hooks', NULL, 1, 't')").run();
    v4.close();
    return { dir, file };
  }

  it('migrates a database at v4 with data to v5, every purpose null', () => {
    const { dir, file } = v4Database();
    const db = openDb(file);
    try {
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT agent_id, description, ordinal, purpose FROM session_subagents').all()).toEqual([{ agent_id: 'a1', description: 'Write the tests', ordinal: 1, purpose: null }]);
      expect(db.prepare('SELECT tool_use_id, description, purpose FROM subagent_dispatches').all()).toEqual([{ tool_use_id: 'toolu_1', description: 'Map the hooks', purpose: null }]);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks migration 5 readable by v1 builds, so a v4 build still opens a v5 database and its own writes work', () => {
    const { db } = makeCtx();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
    // This build as the v4 build sees the schema: four migrations.
    const shipped = MIGRATIONS.splice(4);
    try {
      expect(() => migrate(db)).not.toThrow();
      expect(schemaVersion(db)).toBe(4 + shipped.length);
      db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 't', 't')").run();
      db.prepare('INSERT INTO sessions (id, project_id, state, started_at, last_seen_at, slot) VALUES (?, ?, ?, ?, ?, ?)').run('s1', 1, 'working', 't', 't', 0);
      // The v4 build's own writes, which never name purpose: a new subagent and a new dispatch have none, and show()'s
      // update keeps what the newer build gave.
      db.prepare(
        `INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at, ordinal)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM session_subagents WHERE session_id = ?))`,
      ).run('s1', 'a1', 'general-purpose', 't', 's1');
      db.prepare('INSERT OR IGNORE INTO subagent_dispatches (session_id, tool_use_id, agent_type, description, model, node_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('s1', 'toolu_1', 'general-purpose', 'Write the tests', null, null, 't');
      expect(db.prepare("SELECT purpose FROM session_subagents WHERE agent_id = 'a1'").pluck().get()).toBeNull();
      expect(db.prepare("SELECT purpose FROM subagent_dispatches WHERE tool_use_id = 'toolu_1'").pluck().get()).toBeNull();
      db.prepare("UPDATE session_subagents SET purpose = 'Review the diff.' WHERE agent_id = 'a1'").run();
      db.prepare('UPDATE session_subagents SET description = ?, model = ?, node_id = ?, tool_use_id = ? WHERE session_id = ? AND agent_id = ?').run('Edited by v4', 'opus', null, 'toolu_1', 's1', 'a1');
      expect(db.prepare("SELECT description, model, ordinal, purpose FROM session_subagents WHERE agent_id = 'a1'").get()).toEqual({ description: 'Edited by v4', model: 'opus', ordinal: 1, purpose: 'Review the diff.' });
    } finally {
      MIGRATIONS.push(...shipped);
    }
  });

  it('records events inside the transaction and emits them after commit', () => {
    const ctx = makeCtx();
    const seen: EventRow[] = [];
    ctx.bus.on('event', (e: EventRow) => seen.push(e));
    const result = write(ctx, 'test', (record) => {
      record({ projectId: null, type: 'demo.done', entity: 'demo', entityId: 7, data: { a: 1 } });
      expect(seen).toHaveLength(0);
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ actor: 'test', type: 'demo.done', entityId: '7', data: { a: 1 } });
    const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
    expect(row.c).toBe(1);
  });

  it('rolls back events and emits nothing when the callback throws', () => {
    const ctx = makeCtx();
    const seen: EventRow[] = [];
    ctx.bus.on('event', (e: EventRow) => seen.push(e));
    expect(() =>
      write(ctx, 'test', (record) => {
        record({ projectId: null, type: 'demo', entity: 'demo', entityId: 1 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(seen).toHaveLength(0);
    expect((ctx.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(0);
  });

  it('resets prompts_since_update for scribe writes of that session', () => {
    const ctx = makeCtx();
    ctx.db.prepare("INSERT INTO sessions (id, state, prompts_since_update, started_at, last_seen_at) VALUES ('s1', 'working', 5, 'x', 'x')").run();
    write(ctx, 'scribe:s1', () => undefined);
    expect((ctx.db.prepare("SELECT prompts_since_update AS p FROM sessions WHERE id = 's1'").get() as { p: number }).p).toBe(0);
  });

  it('refuses a write() nested inside another write() and rolls the outer one back', () => {
    const ctx = makeCtx();
    const seen: EventRow[] = [];
    ctx.bus.on('event', (e: EventRow) => seen.push(e));
    expect(() =>
      write(ctx, 'outer', (record) => {
        record({ projectId: null, type: 'outer', entity: 'demo', entityId: 1 });
        write(ctx, 'inner', (inner) => inner({ projectId: null, type: 'inner', entity: 'demo', entityId: 2 }));
      }),
    ).toThrow('write() called inside another write(): events would be emitted before the outer commit');
    expect(seen).toHaveLength(0);
    expect((ctx.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(0);
  });

  it('returns normally and still delivers every event to later listeners when a listener throws', () => {
    const ctx = makeCtx();
    const seen: EventRow[] = [];
    ctx.bus.on('event', () => {
      throw new Error('listener boom');
    });
    ctx.bus.on('event', (e: EventRow) => seen.push(e));
    const result = write(ctx, 'test', (record) => {
      record({ projectId: null, type: 'first', entity: 'demo', entityId: 1 });
      record({ projectId: null, type: 'second', entity: 'demo', entityId: 2 });
      return 42;
    });
    expect(result).toBe(42);
    expect(seen.map((e) => e.type)).toEqual(['first', 'second']);
  });
});
