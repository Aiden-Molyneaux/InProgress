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

/** The ISO time `ms` before the context's clock: the cutoff for "stopped less than this long ago". */
export const msAgo = (ctx: Ctx, ms: number): string => new Date(Date.parse(ctx.now()) - ms).toISOString();

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
 * transaction and delivered to the `ctx.bus` 'event' listeners only after commit;
 * a listener that throws affects neither the write nor the other listeners. A write by
 * `scribe:<sessionId>` resets that session's stale-update counter.
 * Never call write() inside another write(): it throws.
 */
export function write<T>(ctx: Ctx, actor: string, fn: (record: RecordEvent) => T): T {
  if (ctx.db.inTransaction) throw new Error('write() called inside another write(): events would be emitted before the outer commit');
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
  // Call each listener ourselves: emit() stops at the first listener that throws.
  // rawListeners() keeps once() wrappers, so once-listeners still remove themselves.
  for (const event of pending) {
    for (const listener of ctx.bus.rawListeners('event')) {
      try {
        listener.call(ctx.bus, event);
      } catch {
        /* a listener failure must not undo or truncate a committed write */
      }
    }
  }
  return result;
}
