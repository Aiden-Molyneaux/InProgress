import { sessionActivity } from '../../core/activity';
import { STALE_SESSION_MS, type Ask } from '../../core/types';
import { stamp } from '../../core/span';
import type { DB } from '../db/connection';
import { write, type Ctx } from '../db/tx';
import { roundSince } from '../lead';
import { addDeskItem, openDeskItems, type DeskItem, type DeskItemKind } from '../repo/desk';
import { aidensAskSql } from '../repo/asks';
import { resolveProject } from '../repo/projects';
import { findSession } from '../repo/sessions';

/** How long after it is raised a session's question or permission ask is due on the desk. */
export const DESK_ASK_DUE_MS = 3 * 60 * 1000;
/** How long a worker session must have been stopped before the minute watch makes a `stopped` item. */
export const DESK_STOPPED_MS = 10 * 60 * 1000;
/** How long after the minute watch makes an item (stopped, promise_due, or a swept ask's) it is due. */
export const DESK_WATCH_DUE_MS = 5 * 60 * 1000;

/** The kinds of desk item that are about an ask, and close when it clears. */
const ASK_ITEM_KINDS: readonly DeskItemKind[] = ['question', 'permission', 'old_ask', 'promise_due'];

const listeners = new Set<(projectId: number) => void>();

/** Calls `listener` with the project's id each time a producer makes a desk item. Returns the unsubscribe. */
export function onDeskItem(listener: (projectId: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Wakes every listener for the project, each on its own setImmediate: the producer runs inside a synchronous write, so the
 * listener fires after that write commits. A listener's throw is logged here and never reaches the write.
 */
function wake(projectId: number): void {
  for (const listener of listeners) {
    setImmediate(() => {
      try {
        listener(projectId);
      } catch (err) {
        console.error('[desk] a desk listener failed:', err);
      }
    });
  }
}

const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** Adds the item and wakes the listeners when it is new. */
function produce(db: DB, input: Parameters<typeof addDeskItem>[1], now: string): { item: DeskItem; created: boolean } {
  const result = addDeskItem(db, input, now);
  if (result.created) wake(input.projectId);
  return result;
}

/** Whether a desk item of this kind and ref exists in any state, done included. */
const itemEverMade = (db: DB, kind: DeskItemKind, ref: string): boolean =>
  db.prepare('SELECT 1 FROM desk_items WHERE kind = ? AND ref = ?').get(kind, ref) !== undefined;

/**
 * Inside the write that raised or joined `ask`: a session's question or permission ask of Aiden's, on a project whose
 * round is on, is queued on the desk, due DESK_ASK_DUE_MS after it was raised. A joined ask finds its existing item.
 */
export function deskOnAskRaised(db: DB, ask: Ask, now: string): void {
  if (ask.owner !== 'aiden' || (ask.kind !== 'question' && ask.kind !== 'permission') || ask.sessionId === null) return;
  if (roundSince(db, ask.projectId) === null) return;
  produce(db, { projectId: ask.projectId, kind: ask.kind, ref: String(ask.id), nodeId: ask.nodeId, dueAt: plus(ask.raisedAt, DESK_ASK_DUE_MS) }, now);
}

/**
 * Inside the write that first clears ask `askId`: every desk item about it that is not done moves to done, with the
 * outcome `cleared by <by>`. A leased item too: the runner treats an apply on an item no longer leased as abandoned.
 */
export function deskOnAskCleared(db: DB, askId: number, by: string, now: string): void {
  db.prepare(
    `UPDATE desk_items SET state = 'done', done_at = ?, outcome = ? WHERE ref = ? AND state IN ('open', 'leased', 'behind', 'waiting_aiden') AND kind IN (${ASK_ITEM_KINDS.map(() => '?').join(', ')})`,
  ).run(now, `cleared by ${by}`, String(askId), ...ASK_ITEM_KINDS);
}

/** What one minute's desk watch made, per pass. */
export interface DeskWatchResult {
  stopped: number;
  promiseDue: number;
  swept: number;
}

/**
 * The minute watch's desk part. For each live project whose round is on, three passes, each in its own write:
 * stopped (a worker session idle on an active step with no open ask of Aiden's, stopped DESK_STOPPED_MS to
 * STALE_SESSION_MS ago and not before the round was switched on), promise_due (a lead's promise past its time), and the
 * sweep (a session's question or permission ask raised since the round was switched on that has no desk item, as one
 * raised while a rolled-back build ran). Each cause makes one item, however often the watch runs.
 */
export function watchDesk(ctx: Ctx): DeskWatchResult {
  const result: DeskWatchResult = { stopped: 0, promiseDue: 0, swept: 0 };
  const projects = ctx.db.prepare('SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY id').pluck().all() as number[];
  for (const projectId of projects) {
    if (roundSince(ctx.db, projectId) === null) continue;
    result.stopped += write(ctx, 'system', () => stoppedPass(ctx, projectId));
    result.promiseDue += write(ctx, 'system', () => promiseDuePass(ctx, projectId));
    result.swept += write(ctx, 'system', () => sweepPass(ctx, projectId));
  }
  return result;
}

function stoppedPass(ctx: Ctx, projectId: number): number {
  const since = roundSince(ctx.db, projectId);
  if (since === null) return 0;
  const now = ctx.now();
  const nowMs = Date.parse(now);
  const latest = new Date(nowMs - DESK_STOPPED_MS).toISOString();
  const earliest = new Date(nowMs - STALE_SESSION_MS).toISOString();
  const candidates = ctx.db
    .prepare(
      `SELECT s.id, s.focus_node_id, s.last_seen_at FROM sessions s JOIN nodes n ON n.id = s.focus_node_id
       WHERE s.project_id = ? AND s.role = 'worker' AND s.state = 'idle' AND s.ended_at IS NULL AND n.status = 'active'
         AND s.last_seen_at <= ? AND s.last_seen_at >= ? AND s.last_seen_at >= ?
         AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.node_id = n.id AND a.cleared_at IS NULL AND ${aidensAskSql('a.')})
       ORDER BY s.last_seen_at, s.id`,
    )
    .all(projectId, latest, earliest, since) as { id: string; focus_node_id: number; last_seen_at: string }[];
  let made = 0;
  for (const c of candidates) {
    const ref = `${c.id}@${c.last_seen_at}`;
    if (itemEverMade(ctx.db, 'stopped', ref)) continue;
    const session = findSession(ctx, c.id);
    // Live background work (a subagent that is not a reader, a command that counts as work) is not a stop.
    if (session === undefined || sessionActivity(session, nowMs) !== 'idle') continue;
    if (produce(ctx.db, { projectId, kind: 'stopped', ref, nodeId: c.focus_node_id, dueAt: plus(now, DESK_WATCH_DUE_MS) }, now).created) made++;
  }
  return made;
}

function promiseDuePass(ctx: Ctx, projectId: number): number {
  const now = ctx.now();
  const due = ctx.db
    .prepare("SELECT id, node_id FROM asks WHERE project_id = ? AND owner = 'lead' AND cleared_at IS NULL AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at, id")
    .all(projectId, now) as { id: number; node_id: number }[];
  let made = 0;
  for (const a of due) {
    const ref = String(a.id);
    if (itemEverMade(ctx.db, 'promise_due', ref)) continue;
    if (produce(ctx.db, { projectId, kind: 'promise_due', ref, nodeId: a.node_id, dueAt: plus(now, DESK_WATCH_DUE_MS) }, now).created) made++;
  }
  return made;
}

function sweepPass(ctx: Ctx, projectId: number): number {
  const since = roundSince(ctx.db, projectId);
  if (since === null) return 0;
  const now = ctx.now();
  const missing = ctx.db
    .prepare(
      `SELECT a.id, a.kind, a.node_id, a.raised_at FROM asks a
       WHERE a.project_id = ? AND a.owner = 'aiden' AND a.kind IN ('question', 'permission') AND a.cleared_at IS NULL
         AND a.session_id IS NOT NULL AND a.raised_at >= ?
         AND NOT EXISTS (SELECT 1 FROM desk_items d WHERE d.kind = a.kind AND d.ref = CAST(a.id AS TEXT))
       ORDER BY a.raised_at, a.id`,
    )
    .all(projectId, since) as { id: number; kind: 'question' | 'permission'; node_id: number; raised_at: string }[];
  let made = 0;
  for (const a of missing) {
    if (produce(ctx.db, { projectId, kind: a.kind, ref: String(a.id), nodeId: a.node_id, dueAt: plus(a.raised_at, DESK_ASK_DUE_MS) }, now).created) made++;
  }
  return made;
}

/** One open item as `lead desk` prints it: `#<id> <kind> <ref> step #<node> due HH:MM (<n> min left|<n> min over) <state>`. */
function deskLine(item: DeskItem, nowMs: number): string {
  const step = item.nodeId === null ? 'no step' : `step #${item.nodeId}`;
  let due = 'no limit';
  if (item.dueAt !== null) {
    const diff = Date.parse(item.dueAt) - nowMs;
    const minutes = Math.round(Math.abs(diff) / 60_000);
    due = `due ${stamp(item.dueAt).slice(11)} (${minutes} min ${diff >= 0 ? 'left' : 'over'})`;
  }
  return `#${item.id} ${item.kind} ${item.ref} ${step} ${due} ${item.state}`;
}

/** The project's desk: its open items, oldest first, and the text `lead desk` prints. Local time, as the other lead text. */
export function readDesk(ctx: Ctx, ref: string): { items: DeskItem[]; text: string } {
  const project = resolveProject(ctx, ref);
  const items = openDeskItems(ctx.db, project.id);
  const nowMs = Date.parse(ctx.now());
  return { items, text: items.length === 0 ? 'The desk is empty.' : items.map((i) => deskLine(i, nowMs)).join('\n') };
}
