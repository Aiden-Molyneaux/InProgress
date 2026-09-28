import { EventEmitter } from 'node:events';
import type { EventRow } from '../../core/types';
import type { DB } from './connection';

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }
}

export interface Ctx {
  db: DB;
  bus: EventBus;
  now: () => string;
}

export function createCtx(db: DB, now: () => string = () => new Date().toISOString()): Ctx {
  return { db, bus: new EventBus(), now };
}

export interface EventInput {
  projectId: number | null;
  type: string;
  entity: string;
  entityId: string | number;
  data?: unknown;
}

export type RecordEvent = (event: EventInput) => void;

/**
 * Run `fn` in one transaction. Events passed to `record` are inserted in the same
 * transaction and emitted on `ctx.bus` only after commit. A write by
 * `scribe:<sessionId>` resets that session's stale-update counter.
 * Never call write() inside another write().
 */
export function write<T>(ctx: Ctx, actor: string, fn: (record: RecordEvent) => T): T {
  const pending: EventRow[] = [];
  const insert = ctx.db.prepare(
    'INSERT INTO events (ts, project_id, actor, type, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const run = ctx.db.transaction((): T => {
    const result = fn((e) => {
      const ts = ctx.now();
      const data = e.data ?? {};
      const info = insert.run(ts, e.projectId, actor, e.type, e.entity, String(e.entityId), JSON.stringify(data));
      pending.push({ id: Number(info.lastInsertRowid), ts, projectId: e.projectId, actor, type: e.type, entity: e.entity, entityId: String(e.entityId), data });
    });
    if (actor.startsWith('scribe:')) {
      ctx.db.prepare('UPDATE sessions SET prompts_since_update = 0 WHERE id = ?').run(actor.slice('scribe:'.length));
    }
    return result;
  });
  const result = run();
  for (const event of pending) ctx.bus.emit('event', event);
  return result;
}
