import { AIDEN_BROUGHT_LIMIT, LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { leadLine } from '../../core/relay';
import { askTag } from '../../core/types';
import type { Ctx, RecordEvent } from '../db/tx';
import { decideInWrite } from '../lead-commands';
import { leadFolders, logLeadEvent } from '../lead';
import { clearInWrite } from '../repo/asks';
import type { DeskItem } from '../repo/desk';
import { askOf, bringItem, bringNext, broughtOpen, t3ThreadOf, tellAidens } from '../repo/deskBring';
import { addDecision } from '../repo/leadDecisions';
import type { LeadTurn, TurnEffect } from '../repo/leadTurns';
import { insertLeadEvent } from '../repo/leadEvents';
import { getSend, intendSend, moveSend, setSendBody } from '../repo/leadSends';
import { getProjectById } from '../repo/projects';
import { permissionLine, stuckRequestOf } from './hold';
import { parseStartBody, recordStartInWrite, sendMarker } from './sends';

/** What the apply reads outside the database: whether the lead's `threads` read listed a thread (the sender remembers it). */
export interface ApplyDeps {
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
  if (item.kind === 'unknown_send') return applyUnknownSend(ctx, turn, item, record, deps);
  if (item.kind !== 'question' && item.kind !== 'permission') return { itemState: 'done', outcome: `${verdict} (no action in this task)` };
  const ask = askOf(ctx, item);
  if (ask === undefined || ask.clearedAt !== null) return { itemState: 'done', outcome: 'ask cleared' };
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

/**
 * A verdict on an `unknown_send` item (P2's case C): the lead read `threads` and `thread` and says what became of the send.
 * DECIDE with ANSWER `FOUND <thread id>`: it happened, done with that thread (a start recorded as leadStart records one).
 * `FIRST <thread id>`: a start whose thread holds no first message: done, and the first message is a send of its own whose
 * text ends with its own marker line, so it is never sent twice. `NOT FOUND`: cleared, which releases the step for a new
 * start. A thread id the lead's `threads` read did not list, or any other ANSWER, is `unclear` and Aiden's; so is AIDEN.
 */
function applyUnknownSend(ctx: Ctx, turn: LeadTurn, item: DeskItem, record: RecordEvent, deps: ApplyDeps | undefined): TurnEffect {
  const verdict = turn.verdict ?? '';
  const send = getSend(ctx.db, Number(item.ref));
  if (send === undefined || send.state !== 'unknown') return { itemState: 'done', outcome: 'send no longer unknown' };
  const known = `s${send.id}: a ${send.kind} to ${send.target}, written ${send.createdAt}`;
  if (verdict === 'AIDEN') return { itemState: 'waiting_aiden', outcome: `AIDEN (${known})` };
  if (verdict !== 'DECIDE') return { itemState: 'done', outcome: `${verdict} (no action in this task)` };
  const now = ctx.now();
  const answer = (turn.answer ?? '').trim();
  if (/^NOT FOUND\.?$/i.test(answer)) {
    moveSend(ctx.db, send.id, ['unknown'], 'cleared', { now });
    return { itemState: 'done', outcome: 'NOT FOUND' };
  }
  const unclear: TurnEffect = { itemState: 'waiting_aiden', outcome: `unclear (${known})` };
  const m = /^(FOUND|FIRST)\s+(\S+?)\.?$/.exec(answer);
  if (!m) return unclear;
  const word = m[1] as 'FOUND' | 'FIRST';
  const threadId = m[2] as string;
  const folder = send.kind === 'start' ? send.target : leadFolders(ctx, send.projectId)[0];
  if (folder === undefined || deps === undefined || !deps.listed(folder, threadId)) return unclear;
  const start = send.kind === 'start' ? parseStartBody(send.body) : undefined;
  if (word === 'FIRST' && start === undefined) return unclear;
  if (!moveSend(ctx.db, send.id, ['unknown'], 'done', { result: threadId, now })) return { itemState: 'done', outcome: 'send no longer unknown' };
  if (send.kind === 'start') recordStartInWrite(ctx, record, send, threadId);
  if (word === 'FIRST' && start !== undefined) {
    const first = intendSend(ctx.db, { projectId: send.projectId, itemId: item.id, kind: 'relay', target: threadId, body: start.message }, now);
    setSendBody(ctx.db, first.id, `${start.message}\n${sendMarker(first.id)}`);
  }
  return { itemState: 'done', outcome: `${word} ${threadId}` };
}
