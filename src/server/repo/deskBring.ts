import { askTag } from '../../core/types';
import { AIDEN_BROUGHT_LIMIT, LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { clipLine } from '../../core/step-ref';
import type { DB } from '../db/connection';
import { getDeskItem, moveDeskItem, type DeskItem } from './desk';
import { addDecision, type DecisionKind } from './leadDecisions';
import { insertLeadEvent } from './leadEvents';
import { intendSend } from './leadSends';
import { roundSince } from './switches';

export { AIDEN_BROUGHT_LIMIT };
/** How much of an ask's text, and of an answer, a decision's line keeps. */
export const DECISION_LINE_CUT = 80;

/** SQL for "desk item `d` was brought": it has a decisions row whose event is a `bring`. */
const BROUGHT_SQL = `EXISTS (SELECT 1 FROM lead_decisions ld JOIN lead_events e ON e.id = ld.event_id WHERE ld.item_id = d.id AND e.kind = 'bring')`;

/** Items the lead brought to Aiden that still wait on him, in the project, old asks left out. */
export function broughtOpen(db: DB, projectId: number): number {
  return db
    .prepare(`SELECT COUNT(*) FROM desk_items d WHERE d.project_id = ? AND d.state = 'waiting_aiden' AND d.kind <> 'old_ask' AND ${BROUGHT_SQL}`)
    .pluck()
    .get(projectId) as number;
}

/** The projects of the items about ask `askId` that were brought and still wait: a clear of it frees a place. */
export function broughtProjectsOfAsk(db: DB, askId: number): number[] {
  return db
    .prepare(`SELECT DISTINCT d.project_id FROM desk_items d WHERE d.state = 'waiting_aiden' AND d.kind IN ('question', 'permission') AND d.ref = ? AND ${BROUGHT_SQL}`)
    .pluck()
    .all(String(askId)) as number[];
}

/** The T3 Code thread of the session, when it runs in T3 Code and its thread is known; else null (it reads on its next prompt). */
export function t3ThreadOf(db: DB, sessionId: string | null): string | null {
  if (sessionId === null) return null;
  const row = db.prepare('SELECT app, t3_thread_id FROM sessions WHERE id = ?').get(sessionId) as { app: string; t3_thread_id: string | null } | undefined;
  return row !== undefined && row.app === 't3' && row.t3_thread_id ? row.t3_thread_id : null;
}

/** The words a session is told for the turn's AIDEN kind. */
const AIDEN_KIND_WORDS: Record<string, string> = { TASTE: 'taste', DIRECTION: 'direction', 'CANNOT-BE-TAKEN-BACK': 'cannot be taken back' };

/** What bringing needs of the turn that said AIDEN. */
export interface BringTurn {
  id: number;
  /** TASTE, DIRECTION or CANNOT-BE-TAKEN-BACK. */
  kind: string | null;
  /** The would-have: what the lead would choose. */
  answer: string | null;
}

/**
 * Brings the item to Aiden, inside the caller's write: the would-have first, as a `bring` line in the lead's log (text: the
 * turn's answer) and its decisions row (kind product for TASTE or DIRECTION, permission for a permission item, else
 * technical); then the session told, when it runs in T3 Code. The item's state is the caller's. Answers the bring's id, or
 * undefined (nothing written) when the item's ask is gone or cleared, or the project has no lead.
 */
export function bringItem(db: DB, item: DeskItem, turn: BringTurn, now: string): number | undefined {
  const lead = db.prepare('SELECT lead FROM projects WHERE id = ?').pluck().get(item.projectId) as string | null | undefined;
  if (lead === null || lead === undefined || lead.trim() === '') return undefined;
  const ask = db.prepare('SELECT id, node_id, text, session_id, cleared_at FROM asks WHERE CAST(id AS TEXT) = ?').get(item.ref) as
    | { id: number; node_id: number; text: string; session_id: string | null; cleared_at: string | null }
    | undefined;
  if (ask === undefined || ask.cleared_at !== null) return undefined;
  const wouldHave = turn.answer ?? '';
  const eventId = insertLeadEvent(db, { projectId: item.projectId, lead, instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'bring', askId: ask.id, nodeId: ask.node_id, text: wouldHave }, now);
  const product = turn.kind === 'TASTE' || turn.kind === 'DIRECTION';
  const kind: DecisionKind = item.kind === 'permission' ? 'permission' : product ? 'product' : 'technical';
  addDecision(db, { eventId, itemId: item.id, turnId: turn.id, kind, productRuling: product, line: clipLine(ask.text, DECISION_LINE_CUT), wouldHave, saidWhere: null, saidAt: now });
  const thread = t3ThreadOf(db, ask.session_id);
  if (thread !== null) {
    const words = AIDEN_KIND_WORDS[turn.kind ?? ''] ?? (turn.kind ?? '').toLowerCase();
    intendSend(
      db,
      {
        projectId: item.projectId,
        itemId: item.id,
        kind: 'relay',
        target: thread,
        retryKey: `aiden:d${eventId}`,
        body: `[From ${lead}, the lead] ${askTag(ask.id)} is Aiden's to answer (${words}). Carry on with what does not depend on it, or stop.`,
      },
      now,
    );
  }
  return eventId;
}

/**
 * Brings waiting items to Aiden while the project has fewer than AIDEN_BROUGHT_LIMIT brought and open, inside the caller's
 * write: permission items first, then questions whose session is idle, then the rest, oldest first within each. Each keeps
 * its AIDEN turn's answer as the would-have, and its outcome becomes `AIDEN d<id>`. Nothing while the project's round is
 * off. Answers the bring ids.
 */
export function bringNext(db: DB, projectId: number, now: string): number[] {
  if (roundSince(db, projectId) === null) return [];
  let room = AIDEN_BROUGHT_LIMIT - broughtOpen(db, projectId);
  if (room <= 0) return [];
  const waiting = db
    .prepare(
      `SELECT d.id FROM desk_items d
         LEFT JOIN asks a ON CAST(a.id AS TEXT) = d.ref AND d.kind IN ('question', 'permission')
         LEFT JOIN sessions s ON s.id = a.session_id
        WHERE d.project_id = ? AND d.state = 'waiting_aiden' AND d.kind <> 'old_ask' AND NOT ${BROUGHT_SQL}
        ORDER BY CASE WHEN d.kind = 'permission' THEN 0 WHEN d.kind = 'question' AND s.state = 'idle' THEN 1 ELSE 2 END, d.created_at, d.id`,
    )
    .pluck()
    .all(projectId) as number[];
  const brought: number[] = [];
  for (const itemId of waiting) {
    if (room <= 0) break;
    const turn = db.prepare("SELECT id, kind, answer FROM lead_turns WHERE item_id = ? AND state = 'applied' ORDER BY id DESC LIMIT 1").get(itemId) as BringTurn | undefined;
    if (turn === undefined) continue;
    const item = getDeskItem(db, itemId)!;
    const eventId = bringItem(db, item, turn, now);
    if (eventId === undefined) continue;
    moveDeskItem(db, item.id, ['waiting_aiden'], 'waiting_aiden', { outcome: `AIDEN d${eventId}`, now });
    brought.push(eventId);
    room--;
  }
  return brought;
}
