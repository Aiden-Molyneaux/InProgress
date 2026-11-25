import type { Ask } from '../../core/types';
import type { DB } from '../db/connection';
import { addDeskItem, type AddDeskItemInput, type DeskItem, type DeskItemKind } from './desk';
import { bringNext, broughtProjectsOfAsk } from './deskBring';
import { roundBound } from './switches';

/** How long after it is raised a session's question or permission ask is due on the desk. */
export const DESK_ASK_DUE_MS = 3 * 60 * 1000;

/** The kinds of desk item that are about an ask, and close when it clears or goes. */
export const ASK_ITEM_KINDS: readonly DeskItemKind[] = ['question', 'permission', 'old_ask', 'promise_due'];

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

/**
 * Inside the write that raised `ask`, or raised it again after its session's prompt (bumped): a session's question or
 * permission ask of Aiden's, raised since the round was first switched on and while it is on, is queued on the desk, due
 * DESK_ASK_DUE_MS after it was raised. A project that is not active makes none, as the minute watch skips it. The caller does not call it for a plain join, so a join never queues an ask
 * whose item is done.
 */
export function deskOnAskRaised(db: DB, ask: Ask, now: string): void {
  if (ask.owner !== 'aiden' || (ask.kind !== 'question' && ask.kind !== 'permission') || ask.sessionId === null) return;
  if (db.prepare('SELECT status FROM projects WHERE id = ?').pluck().get(ask.projectId) !== 'active') return;
  const bound = roundBound(db, ask.projectId);
  if (bound === null || ask.raisedAt < bound) return;
  produceDeskItem(db, { projectId: ask.projectId, kind: ask.kind, ref: String(ask.id), nodeId: ask.nodeId, dueAt: plusMs(ask.raisedAt, DESK_ASK_DUE_MS) }, now);
}

/** Moves every not-done desk item about one of these asks to done, with `outcome`. */
function closeAskItems(db: DB, askIds: readonly number[], outcome: string, now: string): void {
  if (askIds.length === 0) return;
  db.prepare(
    `UPDATE desk_items SET state = 'done', done_at = ?, outcome = ? WHERE state <> 'done'` +
      ` AND kind IN (${ASK_ITEM_KINDS.map(() => '?').join(', ')}) AND ref IN (${askIds.map(() => '?').join(', ')})`,
  ).run(now, outcome, ...ASK_ITEM_KINDS, ...askIds.map(String));
}

/**
 * Inside the write that first clears ask `askId`: every desk item about it that is not done moves to done, with the
 * outcome `cleared by <by>`. A leased item too: the runner treats an apply on an item no longer leased as abandoned. When
 * one of them was brought to Aiden, the next waiting item of its project is brought (bringNext).
 */
export function deskOnAskCleared(db: DB, askId: number, by: string, now: string): void {
  // An item the lead brought to Aiden frees its place when its ask clears: the next waiting one is brought in this write.
  const freed = broughtProjectsOfAsk(db, askId);
  closeAskItems(db, [askId], `cleared by ${by}`, now);
  for (const projectId of freed) bringNext(db, projectId, now);
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
