import { LEAD_INSTRUCTIONS_VERSION, LEAD_STARTS_PER_DAY } from '../../core/lead';
import { leadLine } from '../../core/relay';
import { stamp } from '../../core/span';
import { stepRef } from '../../core/step-ref';
import { write, type Ctx, type RecordEvent } from '../db/tx';
import { ApiError } from '../errors';
import { logLeadEvent } from '../lead';
import { buildStartBody, ownStartsToday, startGuard } from '../lead-start';
import { moveDeskItem, type DeskItem } from '../repo/desk';
import { addDecision } from '../repo/leadDecisions';
import { insertLeadEvent } from '../repo/leadEvents';
import { intendSend, moveSend, sendByRetryKey, type LeadSend } from '../repo/leadSends';
import type { LeadTurn, TurnEffect } from '../repo/leadTurns';
import { parkNodeInWrite, requireNode } from '../repo/nodes';
import { getProjectById } from '../repo/projects';
import { addResourceInWrite } from '../repo/resources';
import { reserveAllowsStart, type ReserveAnswer } from './reserve';

/*
 * Stopped sessions (lead stage 1, #743, task 9). A `stopped` item is first asked in plain code by the minute watch, with no
 * turn: one message to the session's T3 Code thread, and thirty minutes from its delivery to answer. A session is asked once
 * per step, ever. A session that answers moves again, and its item closes as `session moved on`. One that does not, or one
 * not in T3 Code (it cannot be asked, and gets the same thirty minutes from its stop), gets a turn that answers RESTART,
 * PARK or DONE. The lead never pauses a running session.
 */

/** How long an asked session has to answer before its item is leased for a turn. */
export const ASK_STOPPED_WAIT_MS = 30 * 60 * 1000;
/** How many restarts a step may have: past them, a restart is a park. */
export const RESTARTS_PER_STEP = 2;
/** The park cause when the step has had its restarts. */
export const CAUSE_RESTARTS = 'two restarts tried';
/** The park cause when the starts per day or the reserve refuse a restart (the reserve's why follows it). */
export const CAUSE_LIMIT = 'the start limit or the reserve';
/** What a restart that waits for a fresh usage reading is called, in the item's outcome while it is held. */
export const RESTART_WAITS = 'waits: a restart waits for a fresh usage reading';

/** A stopped item's ref: `<session id>@<last_seen_at>`, the session and the moment it stopped. desk.ts's SQL reads it too. */
export const stoppedRef = (sessionId: string, lastSeenAt: string): string => `${sessionId}@${lastSeenAt}`;

/** A stopped item's ref read back: its session, and when it stopped (undefined for a ref with no `@`). */
export function parseStoppedRef(ref: string): { sessionId: string; stoppedAt: string | undefined } {
  const at = ref.indexOf('@');
  return at > 0 ? { sessionId: ref.slice(0, at), stoppedAt: ref.slice(at + 1) } : { sessionId: ref, stoppedAt: undefined };
}

/** The retry key of a stopped item's ask: one ask per item, ever. */
export const askStoppedKey = (itemId: number): string => `ask-stopped:${itemId}`;

/** What the session is asked, in the lead's name. */
export const askStoppedBody = (lead: string, stepId: number): string => leadLine(lead, `Where does the work on #${stepId} stand? Reply in one line, then carry on.`);

interface SessionRow {
  cwd: string | null;
  branch: string | null;
  t3_thread_id: string | null;
  last_seen_at: string;
}

/** A stopped item's session: its id and when it stopped (from the ref `<session id>@<last_seen_at>`), and its row if any. */
function stoppedOf(ctx: Ctx, item: DeskItem): { sessionId: string; stoppedAt: string; row: SessionRow | undefined } {
  const parsed = parseStoppedRef(item.ref);
  const sessionId = parsed.sessionId;
  const stoppedAt = parsed.stoppedAt ?? item.createdAt;
  const row = ctx.db.prepare('SELECT cwd, branch, t3_thread_id, last_seen_at FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  return { sessionId, stoppedAt, row };
}

/** Whether the session has moved since it stopped (a prompt, a hook): then its stop is over. */
const movedOn = (s: { stoppedAt: string; row: SessionRow | undefined }): boolean => s.row !== undefined && s.row.last_seen_at > s.stoppedAt;

/** The lead's name, or undefined when the project has none. */
function leadName(ctx: Ctx, projectId: number): string | undefined {
  const lead = getProjectById(ctx, projectId)?.lead;
  return lead === null || lead === undefined || lead.trim() === '' ? undefined : lead;
}

/** The item's ask, the relay send under its retry key, or undefined when it was never asked. */
const askOf = (ctx: Ctx, itemId: number): LeadSend | undefined => sendByRetryKey(ctx.db, askStoppedKey(itemId));

/**
 * Closes a stopped item inside the caller's write, and clears its ask when that is still intended: a session that moved on,
 * or an item the lead settled, is not asked after the fact.
 */
export function closeStoppedInWrite(ctx: Ctx, itemId: number, outcome: string): boolean {
  const closed = moveDeskItem(ctx.db, itemId, ['open'], 'done', { outcome, now: ctx.now() });
  clearAskInWrite(ctx, itemId);
  return closed;
}

/** Clears the item's ask while it is still intended. */
export function clearAskInWrite(ctx: Ctx, itemId: number): void {
  const ask = askOf(ctx, itemId);
  if (ask !== undefined) moveSend(ctx.db, ask.id, ['intended'], 'cleared', { now: ctx.now() });
}

/** Whether the item's session can be asked: it runs in T3 Code, the project has a lead, and the item has a step. */
function askable(ctx: Ctx, item: DeskItem, s: { row: SessionRow | undefined }): boolean {
  return (s.row?.t3_thread_id ?? null) !== null && leadName(ctx, item.projectId) !== undefined && item.nodeId !== null;
}

/**
 * The minute watch's ask (plain code, inside its write): an open stopped item whose session can be asked and was not is
 * asked once, a relay send intended under the item's retry key and an `asked` line in the lead's log. Answers whether it
 * asked; the sender carries the ask out after the commit.
 */
export function askStoppedInWrite(ctx: Ctx, item: DeskItem): boolean {
  if (item.kind !== 'stopped' || item.state !== 'open' || item.nodeId === null) return false;
  if (askOf(ctx, item.id) !== undefined) return false;
  const s = stoppedOf(ctx, item);
  if (movedOn(s) || !askable(ctx, item, s)) return false;
  const lead = leadName(ctx, item.projectId) as string;
  const now = ctx.now();
  const body = askStoppedBody(lead, item.nodeId);
  intendSend(ctx.db, { projectId: item.projectId, itemId: item.id, kind: 'relay', target: s.row!.t3_thread_id!, retryKey: askStoppedKey(item.id), body }, now);
  ctx.db.prepare("UPDATE desk_items SET due_at = ?, outcome = 'asked' WHERE id = ? AND state = 'open'").run(new Date(Date.parse(now) + ASK_STOPPED_WAIT_MS).toISOString(), item.id);
  insertLeadEvent(ctx.db, { projectId: item.projectId, lead, instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'asked', nodeId: item.nodeId, sessionId: s.sessionId, text: body }, now);
  return true;
}

/**
 * Whether the runner holds the item back from a lease now: the runner's holdBack, in the server and in tests alike. Only a
 * stopped item is ever held. Its session moved on: closed here (its own immediate write), and held. Asked: held while the ask
 * is not delivered, then thirty minutes from its delivery (an ask that could not be delivered: from when it was written).
 * Not asked: held while the watch can still ask it; one that cannot be asked waits thirty minutes from its stop.
 */
export function stoppedHoldBack(ctx: Ctx, item: DeskItem, reserveNow: (ctx: Ctx, now: string) => ReserveAnswer = reserveAllowsStart): boolean {
  if (item.kind !== 'stopped') return false;
  const s = stoppedOf(ctx, item);
  if (movedOn(s)) {
    write(ctx, 'system', () => closeStoppedInWrite(ctx, item.id, 'session moved on'), { immediate: true });
    return true;
  }
  const nowMs = Date.parse(ctx.now());
  // A restart that waits for a fresh usage reading is held, with the why on the item, until the reading is fresh.
  const lastAnswer = ctx.db.prepare("SELECT answer FROM lead_turns WHERE item_id = ? AND state = 'applied' ORDER BY id DESC LIMIT 1").pluck().get(item.id) as string | null | undefined;
  if (lastAnswer !== undefined && lastAnswer !== null && /^RESTART:/.test(lastAnswer.trim())) {
    const reserve = reserveNow(ctx, ctx.now());
    if (!reserve.ok && reserve.wait === true) {
      // The why is written in a write, and only when it changed: a fill looks often, and the why rarely moves.
      const why = `${RESTART_WAITS} (${reserve.why})`;
      if (item.outcome !== why) write(ctx, 'system', () => ctx.db.prepare("UPDATE desk_items SET outcome = ? WHERE id = ? AND state = 'open'").run(why, item.id), { immediate: true });
      return true;
    }
  }
  const ask = askOf(ctx, item.id);
  if (ask === undefined) return askable(ctx, item, s) || nowMs < Date.parse(s.stoppedAt) + ASK_STOPPED_WAIT_MS;
  if (ask.state === 'intended') return true;
  const from = ask.state === 'done' ? (ask.doneAt ?? ask.createdAt) : ask.createdAt;
  return nowMs < Date.parse(from) + ASK_STOPPED_WAIT_MS;
}

/** The stopped item in plain words for its turn: the session, its branch and worktree, when it stopped, and how to answer. */
export function stoppedTurnLines(ctx: Ctx, item: DeskItem): string[] {
  const s = stoppedOf(ctx, item);
  const step = item.nodeId === null ? 'its step' : `step #${item.nodeId}`;
  const lines = [
    `The session ${s.sessionId} stopped on ${step} at ${stamp(s.stoppedAt)} and has not moved since.`,
    `Its branch: ${s.row?.branch ?? '(not on record)'}. Its worktree: ${s.row?.cwd ?? '(not on record)'}.`,
  ];
  const ask = askOf(ctx, item.id);
  if (ask?.state === 'done') lines.push(`It was asked where the work stands; the ask was delivered at ${stamp(ask.doneAt ?? ask.createdAt)}, and it did not answer.`);
  else if (ask !== undefined) lines.push(`It was to be asked at ${stamp(ask.createdAt)} where the work stands, but the ask was not delivered.`);
  else if (s.row?.t3_thread_id) lines.push('It was not asked where the work stands.');
  else lines.push('It does not run in T3 Code, so it could not be asked.');
  if (s.row?.t3_thread_id) lines.push(`Its T3 Code thread: ${s.row.t3_thread_id} (read it with thread).`);
  lines.push(
    'Read its thread, the step and its branch (branch_merged, change_size, branch_exists), then answer DECIDE with KIND: TECHNICAL and ANSWER one of:',
    'RESTART: then the handoff for a fresh session in the same worktree and branch: the goal, where things are, what was done, and the next step.',
    'PARK: then the cause, when the work cannot go on as it is.',
    'DONE: then what was merged, when the work is finished.',
  );
  // A limit already past is said as what it means now, not as a limit.
  const restarts = item.nodeId === null ? 0 : restartsOf(ctx, item.projectId, item.nodeId);
  const own = ownStartsToday(ctx, item.projectId, Date.parse(ctx.now()));
  if (restarts >= RESTARTS_PER_STEP) lines.push(`This step has had its ${RESTARTS_PER_STEP} restarts: a RESTART now is a PARK.`);
  else if (own >= LEAD_STARTS_PER_DAY) lines.push('Your starts for the last 24 hours are used up: a RESTART now is a PARK.');
  else lines.push(`A step is restarted at most ${RESTARTS_PER_STEP} times (this one ${restarts === 0 ? 'has not been' : `has been ${restarts === 1 ? 'once' : `${restarts} times`}`}), and a restart counts against your starts per day.`);
  return lines;
}

/** How many times the step has been restarted. */
const restartsOf = (ctx: Ctx, projectId: number, nodeId: number): number =>
  ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE project_id = ? AND kind = 'restart' AND node_id = ?").pluck().get(projectId, nodeId) as number;

/** What applyStopped reads outside the database: the reserve, reserveAllowsStart unless a test gives its own. */
export interface StoppedDeps {
  reserveAllowsStart?: (ctx: Ctx, now: string) => ReserveAnswer;
}

/**
 * A verdict on a `stopped` item, inside the runner's write. DECIDE with ANSWER `RESTART: <handoff>`: when the step has had
 * fewer than RESTARTS_PER_STEP restarts, the project's own starts in 24 hours are under LEAD_STARTS_PER_DAY and the reserve
 * allows it, a handoff resource on the step, a start send for a fresh session in the same worktree and branch with the
 * handoff as its first message, a `restart` line and its decision; otherwise a PARK with the cause. `PARK: <cause>`: the
 * step parked as `lead park` parks it, with a technical decision. `DONE: <what was merged>`: the step is left, a
 * `done_noted` line for the morning list. Any other ANSWER is `unclear` and Aiden's; so is AIDEN. A session that moved
 * on meanwhile is left alone.
 */
export function applyStopped(ctx: Ctx, turn: LeadTurn, item: DeskItem, record: RecordEvent, name: string, deps: StoppedDeps = {}): TurnEffect {
  const effect = verdictOnStopped(ctx, turn, item, record, name, deps);
  // The item closes with this turn: an ask still intended is not sent after the fact.
  if (effect.itemState === 'done') clearAskInWrite(ctx, item.id);
  return effect;
}

function verdictOnStopped(ctx: Ctx, turn: LeadTurn, item: DeskItem, record: RecordEvent, name: string, deps: StoppedDeps): TurnEffect {
  const s = stoppedOf(ctx, item);
  if (movedOn(s)) return { itemState: 'done', outcome: 'session moved on' };
  const verdict = turn.verdict ?? '';
  if (verdict === 'AIDEN') return { itemState: 'waiting_aiden', outcome: 'AIDEN (not brought: a stopped session has no ask)' };
  const m = verdict === 'DECIDE' ? /^(RESTART|PARK|DONE):\s*(.*)$/s.exec((turn.answer ?? '').trim()) : null;
  if (!m || item.nodeId === null) return { itemState: 'waiting_aiden', outcome: 'unclear' };
  const word = m[1] as 'RESTART' | 'PARK' | 'DONE';
  const text = (m[2] as string).trim();
  const now = ctx.now();
  const node = requireNode(ctx, item.nodeId);
  const base = { projectId: item.projectId, lead: name, instructions: LEAD_INSTRUCTIONS_VERSION, nodeId: node.id, sessionId: s.sessionId };

  const park = (cause: string): TurnEffect => {
    // A step parked, done or dropped meanwhile is left as it is: no park, no decision, and the outcome says so.
    const status = requireNode(ctx, node.id).status;
    if (status === 'parked' || status === 'done' || status === 'dropped') return { itemState: 'done', outcome: `PARK skipped: #${node.id} is already ${status} (${cause})` };
    parkNodeInWrite(ctx, record, `lead:${name}`, node.id, { reason: cause });
    const eventId = logLeadEvent(ctx, { ...base, kind: 'park', text: cause });
    addDecision(ctx.db, { eventId, itemId: item.id, turnId: turn.id, kind: 'technical', line: `Parked ${stepRef(node.id, node.title)}: ${cause}`, saidWhere: 'desk', saidAt: now });
    return { itemState: 'done', outcome: `PARK d${eventId}` };
  };

  if (word === 'DONE') {
    insertLeadEvent(ctx.db, { ...base, kind: 'done_noted', text }, now);
    return { itemState: 'done', outcome: 'DONE' };
  }
  if (word === 'PARK') return park(text);

  const restarts = restartsOf(ctx, item.projectId, node.id);
  if (restarts >= RESTARTS_PER_STEP) return park(CAUSE_RESTARTS);
  if (ownStartsToday(ctx, item.projectId, Date.parse(now)) >= LEAD_STARTS_PER_DAY) return park(CAUSE_LIMIT);
  const reserve = (deps.reserveAllowsStart ?? reserveAllowsStart)(ctx, now);
  // No fresh reading is no low reserve: the restart waits for one (the item goes back on the desk, held with the why until
  // the reading is fresh), and only a reserve that is really low parks the step.
  if (!reserve.ok && reserve.wait === true) return { itemState: 'open', outcome: `${RESTART_WAITS} (${reserve.why})` };
  if (!reserve.ok) return park(`${CAUSE_LIMIT}: ${reserve.why}`);
  // A restart is the lead's own start: every refusal `lead start` has (Starts off, the in-flight limit, a parked or done
  // step, a live session on it) refuses it too, leaving out only the stopped session itself.
  const project = getProjectById(ctx, item.projectId);
  if (project === undefined) return { itemState: 'done', outcome: 'no lead' };
  let guard: { folder: string; goal: string; phase: string };
  try {
    guard = startGuard(ctx, project, node, { exceptSession: s.sessionId });
  } catch (err) {
    if (err instanceof ApiError) return park(err.message);
    throw err;
  }
  const branch = s.row?.branch ?? null;
  const worktree = s.row?.cwd ?? null;
  const handoff = [
    `# Handoff for ${stepRef(node.id, node.title)} (restart)`,
    '',
    text,
    '',
    `Branch: ${branch ?? '(not on record)'}`,
    `Worktree: ${worktree ?? '(not on record)'}`,
    '',
  ].join('\n');
  const resource = addResourceInWrite(ctx, record, { nodeId: node.id, kind: 'doc', title: `Handoff for #${node.id} (restart ${restarts + 1})`, content: handoff });
  // The first message is lead start's own (the claim line, who started it, not Aiden), with the handoff after it.
  const body = buildStartBody({ lead: name, projectName: project.name, node, goal: guard.goal, phase: guard.phase, restart: { text, branch, worktree } });
  const send = intendSend(ctx.db, { projectId: item.projectId, itemId: item.id, kind: 'start', target: guard.folder, retryKey: `restart:${item.id}`, body: JSON.stringify(body) }, now);
  const eventId = insertLeadEvent(ctx.db, { ...base, kind: 'restart', text: `s${send.id} from r${resource.id}: ${text}` }, now);
  addDecision(ctx.db, {
    eventId,
    itemId: item.id,
    turnId: turn.id,
    kind: 'restart',
    line: `Restarted ${stepRef(node.id, node.title)} from its handoff r${resource.id}, on ${branch ?? 'its branch'} in ${worktree ?? 'its worktree'}.`,
    saidWhere: 'desk',
    saidAt: now,
  });
  return { itemState: 'done', outcome: `RESTART d${eventId}` };
}
