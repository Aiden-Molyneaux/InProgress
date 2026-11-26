import { heldActions, isUpstreamOfMain, mergeTargets, playbookHeldLines, pushTarget, type HeldMatch } from '../../core/hold';
import { goesOutWhy, ONLY_YOU } from '../../core/landing';
import { clipLine } from '../../core/step-ref';
import type { HeldCard, Project } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { conflict, notFound } from '../errors';
import { carriedLine, isOldAsk, oldAskAnswerLine, requireAnswerLead, workProject, WORK_PROJECT, YES_ACTIONS, type AnswerWhere, type CarriedYes, type YesAction } from '../lead-commands';
import { logLeadEvent } from '../lead';
import { getDeskItem, moveDeskItem, type DeskItem } from '../repo/desk';
import { askOf, DECISION_LINE_CUT, reachableThread, t3SessionOnStep } from '../repo/deskBring';
import { addDecision } from '../repo/leadDecisions';
import { clearUntriedVoiceLines, getSend, intendSend, sendByRetryKey, type LeadSend } from '../repo/leadSends';
import { addLogInWrite } from '../repo/logs';
import { shelvedAmong } from '../repo/shelved';
import { checkLanding, landingKey, PUBLISH_NO_YES, realGit, recordYes, type LandingDeps } from './landing';
import { aidenSaidWords } from './aidenSaid';
import { heldKeysOf, heldLandingAsk, heldLines, heldWhatOf, publishesFolderPackage, type HeldKeys, type HeldLine } from './hold';

/*
 * Carrying Aiden's answer (lead stage 1, #743, task 11 and its fixes): what his yes covers, read from git, and his reply to
 * a line from the Voice, found from the line's send.
 */

/** The line an answer prints when the work moved after his word (W8). */
export const CHANGED_AFTER = 'the work changed after his word';
/** Why a held command's yes is not recorded: what it would do now is not what was held (another folder, branch or change). */
export const CHANGED_SINCE_HELD = 'it changed after it was held';
/** Why a held command's yes is not recorded when the hold kept no key for it. */
export const NOT_KEYED = 'it was not checked when it was held: run it yourself';
/** The line an answer prints for a review's yes given with no time of his (W8a). */
export const SAID_AT_NEEDED = 'give --said-at with a yes';

/** Whether the newest commit at `tip` in `folder` is after `asOf` (git gives whole seconds: one in the same second counts as before). */
async function changedAfter(folder: string, tip: string, asOf: string, deps?: LandingDeps): Promise<boolean | { why: string }> {
  const log = await (deps?.git ?? realGit)(folder, ['log', '-1', '--format=%cI', tip, '--']);
  const newest = log.code === 0 ? Date.parse(log.stdout.trim()) : NaN;
  if (Number.isNaN(newest)) return { why: `could not tell when ${tip.replace('refs/heads/', '')} last changed` };
  return newest > Math.floor(Date.parse(asOf) / 1000) * 1000;
}

/**
 * The yes for each action of a review, read now in the session's folder on its branch (nothing logged): a merge, deploy or
 * push on the change of the branch (main...branch, as a merge reads it). A publish takes none on a review (PUBLISH_NO_YES:
 * its key is what goes out, which only a held publish names). No yes when the change cannot be read, or when the branch's
 * newest commit is after his words (`saidAt`): what he said yes to is not what is there now.
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
  const none = (why: string): CarriedYes[] => actions.map((action) => ({ action, patchId: null, why: action === 'publish' ? PUBLISH_NO_YES : why }));
  const session = sessionId === null ? undefined : (ctx.db.prepare('SELECT cwd, branch FROM sessions WHERE id = ?').get(sessionId) as { cwd: string | null; branch: string | null } | undefined);
  const folder = session?.cwd ?? null;
  if (folder === null || folder.trim() === '') return none('its session has no folder on record');
  const branch = session?.branch ? session.branch : undefined;
  /** One read of the landing check for a merge: the key a yes is recorded on, or why there is none. */
  const change = actions.some((a) => a !== 'publish')
    ? await (async (): Promise<{ patchId: string } | { why: string }> => {
        try {
          const read = await checkLanding(ctx, { ref, stepId, action: 'merge', folder, ...(branch === undefined ? {} : { branch }) }, deps, { record: false });
          if (read.patchId === null) return { why: 'there is no change to read' };
          // The range is main...branch: its end is the branch read.
          const after = await changedAfter(folder, read.range.split(/\.{2,3}/)[1] ?? 'HEAD', saidAt, deps);
          if (after !== false) return { why: after === true ? CHANGED_AFTER : after.why };
          return { patchId: read.patchId };
        } catch (err) {
          return { why: (err as Error).message.replace(/\.+$/, '') };
        }
      })()
    : undefined;
  return actions.map((action) => {
    if (action === 'publish') return { action, patchId: null, why: PUBLISH_NO_YES };
    const key = change!;
    return 'patchId' in key ? { action, patchId: key.patchId } : { action, patchId: null, why: key.why };
  });
}

/** The folder a session ran in, as recorded; null when it has none. */
const sessionCwd = (ctx: Ctx, sessionId: string | null): string | null =>
  sessionId === null ? null : ((ctx.db.prepare('SELECT cwd FROM sessions WHERE id = ?').pluck().get(sessionId) as string | null | undefined) ?? null);

/** The commands of a held line on the list, each with the folder it runs in, read from the line's own session's folder. */
const heldMatches = (ctx: Ctx, project: Project, line: Pick<HeldLine, 'sessionId' | 'command'>): HeldMatch[] =>
  heldActions(line.command, playbookHeldLines(project.playbook), sessionCwd(ctx, line.sessionId));

/**
 * Whether a yes can release one command of a held line, read from its words alone: a merge, deploy, push or publish the
 * landing check reads (a playbook line, a pull request's merge, a delete or a repository change never is), in a folder that
 * can be read, a push to origin and a merge of one branch, and a publish of its folder's own package (publishesFolderPackage).
 */
function yesCanRelease(m: HeldMatch): boolean {
  if (!(YES_ACTIONS as readonly string[]).includes(m.action) || m.folder === null) return false;
  if (m.action === 'publish') return publishesFolderPackage(m.segment);
  if (m.action === 'push') {
    const target = pushTarget(m.segment);
    return target.ok && target.remote === 'origin';
  }
  if (m.action === 'merge') {
    const targets = mergeTargets(m.segment);
    return targets.length === 1 && !isUpstreamOfMain(targets[0]!);
  }
  return true;
}

/**
 * Whether Go ahead is offered on a held item: it is on a step, its held line is found, the hold stored what it checked
 * (heldKeysOf) with a key for every action of it, and a yes can release every command of it on the list (yesCanRelease); a
 * push held as public is never released by a yes. Read without git: a yes that cannot be recorded when he clicks (it changed
 * after the hold, a folder with changes not committed) is the route's 409.
 */
export function heldGoAhead(ctx: Ctx, project: Project, item: Pick<DeskItem, 'nodeId' | 'outcome'>, line: HeldLine | undefined): boolean {
  if (item.nodeId === null || line === undefined) return false;
  if (line.why.includes(goesOutWhy('push-public'))) return false;
  const stored = heldKeysOf(item.outcome);
  if (stored === undefined) return false;
  const matches = heldMatches(ctx, project, line);
  return matches.length > 0 && matches.every((m) => yesCanRelease(m) && m.action in stored.keys);
}

/**
 * The yes for each command of a held line his go-ahead covers (`actions`, every one when absent): exactly what the hold
 * checked (`stored`, heldKeysOf). Each command's key is read now as the landing check reads it (heldLandingAsk, then
 * landingKey) in the folder the hold stored, never the session's own, and a yes is recorded only when the checkout still
 * reads the branch the hold read and the key is the one the hold computed. Else no yes: CHANGED_SINCE_HELD, NOT_KEYED for an
 * action the hold kept no key for (or an item with none), PUBLISH_NO_YES for a publish that does not send its folder's
 * package as committed, or why its target cannot be read. A push with nothing to send needs none. Nothing logged.
 */
export async function readHeldYeses(
  ctx: Ctx,
  project: Project,
  line: HeldLine | undefined,
  stored: HeldKeys | undefined,
  actions: readonly YesAction[] | undefined,
  deps?: LandingDeps,
): Promise<CarriedYes[]> {
  const wanted = (a: string): a is YesAction => (YES_ACTIONS as readonly string[]).includes(a) && (actions === undefined || actions.includes(a as YesAction));
  if (line === undefined) return (actions ?? []).map((action) => ({ action, patchId: null, why: 'its held line is not found' }));
  const out: CarriedYes[] = [];
  for (const m of heldMatches(ctx, project, line)) {
    const action = m.action;
    if (!wanted(action)) continue;
    if (action === 'publish' && !publishesFolderPackage(m.segment)) {
      out.push({ action, patchId: null, why: PUBLISH_NO_YES });
      continue;
    }
    const kept = stored?.keys[action];
    if (stored === undefined || kept === undefined) {
      out.push({ action, patchId: null, why: NOT_KEYED });
      continue;
    }
    try {
      // The command as it reads now in the folder the hold read it in.
      const asked = await heldLandingAsk({ ...m, folder: stored.folder }, deps);
      if (!('check' in asked)) {
        out.push({ action, patchId: null, why: asked.clear ? CHANGED_SINCE_HELD : asked.why });
        continue;
      }
      if (asked.read !== stored.branch) {
        out.push({ action, patchId: null, why: CHANGED_SINCE_HELD });
        continue;
      }
      const key = await landingKey(stored.folder, asked.action, asked.branch, action === 'publish' ? m.segment : undefined, deps);
      if (key.nothingToPush) {
        out.push({ action, patchId: null, why: 'nothing to push', needless: true });
        continue;
      }
      if (key.patchId === null) {
        out.push({ action, patchId: null, why: action === 'publish' ? PUBLISH_NO_YES : 'there is no change to read' });
        continue;
      }
      if (kept === null || key.patchId !== kept) out.push({ action, patchId: null, why: CHANGED_SINCE_HELD });
      else if (!out.some((y) => y.action === action && y.patchId === key.patchId)) out.push({ action, patchId: key.patchId });
    } catch (err) {
      out.push({ action, patchId: null, why: (err as Error).message.replace(/\.+$/, '') });
    }
  }
  return out;
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

/** The held line a held item was made from (heldLines), or undefined when it is not found. */
export const heldLineOf = (ctx: Ctx, item: Pick<DeskItem, 'projectId' | 'ref'>): HeldLine | undefined => heldLines(ctx.db, item.projectId).get(item.ref);

/** The session and command a held item is about: its held line's (heldLineOf), or no session and no command when none is found. */
export function heldScope(ctx: Ctx, item: Pick<DeskItem, 'projectId' | 'ref'>): { sessionId: string | null; command: string } {
  const line = heldLineOf(ctx, item);
  return line === undefined ? { sessionId: null, command: '' } : { sessionId: line.sessionId, command: line.command };
}

/**
 * The actions of a held item's command that a yes can be recorded for (YES_ACTIONS), read from its command as the hold read
 * it, in its session's folder: a yes for a held command covers only what that command does.
 */
export function heldYesActions(ctx: Ctx, project: Project, held: { sessionId: string | null; command: string }): YesAction[] {
  const own = new Set(heldMatches(ctx, project, held).map((m) => m.action as string));
  return YES_ACTIONS.filter((a) => own.has(a));
}

/** How many held cards the window is sent for one project at most. */
const HELD_CARDS_MAX = 100;
/** How much of a held command a card carries. */
const HELD_COMMAND_MAX = 2_000;

/**
 * The project's held items waiting on Aiden, oldest first, for the window's Needs me (lead stage 1, task D): what each
 * command does (heldWhatOf, or the command for an item held before that was stored), the command itself (clipped), and
 * whether Go ahead is offered (heldGoAhead). `total` counts every one waiting, past the cap. A project under C:\work shows
 * none, and neither does a step that is parked or under a parked one (as its asks are hidden).
 */
export function heldCards(ctx: Ctx, projectId: number): { cards: HeldCard[]; total: number } {
  if (workProject(ctx, projectId)) return { cards: [], total: 0 };
  const project = ctx.db.prepare('SELECT playbook FROM projects WHERE id = ?').get(projectId) as Pick<Project, 'playbook'> | undefined;
  if (project === undefined) return { cards: [], total: 0 };
  const rows = ctx.db
    .prepare("SELECT id, node_id FROM desk_items WHERE project_id = ? AND kind = 'held' AND state = 'waiting_aiden' ORDER BY created_at, id")
    .all(projectId) as { id: number; node_id: number | null }[];
  const shelved = shelvedAmong(ctx, [...new Set(rows.flatMap((r) => (r.node_id === null ? [] : [r.node_id])))]);
  const shown = rows.filter((r) => r.node_id === null || !shelved.has(r.node_id));
  if (shown.length === 0) return { cards: [], total: 0 };
  const lines = heldLines(ctx.db, projectId);
  const cards = shown.slice(0, HELD_CARDS_MAX).flatMap((r) => {
    const item = getDeskItem(ctx.db, r.id);
    if (item === undefined) return [];
    const line = lines.get(item.ref);
    const command = line?.command ?? '';
    return [
      {
        id: item.id,
        stepId: item.nodeId,
        createdAt: item.createdAt,
        what: heldWhatOf(item.outcome) ?? clipLine(command, HELD_COMMAND_MAX),
        command: command.length > HELD_COMMAND_MAX ? `${command.slice(0, HELD_COMMAND_MAX - 1)}…` : command,
        goAhead: heldGoAhead(ctx, project as Project, item, line),
      },
    ];
  });
  return { cards, total: shown.length };
}

export interface ItemAnswerInput {
  aidenWords: string;
  where?: AnswerWhere;
  saidAt?: string;
  shown?: number[];
  /** For a held action, the yes for each action he okayed, read before the write (readHeldYeses). */
  yeses?: CarriedYes[];
  /** Lines the route adds to the answer: what of --yes or --says was not used, and why. */
  notes?: string[];
  /** The window's answer to a held card: the item must be a held one still waiting on Aiden, else a 409 and nothing changes. */
  heldWaiting?: boolean;
  /** Who the write is recorded as, when not the lead (the window's answer is the window's). */
  actor?: string;
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
  return write(ctx, input.actor ?? actor, (record) => {
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
      if (got.length) lines.push(`His yes covers ${[...new Set(got.map((y) => y.action))].join(', ')} of the change as it is now.`);
      for (const y of yeses.filter((y) => y.patchId === null)) {
        lines.push(y.needless ? `No yes needed for ${y.action}: ${y.why ?? 'the landing check clears it'}.` : `No yes recorded for ${y.action}: ${y.why ?? 'the change could not be read'}.`);
      }
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
    if (held !== undefined) clearUntriedVoiceLines(ctx.db, [item.id]);
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
