import type { EventRow } from '../../core/types';
import type { Ctx } from '../db/tx';

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

export function listEventsSince(ctx: Ctx, since: number, limit = 5000): EventRow[] {
  return (ctx.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(since, limit) as EventDbRow[]).map(toEvent);
}

export function maxEventId(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }).id;
}

export function lastProjectEvent(ctx: Ctx, projectId: number): EventRow | null {
  const row = ctx.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId) as EventDbRow | undefined;
  return row ? toEvent(row) : null;
}
