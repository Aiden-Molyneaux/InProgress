import type { DB } from '../db/connection';

/** What a send is (migration 21). */
export type SendKind = 'start' | 'relay' | 'voice_line' | 'carry' | 'morning';

export type SendState = 'intended' | 'done' | 'unknown' | 'cleared';

/** An action that leaves InProgress, written before it happens. */
export interface LeadSend {
  id: number;
  projectId: number;
  itemId: number | null;
  kind: SendKind;
  /** A thread id, or 'webhook'. */
  target: string;
  retryKey: string | null;
  state: SendState;
  /** The thread or message id it made. */
  result: string | null;
  createdAt: string;
  doneAt: string | null;
  /** The Voice's stamp: when Aiden saw it. */
  seenAt: string | null;
  /** The text sent. */
  body: string;
}

interface LeadSendRow {
  id: number;
  project_id: number;
  item_id: number | null;
  kind: string;
  target: string;
  retry_key: string | null;
  state: string;
  result: string | null;
  created_at: string;
  done_at: string | null;
  seen_at: string | null;
  body: string;
}

const toLeadSend = (r: LeadSendRow): LeadSend => ({
  id: r.id,
  projectId: r.project_id,
  itemId: r.item_id,
  kind: r.kind as SendKind,
  target: r.target,
  retryKey: r.retry_key,
  state: r.state as SendState,
  result: r.result,
  createdAt: r.created_at,
  doneAt: r.done_at,
  seenAt: r.seen_at,
  body: r.body,
});

export interface IntendSendInput {
  projectId: number;
  itemId?: number | null;
  kind: SendKind;
  target: string;
  retryKey?: string | null;
  body?: string;
}

/**
 * Writes the send as intended, before the action. A retry key used before throws (lead_sends_retry_once);
 * sendByRetryKey finds the earlier send.
 */
export function intendSend(db: DB, input: IntendSendInput, now: string): LeadSend {
  const info = db
    .prepare('INSERT INTO lead_sends (project_id, item_id, kind, target, retry_key, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(input.projectId, input.itemId ?? null, input.kind, input.target, input.retryKey ?? null, now, input.body ?? '');
  return getSend(db, Number(info.lastInsertRowid))!;
}

export function getSend(db: DB, id: number): LeadSend | undefined {
  const row = db.prepare('SELECT * FROM lead_sends WHERE id = ?').get(id) as LeadSendRow | undefined;
  return row ? toLeadSend(row) : undefined;
}

/** The send written under this retry key, or undefined. */
export function sendByRetryKey(db: DB, retryKey: string): LeadSend | undefined {
  const row = db.prepare('SELECT * FROM lead_sends WHERE retry_key = ?').get(retryKey) as LeadSendRow | undefined;
  return row ? toLeadSend(row) : undefined;
}

/**
 * Compare-and-set: moves the send to `to` only while its state is one of `from`, writing the result when given. A move
 * to done sets done_at to `now`. Returns whether the row changed.
 */
export function moveSend(db: DB, id: number, from: SendState[], to: SendState, opts: { result?: string; now: string }): boolean {
  if (from.length === 0) return false;
  const sets = ['state = ?'];
  const values: unknown[] = [to];
  if (opts.result !== undefined) {
    sets.push('result = ?');
    values.push(opts.result);
  }
  if (to === 'done') {
    sets.push('done_at = ?');
    values.push(opts.now);
  }
  const info = db
    .prepare(`UPDATE lead_sends SET ${sets.join(', ')} WHERE id = ? AND state IN (${from.map(() => '?').join(', ')})`)
    .run(...values, id, ...from);
  return info.changes > 0;
}

/** Stamps the send as seen, once: a later stamp leaves the first. Returns whether it stamped. */
export function stampSeen(db: DB, id: number, now: string): boolean {
  return db.prepare('UPDATE lead_sends SET seen_at = ? WHERE id = ? AND seen_at IS NULL').run(now, id).changes > 0;
}

/** The project's sends in this state, oldest first. */
export function sendsInState(db: DB, projectId: number, state: SendState): LeadSend[] {
  return (db
    .prepare('SELECT * FROM lead_sends WHERE project_id = ? AND state = ? ORDER BY created_at, id')
    .all(projectId, state) as LeadSendRow[]).map(toLeadSend);
}
