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
  /**
   * Run by write() inside its transaction, after `fn`, for the projects its events name: the Board reconcile
   * (repo/taskState.ts). The server sets it in main.ts; unset, writes skip it.
   */
  reconcile?: (ctx: Ctx, projectIds: number[]) => void;
  /**
   * The server's home folder, set by main.ts. The lead's folders are under it (`<home>/lead/<slug>`): the hooks treat them as
   * the lead's own and the morning list starts its thread there. Unset, there is no lead folder.
   */
  home?: string;
}

export function createCtx(db: DB, now: () => string = () => new Date().toISOString()): Ctx {
  const ctx: Ctx = { db, bus: new EventBus(), now };
  watchDeskWrites(db);
  ctxByDb.set(db, ctx);
  return ctx;
}

/** The context made for each database: flushDesk writes through it. */
const ctxByDb = new WeakMap<DB, Ctx>();
/** The databases whose desk writes are watched (the temp table and triggers exist on the connection). */
const deskWatched = new WeakSet<DB>();

/**
 * Watches the desk on this connection: temp triggers note the project of every desk item inserted, or whose state or
 * due_at changes, whoever writes it (a repo function, a bulk UPDATE, the runner's own transactions). write() turns the
 * notes into one `project.updated` (changes: { desk: true }) per project, so an open window reloads its desk.
 */
function watchDeskWrites(db: DB): void {
  if (deskWatched.has(db)) return;
  try {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS desk_touched (project_id INTEGER NOT NULL);
      CREATE TEMP TRIGGER IF NOT EXISTS desk_touched_insert AFTER INSERT ON main.desk_items
        BEGIN INSERT INTO desk_touched (project_id) VALUES (NEW.project_id); END;
      CREATE TEMP TRIGGER IF NOT EXISTS desk_touched_update AFTER UPDATE OF state, due_at ON main.desk_items
        WHEN OLD.state IS NOT NEW.state OR OLD.due_at IS NOT NEW.due_at
        BEGIN INSERT INTO desk_touched (project_id) VALUES (NEW.project_id); END;
    `);
    deskWatched.add(db);
  } catch (err) {
    // A database with no desk yet (one opened before its migrations): there is nothing to watch, and no event to miss.
    if (!(err instanceof Error) || !/no such table/i.test(err.message)) throw err;
  }
}

/** The projects whose desk changed since the last drain, emptied. Read inside a transaction. */
function drainDesk(db: DB): number[] {
  if (!deskWatched.has(db)) return [];
  const ids = db.prepare('SELECT DISTINCT project_id FROM temp.desk_touched ORDER BY project_id').pluck().all() as number[];
  if (ids.length) db.prepare('DELETE FROM temp.desk_touched').run();
  return ids;
}

/**
 * For a desk change made in a transaction of its own, not in write() (the runner's lease, apply, fail and reopen): records
 * and delivers its `project.updated` events now, in a write of their own. Inside a transaction it does nothing: the
 * enclosing write() records them.
 */
export function flushDesk(db: DB): void {
  const ctx = ctxByDb.get(db);
  if (ctx === undefined || db.inTransaction || !deskWatched.has(db)) return;
  try {
    if (db.prepare('SELECT 1 FROM temp.desk_touched LIMIT 1').get() === undefined) return;
    write(ctx, 'system', () => undefined);
  } catch (err) {
    // The desk change has committed: telling the window never undoes what the caller learns. The next write tells it.
    console.error(`InProgress: could not tell the window of a desk change: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A desk-only change's data, as write() records it: `{ changes: { desk: true } }`. */
export const DESK_ONLY_DATA = { changes: { desk: true } } as const;

/** Whether an event is a desk-only `project.updated`: it tells the window to reload its desk, and says nothing else. */
export function deskOnly(e: { type: string; data?: unknown }): boolean {
  if (e.type !== 'project.updated' || e.data === null || typeof e.data !== 'object') return false;
  const d = e.data as { changes?: unknown };
  const keys = Object.keys(d);
  if (keys.length !== 1 || keys[0] !== 'changes' || d.changes === null || typeof d.changes !== 'object') return false;
  const changes = d.changes as Record<string, unknown>;
  return Object.keys(changes).length === 1 && changes.desk === true;
}

/** SQL (events alias `e`) true for a row that is not a desk-only `project.updated`: what the last-event reads count. */
export const NOT_DESK_ONLY_SQL = `NOT (e.type = 'project.updated' AND e.data = '${JSON.stringify(DESK_ONLY_DATA)}')`;

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
 * `scribe:<sessionId>` resets that session's stale-update counter. When `ctx.reconcile` is set, it runs inside the
 * transaction for the projects the events name; a reconcile that throws is logged and leaves the write committed.
 * Never call write() inside another write(): it throws. `immediate` takes the write lock at the start (BEGIN IMMEDIATE),
 * for a write that reads and then decides, as the lead runner's apply does: a second connection waits rather than
 * meeting a stale read.
 */
export function write<T>(ctx: Ctx, actor: string, fn: (record: RecordEvent) => T, opts: { immediate?: boolean } = {}): T {
  if (ctx.db.inTransaction) throw new Error('write() called inside another write(): events would be emitted before the outer commit');
  const pending: EventRow[] = [];
  const insert = ctx.db.prepare(
    'INSERT INTO events (ts, project_id, actor, type, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const run = ctx.db.transaction((): T => {
    const record: RecordEvent = (e) => {
      const ts = ctx.now();
      const data = e.data ?? {};
      const info = insert.run(ts, e.projectId, actor, e.type, e.entity, String(e.entityId), JSON.stringify(data));
      pending.push({ id: Number(info.lastInsertRowid), ts, projectId: e.projectId, actor, type: e.type, entity: e.entity, entityId: String(e.entityId), data });
    };
    const result = fn(record);
    // Every project whose desk this write changed (an item made, moved, or given a new due time): one event each.
    for (const projectId of drainDesk(ctx.db)) record({ projectId, type: 'project.updated', entity: 'project', entityId: projectId, data: DESK_ONLY_DATA });
    const projectIds = [...new Set(pending.map((e) => e.projectId).filter((id): id is number => id !== null))];
    if (projectIds.length && ctx.reconcile) {
      const reconcile = ctx.reconcile;
      try {
        // A nested transaction is a SAVEPOINT: a throw rolls back the reconcile's own updates and nothing else.
        ctx.db.transaction(() => reconcile(ctx, projectIds))();
      } catch (err) {
        // Some SQLite errors (a full disk, an I/O error) roll back the whole transaction, not just the savepoint: the
        // write is already lost, so it must fail and say so rather than log and report success.
        if (!ctx.db.inTransaction) throw err;
        // A bug in the reconcile must never stop a write: the Board's stored state catches up on the next one.
        console.error('[reconcile]', err);
      }
    }
    if (actor.startsWith('scribe:')) {
      ctx.db.prepare('UPDATE sessions SET prompts_since_update = 0 WHERE id = ?').run(actor.slice('scribe:'.length));
    }
    return result;
  });
  const result = opts.immediate ? run.immediate() : run();
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
