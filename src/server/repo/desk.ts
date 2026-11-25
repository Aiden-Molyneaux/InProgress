import type { DB } from '../db/connection';

/** What a desk item is about (migration 21). No CHECK in the table: this union is the list. */
export type DeskItemKind =
  | 'question'
  | 'permission'
  | 'stopped'
  | 'stuck'
  | 'held'
  | 'unknown_send'
  | 'aiden_said'
  | 'old_ask'
  | 'promise_due';

export type DeskItemState = 'open' | 'leased' | 'done' | 'behind' | 'waiting_aiden';

/** A thing the lead must deal with. */
export interface DeskItem {
  id: number;
  projectId: number;
  kind: DeskItemKind;
  /** The ask id, session id or send id the item is about. */
  ref: string;
  nodeId: number | null;
  createdAt: string;
  /** Its limit, or null for none. */
  dueAt: string | null;
  state: DeskItemState;
  doneAt: string | null;
  outcome: string | null;
}

interface DeskItemRow {
  id: number;
  project_id: number;
  kind: string;
  ref: string;
  node_id: number | null;
  created_at: string;
  due_at: string | null;
  state: string;
  done_at: string | null;
  outcome: string | null;
}

const toDeskItem = (r: DeskItemRow): DeskItem => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind as DeskItemKind,
  ref: r.ref,
  nodeId: r.node_id,
  createdAt: r.created_at,
  dueAt: r.due_at,
  state: r.state as DeskItemState,
  doneAt: r.done_at,
  outcome: r.outcome,
});

export interface AddDeskItemInput {
  projectId: number;
  kind: DeskItemKind;
  ref: string;
  nodeId?: number | null;
  dueAt?: string | null;
}

/**
 * Queues the item, or finds the one already queued: one (kind, ref) is never queued twice while not done
 * (desk_items_open_once). `created` is false when the item already existed; the existing row is returned unchanged.
 */
export function addDeskItem(db: DB, input: AddDeskItemInput, now: string): { item: DeskItem; created: boolean } {
  const info = db
    .prepare('INSERT INTO desk_items (project_id, kind, ref, node_id, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .run(input.projectId, input.kind, input.ref, input.nodeId ?? null, now, input.dueAt ?? null);
  const row = db.prepare("SELECT * FROM desk_items WHERE kind = ? AND ref = ? AND state <> 'done'").get(input.kind, input.ref) as DeskItemRow;
  return { item: toDeskItem(row), created: info.changes > 0 };
}

export function getDeskItem(db: DB, id: number): DeskItem | undefined {
  const row = db.prepare('SELECT * FROM desk_items WHERE id = ?').get(id) as DeskItemRow | undefined;
  return row ? toDeskItem(row) : undefined;
}

/** The project's items not done, oldest first. */
export function openDeskItems(db: DB, projectId: number): DeskItem[] {
  return (db
    .prepare("SELECT * FROM desk_items WHERE project_id = ? AND state <> 'done' ORDER BY created_at, id")
    .all(projectId) as DeskItemRow[]).map(toDeskItem);
}

/**
 * Compare-and-set: moves the item to `to` only while its state is one of `from`. A move to done sets done_at to `now`
 * and the outcome; a move to any other state clears both, so an item reopened carries no stale outcome. Returns
 * whether the row changed.
 */
export function moveDeskItem(db: DB, id: number, from: DeskItemState[], to: DeskItemState, opts: { outcome?: string; now: string }): boolean {
  if (from.length === 0) return false;
  const done = to === 'done';
  const info = db
    .prepare(`UPDATE desk_items SET state = ?, done_at = ?, outcome = ? WHERE id = ? AND state IN (${from.map(() => '?').join(', ')})`)
    .run(to, done ? opts.now : null, done ? (opts.outcome ?? null) : null, id, ...from);
  return info.changes > 0;
}
