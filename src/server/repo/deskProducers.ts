import type { Ask } from '../../core/types';
import type { DB } from '../db/connection';
import type { Ctx } from '../db/tx';
import { addDeskItem, moveDeskItem, type AddDeskItemInput, type DeskItem, type DeskItemKind } from './desk';
import { bringItem, bringNext, broughtProjectsOfAsk } from './deskBring';
import type { DecisionKind } from './leadDecisions';
import { roundBound } from './switches';

/** How long after it is raised a session's question or permission ask is due on the desk. */
export const DESK_ASK_DUE_MS = 3 * 60 * 1000;

/** The kinds of desk item that are about an ask, and close when it clears or goes. */
export const ASK_ITEM_KINDS: readonly DeskItemKind[] = ['question', 'permission', 'old_ask', 'promise_due', 'review'];

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

export const plusMs = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** Adds the item, and wakes the listeners when it is new. */
export function produceDeskItem(db: DB, input: AddDeskItemInput, now: string): { item: DeskItem; created: boolean } {
  const result = addDeskItem(db, input, now);
  if (result.created) wake(input.projectId);
  return result;
}

/** The read itemEverMade runs: served by desk_items_kind_ref (a test plans this very text). */
export const ITEM_EVER_MADE_SQL = 'SELECT 1 FROM desk_items WHERE kind = ? AND ref = ?';

/** Whether a desk item of this kind and ref exists in any state, done included. */
export const itemEverMade = (db: DB, kind: DeskItemKind, ref: string): boolean => db.prepare(ITEM_EVER_MADE_SQL).get(kind, ref) !== undefined;

/** How long after a `stuck` item is made a permission ask of the same session makes no desk item of its own. */
export const STUCK_COVERS_ASK_MS = 10 * 60 * 1000;

/**
 * Whether the session has a `stuck` desk item made since `since` (ISO), in any state: the lead already had its permission
 * prompt through the permission hook (src/server/lead/hold.ts). The item's session is in its `stuck` line in the lead's
 * log, whose text starts with the item's ref.
 */
function stuckSince(db: DB, projectId: number, sessionId: string, since: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM desk_items d JOIN lead_events e ON e.project_id = d.project_id AND e.kind = 'stuck' AND substr(e.text, 1, length(d.ref)) = d.ref
          WHERE d.project_id = ? AND d.kind = 'stuck' AND d.created_at >= ? AND e.session_id = ? LIMIT 1`,
      )
      .get(projectId, since, sessionId) !== undefined
  );
}

/** An ask raised again by an undo: it is Aiden's at once, brought with the undone decision's kind and the lead's withdrawn answer. */
export interface UndoneAsk {
  /** The lead's answer the undo withdrew: the bring's would-have. */
  wouldHave: string;
  kind: DecisionKind;
  productRuling: boolean;
}

/**
 * Inside the write that raised `ask`, or raised it again after its session's prompt (bumped): a session's question or
 * permission ask of Aiden's, raised since the round was first switched on and while it is on, is queued on the desk, due
 * DESK_ASK_DUE_MS after it was raised. A project that is not active makes none, as the minute watch skips it. The caller
 * does not call it for a plain join, so a join never queues an ask whose item is done. A permission ask makes none while
 * its session has a `stuck` item made in the last STUCK_COVERS_ASK_MS: the notification hook raised it for the prompt
 * the lead already had. With `undone` (an undo raised it again), the item goes straight to waiting_aiden and is brought,
 * whatever the limit, with nothing sent: it is Aiden's now, not the lead's to decide again.
 */
export function deskOnAskRaised(ctx: Ctx, ask: Ask, undone?: UndoneAsk): void {
  // A review reads the clock only when it makes an item (a test clock ticks on every read).
  if (ask.kind === 'review') {
    deskOnReviewRaised(ctx, ask);
    return;
  }
  const db = ctx.db;
  const now = ctx.now();
  if (ask.owner !== 'aiden' || (ask.kind !== 'question' && ask.kind !== 'permission') || ask.sessionId === null) return;
  if (db.prepare('SELECT status FROM projects WHERE id = ?').pluck().get(ask.projectId) !== 'active') return;
  const bound = roundBound(db, ask.projectId);
  if (bound === null || ask.raisedAt < bound) return;
  // An ask that is an old ask on the desk already (an undone old question, task 17) is carried by the old asks' list.
  if (oldAskOpen(db, ask.id)) return;
  const input: AddDeskItemInput = { projectId: ask.projectId, kind: ask.kind, ref: String(ask.id), nodeId: ask.nodeId, dueAt: plusMs(ask.raisedAt, DESK_ASK_DUE_MS) };
  if (undone !== undefined) {
    const { item, created } = addDeskItem(db, { ...input, state: 'waiting_aiden' }, now);
    if (!created) return;
    const eventId = bringItem(ctx, item, { id: null, kind: null, answer: undone.wouldHave }, { tell: false, decision: { kind: undone.kind, productRuling: undone.productRuling } });
    if (eventId !== undefined) moveDeskItem(db, item.id, ['waiting_aiden'], 'waiting_aiden', { outcome: `AIDEN d${eventId}`, now });
    return;
  }
  if (ask.kind === 'permission' && stuckSince(db, ask.projectId, ask.sessionId, plusMs(now, -STUCK_COVERS_ASK_MS))) return;
  produceDeskItem(db, input, now);
}

/**
 * Inside the write that raised `ask`, a session's review of Aiden's (#743, R1): in an active project with a lead and its round
 * on, raised since the round was first switched on, it goes on the desk as a `review` item straight to waiting_aiden, with
 * no turn (the lead never judges a review; a landing is the landing check's), and is brought at once, whatever the
 * project's count of brought items (it counts toward it): a `bring` line with no would-have, its decisions row, and its
 * line to the Voice. Raised again after its session's prompt, it finds its item and brings nothing more. The minute's sweep
 * (lead/desk.ts) calls it too, for a review raised while the round was off. Answers whether it made the item.
 */
export function deskOnReviewRaised(ctx: Ctx, ask: Ask): boolean {
  const db = ctx.db;
  if (ask.owner !== 'aiden' || ask.sessionId === null) return false;
  const project = db.prepare('SELECT status, lead FROM projects WHERE id = ?').get(ask.projectId) as { status: string; lead: string | null } | undefined;
  if (project === undefined || project.status !== 'active' || project.lead === null || project.lead.trim() === '') return false;
  const bound = roundBound(db, ask.projectId);
  if (bound === null || ask.raisedAt < bound) return false;
  // An old review on the desk already is carried by the old asks' list: no review item beside it.
  if (oldAskOpen(db, ask.id)) return false;
  const now = ctx.now();
  const { item, created } = addDeskItem(db, { projectId: ask.projectId, kind: 'review', ref: String(ask.id), nodeId: ask.nodeId, state: 'waiting_aiden' }, now);
  if (!created) return false;
  const eventId = bringItem(ctx, item, { id: null, kind: null, answer: null }, { tell: false, decision: { kind: 'technical', productRuling: false } });
  if (eventId !== undefined) moveDeskItem(db, item.id, ['waiting_aiden'], 'waiting_aiden', { outcome: `AIDEN d${eventId}`, now });
  return true;
}

/** Whether the ask has an old_ask desk item not done. */
const oldAskOpen = (db: DB, askId: number): boolean => db.prepare("SELECT 1 FROM desk_items WHERE kind = 'old_ask' AND ref = ? AND state <> 'done'").get(String(askId)) !== undefined;

/**
 * Moves every not-done desk item about one of these asks to done, with `outcome`. Their lines to the Voice not yet tried
 * move to cleared: an ask answered elsewhere (the window, its thread) is never spoken after. A line being tried is left to
 * the sender, which may have sent it already.
 */
function closeAskItems(db: DB, askIds: readonly number[], outcome: string, now: string): void {
  if (askIds.length === 0) return;
  const kinds = ASK_ITEM_KINDS.map(() => '?').join(', ');
  const refs = askIds.map(() => '?').join(', ');
  db.prepare(
    `UPDATE lead_sends SET state = 'cleared' WHERE kind = 'voice_line' AND state = 'intended' AND result IS NULL` +
      ` AND item_id IN (SELECT id FROM desk_items WHERE state <> 'done' AND kind IN (${kinds}) AND ref IN (${refs}))`,
  ).run(...ASK_ITEM_KINDS, ...askIds.map(String));
  db.prepare(
    `UPDATE desk_items SET state = 'done', done_at = ?, outcome = ? WHERE state <> 'done'` +
      ` AND kind IN (${ASK_ITEM_KINDS.map(() => '?').join(', ')}) AND ref IN (${askIds.map(() => '?').join(', ')})`,
  ).run(now, outcome, ...ASK_ITEM_KINDS, ...askIds.map(String));
}

/** While a write clears several asks (withBringDeferred), the projects whose brought items it freed: brought once, after. */
let deferred: { db: DB; projects: Set<number> } | null = null;

/**
 * Runs `fn`, a part of a write that may clear several asks (a drop or a park clears every ask on its step), with the
 * bring that each clear of a brought ask runs held back: bringNext runs once per freed project after `fn`, so it never
 * brings an ask that `fn` clears later. Nested calls run inside the outer one's deferral.
 */
export function withBringDeferred<T>(ctx: Ctx, fn: () => T): T {
  if (deferred !== null) return fn();
  const mine = { db: ctx.db, projects: new Set<number>() };
  deferred = mine;
  let result: T;
  try {
    result = fn();
  } finally {
    deferred = null;
  }
  for (const projectId of mine.projects) bringNext(ctx, projectId);
  return result;
}

/**
 * Inside the write that first clears ask `askId`: every desk item about it that is not done moves to done, with the
 * outcome `cleared by <by>`. A leased item too: the runner treats an apply on an item no longer leased as abandoned. When
 * one of them was brought to Aiden, the next waiting item of its project is brought (bringNext), at once, or after the
 * other clears under withBringDeferred.
 */
export function deskOnAskCleared(ctx: Ctx, askId: number, by: string): void {
  // An item the lead brought to Aiden frees its place when its ask clears: the next waiting one is brought in this write.
  const freed = broughtProjectsOfAsk(ctx.db, askId);
  closeAskItems(ctx.db, [askId], `cleared by ${by}`, ctx.now());
  for (const projectId of freed) {
    if (deferred !== null && deferred.db === ctx.db) deferred.projects.add(projectId);
    else bringNext(ctx, projectId);
  }
}

/**
 * Inside the write that deletes these steps, before the delete: their asks go by cascade, with no clear, so every desk
 * item about one of them that is not done moves to done, outcome `step deleted`. So do the stopped items on the steps
 * themselves.
 */
export function deskOnStepsDeleted(db: DB, nodeIds: readonly number[], now: string): void {
  if (nodeIds.length === 0) return;
  const askIds = db.prepare(`SELECT id FROM asks WHERE node_id IN (${nodeIds.map(() => '?').join(', ')})`).pluck().all(...nodeIds) as number[];
  closeAskItems(db, askIds, 'step deleted', now);
  db.prepare(`UPDATE desk_items SET state = 'done', done_at = ?, outcome = 'step deleted' WHERE project_id = (SELECT project_id FROM nodes WHERE id = ?) AND state <> 'done' AND kind = 'stopped' AND node_id IN (${nodeIds.map(() => '?').join(', ')})`).run(now, nodeIds[0], ...nodeIds);
}
