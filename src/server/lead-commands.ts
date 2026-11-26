import { isAidens, LEAD_INSTRUCTIONS_VERSION, type LeadSwitch } from '../core/lead';
import { leadLine } from '../core/relay';
import { clipLine, stepRef } from '../core/step-ref';
import { askTag, type Ask, type Project, type TreeNode } from '../core/types';
import { write, type Ctx, type RecordEvent } from './db/tx';
import { clip, stamp } from './digest';
import { badRequest, conflict, notFound } from './errors';
import { ARCHIVED, leadSwitches, logLeadEvent, noLeadNamed, outOfDate, requireLead } from './lead';
import { LEAD_NAME, LEAD_NAME_RULE } from '../core/lead';
import { resolveProject } from './repo/projects';
import { intentHeadlines } from './lead-text';
import { aidensAskSql, clearInWrite, markAnswersDelivered, raiseAskInWrite, requireAsk } from './repo/asks';
import { DECISION_LINE_CUT, reachableThread } from './repo/deskBring';
import { addDeskItem, getDeskItem } from './repo/desk';
import { intendSend, sendByRetryKey } from './repo/leadSends';
import { SETTING_KEYS } from './lead/settings';
import { addDecision, decisionByEvent, type DecisionKind, type SaidWhere } from './repo/leadDecisions';
import { parkNodeInWrite, requireNode, unparkNodeInWrite, updateNodeInWrite } from './repo/nodes';
import { setProjectIntentInWrite } from './repo/projects';
import { liveDriver, liveSessionUnder } from './repo/sessions';
import { parkedAncestor, subtreeIds } from './repo/shelved';
import { listBindings } from './repo/projects';
import { produceDeskItem } from './repo/deskProducers';
import { getSend, stampSeen } from './repo/leadSends';
import { recordYes, type LandingDeps } from './lead/landing';
import { answerYesIds, carryTarget, liveTarget, readSessionYeses } from './lead/carry';
import { addLogInWrite } from './repo/logs';

/**
 * The lead's six commands. Each one is checked, performed and logged in a single write: requireLead first (outside it, a
 * read), then one write that reads the ask or step again, runs the checks in order, makes the change and writes its line
 * to lead_events. A refused command throws before anything is written; a done one always has its line.
 */

/** How much of a stored answer the refusal of a second answer quotes. */
const ANSWER_CUT = 120;
/** The refusal of `answer` in a project whose folders are all under C:\work: the lead carries nothing there. */
export const WORK_PROJECT = "This project's folders are under C:\\work: the lead carries no answer there.";
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
 * step under it, and while an ask waits on Aiden on the step or under it: a park or drop clears the step's own asks with
 * no answer and hides the ones under it, and an undo does not bring a cleared one back. `session` is the refusal for a live session.
 */
function requireQuiet(ctx: Ctx, node: TreeNode, session: string): void {
  if (liveSessionUnder(ctx, node.id)) throw conflict(session);
  const ids = subtreeIds(ctx, node.id);
  const open = ctx.db
    .prepare(`SELECT id FROM asks WHERE cleared_at IS NULL AND ${aidensAskSql()} AND node_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`)
    .pluck()
    .all(...ids) as number[];
  if (open.length) {
    throw conflict(`${stepRef(node.id, node.title)} has an ask waiting on Aiden (${open.map(askTag).join(', ')}). Bring it to him first, or pass his words with --aiden.`);
  }
}

/** The actions a review's go-ahead covers when the caller names none: "ship it". */
export const YES_ACTIONS = ['merge', 'deploy', 'push'] as const;
export type YesAction = (typeof YES_ACTIONS)[number];

/** One action of a review's go-ahead, read before the write: the change's patch id, or why it could not be read. */
export interface CarriedYes {
  action: YesAction;
  patchId: string | null;
  why?: string;
}

/** What `lead answer` carries: Aiden's words, where and when he said them, what he was shown, and for a review what his yes covers. */
export interface LeadAnswerInput {
  askId: number;
  aidenWords: string;
  says?: string;
  where?: 'voice' | 'thread';
  /** When he said it (ISO); now when absent. */
  saidAt?: string;
  /** The documents he was shown, by id. */
  shown?: number[];
  /** A review's yes, each action with the patch id read just before (readYeses). */
  yeses?: CarriedYes[];
}

/** Whether every folder bound to the project is at or under C:/work (a project with none is not). */
export function workProject(ctx: Ctx, projectId: number): boolean {
  const paths = listBindings(ctx)
    .filter((b) => b.projectId === projectId)
    .map((b) => b.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
  return paths.length > 0 && paths.every((p) => p === 'c:/work' || p.startsWith('c:/work/'));
}

/** A time as HH:MM, local. */
const hhmmOf = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The line a T3 Code session reads in its thread when the lead carries Aiden's answer. */
export const carriedLine = (lead: string, where: 'voice' | 'thread', saidAt: string, words: string, askId?: number): string =>
  // The ask is named, so a session with several asks knows which one he answered (a held or "you decide" item has none).
  `Aiden's answer${askId === undefined ? '' : ` to ${askTag(askId)}`}, carried by ${lead} from ${where === 'voice' ? 'Grok' : "the lead's thread"} at ${hhmmOf(saidAt)}: "${words.trim()}"`;

/**
 * For a review: the patch id of the change of the ask's step, read now in its session's folder on the branch it is on
 * (main...branch, as the landing check reads a merge, nothing logged). Every action the yes covers is keyed on that one
 * change: after the merge, a deploy reads main against the live build and a push the branch against origin, which is the
 * same change when nothing else came between, and is held when something did. A change that cannot be read carries the
 * reason for every action, and so does a change with a commit after his words (`saidAt`). A read, outside any write;
 * undefined for an ask that is not a review of this project.
 */
export async function readYeses(
  ctx: Ctx,
  ref: string,
  projectId: number,
  askId: number,
  actions: readonly YesAction[],
  saidAt: string,
  deps?: LandingDeps,
): Promise<CarriedYes[] | undefined> {
  const ask = ctx.db.prepare('SELECT kind, node_id, session_id, project_id FROM asks WHERE id = ?').get(askId) as
    | { kind: string; node_id: number; session_id: string | null; project_id: number }
    | undefined;
  // Another project's ask runs no git: leadAnswer refuses it.
  if (ask === undefined || ask.kind !== 'review' || ask.project_id !== projectId) return undefined;
  return readSessionYeses(ctx, ref, ask.node_id, ask.session_id, actions, saidAt, deps);
}

/**
 * The project `lead answer` may write to: one whose lead is `as`, or one with no lead at all (Aiden's other personal
 * projects: the lead carries his answer on their old asks under its own name). A project naming another lead, an archived
 * one, a name that is not a lead's, and older rules are refused. A read; leadAnswer also refuses a project under C:\work.
 */
export function requireAnswerLead(ctx: Ctx, ref: string, as: string, instructions: number): { project: Project; name: string; actor: string } {
  const project = resolveProject(ctx, ref);
  const named = project.lead === null || project.lead.trim() === '' ? null : project.lead.trim();
  const name = named ?? as.trim();
  if (project.status === 'archived') throw conflict(ARCHIVED);
  if (named !== null && named.toLowerCase() !== as.trim().toLowerCase()) throw conflict(noLeadNamed(as.trim()));
  requireLeadWho(name, instructions, project.slug, named === null);
  return { project, name, actor: `lead:${name}` };
}

/**
 * The name and rules checks of a lead command: with `checkName`, a name that is not a lead's is a 400; with `checkRules`,
 * rules older than LEAD_INSTRUCTIONS_VERSION are a 409 naming `slug` in the rules command to run. requireAnswerLead and the old-asks
 * commands that name no project (src/server/lead/oldAsks.ts) check through here.
 */
export function requireLeadWho(name: string, instructions: number, slug: string, checkName = true, checkRules = true): void {
  if (checkName && !LEAD_NAME.test(name)) throw badRequest(LEAD_NAME_RULE);
  if (checkRules && instructions < LEAD_INSTRUCTIONS_VERSION) throw conflict(outOfDate(instructions, slug, name));
}

/** Actions as a sentence names them: `merge, deploy and push`. */
const andList = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Clears an open ask of Aiden's (a question, a permission or a review) with his words, carried by the lead: `answered_via`
 * is `lead`. It records his sentence, when, where and what he was shown (an `answer` line and a decisions row), and for a
 * review each yes whose patch id was read (`yeses`), so the landing check clears that change and not a later one. A T3
 * Code session is told in its thread once (retry key `carry:a<ask id>`), and once that is done its next prompt does not
 * repeat it (sends.ts stamps the answer delivered); any other session reads the answer on its next prompt. The project is
 * one this lead leads or one with no lead (requireAnswerLead); one whose folders are all under C:\work is refused.
 */
export function leadAnswer(ctx: Ctx, ref: string, as: string, instructions: number, input: LeadAnswerInput): { text: string; ask: Ask; carried: boolean } {
  const { project, name, actor } = requireAnswerLead(ctx, ref, as, instructions);
  if (workProject(ctx, project.id)) throw conflict(WORK_PROJECT);
  const where = input.where ?? 'thread';
  const saidAt = input.saidAt ?? ctx.now();
  return write(ctx, actor, (record) => {
    const before = askIn(ctx, project, input.askId);
    const tag = askTag(before.id);
    if (!isAidens(before)) throw conflict(`${tag} is the lead's own promise. Clear it with kept.`);
    if (before.clearedAt !== null) {
      throw conflict(before.answer !== '' ? `Already answered: "${clip(before.answer, ANSWER_CUT)}".` : `${tag} is already cleared, with no answer.`);
    }
    // With `says`, the session reads the answer his words accepted, and his words beside it; the log keeps his words alone.
    const stored = input.says === undefined ? input.aidenWords : `${input.says} (Aiden said: "${input.aidenWords}")`;
    const ask = clearInWrite(ctx, record, actor, before, stored, true, 'lead');
    const shown = (input.shown ?? []).map((id) => `r${id}`).join(',');
    // A review's yes, only for the actions his words okayed (`yeses`, read before the write): written first, so the
    // answer's line names them (`yes e12,e13`) and its undo withdraws them.
    const yesLines: string[] = [];
    const yesIds: number[] = [];
    if (before.kind === 'review') {
      const yeses = input.yeses ?? [];
      const got = yeses.filter((y) => y.patchId !== null);
      for (const y of got) yesIds.push(recordYes(ctx, project.id, { action: y.action, patchId: y.patchId as string, stepId: ask.nodeId, aidenWords: input.aidenWords, said: saidAt }));
      if (got.length) yesLines.push(`His yes covers ${andList(got.map((y) => y.action))} of the change as it is now.`);
      for (const y of yeses.filter((y) => y.patchId === null)) yesLines.push(`No yes recorded for ${y.action}: ${y.why ?? 'the change could not be read'}.`);
    }
    const eventId = logLeadEvent(ctx, {
      projectId: project.id,
      lead: name,
      instructions,
      kind: 'answer',
      askId: ask.id,
      nodeId: ask.nodeId,
      aidenWords: input.aidenWords,
      text: `where ${where}; said ${saidAt}${shown === '' ? '' : `; shown ${shown}`}${yesIds.length ? `; yes ${yesIds.map((id) => `e${id}`).join(',')}` : ''}`,
    });
    addDecision(ctx.db, {
      eventId,
      kind: before.kind === 'permission' ? 'permission' : 'technical',
      line: clipLine(before.text, DECISION_LINE_CUT),
      aidenAnswer: stored,
      aidenWords: input.aidenWords,
      saidWhere: where,
      saidAt,
    });
    const lines = [`Answered ${tag} with Aiden's words: decision ${decisionTag(eventId)}.`, ...yesLines];
    // Only a reachable session is told in its thread (seen in the last two days): a relay would wake a long-gone one on a
    // stale step. Any other reads the answer on its next prompt, if it ever resumes.
    const thread = reachableThread(ctx.db, { sessionId: ask.sessionId }, ctx.now());
    const retryKey = `carry:${askTag(ask.id)}`;
    let carried = false;
    if (thread !== null && sendByRetryKey(ctx.db, retryKey) === undefined) {
      intendSend(ctx.db, { projectId: project.id, kind: 'carry', target: thread, retryKey, body: carriedLine(name, where, saidAt, input.aidenWords, ask.id) }, ctx.now());
      carried = true;
      lines.push('Its session is told in its thread.');
    }
    return { text: lines.join(' '), ask, carried };
  });
}

/** `lead seen`: the Voice passed Aiden's word on a line; its send is stamped seen, once. A send of another project, or not a voice line, is refused. */
export function leadSeen(ctx: Ctx, ref: string, as: string, instructions: number, input: { sendId: number }): { text: string; stamped: boolean } {
  const { project, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, () => {
    const send = getSend(ctx.db, input.sendId);
    if (send === undefined) throw notFound(`s${input.sendId} not found.`);
    if (send.projectId !== project.id) throw conflict(`s${send.id} is not in this project.`);
    if (send.kind !== 'voice_line') throw conflict(`s${send.id} is not a line to the Voice.`);
    const stamped = stampSeen(ctx.db, send.id, ctx.now());
    return { text: `Seen s${send.id}.`, stamped };
  });
}

/**
 * `lead desk-add`: Aiden said "you decide" on a step. His words go on the desk as an `aiden_said` item on the step, for the
 * round to answer like a question; the words are an `aiden_said` line in the lead's log, which the item's ref names.
 */
export function leadDeskAdd(ctx: Ctx, ref: string, as: string, instructions: number, input: { stepId: number; aidenWords: string }): { text: string; itemId: number } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, () => {
    const node = requireInProject(requireNode(ctx, input.stepId), project);
    const eventId = logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'aiden_said', nodeId: node.id, aidenWords: input.aidenWords });
    const { item } = produceDeskItem(ctx.db, { projectId: project.id, kind: 'aiden_said', ref: `said:${eventId}`, nodeId: node.id }, ctx.now());
    return { text: `On the desk: item #${item.id} for ${stepRef(node.id, node.title)}. The round answers it.`, itemId: item.id };
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
  input: { askId: number; answer: string; reason: string; aidenWords?: string; kind?: 'product' | 'technical' },
): { text: string; ask: Ask; decision: number } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    const before = askIn(ctx, project, input.askId);
    if (isAidens(before) && before.kind !== 'question') throw conflict(DECIDE_QUESTION_ONLY);
    const kind = input.kind ?? 'technical';
    const decision = decideInWrite(ctx, record, {
      project,
      name,
      actor,
      instructions,
      ask: before,
      answer: input.answer,
      reason: input.reason,
      aidenWords: input.aidenWords,
      decision: { kind, productRuling: kind === 'product', saidWhere: 'thread' },
    });
    const ask = requireAsk(ctx, before.id);
    const heard = ask.sessionId === null ? 'No session is waiting on it.' : 'Its session reads your answer on its next prompt.';
    return { text: `Decided ${askTag(ask.id)}: decision ${decisionTag(decision)}. ${heard}`, ask, decision };
  });
}

/** A decision's row beside its event: its kind and ruling, where it was said, and the desk item and turn it came from. */
export interface DecisionMeta {
  kind: DecisionKind;
  productRuling: boolean;
  saidWhere: SaidWhere;
  itemId?: number;
  turnId?: number;
}

/**
 * A decision on an open ask of Aiden's, inside an open write: the ask cleared with the lead's answer (`answered_via`
 * `lead_decided`), its `decide` line in the lead's log, whose id it answers (the `d12` undo takes), and its decisions row
 * beside that line (`decision`, with the line `<ask> -> <answer>`). `lead decide` and the desk (src/server/lead/apply.ts)
 * both decide through here; only `lead decide` refuses a permission. Refuses the lead's own promise, and an ask already
 * cleared.
 */
export function decideInWrite(
  ctx: Ctx,
  record: RecordEvent,
  input: { project: Project; name: string; actor: string; instructions: number; ask: Ask; answer: string; reason: string; aidenWords?: string | undefined; decision: DecisionMeta },
): number {
  const before = input.ask;
  const tag = askTag(before.id);
  if (!isAidens(before)) throw conflict(`${tag} is the lead's own promise. Clear it with kept.`);
  if (before.clearedAt !== null) {
    throw conflict(before.answer !== '' ? `Already answered: "${clip(before.answer, ANSWER_CUT)}".` : `${tag} is already cleared, with no answer.`);
  }
  const ask = clearInWrite(ctx, record, input.actor, before, input.answer, true, 'lead_decided');
  const eventId = logLeadEvent(ctx, { projectId: input.project.id, lead: input.name, instructions: input.instructions, kind: 'decide', askId: ask.id, nodeId: ask.nodeId, text: input.reason, aidenWords: input.aidenWords });
  const d = input.decision;
  addDecision(ctx.db, {
    eventId,
    ...(d.itemId === undefined ? {} : { itemId: d.itemId }),
    ...(d.turnId === undefined ? {} : { turnId: d.turnId }),
    kind: d.kind,
    productRuling: d.productRuling,
    line: `${clipLine(before.text, DECISION_LINE_CUT)} -> ${clipLine(input.answer, DECISION_LINE_CUT)}`,
    ...(input.aidenWords === undefined ? {} : { aidenWords: input.aidenWords }),
    saidWhere: d.saidWhere,
    saidAt: ctx.now(),
  });
  return eventId;
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
export function leadUndo(ctx: Ctx, ref: string, as: string, instructions: number, input: { eventId: number; aidenWords: string; reason?: string }): { text: string } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    const tag = decisionTag(input.eventId);
    const event = ctx.db
      .prepare("SELECT id, kind, node_id, ask_id, text FROM lead_events WHERE id = ? AND project_id = ? AND kind IN ('decide', 'park', 'drop', 'answer')")
      .get(input.eventId, project.id) as DecisionRow | undefined;
    // A carried answer is undone only when it has its decisions row (an answer carried before task 11 has none).
    if (event === undefined || (event.kind === 'answer' && decisionByEvent(ctx.db, event.id) === undefined)) throw notFound(`${tag} not found.`, 'The brief lists decisions as d<number>.');
    // An undo line's text is the decision's tag: decisionTag names the other site.
    if (ctx.db.prepare("SELECT 1 FROM lead_events WHERE project_id = ? AND kind = 'undo' AND text = ?").get(project.id, tag) !== undefined) throw conflict(`${tag} is already undone.`);
    /** Tells the session the relay of the decision went to, once; with no relay, a line in the step's log. */
    const withdraw = (target: string | undefined, line: string): void => {
      const retryKey = `undo:${tag}`;
      if (target !== undefined) {
        if (sendByRetryKey(ctx.db, retryKey) === undefined) intendSend(ctx.db, { projectId: project.id, kind: 'relay', target, retryKey, body: leadLine(name, line) }, ctx.now());
      } else if (event.node_id !== null) addLogInWrite(ctx, record, event.node_id, `${name}: ${line}`);
    };
    let text: string;
    if (event.kind === 'answer') {
      // His carried answer withdrawn: each yes it recorded is withdrawn too (a `yes_withdrawn` line the landing check reads).
      const yeses = answerYesIds(event.text)
        .map((id) => ctx.db.prepare("SELECT id, node_id, text FROM lead_events WHERE id = ? AND project_id = ? AND kind = 'yes'").get(id, project.id) as { id: number; node_id: number | null; text: string } | undefined)
        .filter((y) => y !== undefined);
      for (const y of yeses) logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'yes_withdrawn', ...(y.node_id === null ? {} : { nodeId: y.node_id }), text: `e${y.id}`, aidenWords: input.aidenWords });
      const target = carryTarget(ctx, { askId: event.ask_id, text: event.text });
      withdraw(target, `${tag} is withdrawn: Aiden's answer no longer stands${yeses.length ? ', and neither does his go-ahead' : ''}.`);
      // A session not reached in its thread reads the withdrawal as its ask's answer on its next prompt (the log line stays).
      if (target === undefined && event.ask_id !== null) {
        const why = input.reason?.trim() || `"${input.aidenWords.trim()}"`;
        ctx.db
          .prepare('UPDATE asks SET answer = ?, answered_via = NULL, answer_delivered_at = NULL WHERE id = ?')
          .run(`Aiden's answer ${tag} is withdrawn by ${name}: ${why}`, event.ask_id);
      }
      text = `Undid ${tag}: Aiden's answer is withdrawn${yeses.length ? `, with his yes for ${andList(yeses.map((y) => y.text.split(' ')[0]!))}` : ''}.`;
      // A review's answer withdrawn: the review is raised again, as an undone question is, so his corrected word has a line
      // to answer (with the round on it is brought through the Voice).
      const answered = event.ask_id === null ? undefined : ctx.db.prepare('SELECT id FROM asks WHERE id = ?').pluck().get(event.ask_id) === undefined ? undefined : requireAsk(ctx, event.ask_id);
      if (answered !== undefined && answered.kind === 'review') {
        // A review of work that landed, or of a step set aside, is not asked again: the answer and its yeses are withdrawn all
        // the same. Checked first, so the raise never refuses and rolls the whole undo back.
        const step = requireNode(ctx, answered.nodeId);
        const above = parkedAncestor(ctx, step.id);
        if (step.status === 'done' || step.status === 'parked' || step.status === 'dropped') {
          text += ` #${step.id} is ${step.status}, so its review is not asked again.`;
        } else if (above !== null) {
          text += ` #${step.id} is under parked #${above}, so its review is not asked again.`;
        } else {
          const again = raiseAskInWrite(ctx, record, actor, { nodeId: answered.nodeId, kind: 'review', text: answered.text, ...(answered.sessionId === null ? {} : { sessionId: answered.sessionId }) });
          text += ` The review is Aiden's again as ${askTag(again.ask.id)}.`;
        }
      }
    } else if (event.kind === 'decide' && event.ask_id === null) {
      // A decision on what Aiden left to the lead (an aiden_said item): there is no question to raise again. The session its
      // relay went to is told once that it is withdrawn; with no relay, the step's log says so.
      // A relay cleared unsent went to a dead thread: the withdrawal goes to the step's log instead.
      withdraw(reachableThread(ctx.db, { threadId: liveTarget(ctx, `aiden-said:${tag}`) }, ctx.now()) ?? undefined, `${tag} is withdrawn: Aiden takes it back.`);
      text = `Undid ${tag}: the decision is withdrawn.`;
    } else if (event.kind === 'decide') {
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
      // Raised again with its own kind (a permission stays a permission). With the round on, its desk item is Aiden's at
      // once and brought, never back on the lead's desk to be decided again.
      const was = decisionByEvent(ctx.db, event.id);
      const undone = { wouldHave: old.answer, kind: was?.kind ?? (old.kind === 'permission' ? 'permission' : 'technical'), productRuling: was?.productRuling ?? false };
      const raised = raiseAskInWrite(ctx, record, actor, { nodeId: old.nodeId, kind: old.kind, text: old.text, ...(old.sessionId === null ? {} : { sessionId: old.sessionId }) }, undone);
      const oldAsk = was?.itemId != null && getDeskItem(ctx.db, was.itemId)?.kind === 'old_ask';
      // An old ask's question raised again is his, carried by lead old-asks next, unless the desk already brings it.
      if (oldAsk && ctx.db.prepare("SELECT 1 FROM desk_items WHERE kind IN ('question', 'permission', 'old_ask') AND ref = ?").get(String(raised.ask.id)) === undefined) {
        addDeskItem(ctx.db, { projectId: project.id, kind: 'old_ask', ref: String(raised.ask.id), nodeId: raised.ask.nodeId, state: 'waiting_aiden' }, ctx.now());
      }
      // A decision made at the desk or in the thread was told to its session: the session is told once that it is withdrawn.
      // An old ask's session is told only while it has not ended (as its decision was); else the step's log says it.
      if (was?.saidWhere === 'desk' || was?.saidWhere === 'thread') {
        const thread = reachableThread(ctx.db, { sessionId: old.sessionId }, ctx.now());
        const retryKey = `undo:${tag}`;
        const line = `${tag} is withdrawn: ${askTag(old.id)} is Aiden's again.`;
        if (thread !== null && sendByRetryKey(ctx.db, retryKey) === undefined) {
          intendSend(ctx.db, { projectId: project.id, kind: 'relay', target: thread, retryKey, body: leadLine(name, line) }, ctx.now());
        } else if (thread === null && oldAsk) addLogInWrite(ctx, record, old.nodeId, `${name}: ${line}`);
      }
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
    // His reason, when he gave one, becomes a standing ruling the lead reads before the next call of that kind.
    if (input.reason !== undefined && input.reason.trim() !== '') {
      // The undo's tag leads the text (`d12: <reason>`), so standingRulings names the undo it came from without a join.
      logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'ruling', text: `${tag}: ${input.reason.trim()}`, aidenWords: input.aidenWords });
    }
    return { text };
  });
}

/**
 * Aiden answers, in the window, an ask the lead already decided (`answered_via` `lead_decided`): his answer is not dropped.
 * It is recorded as `lead undo` of that decision plus his answer: an `undo` line, an `answer` line with his words, and a
 * relay to the session (a T3 Code one) that his answer replaces the decision, once (retry key `late:a<ask id>`). The ask's
 * answer becomes his words, as his own (answered_via NULL), with an event for the window; a session not in T3 Code reads
 * it on its next prompt. False,
 * with nothing written, when the ask is not one the lead decided, has no lead, or was already undone.
 */
export function lateAnswer(ctx: Ctx, askId: number, words: string, actor: string): boolean {
  return write(ctx, actor, (record) => {
    const ask = requireAsk(ctx, askId);
    if (ask.clearedAt === null || ask.answeredVia !== 'lead_decided' || words.trim() === '') return false;
    const project = ctx.db.prepare('SELECT id, lead FROM projects WHERE id = ?').get(ask.projectId) as { id: number; lead: string | null } | undefined;
    if (project === undefined || project.lead === null || project.lead.trim() === '') return false;
    const event = ctx.db.prepare("SELECT id FROM lead_events WHERE project_id = ? AND kind = 'decide' AND ask_id = ? ORDER BY id DESC LIMIT 1").pluck().get(project.id, ask.id) as number | undefined;
    if (event === undefined) return false;
    const tag = decisionTag(event);
    if (ctx.db.prepare("SELECT 1 FROM lead_events WHERE project_id = ? AND kind = 'undo' AND text = ?").get(project.id, tag) !== undefined) return false;
    const base = { projectId: project.id, lead: project.lead, instructions: LEAD_INSTRUCTIONS_VERSION, nodeId: ask.nodeId, askId: ask.id, aidenWords: words };
    logLeadEvent(ctx, { ...base, kind: 'undo', text: tag });
    logLeadEvent(ctx, { ...base, kind: 'answer' });
    // His words reach only a reachable session; any other reads them on its next prompt (the thread === null branch below).
    const thread = reachableThread(ctx.db, { sessionId: ask.sessionId }, ctx.now());
    const retryKey = `late:${askTag(ask.id)}`;
    if (thread !== null && sendByRetryKey(ctx.db, retryKey) === undefined) {
      // His own words, so not under the lead's [From ...] header, which a session reads as not Aiden.
      intendSend(ctx.db, { projectId: project.id, kind: 'carry', target: thread, retryKey, body: `Aiden's answer to ${askTag(ask.id)}, which replaces ${tag}, carried by ${project.lead} from the window at ${hhmmOf(ctx.now())}: "${words.trim()}"` }, ctx.now());
    }
    // The ask's answer is his now, Aiden's own (answered_via NULL), so the window shows it and no line calls it the lead's.
    // It is marked not yet delivered: a session with no reachable thread reads it on its next prompt, as any answered ask;
    // a reachable one has the carry, which stamps it delivered when tried and takes that back when it is cleared unsent.
    ctx.db.prepare('UPDATE asks SET answer = ?, answered_via = NULL, answer_delivered_at = NULL WHERE id = ?').run(words.trim(), ask.id);
    record({ projectId: project.id, type: 'ask.cleared', entity: 'ask', entityId: ask.id, data: { ask: requireAsk(ctx, ask.id) } });
    return true;
  });
}

/** `lead set`: one setting of the project, as a `setting` line `<key> <value>`; the newest of a key wins. Refuses a key or value it does not know. */
export function leadSet(ctx: Ctx, ref: string, as: string, instructions: number, input: { key: string; value: string; aidenWords?: string }): { text: string } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  const check = Object.hasOwn(SETTING_KEYS, input.key) ? SETTING_KEYS[input.key]! : undefined;
  if (check === undefined) throw badRequest(`${input.key} is not a setting.`, `The settings are: ${Object.keys(SETTING_KEYS).join(', ')}.`);
  const value = input.value.trim();
  const bad = check(value);
  if (bad !== null) throw badRequest(bad);
  return write(ctx, actor, () => {
    logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'setting', text: `${input.key} ${value}`, ...(input.aidenWords === undefined ? {} : { aidenWords: input.aidenWords }) });
    return { text: `Set ${input.key} to ${value}.` };
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

/** A switch as a sentence names it: `Starts`, `Landing`. */
const switchName = (s: LeadSwitch): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Turns a switch on, on Aiden's words: the log's newest allow line for it is what the project reads. Already on is refused. */
export function leadAllow(ctx: Ctx, ref: string, as: string, instructions: number, input: { switch: LeadSwitch; aidenWords: string }): { text: string } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    if (leadSwitches(ctx, project.id)[input.switch].on) throw conflict(`${switchName(input.switch)} is already on.`);
    logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'allow', text: input.switch, aidenWords: input.aidenWords });
    // The log line alone moves nothing on the project's stream: this is what makes an open Lead view read the brief again.
    record({ projectId: project.id, type: 'project.updated', entity: 'project', entityId: project.id, data: { changes: { [input.switch]: 'on' } } });
    return { text: `${switchName(input.switch)} is on for ${project.name}.` };
  });
}

/** Turns a switch off. Already off, or never on, is refused. Aiden's words are kept when given. */
export function leadDisallow(ctx: Ctx, ref: string, as: string, instructions: number, input: { switch: LeadSwitch; aidenWords?: string }): { text: string } {
  const { project, name, actor } = leadOf(ctx, ref, as, instructions);
  return write(ctx, actor, (record) => {
    if (!leadSwitches(ctx, project.id)[input.switch].on) throw conflict(`${switchName(input.switch)} is already off.`);
    logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind: 'disallow', text: input.switch, aidenWords: input.aidenWords });
    record({ projectId: project.id, type: 'project.updated', entity: 'project', entityId: project.id, data: { changes: { [input.switch]: 'off' } } });
    return { text: `${switchName(input.switch)} is off for ${project.name}.` };
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
