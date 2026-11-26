import { clipLine } from '../../core/step-ref';
import type { Project } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { conflict, notFound } from '../errors';
import { carriedLine, requireAnswerLead, workProject, WORK_PROJECT, type CarriedYes, type YesAction } from '../lead-commands';
import { logLeadEvent } from '../lead';
import { getDeskItem, moveDeskItem, type DeskItem } from '../repo/desk';
import { askOf, DECISION_LINE_CUT, t3ThreadOf, t3ThreadOnStep } from '../repo/deskBring';
import { addDecision } from '../repo/leadDecisions';
import { getSend, intendSend, sendByRetryKey, type LeadSend } from '../repo/leadSends';
import { addLogInWrite } from '../repo/logs';
import { checkLanding, realGit, recordYes, type LandingDeps } from './landing';
import { aidenSaidWords } from './aidenSaid';
import { heldRef } from './hold';

/*
 * Carrying Aiden's answer (lead stage 1, #743, task 11 and its fixes): what his yes covers, read from git, and his reply to
 * a line from the Voice, found from the line's send.
 */

/** The line an answer prints when the work moved after his word (W8). */
export const CHANGED_AFTER = 'the work changed after his word';
/** The line an answer prints for a review's yes given with no time of his (W8a). */
export const SAID_AT_NEEDED = 'give --said-at with a yes';

/**
 * The yes for each action, keyed on the change of the session's branch (main...branch, as the landing check reads a merge,
 * nothing logged), read now in its folder. No yes when the change cannot be read, or when its newest commit is after his
 * words (`saidAt`): what he said yes to is not what is there now.
 */
export async function readSessionYeses(
  ctx: Ctx,
  ref: string,
  stepId: number,
  sessionId: string | null,
  actions: readonly YesAction[],
  saidAt: string,
  deps?: LandingDeps,
): Promise<CarriedYes[]> {
  const none = (why: string): CarriedYes[] => actions.map((action) => ({ action, patchId: null, why }));
  const session = sessionId === null ? undefined : (ctx.db.prepare('SELECT cwd, branch FROM sessions WHERE id = ?').get(sessionId) as { cwd: string | null; branch: string | null } | undefined);
  const folder = session?.cwd ?? null;
  if (folder === null || folder.trim() === '') return none('its session has no folder on record');
  const branch = session?.branch ? session.branch : undefined;
  try {
    const read = await checkLanding(ctx, { ref, stepId, action: 'merge', folder, ...(branch === undefined ? {} : { branch }) }, deps, { record: false });
    if (read.patchId === null) return none('there is no change to read');
    const tip = read.range.split('...')[1] ?? 'HEAD';
    const log = await (deps?.git ?? realGit)(folder, ['log', '-1', '--format=%cI', tip, '--']);
    const newest = log.code === 0 ? Date.parse(log.stdout.trim()) : NaN;
    if (Number.isNaN(newest)) return none(`could not tell when ${tip.replace('refs/heads/', '')} last changed`);
    // git gives whole seconds: a commit in the same second as his word counts as before it.
    if (newest > Math.floor(Date.parse(saidAt) / 1000) * 1000) return none(CHANGED_AFTER);
    return actions.map((action) => ({ action, patchId: read.patchId }));
  } catch (err) {
    return none((err as Error).message.replace(/\.+$/, ''));
  }
}

/** What a line to the Voice is about, for his reply: an ask (a bring line), a held action, or what he left to the lead. */
export type VoiceTarget = ({ kind: 'ask'; askId: number } | { kind: 'held' | 'aiden_said'; item: DeskItem }) & { send: LeadSend };

/** The thing a line to the Voice is about. A send that is not a voice line, of another project, or about nothing he can answer is a 409. */
export function voiceTarget(ctx: Ctx, project: Project, sendId: number): VoiceTarget {
  const send = getSend(ctx.db, sendId);
  if (send === undefined) throw notFound(`s${sendId} not found.`);
  if (send.projectId !== project.id) throw conflict(`s${send.id} is not in this project.`);
  if (send.kind !== 'voice_line') throw conflict(`s${send.id} is not a line to the Voice.`);
  const item = send.itemId === null ? undefined : getDeskItem(ctx.db, send.itemId);
  if (item === undefined) throw conflict(`s${send.id} is not about anything Aiden answers: pass the ask number instead.`);
  if (item.kind === 'held' || item.kind === 'aiden_said') return { kind: item.kind, item, send };
  const ask = askOf(ctx, item);
  if (ask === undefined) throw conflict(`s${send.id} is about an ask that is gone.`);
  return { kind: 'ask', askId: ask.id, send };
}

/**
 * The session and command a held item is about: the `held` line whose session and command make the item's ref (heldRef),
 * as morning.ts finds it. The line is `<command> -> <why>`, and either part may hold an arrow, so each cut is tried.
 */
export function heldScope(ctx: Ctx, item: DeskItem): { sessionId: string | null; command: string } {
  const rows = ctx.db.prepare("SELECT session_id, text FROM lead_events WHERE project_id = ? AND kind = 'held' ORDER BY id").all(item.projectId) as { session_id: string | null; text: string }[];
  for (const r of rows) {
    for (let at = r.text.indexOf(' -> '); at >= 0; at = r.text.indexOf(' -> ', at + 1)) {
      const command = r.text.slice(0, at);
      if (heldRef(r.session_id, command) === item.ref) return { sessionId: r.session_id, command };
    }
  }
  return { sessionId: null, command: '' };
}

export interface ItemAnswerInput {
  aidenWords: string;
  where?: 'voice' | 'thread';
  saidAt?: string;
  shown?: number[];
  /** For a held action, the yes for each action he okayed, read before the write (readSessionYeses). */
  yeses?: CarriedYes[];
  /** Lines the route adds to the answer: what of --yes or --says was not used, and why. */
  notes?: string[];
}

/**
 * Aiden's reply to the line about a held action or about what he left to the lead (W2). His words are recorded (an
 * `answer` line and a decisions row), a held action gets the yes he gave for it, his words reach the session in its T3 Code
 * thread (once, retry key `carry:i<item id>`) or else a line in the step's log, and the item is done.
 */
export function leadAnswerItem(ctx: Ctx, ref: string, as: string, instructions: number, itemId: number, input: ItemAnswerInput): { text: string; carried: boolean; decision: number } {
  const { project, name, actor } = requireAnswerLead(ctx, ref, as, instructions);
  if (workProject(ctx, project.id)) throw conflict(WORK_PROJECT);
  const where = input.where ?? 'voice';
  const saidAt = input.saidAt ?? ctx.now();
  return write(ctx, actor, (record) => {
    const item = getDeskItem(ctx.db, itemId);
    if (item === undefined || item.projectId !== project.id) throw notFound(`Desk item #${itemId} not found.`);
    if (item.state === 'done') throw conflict(`Desk item #${item.id} is already closed.`);
    const held = item.kind === 'held' ? heldScope(ctx, item) : undefined;
    const lines: string[] = [];
    const yesIds: number[] = [];
    if (held !== undefined) {
      const yeses = input.yeses ?? [];
      const got = item.nodeId === null ? [] : yeses.filter((y) => y.patchId !== null);
      for (const y of got) yesIds.push(recordYes(ctx, project.id, { action: y.action, patchId: y.patchId as string, stepId: item.nodeId as number, aidenWords: input.aidenWords, said: saidAt }));
      if (got.length) lines.push(`His yes covers ${got.map((y) => y.action).join(', ')} of the change as it is now.`);
      for (const y of yeses.filter((y) => y.patchId === null)) lines.push(`No yes recorded for ${y.action}: ${y.why ?? 'the change could not be read'}.`);
    }
    lines.push(...(input.notes ?? []));
    const shown = (input.shown ?? []).map((id) => `r${id}`).join(',');
    const eventId = logLeadEvent(ctx, {
      projectId: project.id,
      lead: name,
      instructions,
      kind: 'answer',
      ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
      ...(held?.sessionId ? { sessionId: held.sessionId } : {}),
      aidenWords: input.aidenWords,
      text: `where ${where}; said ${saidAt}; item ${item.id}${shown === '' ? '' : `; shown ${shown}`}${yesIds.length ? `; yes ${yesIds.map((id) => `e${id}`).join(',')}` : ''}`,
    });
    const about = held !== undefined ? held.command : (aidenSaidWords(ctx, item) ?? 'what Aiden left to the lead');
    addDecision(ctx.db, {
      eventId,
      itemId: item.id,
      kind: held !== undefined ? 'permission' : 'technical',
      line: clipLine(about, DECISION_LINE_CUT),
      aidenAnswer: input.aidenWords,
      aidenWords: input.aidenWords,
      saidWhere: where,
      saidAt,
    });
    moveDeskItem(ctx.db, item.id, ['open', 'leased', 'behind', 'waiting_aiden'], 'done', { outcome: `ANSWERED d${eventId}`, now: ctx.now() });
    const thread = held !== undefined ? t3ThreadOf(ctx.db, held.sessionId) : item.nodeId === null ? null : t3ThreadOnStep(ctx, item.nodeId);
    const retryKey = `carry:i${item.id}`;
    const said = carriedLine(name, where, saidAt, input.aidenWords);
    let carried = false;
    if (thread !== null) {
      if (sendByRetryKey(ctx.db, retryKey) === undefined) {
        intendSend(ctx.db, { projectId: project.id, itemId: item.id, kind: 'carry', target: thread, retryKey, body: said }, ctx.now());
        carried = true;
        lines.push('Its session is told in its thread.');
      }
    } else if (item.nodeId !== null) {
      addLogInWrite(ctx, record, item.nodeId, said);
      lines.push("His words are in the step's log.");
    }
    return { text: [`Answered desk item #${item.id} with Aiden's words: decision d${eventId}.`, ...lines].join(' '), carried, decision: eventId };
  });
}

/** The thread a relay or carry went to, for an undo; undefined when there was none, or it was cleared unsent (a dead thread). */
export function liveTarget(ctx: Ctx, retryKey: string): string | undefined {
  const send = sendByRetryKey(ctx.db, retryKey);
  return send === undefined || send.state === 'cleared' ? undefined : send.target;
}

/** The relay target a carried answer went to, for its undo: the carry send of the ask or of the item. */
export function carryTarget(ctx: Ctx, answer: { askId: number | null; text: string }): string | undefined {
  const item = /; item (\d+)/.exec(answer.text);
  const key = answer.askId !== null ? `carry:a${answer.askId}` : item !== null ? `carry:i${item[1]}` : undefined;
  return key === undefined ? undefined : liveTarget(ctx, key);
}

/** The yes rows an answer recorded, from its line's `yes e12,e13`. */
export function answerYesIds(text: string): number[] {
  const m = /; yes ((?:e\d+,?)+)/.exec(text);
  return m === null ? [] : m[1]!.split(',').filter((t) => t !== '').map((t) => Number(t.slice(1)));
}
