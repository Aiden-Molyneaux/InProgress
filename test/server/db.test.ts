import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDb, schemaVersion } from '../../src/server/db/connection';
import { MIGRATIONS } from '../../src/server/db/schema';
import { write } from '../../src/server/db/tx';
import type { EventRow } from '../../src/core/types';
import { maxEventId } from '../../src/server/repo/events';
import { makeCtx } from '../helpers';

describe('database', () => {
  it('migrates to the latest schema with foreign keys on', () => {
    const ctx = makeCtx();
    expect(schemaVersion(ctx.db)).toBe(1);
    const tables = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['projects', 'bindings', 'nodes', 'resources', 'log_entries', 'sessions', 'session_subagents', 'events', 'meta']));
    expect(ctx.db.pragma('foreign_keys', { simple: true })).toBe(1);
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
    expect(() => migrate(db)).toThrow('InProgress database schema v99 is newer than this build (v1); update InProgress');
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
