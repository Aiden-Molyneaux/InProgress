import type { EventRow } from '../../core/types';
import type { Ctx, EventInput } from '../db/tx';

interface EventDbRow {
  id: number;
  ts: string;
  project_id: number | null;
  actor: string;
  type: string;
  entity: string;
  entity_id: string;
  data: string;
}

export const toEvent = (r: EventDbRow): EventRow => ({
  id: r.id,
  ts: r.ts,
  projectId: r.project_id,
  actor: r.actor,
  type: r.type,
  entity: r.entity,
  entityId: r.entity_id,
  data: JSON.parse(r.data) as unknown,
});

/** The reconnect replay: the window's own measurements (`window.` types, spec 2.6) are left out. */
export function listEventsSince(ctx: Ctx, since: number, limit = 5000): EventRow[] {
  return (ctx.db.prepare("SELECT * FROM events WHERE id > ? AND type NOT LIKE 'window.%' ORDER BY id LIMIT ?").all(since, limit) as EventDbRow[]).map(toEvent);
}

/** Inserts an event row with no bus notice (the window's measurements). */
export function recordQuiet(ctx: Ctx, actor: string, e: EventInput): void {
  ctx.db
    .prepare('INSERT INTO events (ts, project_id, actor, type, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.now(), e.projectId, actor, e.type, e.entity, String(e.entityId), JSON.stringify(e.data ?? {}));
}

export function maxEventId(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }).id;
}

export function lastProjectEvent(ctx: Ctx, projectId: number): EventRow | null {
  const row = ctx.db.prepare("SELECT * FROM events WHERE project_id = ? AND type NOT LIKE 'window.%' ORDER BY id DESC LIMIT 1").get(projectId) as EventDbRow | undefined;
  return row ? toEvent(row) : null;
}

export const EVENTS_RETENTION_DAYS = 30;

/**
 * Delete events older than `days`, except each project's newest event (the activity strip and the
 * project switcher's last-activity order read it). Ids are AUTOINCREMENT, so pruning never lets a
 * later event reuse an id an SSE client has already seen. Returns how many were deleted.
 */
export function pruneEvents(ctx: Ctx, days = EVENTS_RETENTION_DAYS): number {
  const cutoff = new Date(Date.parse(ctx.now()) - days * 24 * 60 * 60 * 1000).toISOString();
  return ctx.db
    .prepare("DELETE FROM events WHERE ts < ? AND id NOT IN (SELECT MAX(id) FROM events WHERE project_id IS NOT NULL AND type NOT LIKE 'window.%' GROUP BY project_id)")
    .run(cutoff).changes;
}
