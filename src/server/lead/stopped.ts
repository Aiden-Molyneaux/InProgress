import { LEAD_INSTRUCTIONS_VERSION, LEAD_STARTS_PER_DAY } from '../../core/lead';
import { leadLine } from '../../core/relay';
import { stamp } from '../../core/span';
import { stepRef } from '../../core/step-ref';
import { write, type Ctx, type RecordEvent } from '../db/tx';
import { ApiError } from '../errors';
import { logLeadEvent } from '../lead';
import { ownStartsToday, startGuard, startProviderModel } from '../lead-start';
import { getDeskItem, moveDeskItem, type DeskItem } from '../repo/desk';
import { addDecision } from '../repo/leadDecisions';
import { insertLeadEvent } from '../repo/leadEvents';
import { intendSend, sendByRetryKey } from '../repo/leadSends';
import type { LeadTurn, TurnEffect } from '../repo/leadTurns';
import { parkNodeInWrite, requireNode } from '../repo/nodes';
import { getProjectById } from '../repo/projects';
import { addResourceInWrite } from '../repo/resources';
import { reserveAllowsStart, type ReserveAnswer } from './reserve';
import type { StartBody } from './sends';

/*
 * Stopped sessions (lead stage 1, #743, task 9). A `stopped` item is first asked in plain code, with no turn: one message to
 * the session's T3 Code thread, and thirty minutes to answer. A session that answers moves again, and the minute watch
 * closes its item as `session moved on`. One that does not, or one not in T3 Code (it cannot be asked), gets a turn that
 * answers RESTART, PARK or DONE. The lead never pauses a running session.
 */

/** How long an asked session has to answer before its item is leased for a turn. */
export const ASK_STOPPED_WAIT_MS = 30 * 60 * 1000;
/** How many restarts a step may have: past them, a restart is a park. */
export const RESTARTS_PER_STEP = 2;
/** The park cause when the step has had its restarts. */
export const CAUSE_RESTARTS = 'two restarts tried';
/** The park cause when the starts per day or the reserve refuse a restart. */
export const CAUSE_LIMIT = 'the start limit or the reserve';

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
  const at = item.ref.indexOf('@');
  const sessionId = at > 0 ? item.ref.slice(0, at) : item.ref;
  const stoppedAt = at > 0 ? item.ref.slice(at + 1) : item.createdAt;
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

/**
 * What the runner does with an open item before it leases it: 'lease' it for a turn, 'hold' it (a stopped item asked and
 * not yet past its due_at, or one whose session moved on, closed here), or 'asked' (a stopped item asked now: a relay send
 * intended, the sender carries it out). Only `stopped` items are ever held or asked. Writes in its own immediate write.
 */
export function stoppedBeforeLease(ctx: Ctx, item: DeskItem): 'lease' | 'hold' | 'asked' {
  if (item.kind !== 'stopped') return 'lease';
  const s = stoppedOf(ctx, item);
  const now = ctx.now();
  if (movedOn(s)) {
    write(ctx, 'system', () => moveDeskItem(ctx.db, item.id, ['open'], 'done', { outcome: 'session moved on', now }), { immediate: true });
    return 'hold';
  }
  if (sendByRetryKey(ctx.db, askStoppedKey(item.id)) !== undefined) return item.dueAt !== null && now < item.dueAt ? 'hold' : 'lease';
  const thread = s.row?.t3_thread_id ?? null;
  const lead = leadName(ctx, item.projectId);
  // A session not in T3 Code cannot be asked, and a step-less item has nothing to ask about: straight to the turn.
  if (thread === null || lead === undefined || item.nodeId === null) return 'lease';
  const stepId = item.nodeId;
  const asked = write(
    ctx,
    `lead:${lead}`,
    (): boolean => {
      // Read again inside the write: another runner may have asked or leased it meanwhile.
      if (getDeskItem(ctx.db, item.id)?.state !== 'open' || sendByRetryKey(ctx.db, askStoppedKey(item.id)) !== undefined) return false;
      const body = askStoppedBody(lead, stepId);
      intendSend(ctx.db, { projectId: item.projectId, itemId: item.id, kind: 'relay', target: thread, retryKey: askStoppedKey(item.id), body }, now);
      ctx.db.prepare("UPDATE desk_items SET due_at = ?, outcome = 'asked' WHERE id = ? AND state = 'open'").run(new Date(Date.parse(now) + ASK_STOPPED_WAIT_MS).toISOString(), item.id);
      insertLeadEvent(ctx.db, { projectId: item.projectId, lead, instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'asked', nodeId: stepId, sessionId: s.sessionId, text: body }, now);
      return true;
    },
    { immediate: true },
  );
  return asked ? 'asked' : 'hold';
}

/** The stopped item in plain words for its turn: the session, its branch and worktree, when it stopped, and how to answer. */
export function stoppedTurnLines(ctx: Ctx, item: DeskItem): string[] {
  const s = stoppedOf(ctx, item);
  const step = item.nodeId === null ? 'its step' : `step #${item.nodeId}`;
  const lines = [
    `The session ${s.sessionId} stopped on ${step} at ${stamp(s.stoppedAt)} and has not moved since.`,
    `Its branch: ${s.row?.branch ?? '(not on record)'}. Its worktree: ${s.row?.cwd ?? '(not on record)'}.`,
  ];
  const ask = sendByRetryKey(ctx.db, askStoppedKey(item.id));
  if (ask !== undefined) lines.push(`It was asked at ${stamp(ask.createdAt)} where the work stands, and did not answer.`);
  else lines.push('It does not run in T3 Code, so it could not be asked.');
  if (s.row?.t3_thread_id) lines.push(`Its T3 Code thread: ${s.row.t3_thread_id} (read it with thread).`);
  lines.push(
    'Read its thread, the step and its branch (branch_merged, change_size, branch_exists), then answer DECIDE with KIND: TECHNICAL and ANSWER one of:',
    'RESTART: then the handoff for a fresh session in the same worktree and branch: the goal, where things are, what was done, and the next step.',
    'PARK: then the cause, when the work cannot go on as it is.',
    'DONE: then what was merged, when the work is finished.',
    `A step is restarted at most ${RESTARTS_PER_STEP} times, and a restart counts against your starts per day.`,
  );
  return lines;
}

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
    // A step already done or dropped keeps its state: the PARK is its line and decision only.
    if (node.status !== 'done' && node.status !== 'dropped') parkNodeInWrite(ctx, record, `lead:${name}`, node.id, { reason: cause });
    const eventId = logLeadEvent(ctx, { ...base, kind: 'park', text: cause });
    addDecision(ctx.db, { eventId, itemId: item.id, turnId: turn.id, kind: 'technical', line: `Parked ${stepRef(node.id, node.title)}: ${cause}`, saidWhere: 'desk', saidAt: now });
    return { itemState: 'done', outcome: `PARK d${eventId}` };
  };

  if (word === 'DONE') {
    insertLeadEvent(ctx.db, { ...base, kind: 'done_noted', text }, now);
    return { itemState: 'done', outcome: 'DONE' };
  }
  if (word === 'PARK') return park(text);

  const restarts = ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE project_id = ? AND kind = 'restart' AND node_id = ?").pluck().get(item.projectId, node.id) as number;
  if (restarts >= RESTARTS_PER_STEP) return park(CAUSE_RESTARTS);
  const reserve = (deps.reserveAllowsStart ?? reserveAllowsStart)(ctx, now);
  if (ownStartsToday(ctx, item.projectId, Date.parse(now)) >= LEAD_STARTS_PER_DAY || !reserve.ok) return park(CAUSE_LIMIT);
  // A restart is the lead's own start: every refusal `lead start` has (Starts off, the in-flight limit, a parked or done
  // step, a live session on it) refuses it too, leaving out only the stopped session itself.
  const project = getProjectById(ctx, item.projectId);
  if (project === undefined) return { itemState: 'done', outcome: 'no lead' };
  let folder: string;
  try {
    folder = startGuard(ctx, project, node, { exceptSession: s.sessionId }).folder;
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
  const body: StartBody = {
    message: handoff,
    title: `#${node.id} ${node.title} (restart)`,
    ...startProviderModel(),
    ...(worktree === null ? {} : { worktree }),
    ...(branch === null ? {} : { branch }),
    nodeId: node.id,
  };
  const send = intendSend(ctx.db, { projectId: item.projectId, itemId: item.id, kind: 'start', target: folder, retryKey: `restart:${item.id}`, body: JSON.stringify(body) }, now);
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
