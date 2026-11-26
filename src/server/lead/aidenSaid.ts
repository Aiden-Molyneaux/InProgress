import { LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { leadLine } from '../../core/relay';
import { clipLine } from '../../core/step-ref';
import type { Ctx, RecordEvent } from '../db/tx';
import { logLeadEvent } from '../lead';
import type { DeskItem } from '../repo/desk';
import { DECISION_LINE_CUT, reachableThread, t3SessionOnStep } from '../repo/deskBring';
import { addDecision } from '../repo/leadDecisions';
import { intendSend } from '../repo/leadSends';
import type { LeadTurn, TurnEffect } from '../repo/leadTurns';
import { addLogInWrite } from '../repo/logs';
import { getProjectById } from '../repo/projects';
import { intendBringLine } from './voice';

/*
 * An `aiden_said` item (lead stage 1, #743, task 11): Aiden said "you decide" on a step, and `lead desk-add` put his words
 * on the desk. The round's verdict on it: DECIDE is a numbered decision (undoable, his words kept), relayed to the T3 Code
 * session on the step or else logged on the step; AIDEN brings it back to him; CARD is noted.
 */

/** Aiden's words on the item, from the `aiden_said` line its ref (`said:<event id>`) names; undefined when they are gone. */
export function aidenSaidWords(ctx: Ctx, item: Pick<DeskItem, 'ref'>): string | undefined {
  const said = /^said:(\d+)$/.exec(item.ref);
  if (said === null) return undefined;
  const words = ctx.db.prepare("SELECT aiden_words FROM lead_events WHERE id = ? AND kind = 'aiden_said'").pluck().get(Number(said[1])) as string | null | undefined;
  return words ?? undefined;
}

/** The turn's WHY as a sentence. */
const sentence = (text: string): string => {
  const t = text.trim();
  return t === '' || /[.!?]$/.test(t) ? t : `${t}.`;
};

/** Applies the round's verdict on an aiden_said item, inside the runner's write. */
export function applyAidenSaid(ctx: Ctx, turn: LeadTurn, item: DeskItem, record: RecordEvent, name: string): TurnEffect {
  const verdict = turn.verdict ?? '';
  const words = aidenSaidWords(ctx, item);
  const answer = (turn.answer ?? '').trim();
  const why = (turn.why ?? '').trim();
  const now = ctx.now();
  const base = { projectId: item.projectId, lead: name, instructions: LEAD_INSTRUCTIONS_VERSION, ...(item.nodeId === null ? {} : { nodeId: item.nodeId }) };
  if (verdict === 'DECIDE') {
    const id = logLeadEvent(ctx, { ...base, kind: 'decide', text: why, ...(words === undefined ? {} : { aidenWords: words }) });
    const product = turn.kind === 'PRODUCT';
    addDecision(ctx.db, {
      eventId: id,
      itemId: item.id,
      turnId: turn.id,
      kind: product ? 'product' : 'technical',
      productRuling: product,
      line: clipLine(answer, DECISION_LINE_CUT),
      aidenAnswer: answer,
      aidenWords: words ?? null,
      saidWhere: 'desk',
      saidAt: now,
    });
    // Only a reachable thread is told (reachableThread); else the step's log says it.
    const thread = item.nodeId === null ? null : reachableThread(ctx.db, { sessionId: t3SessionOnStep(ctx, item.nodeId) }, now);
    const left = words === undefined ? 'Aiden left this to the lead.' : `Aiden left this to the lead: "${words}".`;
    if (thread !== null) {
      intendSend(
        ctx.db,
        { projectId: item.projectId, itemId: item.id, kind: 'relay', target: thread, retryKey: `aiden-said:d${id}`, body: leadLine(name, `d${id}: ${answer}\nWhy: ${sentence(why)} ${left} He can undo this with "undo d${id}".`) },
        now,
      );
    } else if (item.nodeId !== null) {
      addLogInWrite(ctx, record, item.nodeId, `${name} decided d${id}: ${answer} Why: ${sentence(why)} ${left}`);
    }
    return { itemState: 'done', outcome: `DECIDE d${id}` };
  }
  if (verdict === 'AIDEN') {
    // Brought back to him: a bring line with the would-have, its decisions row, and a line to the Voice.
    const id = logLeadEvent(ctx, { ...base, kind: 'bring', text: answer });
    addDecision(ctx.db, { eventId: id, itemId: item.id, turnId: turn.id, kind: 'technical', line: clipLine(words ?? 'what Aiden left to the lead', DECISION_LINE_CUT), wouldHave: answer, aidenWords: words ?? null, saidAt: now });
    const project = getProjectById(ctx, item.projectId);
    const stepTitle = item.nodeId === null ? null : ((ctx.db.prepare('SELECT title FROM nodes WHERE id = ?').pluck().get(item.nodeId) as string | undefined) ?? null);
    intendBringLine(
      ctx.db,
      { projectId: item.projectId, itemId: item.id, eventId: id, projectName: project?.name ?? '', stepId: item.nodeId, stepTitle, askText: `You left it to me: "${words ?? ''}". It is yours after all.`, wouldHave: answer },
      now,
    );
    return { itemState: 'waiting_aiden', outcome: `AIDEN d${id}` };
  }
  if (verdict === 'CARD') {
    const id = logLeadEvent(ctx, { ...base, kind: 'card', text: answer });
    return { itemState: 'done', outcome: `CARD noted (e${id})` };
  }
  return { itemState: 'done', outcome: `${verdict} (no action in this task)` };
}
