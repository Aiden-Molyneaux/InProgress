import { AIDEN_BROUGHT_LIMIT, LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { leadLine } from '../../core/relay';
import { clipLine } from '../../core/step-ref';
import { askTag, type Ask } from '../../core/types';
import type { DB } from '../db/connection';
import type { Ctx } from '../db/tx';
import { requireAsk } from './asks';
import { getDeskItem, moveDeskItem, type DeskItem } from './desk';
import { addDecision, type DecisionKind } from './leadDecisions';
import { insertLeadEvent } from './leadEvents';
import { intendSend, sendByRetryKey } from './leadSends';
import { getProjectById } from './projects';
import { shelvedAmong } from './shelved';
import { roundSince } from './switches';
import { intendBringLine, intendReviewLine } from '../lead/voice';
import { PICTURE_FILE } from '../../core/pictures';

/** How much of an ask's text, and of an answer, a decision's line keeps. */
export const DECISION_LINE_CUT = 80;

/** SQL for "desk item `d` was brought": it has a decisions row whose event is a `bring`. */
const BROUGHT_SQL = `EXISTS (SELECT 1 FROM lead_decisions ld JOIN lead_events e ON e.id = ld.event_id WHERE ld.item_id = d.id AND e.kind = 'bring')`;

/** The items among these whose step is shelved (parked, or under a parked step), as the brief hides their asks. */
function onShelvedSteps(ctx: Ctx, rows: readonly { id: number; nodeId: number | null }[]): Set<number> {
  const shelved = shelvedAmong(ctx, [...new Set(rows.flatMap((r) => (r.nodeId === null ? [] : [r.nodeId])))]);
  return new Set(rows.filter((r) => r.nodeId !== null && shelved.has(r.nodeId)).map((r) => r.id));
}

/** Items the lead brought to Aiden that still wait on him, in the project, old asks and items on shelved steps left out. */
export function broughtOpen(ctx: Ctx, projectId: number): number {
  const rows = ctx.db
    .prepare(`SELECT d.id, d.node_id AS nodeId FROM desk_items d WHERE d.project_id = ? AND d.state = 'waiting_aiden' AND d.kind <> 'old_ask' AND ${BROUGHT_SQL}`)
    .all(projectId) as { id: number; nodeId: number | null }[];
  return rows.length - onShelvedSteps(ctx, rows).size;
}

/** The projects of the items about ask `askId` that were brought and still wait: a clear of it frees a place. */
export function broughtProjectsOfAsk(db: DB, askId: number): number[] {
  return db
    .prepare(`SELECT DISTINCT d.project_id FROM desk_items d WHERE d.state = 'waiting_aiden' AND d.kind IN ('question', 'permission', 'review') AND d.ref = ? AND ${BROUGHT_SQL}`)
    .pluck()
    .all(String(askId)) as number[];
}

/** The T3 Code thread of the session, when it runs in T3 Code and its thread is known; else null (it reads on its next prompt). */
export function t3ThreadOf(db: DB, sessionId: string | null): string | null {
  if (sessionId === null) return null;
  const row = db.prepare('SELECT app, t3_thread_id FROM sessions WHERE id = ?').get(sessionId) as { app: string; t3_thread_id: string | null } | undefined;
  return row !== undefined && row.app === 't3' && row.t3_thread_id ? row.t3_thread_id : null;
}

/** How recently a T3 Code session must have been seen for a relay of Aiden's words to reach its thread. */
export const REACHABLE_MS = 48 * 60 * 60 * 1000;

/**
 * The T3 Code thread a relay of Aiden's words, or of a withdrawal, may go to; else null. A thread is reachable when its
 * session (for a thread id, any session on that thread) was last seen within REACHABLE_MS of `now`, whatever its state:
 * one marked ended after a quiet night still gets his morning answer, and an old ask's weeks-old session is never woken
 * on a stale step. Not reachable, the caller does what it does with no thread: the answer waits for the next prompt, or
 * the step's log says it.
 */
export function reachableThread(db: DB, ref: { sessionId: string | null } | { threadId: string | null | undefined }, now: string): string | null {
  const since = new Date(Date.parse(now) - REACHABLE_MS).toISOString();
  if ('sessionId' in ref) {
    const thread = t3ThreadOf(db, ref.sessionId);
    if (thread === null) return null;
    const seen = db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').pluck().get(ref.sessionId) as string | null | undefined;
    return seen !== null && seen !== undefined && seen >= since ? thread : null;
  }
  if (ref.threadId === null || ref.threadId === undefined || ref.threadId === '') return null;
  const seen = db.prepare("SELECT 1 FROM sessions WHERE app = 't3' AND t3_thread_id = ? AND last_seen_at >= ? LIMIT 1").get(ref.threadId, since) !== undefined;
  return seen ? ref.threadId : null;
}

/** The newest T3 session focused on the step, whatever its state: gate it with reachableThread({ sessionId }), so a thread reused by another session never passes on that one's sighting. */
export function t3SessionOnStep(ctx: Ctx, nodeId: number): string | null {
  const id = ctx.db
    .prepare("SELECT id FROM sessions WHERE focus_node_id = ? AND app = 't3' AND t3_thread_id IS NOT NULL AND t3_thread_id <> '' ORDER BY last_seen_at DESC LIMIT 1")
    .pluck()
    .get(nodeId) as string | undefined;
  return id ?? null;
}

/** The desk item kinds whose ref is an ask id: an old ask's and a review's too, so a reply to its Voice line finds its ask. */
const ASK_KINDS: ReadonlySet<string> = new Set(['question', 'permission', 'old_ask', 'review']);

/** The ask a question, permission, old_ask or review item is about, read in this write; undefined when it is gone (its project deleted, or the row). */
export function askOf(ctx: Ctx, item: DeskItem): Ask | undefined {
  // Only a question, permission, old_ask or review item's ref is an ask id: an unknown_send's is a send id, a stopped item's a session.
  if (!ASK_KINDS.has(item.kind)) return undefined;
  if (!/^\d+$/.test(item.ref)) return undefined;
  const id = Number(item.ref);
  if (ctx.db.prepare('SELECT 1 FROM asks WHERE id = ?').get(id) === undefined) return undefined;
  try {
    return requireAsk(ctx, id);
  } catch {
    // requireAsk refuses an ask of a deleted project: for the desk that is an ask gone, an ordinary outcome.
    return undefined;
  }
}

/** The words a session is told for the turn's AIDEN kind. */
const AIDEN_KIND_WORDS: Record<string, string> = { TASTE: 'taste', DIRECTION: 'direction', 'CANNOT-BE-TAKEN-BACK': 'cannot be taken back' };

/**
 * Tells the ask's session, when it runs in T3 Code, that the ask is Aiden's: one send per ask (retry key `aiden:a<ask id>`),
 * made when the lead says AIDEN, whether the item is brought at once or waits past the limit. Inside the caller's write.
 */
export function tellAidens(db: DB, input: { projectId: number; itemId: number; lead: string; ask: Pick<Ask, 'id' | 'sessionId'>; kind: string | null }, now: string): void {
  // Only a reachable thread is told (reachableThread); any other session has nothing sent.
  const thread = reachableThread(db, { sessionId: input.ask.sessionId }, now);
  const retryKey = `aiden:${askTag(input.ask.id)}`;
  // Told once per ask: a later item about the same ask (raised anew after its session's prompt) sends nothing more.
  if (thread === null || sendByRetryKey(db, retryKey) !== undefined) return;
  const words = AIDEN_KIND_WORDS[input.kind ?? ''] ?? (input.kind ?? '').toLowerCase();
  intendSend(
    db,
    {
      projectId: input.projectId,
      itemId: input.itemId,
      kind: 'relay',
      target: thread,
      retryKey,
      body: leadLine(input.lead, `${askTag(input.ask.id)} is Aiden's to answer (${words}). Carry on with what does not depend on it, or stop.`),
    },
    now,
  );
}

/** What bringing needs of the turn that said AIDEN. */
export interface BringTurn {
  /** The turn, or null for an item brought with no turn (a question raised again by an undo). */
  id: number | null;
  /** TASTE, DIRECTION or CANNOT-BE-TAKEN-BACK. */
  kind: string | null;
  /** The would-have: what the lead would choose. */
  answer: string | null;
}

export interface BringOptions {
  /** Tell the session it is Aiden's (tellAidens). Only the AIDEN verdict brings with it: a later bring sends nothing more. */
  tell: boolean;
  /** The decision's kind and ruling when no turn's kind gives them (an undone decision keeps its own). */
  decision?: { kind: DecisionKind; productRuling: boolean };
}

/**
 * Brings the item to Aiden, inside the caller's write: the would-have first, as a `bring` line in the lead's log (text: the
 * turn's answer) and its decisions row (kind product for TASTE or DIRECTION, permission for a permission item, else
 * technical, unless `opts.decision` names them); then, with `opts.tell`, the session told; then its line to the Voice. The item's state is the
 * caller's. Answers the bring's id, or undefined (nothing written) when the item's ask is gone or cleared, or the project
 * has no lead.
 */
export function bringItem(ctx: Ctx, item: DeskItem, turn: BringTurn, opts: BringOptions): number | undefined {
  const project = getProjectById(ctx, item.projectId);
  const lead = project?.lead;
  if (lead === null || lead === undefined || lead.trim() === '') return undefined;
  const ask = askOf(ctx, item);
  if (ask === undefined || ask.clearedAt !== null) return undefined;
  const now = ctx.now();
  const wouldHave = turn.answer ?? '';
  const eventId = insertLeadEvent(ctx.db, { projectId: item.projectId, lead, instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'bring', askId: ask.id, nodeId: ask.nodeId, text: wouldHave }, now);
  const product = turn.kind === 'TASTE' || turn.kind === 'DIRECTION';
  const decision = opts.decision ?? { kind: item.kind === 'permission' ? 'permission' : product ? 'product' : 'technical', productRuling: product };
  addDecision(ctx.db, {
    eventId,
    itemId: item.id,
    turnId: turn.id,
    kind: decision.kind,
    productRuling: decision.productRuling,
    line: clipLine(ask.text, DECISION_LINE_CUT),
    wouldHave,
    saidWhere: null,
    saidAt: now,
  });
  if (opts.tell) tellAidens(ctx.db, { projectId: item.projectId, itemId: item.id, lead, ask, kind: turn.kind }, now);
  // Every bring reaches the Voice as one line (task 11), gathered with the project's others by the sender.
  const stepTitle = ctx.db.prepare('SELECT title FROM nodes WHERE id = ?').pluck().get(ask.nodeId) as string | undefined;
  if (item.kind === 'review') {
    // A review's line names its newest picture, when the step has one, so he can say "show me".
    const picture = (ctx.db.prepare('SELECT id, path FROM resources WHERE node_id = ? AND path IS NOT NULL ORDER BY id DESC').all(ask.nodeId) as { id: number; path: string }[]).find((r) =>
      PICTURE_FILE.test(r.path),
    );
    intendReviewLine(
      ctx.db,
      { projectId: item.projectId, itemId: item.id, eventId, projectName: project!.name, stepId: ask.nodeId, stepTitle: stepTitle ?? null, askText: ask.text, pictureId: picture?.id ?? null },
      now,
    );
    return eventId;
  }
  intendBringLine(
    ctx.db,
    { projectId: item.projectId, itemId: item.id, eventId, projectName: project!.name, stepId: ask.nodeId, stepTitle: stepTitle ?? null, askText: ask.text, wouldHave },
    now,
  );
  return eventId;
}

/**
 * Brings waiting items to Aiden while the project has fewer than AIDEN_BROUGHT_LIMIT brought and open, inside the caller's
 * write: permission items first, then questions whose session is idle, then the rest, oldest first within each. Items on
 * shelved steps wait, and do not count. Each keeps its AIDEN turn's answer as the would-have, and its outcome becomes
 * `AIDEN d<id>`. Its session was told when the lead said AIDEN, so nothing is sent. Nothing while the project's round is
 * off. Answers the bring ids.
 */
export function bringNext(ctx: Ctx, projectId: number): number[] {
  const db = ctx.db;
  if (roundSince(db, projectId) === null) return [];
  let room = AIDEN_BROUGHT_LIMIT - broughtOpen(ctx, projectId);
  if (room <= 0) return [];
  const rows = db
    .prepare(
      `SELECT d.id, d.node_id AS nodeId FROM desk_items d
         LEFT JOIN asks a ON a.id = CAST(d.ref AS INTEGER) AND d.kind IN ('question', 'permission')
         LEFT JOIN sessions s ON s.id = a.session_id
        WHERE d.project_id = ? AND d.state = 'waiting_aiden' AND d.kind IN ('question', 'permission') AND NOT ${BROUGHT_SQL}
        ORDER BY CASE WHEN d.kind = 'permission' THEN 0 WHEN d.kind = 'question' AND s.state = 'idle' THEN 1 ELSE 2 END, d.created_at, d.id`,
    )
    .all(projectId) as { id: number; nodeId: number | null }[];
  const shelved = onShelvedSteps(ctx, rows);
  const brought: number[] = [];
  for (const { id: itemId } of rows) {
    if (room <= 0) break;
    if (shelved.has(itemId)) continue;
    const turn = db.prepare("SELECT id, kind, answer FROM lead_turns WHERE item_id = ? AND state = 'applied' ORDER BY id DESC LIMIT 1").get(itemId) as BringTurn | undefined;
    if (turn === undefined) continue;
    const item = getDeskItem(db, itemId)!;
    const eventId = bringItem(ctx, item, turn, { tell: false });
    if (eventId === undefined) continue;
    moveDeskItem(db, item.id, ['waiting_aiden'], 'waiting_aiden', { outcome: `AIDEN d${eventId}`, now: ctx.now() });
    brought.push(eventId);
    room--;
  }
  return brought;
}
