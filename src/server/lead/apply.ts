import { LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { clipLine } from '../../core/step-ref';
import { askTag, type Ask } from '../../core/types';
import type { Ctx, RecordEvent } from '../db/tx';
import { decideInWrite } from '../lead-commands';
import { logLeadEvent } from '../lead';
import { clearInWrite, requireAsk } from '../repo/asks';
import type { DeskItem } from '../repo/desk';
import { AIDEN_BROUGHT_LIMIT, bringItem, bringNext as bringNextIn, broughtOpen, DECISION_LINE_CUT, t3ThreadOf } from '../repo/deskBring';
import { addDecision, type DecisionKind } from '../repo/leadDecisions';
import type { LeadTurn, TurnEffect } from '../repo/leadTurns';
import { insertLeadEvent } from '../repo/leadEvents';
import { intendSend } from '../repo/leadSends';
import { getProjectById } from '../repo/projects';
import { permissionLine, stuckRequestOf } from './hold';

export { AIDEN_BROUGHT_LIMIT } from '../repo/deskBring';

/** What a CARD tells the session until the landing check (task 6) answers in its place. */
export const cardAnswer = (stepId: number): string =>
  `A landing is decided by the landing check, not by the lead. Run: inprogress landing ${stepId} --action <merge|deploy|push|publish|push-public>, and follow its answer.`;

/** The ask a question or permission item is about, read in this write; undefined when it is gone (its project deleted, or the row). */
function askOf(ctx: Ctx, item: DeskItem): Ask | undefined {
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

/**
 * What a verdict does, as the runner's `apply`: run inside the runner's write (immediate, under the lead's actor) and
 * applyTurn's compare-and-set, with that write's `record`, so it only writes the database and its events reach the window
 * after the commit. Every action that leaves InProgress is a lead_sends row in state intended, carried out after the commit by the
 * sender (task 8). An ordinary refusal (no lead, an ask already cleared or gone) is an outcome with the item done, never a
 * throw. Writes as `lead:<the project's lead>` under the current rules version.
 */
export function applyVerdict(ctx: Ctx, turn: LeadTurn, item: DeskItem, record: RecordEvent): TurnEffect {
  const project = getProjectById(ctx, item.projectId);
  if (project === undefined || project.lead === null || project.lead.trim() === '') return { itemState: 'done', outcome: 'no lead' };
  const name = project.lead;
  const actor = `lead:${name}`;
  const verdict = turn.verdict ?? '';
  if (item.kind === 'stuck') return applyStuck(ctx, turn, item, name);
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
    const id = decideInWrite(ctx, record, { project, name, actor, instructions: LEAD_INSTRUCTIONS_VERSION, ask, answer, reason: why });
    const kind: DecisionKind = item.kind === 'permission' ? 'permission' : turn.kind === 'PRODUCT' ? 'product' : 'technical';
    addDecision(ctx.db, {
      eventId: id,
      itemId: item.id,
      turnId: turn.id,
      kind,
      productRuling: turn.kind === 'PRODUCT',
      line: `${clipLine(ask.text, DECISION_LINE_CUT)} -> ${clipLine(answer, DECISION_LINE_CUT)}`,
      saidWhere: 'desk',
      saidAt: now,
    });
    tell(`relay:d${id}`, `[From ${name}, the lead] d${id}: ${answer}\nWhy: ${why} Aiden can undo this with "undo d${id}".`);
    return { itemState: 'done', outcome: `DECIDE d${id}` };
  }
  if (verdict === 'AIDEN') {
    // Waiting items come first, in their order, while there is room; this one is brought only if room is left.
    bringNextIn(ctx.db, project.id, now);
    if (broughtOpen(ctx.db, project.id) >= AIDEN_BROUGHT_LIMIT) return { itemState: 'waiting_aiden', outcome: 'AIDEN waiting (limit)' };
    const id = bringItem(ctx.db, item, { id: turn.id, kind: turn.kind, answer: turn.answer }, now);
    return { itemState: 'waiting_aiden', outcome: id === undefined ? 'AIDEN waiting (limit)' : `AIDEN d${id}` };
  }
  if (verdict === 'CARD' && item.kind === 'question') {
    const said = cardAnswer(ask.nodeId);
    clearInWrite(ctx, record, actor, ask, said, true, 'lead_decided');
    logLeadEvent(ctx, { projectId: project.id, lead: name, instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'card', askId: ask.id, nodeId: ask.nodeId, text: answer });
    tell(`card:${askTag(ask.id)}`, `[From ${name}, the lead] ${askTag(ask.id)}: ${said}`);
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

/** Brings the project's next waiting items to Aiden while it has room (src/server/repo/deskBring.ts), in one write of its own. */
export function bringNext(ctx: Ctx, projectId: number): number[] {
  return ctx.db.transaction(() => bringNextIn(ctx.db, projectId, ctx.now())).immediate();
}
