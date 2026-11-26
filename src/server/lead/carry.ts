import { heldActions, playbookHeldLines } from '../../core/hold';
import { clipLine } from '../../core/step-ref';
import type { HeldCard, Project } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { conflict, notFound } from '../errors';
import { carriedLine, isOldAsk, oldAskAnswerLine, requireAnswerLead, workProject, WORK_PROJECT, YES_ACTIONS, type AnswerWhere, type CarriedYes, type YesAction } from '../lead-commands';
import { logLeadEvent } from '../lead';
import { getDeskItem, moveDeskItem, type DeskItem } from '../repo/desk';
import { askOf, DECISION_LINE_CUT, reachableThread, t3SessionOnStep } from '../repo/deskBring';
import { addDecision } from '../repo/leadDecisions';
import { getSend, intendSend, sendByRetryKey, type LeadSend } from '../repo/leadSends';
import { addLogInWrite } from '../repo/logs';
import { checkLanding, realGit, recordYes, type LandingDeps } from './landing';
import { aidenSaidWords } from './aidenSaid';
import { heldRef, heldWhatOf } from './hold';

/*
 * Carrying Aiden's answer (lead stage 1, #743, task 11 and its fixes): what his yes covers, read from git, and his reply to
 * a line from the Voice, found from the line's send.
 */

/** The line an answer prints when the work moved after his word (W8). */
export const CHANGED_AFTER = 'the work changed after his word';
/** The line an answer prints for a review's yes given with no time of his (W8a). */
export const SAID_AT_NEEDED = 'give --said-at with a yes';

/**
 * The yes for each action, read now in the session's folder on its branch, as the landing check keys it (nothing logged):
 * a merge, deploy or push on the change of the branch (main...branch, as a merge reads it), a publish on the tree of the
 * branch's head (what a publish sends). No yes when the change cannot be read, or when the branch's newest commit is after
 * his words (`saidAt`): what he said yes to is not what is there now.
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
  /** One read of the landing check: the key a yes is recorded on for `action`, or why there is none. */
  const keyOf = async (action: 'merge' | 'publish'): Promise<{ patchId: string } | { why: string }> => {
    try {
      const read = await checkLanding(ctx, { ref, stepId, action, folder, ...(branch === undefined ? {} : { branch }) }, deps, { record: false });
      if (read.patchId === null) return { why: 'there is no change to read' };
      // The range ends at the branch read: main...branch, or origin/branch..branch for a publish of a pushed branch.
      const tip = read.range.split(/\.{2,3}/)[1] ?? 'HEAD';
      const log = await (deps?.git ?? realGit)(folder, ['log', '-1', '--format=%cI', tip, '--']);
      const newest = log.code === 0 ? Date.parse(log.stdout.trim()) : NaN;
      if (Number.isNaN(newest)) return { why: `could not tell when ${tip.replace('refs/heads/', '')} last changed` };
      // git gives whole seconds: a commit in the same second as his word counts as before it.
      if (newest > Math.floor(Date.parse(saidAt) / 1000) * 1000) return { why: CHANGED_AFTER };
      return { patchId: read.patchId };
    } catch (err) {
      return { why: (err as Error).message.replace(/\.+$/, '') };
    }
  };
  const change = actions.some((a) => a !== 'publish') ? await keyOf('merge') : undefined;
  const tree = actions.includes('publish') ? await keyOf('publish') : undefined;
  return actions.map((action) => {
    const key = (action === 'publish' ? tree : change)!;
    return 'patchId' in key ? { action, patchId: key.patchId } : { action, patchId: null, why: key.why };
  });
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

/**
 * The actions of a held item's command that a yes can be recorded for (YES_ACTIONS), read from its command as the hold read
 * it, in its session's folder: a yes for a held command covers only what that command does.
 */
export function heldYesActions(ctx: Ctx, project: Project, held: { sessionId: string | null; command: string }): YesAction[] {
  const cwd = held.sessionId === null ? null : ((ctx.db.prepare('SELECT cwd FROM sessions WHERE id = ?').pluck().get(held.sessionId) as string | null | undefined) ?? null);
  const own = new Set(heldActions(held.command, playbookHeldLines(project.playbook), cwd).map((m) => m.action as string));
  return YES_ACTIONS.filter((a) => own.has(a));
}

/** How many held cards the window is sent for one project at most. */
const HELD_CARDS_MAX = 100;

/**
 * The project's held items waiting on Aiden, oldest first, for the window's Needs me (lead stage 1, task D): what each
 * command does (heldWhatOf, or the command for an item held before that was stored) and the command itself.
 */
export function heldCards(ctx: Ctx, projectId: number): HeldCard[] {
  const rows = ctx.db
    .prepare("SELECT id FROM desk_items WHERE project_id = ? AND kind = 'held' AND state = 'waiting_aiden' ORDER BY created_at, id LIMIT ?")
    .pluck()
    .all(projectId, HELD_CARDS_MAX) as number[];
  return rows.flatMap((id) => {
    const item = getDeskItem(ctx.db, id);
    if (item === undefined) return [];
    const { command } = heldScope(ctx, item);
    return [{ id: item.id, stepId: item.nodeId, createdAt: item.createdAt, what: heldWhatOf(item.outcome) ?? command, command }];
  });
}

export interface ItemAnswerInput {
  aidenWords: string;
  where?: AnswerWhere;
  saidAt?: string;
  shown?: number[];
  /** For a held action, the yes for each action he okayed, read before the write (readSessionYeses). */
  yeses?: CarriedYes[];
  /** Lines the route adds to the answer: what of --yes or --says was not used, and why. */
  notes?: string[];
  /** The window's answer to a held card: the item must be a held one still waiting on Aiden, else a 409 and nothing changes. */
  heldWaiting?: boolean;
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
    if (input.heldWaiting && (item.kind !== 'held' || item.state !== 'waiting_aiden')) throw conflict(`Desk item #${item.id} is not a held command waiting on Aiden.`);
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
    // A held item's line to the Voice not yet tried is never spoken once he has answered it (the window answers before it goes).
    if (held !== undefined) {
      ctx.db.prepare("UPDATE lead_sends SET state = 'cleared' WHERE item_id = ? AND kind = 'voice_line' AND state = 'intended' AND result IS NULL").run(item.id);
    }
    // His words reach only a reachable thread (reachableThread): the held command's session, or the step's session now. An
    // item about an old ask (isOldAsk) is never carried: the step's log records his words.
    const asked = item.kind === 'held' || item.kind === 'aiden_said' ? undefined : askOf(ctx, item);
    const oldAsk = item.kind === 'old_ask' || (asked !== undefined && isOldAsk(ctx.db, asked));
    const thread = oldAsk
      ? null
      : held !== undefined
        ? reachableThread(ctx.db, { sessionId: held.sessionId }, ctx.now())
        : item.nodeId === null
          ? null
          : reachableThread(ctx.db, { sessionId: t3SessionOnStep(ctx, item.nodeId) }, ctx.now());
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
      addLogInWrite(ctx, record, item.nodeId, oldAsk && asked !== undefined ? oldAskAnswerLine(asked.id, input.aidenWords) : said);
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

/**
 * The relay target a carried answer went to, for its undo: the carry send of the ask or of the item, while its thread is
 * reachable (reachableThread). Else no withdrawal relay: the undo's log line and the ask's answer say it.
 */
export function carryTarget(ctx: Ctx, answer: { askId: number | null; text: string }): string | undefined {
  const item = /; item (\d+)/.exec(answer.text);
  const key = answer.askId !== null ? `carry:a${answer.askId}` : item !== null ? `carry:i${item[1]}` : undefined;
  const target = key === undefined ? undefined : liveTarget(ctx, key);
  return reachableThread(ctx.db, { threadId: target }, ctx.now()) ?? undefined;
}

/** The yes rows an answer recorded, from its line's `yes e12,e13`. */
export function answerYesIds(text: string): number[] {
  const m = /; yes ((?:e\d+,?)+)/.exec(text);
  return m === null ? [] : m[1]!.split(',').filter((t) => t !== '').map((t) => Number(t.slice(1)));
}
