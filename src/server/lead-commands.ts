import { isAidens } from '../core/lead';
import { stepRef } from '../core/step-ref';
import { askTag, type Ask, type Project, type TreeNode } from '../core/types';
import { write, type Ctx } from './db/tx';
import { clip, stamp } from './digest';
import { badRequest, conflict, notFound } from './errors';
import { logLeadEvent, requireLead } from './lead';
import { intentHeadlines } from './lead-text';
import { aidensAskSql, clearInWrite, markAnswersDelivered, raiseAskInWrite, requireAsk } from './repo/asks';
import { parkNodeInWrite, requireNode, unparkNodeInWrite, updateNodeInWrite } from './repo/nodes';
import { setProjectIntentInWrite } from './repo/projects';
import { liveDriver, liveSessionUnder } from './repo/sessions';
import { parkedAncestor, subtreeIds } from './repo/shelved';

/**
 * The lead's six commands. Each one is checked, performed and logged in a single write: requireLead first (outside it, a
 * read), then one write that reads the ask or step again, runs the checks in order, makes the change and writes its line
 * to lead_events. A refused command throws before anything is written; a done one always has its line.
 */

/** How much of a stored answer the refusal of a second answer quotes. */
const ANSWER_CUT = 120;
/** The refusal of `answer` for a permission or a review: in stage 1 the lead carries his answer to a question only. */
export const QUESTION_ONLY = "The lead can carry Aiden's answer to a question only. A permission or a review needs Aiden in the thread or the window.";
/** The refusal of a decide on a permission or a review: only a question is the lead's to answer for Aiden. */
export const DECIDE_QUESTION_ONLY = "The lead decides a question only. A permission or a review is Aiden's: it needs him in the thread or the window.";
/** The refusal of a drop of a step of Aiden's without his words. */
export const needsAidensWords = (origin: string): string => `This step is Aiden's (origin ${origin}). Pass his words with --aiden.`;
/** The refusal of a park of a step of Aiden's with neither his words nor a reason. */
export const parkNeedsWordsOrReason = (origin: string): string =>
  `This step is Aiden's (origin ${origin}). Pass his words with --aiden, or your reason with --reason when nobody is working on it.`;
/** How a decision is named to Aiden: `d12`, the id of its line in the lead's log. leadUndo and decidedSince (lead.ts) match an undo line by this text in SQL. */
export const decisionTag = (eventId: number): string => `d${eventId}`;
/** The refusal of an intent record the brief could not read a Goal and a Phase from. */
export const INTENT_HEADINGS = 'The intent record needs a line under a Goal heading and a line under a Phase heading.';

/** The project the lead may change, its stored lead name, and the actor its writes are recorded under. */
function leadOf(ctx: Ctx, ref: string, as: string, instructions: number): { project: Project; name: string; actor: string } {
  const project = requireLead(ctx, ref, as, instructions, true);
  // requireLead has matched `as` against the stored name, so it is set.
  const name = project.lead as string;
  return { project, name, actor: `lead:${name}` };
}

/** The ask `askId`, read in this write, when it is in the project; refused when it is in another. */
function askIn(ctx: Ctx, project: Project, askId: number): Ask {
  const ask = requireAsk(ctx, askId);
  if (ask.projectId !== project.id) throw conflict(`${askTag(askId)} is not in this project.`);
  return ask;
}

/** A step of another project is refused. */
function requireInProject(node: TreeNode, project: Project): TreeNode {
  if (node.projectId !== project.id) throw conflict(`#${node.id} is not in this project.`);
  return node;
}

/** A step Aiden added (`me`) or asked for (`asked`) is his: the lead parks or drops it only with his words. */
function requireWordsFor(node: TreeNode, aidenWords: string | undefined): void {
  if ((node.origin === 'me' || node.origin === 'asked') && aidenWords === undefined) throw conflict(needsAidensWords(node.origin));
}

/**
 * A park or drop made on the lead's own judgment (no words of Aiden's) is refused while a session works on the step or any
 * step under it, and while a question waits on Aiden on the step or under it: parking or dropping clears those asks with
 * no answer, and an undo does not bring them back. `session` is the refusal for a live session.
 */
function requireQuiet(ctx: Ctx, node: TreeNode, session: string): void {
  if (liveSessionUnder(ctx, node.id)) throw conflict(session);
  const ids = subtreeIds(ctx, node.id);
  const open = ctx.db
    .prepare(`SELECT id FROM asks WHERE cleared_at IS NULL AND ${aidensAskSql()} AND node_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`)
    .pluck()
    .all(...ids) as number[];
  if (open.length) {
    throw conflict(`${stepRef(node.id, node.title)} has a question waiting on Aiden (${open.map(askTag).join(', ')}). Bring it to him first, or pass his words with --aiden.`);
  }
}

/** Clears an open question of Aiden's with his words, carried by the lead: `answered_via` is `lead`. */
export function leadAnswer(ctx: Ctx, ref: string, as: string, instructions: number, input: { askId: number; aidenWords: string; says?: string }): { text: string; ask: Ask } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    const before = askIn(ctx, project, input.askId);
    const tag = askTag(before.id);
    if (!isAidens(before)) throw conflict(`${tag} is the lead's own promise. Clear it with kept.`);
    if (before.kind !== 'question') throw conflict(QUESTION_ONLY);
    if (before.clearedAt !== null) {
      throw conflict(before.answer !== '' ? `Already answered: "${clip(before.answer, ANSWER_CUT)}".` : `${tag} is already cleared, with no answer.`);
    }
    // With `says`, the session reads the answer his words accepted, and his words beside it; the log keeps his words alone.
    const stored = input.says === undefined ? input.aidenWords : `${input.says} (Aiden said: "${input.aidenWords}")`;
    const ask = clearInWrite(ctx, record, actor, before, stored, true, 'lead');
    logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'answer', askId: ask.id, nodeId: ask.nodeId, aidenWords: input.aidenWords });
    return { text: `Answered ${tag} with Aiden's words.`, ask };
  });
}

/**
 * Answers an open question on the lead's judgment, under his mandate: `answered_via` is `lead_decided`, so its session reads
 * that the lead decided, not Aiden. The decision is the number of its line in the lead's log (`d12`), which undo takes.
 */
export function leadDecide(
  ctx: Ctx,
  ref: string,
  as: string,
  instructions: number,
  input: { askId: number; answer: string; reason: string; aidenWords?: string },
): { text: string; ask: Ask; decision: number } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    const before = askIn(ctx, project, input.askId);
    const tag = askTag(before.id);
    if (!isAidens(before)) throw conflict(`${tag} is the lead's own promise. Clear it with kept.`);
    if (before.kind !== 'question') throw conflict(DECIDE_QUESTION_ONLY);
    if (before.clearedAt !== null) {
      throw conflict(before.answer !== '' ? `Already answered: "${clip(before.answer, ANSWER_CUT)}".` : `${tag} is already cleared, with no answer.`);
    }
    const ask = clearInWrite(ctx, record, actor, before, input.answer, true, 'lead_decided');
    const decision = logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'decide', askId: ask.id, nodeId: ask.nodeId, text: input.reason, aidenWords: input.aidenWords });
    const heard = ask.sessionId === null ? 'No session is waiting on it.' : 'Its session reads your answer on its next prompt.';
    return { text: `Decided ${tag}: decision ${decisionTag(decision)}. ${heard}`, ask, decision };
  });
}

/** Parks a step: the reason given, else Aiden's words, else that the lead parked it. A step of Aiden's needs his words. */
export function leadPark(
  ctx: Ctx,
  ref: string,
  as: string,
  instructions: number,
  input: { stepId: number; reason?: string; aidenWords?: string },
): { text: string; node: TreeNode; decision: number | null } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    // Another project's step, its root included, is refused as not in this project: only this project's own root is "the project itself".
    const before = requireInProject(requireNode(ctx, input.stepId), project);
    if (before.parentId === null) throw conflict('The project itself cannot be parked.');
    if (before.status === 'parked') throw conflict(`#${before.id} is already parked.`);
    if (input.aidenWords === undefined) {
      // On the lead's own judgment, whatever the origin: only when nobody works on the step or under it, and no question waits on Aiden there.
      const his = before.origin === 'me' || before.origin === 'asked';
      if (his && input.reason === undefined) throw conflict(parkNeedsWordsOrReason(before.origin));
      requireQuiet(
        ctx,
        before,
        his
          ? `${stepRef(before.id, before.title)} has a session working on it, and it is Aiden's (origin ${before.origin}). Parking it needs his words: pass them with --aiden.`
          : `${stepRef(before.id, before.title)} has a session working on it. Wait for it to end, or pass Aiden's words with --aiden.`,
      );
    }
    const reason = input.reason ?? input.aidenWords ?? `Parked by ${name}.`;
    const node = parkNodeInWrite(ctx, record, actor, before.id, { reason });
    const event = logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'park', nodeId: node.id, text: reason, aidenWords: input.aidenWords });
    const decision = input.aidenWords === undefined ? event : null;
    return { text: `Parked ${stepRef(node.id, node.title)}.${decision === null ? '' : ` Decision ${decisionTag(decision)}.`}`, node, decision };
  });
}

/**
 * Drops a step and clears its open asks, as a drop from anywhere does. A step of Aiden's needs his words, and a step a
 * live session drives, or with open steps under it, is refused. The reason is kept in the lead's log only: a step has no field for it.
 */
export function leadDrop(
  ctx: Ctx,
  ref: string,
  as: string,
  instructions: number,
  input: { stepId: number; reason: string; aidenWords?: string },
): { text: string; node: TreeNode; decision: number | null } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    const before = requireInProject(requireNode(ctx, input.stepId), project);
    if (before.parentId === null) throw conflict('The project itself cannot be dropped.');
    if (before.status === 'done' || before.status === 'dropped') throw conflict(`#${before.id} is ${before.status}.`);
    requireWordsFor(before, input.aidenWords);
    // The window's Done refuses a step a live session drives by the same test: its work would go on under a dropped step.
    if (liveDriver(ctx, before) !== null) throw conflict(`${stepRef(before.id, before.title)} has a session working on it. Park it, or wait for the session to end.`);
    if (input.aidenWords === undefined) requireQuiet(ctx, before, `${stepRef(before.id, before.title)} has a session working on it. Wait for it to end, or pass Aiden's words with --aiden.`);
    // Direct children only, as the window's Done counts them: a parked child is set aside, not open.
    const open = ctx.db.prepare("SELECT 1 FROM nodes WHERE parent_id = ? AND status NOT IN ('done', 'dropped', 'parked')").get(before.id) !== undefined;
    if (open) throw conflict(`${stepRef(before.id, before.title)} has open steps under it. Drop or park those first.`);
    const node = updateNodeInWrite(ctx, record, actor, before.id, { status: 'dropped' });
    const event = logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'drop', nodeId: node.id, text: input.reason, aidenWords: input.aidenWords });
    const decision = input.aidenWords === undefined ? event : null;
    return { text: `Dropped ${stepRef(node.id, node.title)}.${decision === null ? '' : ` Decision ${decisionTag(decision)}.`}`, node, decision };
  });
}

interface DecisionRow {
  id: number;
  kind: string;
  node_id: number | null;
  ask_id: number | null;
  text: string;
}

/**
 * Puts a decision back, on Aiden's words: a parked or dropped step returns to the backlog, a decided question is raised
 * again as a new ask of his. A decision is undone once; a step that has moved on since (unparked, finished) is refused.
 */
export function leadUndo(ctx: Ctx, ref: string, as: string, instructions: number, input: { eventId: number; aidenWords: string }): { text: string } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    const tag = decisionTag(input.eventId);
    const event = ctx.db
      .prepare("SELECT id, kind, node_id, ask_id, text FROM lead_events WHERE id = ? AND project_id = ? AND kind IN ('decide', 'park', 'drop')")
      .get(input.eventId, project.id) as DecisionRow | undefined;
    if (event === undefined) throw notFound(`${tag} not found.`, 'The brief lists decisions as d<number>.');
    // An undo line's text is the decision's tag: decisionTag names the other site.
    if (ctx.db.prepare("SELECT 1 FROM lead_events WHERE project_id = ? AND kind = 'undo' AND text = ?").get(project.id, tag) !== undefined) throw conflict(`${tag} is already undone.`);
    let text: string;
    if (event.kind === 'decide') {
      const old = requireAsk(ctx, event.ask_id as number);
      const step = requireNode(ctx, old.nodeId);
      const above = parkedAncestor(ctx, step.id);
      if (step.status === 'parked' || step.status === 'dropped') throw conflict(`#${step.id} is ${step.status} now, so its question cannot be asked again. Tell Aiden.`);
      if (above !== null) throw conflict(`#${step.id} is under parked #${above} now, so its question cannot be asked again. Tell Aiden.`);
      if (step.status === 'done') {
        // A question step the decision finished is reopened; a step finished on anything else stays finished.
        if (step.kind !== 'question' || step.outcome !== old.answer) throw conflict(`#${step.id} is finished, so its question cannot be asked again. Tell Aiden.`);
        updateNodeInWrite(ctx, record, actor, step.id, { status: 'todo', outcome: '' });
      }
      // A withdrawn answer its session has not read yet is never read.
      if (old.answerDeliveredAt === null) markAnswersDelivered(ctx, [old.id]);
      const raised = raiseAskInWrite(ctx, record, actor, { nodeId: old.nodeId, kind: 'question', text: old.text, ...(old.sessionId === null ? {} : { sessionId: old.sessionId }) });
      text = `Undid ${tag}: the question is Aiden's again as ${askTag(raised.ask.id)}. Your answer was: "${clip(old.answer, ANSWER_CUT)}".`;
    } else {
      const node = requireNode(ctx, event.node_id as number);
      const was = event.kind === 'park' ? 'parked' : 'dropped';
      if (node.status !== was) throw conflict(`#${node.id} is not ${was} any more: nothing to undo.`);
      if (event.kind === 'park' && node.parkedReason !== event.text) throw conflict(`#${node.id} was parked again since ${tag}: that park is not yours to undo.`);
      if (event.kind === 'park') unparkNodeInWrite(ctx, record, node.id, false);
      else updateNodeInWrite(ctx, record, actor, node.id, { status: 'todo' });
      const above = event.kind === 'park' ? parkedAncestor(ctx, node.id) : null;
      text = above === null ? `Undid ${tag}: ${stepRef(node.id, node.title)} is back in the backlog.` : `Undid ${tag}: ${stepRef(node.id, node.title)} is unparked, but it stays set aside under parked #${above}.`;
    }
    logLeadEvent(ctx, {
      projectId: project.id,
      lead: name,
      instructions,
      kind: 'undo',
      ...(event.node_id === null ? {} : { nodeId: event.node_id }),
      ...(event.ask_id === null ? {} : { askId: event.ask_id }),
      text: tag,
      aidenWords: input.aidenWords,
    });
    return { text };
  });
}

/**
 * The lead promises to do something by a time: a review ask it owns, on the step named or else the project's root. It is
 * listed under For the lead and adds nothing to what needs Aiden. The same promise again joins the open one, unlogged.
 */
export function leadPromise(
  ctx: Ctx,
  ref: string,
  as: string,
  instructions: number,
  input: { text: string; dueAt: string; stepId?: number },
): { text: string; ask: Ask; joined: boolean } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    const nodeId = input.stepId !== undefined ? requireInProject(requireNode(ctx, input.stepId), project).id : project.rootNodeId;
    if (!(Date.parse(input.dueAt) > Date.parse(ctx.now()))) throw conflict('The due time is in the past.');
    const { ask, joined } = raiseAskInWrite(ctx, record, actor, { nodeId, kind: 'review', text: input.text, owner: 'lead', dueAt: input.dueAt });
    // A joined promise keeps the due time on record (the new one is not stored), so the reply names that one.
    if (joined) return { text: `Already promised: ${askTag(ask.id)}, ${ask.dueAt === null ? 'with no due time' : `due ${stamp(ask.dueAt)}`}.`, ask, joined };
    logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'promise', askId: ask.id, nodeId: ask.nodeId, text: ask.text });
    return { text: `Promised ${askTag(ask.id)}, due ${stamp(ask.dueAt as string)}.`, ask, joined };
  });
}

/** Clears a promise of the lead's. It has no answer, so no session is told of one. */
export function leadKept(ctx: Ctx, ref: string, as: string, instructions: number, input: { askId: number; note?: string }): { text: string; ask: Ask } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    const before = askIn(ctx, project, input.askId);
    const tag = askTag(before.id);
    if (isAidens(before)) throw conflict(`${tag} is Aiden's. The lead clears only its own promises.`);
    if (before.clearedAt !== null) throw conflict(`${tag} is already cleared.`);
    const ask = clearInWrite(ctx, record, actor, before, '', false);
    logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'kept', askId: ask.id, nodeId: ask.nodeId, text: input.note ?? '' });
    return { text: `Kept ${tag}.`, ask };
  });
}

/** Replaces the intent record. It needs a line under a Goal heading and one under a Phase heading; the log keeps every version. */
export function leadIntent(ctx: Ctx, ref: string, as: string, instructions: number, input: { intent: string }): { text: string; updatedAt: string } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    const { goal, phase } = intentHeadlines(input.intent);
    if (!goal || !phase) throw badRequest(INTENT_HEADINGS);
    const updatedAt = setProjectIntentInWrite(ctx, record, project.id, input.intent);
    logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'intent', text: input.intent });
    return { text: `Intent record replaced (${input.intent.length} characters).`, updatedAt };
  });
}
