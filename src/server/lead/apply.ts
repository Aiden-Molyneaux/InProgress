import { AIDEN_BROUGHT_LIMIT, LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { leadLine } from '../../core/relay';
import { askTag } from '../../core/types';
import type { Ctx, RecordEvent } from '../db/tx';
import { decideInWrite, DECIDE_QUESTION_ONLY } from '../lead-commands';
import { logLeadEvent } from '../lead';
import { clearInWrite, requireAsk } from '../repo/asks';
import type { DeskItem } from '../repo/desk';
import { askOf, bringItem, bringNext, broughtOpen, t3ThreadOf, tellAidens } from '../repo/deskBring';
import { addDecision } from '../repo/leadDecisions';
import type { LeadTurn, TurnEffect } from '../repo/leadTurns';
import { insertLeadEvent } from '../repo/leadEvents';
import { getSend, intendSend, moveSend, sendByRetryKey, setSendBody, type LeadSend } from '../repo/leadSends';
import { liveSessionUnder } from '../repo/sessions';
import { getProjectById } from '../repo/projects';
import { permissionLine, stuckRequestOf } from './hold';
import { parseStartBody, recordStartInWrite, sendMarker } from './sends';
import { applyStopped, type StoppedDeps } from './stopped';
import { applyAidenSaid } from './aidenSaid';

/**
 * What the apply reads outside the database: whether the lead's `threads` read listed a thread (the sender remembers it),
 * and for a restart the reserve (stopped.ts's default unless given).
 */
export interface ApplyDeps extends StoppedDeps {
  listed(project: string, threadId: string): boolean;
}

/** What a CARD tells the session until the landing check (task 6) answers in its place. */
export const cardAnswer = (stepId: number): string =>
  `A landing is decided by the landing check, not by the lead. Run: inprogress landing ${stepId} --action <merge|deploy|push|publish|push-public>, and follow its answer.`;

/** The turn's WHY as a sentence: a period added when it ends in none of . ! or ?. */
export const sentence = (text: string): string => {
  const t = text.trim();
  return t === '' || /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * What a verdict does, as the runner's `apply`: run inside the runner's write (immediate, under the lead's actor) and
 * applyTurn's compare-and-set, with that write's `record`, so it only writes the database and its events reach the window
 * after the commit. Every action that leaves InProgress is a lead_sends row in state intended, carried out after the commit by the
 * sender (task 8). An ordinary refusal (no lead, an ask already cleared or gone) is an outcome with the item done, never a
 * throw. Writes as `lead:<the project's lead>` under the current rules version.
 */
export function applyVerdict(ctx: Ctx, turn: LeadTurn, item: DeskItem, record: RecordEvent, deps?: ApplyDeps): TurnEffect {
  const project = getProjectById(ctx, item.projectId);
  if (project === undefined || project.lead === null || project.lead.trim() === '') return { itemState: 'done', outcome: 'no lead' };
  const name = project.lead;
  const actor = `lead:${name}`;
  const verdict = turn.verdict ?? '';
  if (item.kind === 'stuck') return applyStuck(ctx, turn, item, name);
  if (item.kind === 'unknown_send') return applyUnknownSend(ctx, turn, item, record, name, deps);
  if (item.kind === 'stopped') return applyStopped(ctx, turn, item, record, name, deps);
  if (item.kind === 'promise_due') return applyPromiseDue(ctx, turn, item, record, name);
  if (item.kind === 'aiden_said') return applyAidenSaid(ctx, turn, item, record, name);
  if (item.kind !== 'question' && item.kind !== 'permission' && item.kind !== 'old_ask') return { itemState: 'done', outcome: `${verdict} (no action in this task)` };
  const ask = askOf(ctx, item);
  if (ask === undefined || ask.clearedAt !== null) return { itemState: 'done', outcome: 'ask cleared' };
  // An old ask (task 17) the lead may decide only when it is a question, as lead decide does. Any other is Aiden's: it
  // waits on him with no bring, and lead old-asks next carries it to the Voice.
  if (item.kind === 'old_ask' && !(verdict === 'DECIDE' && ask.kind === 'question')) {
    return { itemState: 'waiting_aiden', outcome: verdict === 'DECIDE' ? `AIDEN for the Voice: ${DECIDE_QUESTION_ONLY}` : `${verdict} for the Voice` };
  }
  const answer = turn.answer ?? '';
  const why = turn.why ?? '';
  const now = ctx.now();
  /** The session's message, when it runs in T3 Code: a send intended now, made after the commit. */
  const tell = (retryKey: string, body: string): void => {
    const thread = t3ThreadOf(ctx.db, ask.sessionId);
    if (thread !== null) intendSend(ctx.db, { projectId: project.id, itemId: item.id, kind: 'relay', target: thread, retryKey, body }, now);
  };
  if (verdict === 'DECIDE') {
    const id = decideInWrite(ctx, record, {
      project,
      name,
      actor,
      instructions: LEAD_INSTRUCTIONS_VERSION,
      ask,
      answer,
      reason: why,
      decision: {
        kind: item.kind === 'permission' ? 'permission' : turn.kind === 'PRODUCT' ? 'product' : 'technical',
        productRuling: turn.kind === 'PRODUCT',
        saidWhere: 'desk',
        itemId: item.id,
        turnId: turn.id,
      },
    });
    tell(`relay:d${id}`, leadLine(name, `d${id}: ${answer}\nWhy: ${sentence(why)} Aiden can undo this with "undo d${id}".`));
    return { itemState: 'done', outcome: `DECIDE d${id}` };
  }
  if (verdict === 'AIDEN') {
    // Waiting items come first, in their order, while there is room; this one is brought only if room is left.
    bringNext(ctx, project.id);
    const room = broughtOpen(ctx, project.id) < AIDEN_BROUGHT_LIMIT;
    const id = room ? bringItem(ctx, item, { id: turn.id, kind: turn.kind, answer: turn.answer }, { tell: true }) : undefined;
    if (id !== undefined) return { itemState: 'waiting_aiden', outcome: `AIDEN d${id}` };
    // Past the limit it waits to be brought, but its session hears at once that the ask is Aiden's: the bring later sends nothing.
    tellAidens(ctx.db, { projectId: project.id, itemId: item.id, lead: name, ask, kind: turn.kind }, now);
    return { itemState: 'waiting_aiden', outcome: 'AIDEN waiting (limit)' };
  }
  if (verdict === 'CARD' && item.kind === 'question') {
    const said = cardAnswer(ask.nodeId);
    // Not a decision: its session reads the landing check's rule, with no undo word (session-flow's answers line).
    clearInWrite(ctx, record, actor, ask, said, true, 'lead_card');
    logLeadEvent(ctx, { projectId: project.id, lead: name, instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'card', askId: ask.id, nodeId: ask.nodeId, text: answer });
    tell(`card:${askTag(ask.id)}`, leadLine(name, `${askTag(ask.id)}: ${said}`));
    return { itemState: 'done', outcome: 'CARD' };
  }
  return { itemState: 'done', outcome: `${verdict} (no action in this task)` };
}

/**
 * A verdict on a `promise_due` item: a promise of the lead's past its time. DECIDE with ANSWER starting `KEPT:` clears the
 * promise as `lead kept` does (cleared with no answer, a `kept` line with the note after the colon). Any other answer, or
 * a promise already cleared or not the lead's, is noted as it stands for the morning list. The item is done either way.
 */
function applyPromiseDue(ctx: Ctx, turn: LeadTurn, item: DeskItem, record: RecordEvent, name: string): TurnEffect {
  const verdict = turn.verdict ?? '';
  const askId = /^\d+$/.test(item.ref) ? Number(item.ref) : undefined;
  const base = { projectId: item.projectId, lead: name, instructions: LEAD_INSTRUCTIONS_VERSION, ...(item.nodeId === null ? {} : { nodeId: item.nodeId }) };
  const kept = verdict === 'DECIDE' ? /^KEPT:\s*(.*)$/s.exec((turn.answer ?? '').trim()) : null;
  const before = askId === undefined ? undefined : ctx.db.prepare('SELECT 1 FROM asks WHERE id = ?').get(askId) === undefined ? undefined : requireAsk(ctx, askId);
  if (kept && before !== undefined && before.owner === 'lead' && before.clearedAt === null) {
    const ask = clearInWrite(ctx, record, `lead:${name}`, before, '', false);
    const id = logLeadEvent(ctx, { ...base, kind: 'kept', askId: ask.id, nodeId: ask.nodeId, text: (kept[1] as string).trim() });
    return { itemState: 'done', outcome: `KEPT (e${id})` };
  }
  const id = insertLeadEvent(ctx.db, { ...base, kind: 'promise_due', ...(askId === undefined ? {} : { askId }), text: `${verdict}: ${turn.answer ?? ''}`.trim() }, ctx.now());
  return { itemState: 'done', outcome: `${verdict} noted (e${id})` };
}

/**
 * A verdict on a `stuck` item, a permission request the permission hook is waiting on (task 7). DECIDE with an ANSWER that
 * starts `ALLOW:` or `DENY:` is the lead's decision: a `permission` line in his log and its decisions row, and the outcome
 * `ALLOW <reason>` or `DENY <reason>` the waiting request reads. Any other ANSWER is `unclear`: the request says nothing.
 * AIDEN leaves it waiting on Aiden: it has no ask to bring, so nothing is brought. Anything else is done with no action.
 */
function applyStuck(ctx: Ctx, turn: LeadTurn, item: DeskItem, name: string): TurnEffect {
  const verdict = turn.verdict ?? '';
  if (verdict === 'AIDEN') return { itemState: 'waiting_aiden', outcome: 'AIDEN (not brought: a stuck request has no ask)' };
  if (verdict !== 'DECIDE') return { itemState: 'done', outcome: `${verdict} (no action in this task)` };
  const m = /^(ALLOW|DENY):\s*(.*)$/s.exec((turn.answer ?? '').trim());
  if (!m) return { itemState: 'done', outcome: 'unclear' };
  const behavior = m[1] === 'ALLOW' ? 'allow' : 'deny';
  const reason = m[2].trim();
  const now = ctx.now();
  const request = stuckRequestOf(ctx, item);
  const id = insertLeadEvent(
    ctx.db,
    {
      projectId: item.projectId,
      lead: name,
      instructions: LEAD_INSTRUCTIONS_VERSION,
      kind: 'permission',
      ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
      ...(request?.sessionId ? { sessionId: request.sessionId } : {}),
      text: `${behavior}: ${reason}`,
    },
    now,
  );
  addDecision(ctx.db, {
    eventId: id,
    itemId: item.id,
    turnId: turn.id,
    kind: 'permission',
    productRuling: false,
    line: permissionLine(request?.toolName ?? '(tool unknown)', request?.input ?? '', behavior),
    saidWhere: 'desk',
    saidAt: now,
  });
  return { itemState: 'done', outcome: `${behavior === 'allow' ? 'ALLOW' : 'DENY'} ${reason}`.trim() };
}

/** The kinds of send that are a message to a thread: NOT FOUND sends one of them once more. */
const MESSAGE_KINDS: ReadonlySet<string> = new Set(['relay', 'carry', 'morning']);

/** Writes the `send_cleared` line for a send the lead found was never made, through the write's record. */
function sendClearedInWrite(ctx: Ctx, record: RecordEvent, name: string, item: DeskItem, send: LeadSend, text: string): void {
  logLeadEvent(ctx, { projectId: send.projectId, lead: name, instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'send_cleared', ...(item.nodeId === null ? {} : { nodeId: item.nodeId }), text });
  record({ projectId: send.projectId, type: 'project.updated', entity: 'project', entityId: send.projectId, data: { changes: { sendCleared: send.id } } });
}

/**
 * Why a FOUND or FIRST on a start cannot be taken as it stands, or undefined: the step has a newer start that is not
 * cleared, a live session other than the thread's own works on the step, or another start already has that thread.
 */
function startTaken(ctx: Ctx, send: LeadSend, threadId: string): string | undefined {
  const nodeId = parseStartBody(send.body)?.nodeId;
  if (nodeId !== undefined) {
    const newer = ctx.db
      .prepare("SELECT id FROM lead_sends WHERE project_id = ? AND kind = 'start' AND id > ? AND state <> 'cleared' AND json_valid(body) AND json_extract(body, '$.nodeId') = ? LIMIT 1")
      .pluck()
      .get(send.projectId, send.id, nodeId) as number | undefined;
    if (newer !== undefined) return `the step has a newer start, s${newer}`;
    const own = ctx.db.prepare('SELECT id FROM sessions WHERE t3_thread_id = ?').pluck().get(threadId) as string | undefined;
    if (liveSessionUnder(ctx, nodeId, own)) return 'a live session works on the step';
  }
  const other = ctx.db.prepare("SELECT id FROM lead_sends WHERE kind = 'start' AND id <> ? AND result = ? LIMIT 1").pluck().get(send.id, threadId) as number | undefined;
  return other === undefined ? undefined : `the thread is already s${other}'s`;
}

/**
 * A verdict on an `unknown_send` item (P2's case C): the lead read `threads` and `thread` and says what became of the send.
 * A start: DECIDE with ANSWER `FOUND <thread id>`: it happened, done with that thread (recorded as leadStart records one).
 * `FIRST <thread id>`: a thread that holds no first message: done, and the first message is a send of its own whose text
 * ends with its own marker line, so it is never sent twice. A thread id the lead's `threads` read did not list, a step with
 * a newer start or a live session, or a thread another start has, is `unclear` and Aiden's. A message: `DELIVERED <its
 * thread>`: done. `NOT FOUND`: cleared with a `send_cleared` line; a start's step can be started again, and a message is
 * sent once more as a new send (retry key `<key>:again`), and a second NOT FOUND for it is Aiden's. Any other ANSWER is
 * `unclear` and Aiden's; so is AIDEN.
 */
function applyUnknownSend(ctx: Ctx, turn: LeadTurn, item: DeskItem, record: RecordEvent, name: string, deps: ApplyDeps | undefined): TurnEffect {
  const verdict = turn.verdict ?? '';
  const send = getSend(ctx.db, Number(item.ref));
  if (send === undefined || send.state !== 'unknown') return { itemState: 'done', outcome: 'send no longer unknown' };
  const known = `s${send.id}: a ${send.kind} to ${send.target}, written ${send.createdAt}`;
  if (verdict === 'AIDEN') return { itemState: 'waiting_aiden', outcome: `AIDEN (${known})` };
  if (verdict !== 'DECIDE') return { itemState: 'done', outcome: `${verdict} (no action in this task)` };
  const now = ctx.now();
  const answer = (turn.answer ?? '').trim();
  const unclear = (why?: string): TurnEffect => ({ itemState: 'waiting_aiden', outcome: `unclear (${why === undefined ? '' : `${why}; `}${known})` });
  if (/^NOT FOUND\.?$/i.test(answer)) {
    if (!MESSAGE_KINDS.has(send.kind)) {
      if (!moveSend(ctx.db, send.id, ['unknown'], 'cleared', { now })) return { itemState: 'done', outcome: 'send no longer unknown' };
      sendClearedInWrite(ctx, record, name, item, send, `s${send.id}: NOT FOUND`);
      return { itemState: 'done', outcome: 'NOT FOUND' };
    }
    // A message goes once more, and only once: a second NOT FOUND for the same text is Aiden's.
    const againKey = send.retryKey === null ? null : `${send.retryKey}:again`;
    const before = ctx.db
      .prepare("SELECT 1 FROM lead_sends WHERE project_id = ? AND id < ? AND kind = ? AND target = ? AND body = ? AND state = 'cleared'")
      .get(send.projectId, send.id, send.kind, send.target, send.body);
    if (send.retryKey?.endsWith(':again') || before !== undefined || (againKey !== null && sendByRetryKey(ctx.db, againKey) !== undefined)) {
      return { itemState: 'waiting_aiden', outcome: `NOT FOUND again (${known})` };
    }
    if (!moveSend(ctx.db, send.id, ['unknown'], 'cleared', { now })) return { itemState: 'done', outcome: 'send no longer unknown' };
    const again = intendSend(ctx.db, { projectId: send.projectId, itemId: send.itemId, kind: send.kind, target: send.target, retryKey: againKey, body: send.body }, now);
    sendClearedInWrite(ctx, record, name, item, send, `s${send.id}: NOT FOUND, sent again as s${again.id}`);
    return { itemState: 'done', outcome: `NOT FOUND, sent again as s${again.id}` };
  }
  const m = /^(FOUND|FIRST|DELIVERED)\s+(\S+?)\.?$/.exec(answer);
  if (!m) return unclear();
  const word = m[1] as 'FOUND' | 'FIRST' | 'DELIVERED';
  const threadId = m[2] as string;
  if (send.kind !== 'start') {
    if (word !== 'DELIVERED' || threadId !== send.target) return unclear();
    if (!moveSend(ctx.db, send.id, ['unknown'], 'done', { result: threadId, now })) return { itemState: 'done', outcome: 'send no longer unknown' };
    return { itemState: 'done', outcome: `DELIVERED ${threadId}` };
  }
  if (word === 'DELIVERED') return unclear();
  if (deps === undefined || !deps.listed(send.target, threadId)) return unclear();
  const start = parseStartBody(send.body);
  if (word === 'FIRST' && start === undefined) return unclear();
  const taken = startTaken(ctx, send, threadId);
  if (taken !== undefined) return unclear(taken);
  if (!moveSend(ctx.db, send.id, ['unknown'], 'done', { result: threadId, now })) return { itemState: 'done', outcome: 'send no longer unknown' };
  recordStartInWrite(ctx, record, send, threadId);
  if (word === 'FIRST' && start !== undefined) {
    const first = intendSend(ctx.db, { projectId: send.projectId, itemId: item.id, kind: 'relay', target: threadId, body: start.message }, now);
    setSendBody(ctx.db, first.id, `${start.message}\n${sendMarker(first.id)}`);
  }
  return { itemState: 'done', outcome: `${word} ${threadId}` };
}
