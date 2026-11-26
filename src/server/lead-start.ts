import { isLive } from '../core/board';
import { AIDEN_OPEN_LIMIT, IN_FLIGHT_LIMIT, LEAD_START_MODEL, LEAD_START_PROVIDER, LEAD_STARTS_PER_DAY, type LeadEventKind } from '../core/lead';
import { startHandoff, startTitle } from '../core/lead-start';
import { stepRef } from '../core/step-ref';
import { write, type Ctx } from './db/tx';
import { badGateway, conflict } from './errors';
import { aidenOpenAsks, leadFolders, leadSwitches, logLeadEvent, requireLead } from './lead';
import { reasonOf } from './lead-relay';
import { intentHeadlines } from './lead-text';
import { requireNode } from './repo/nodes';
import { liveSessionUnder, readProjectSessions } from './repo/sessions';
import { parkedAncestor } from './repo/shelved';
import type { Sender, StartBody, StartOptions } from './lead/sends';
import { intendSend } from './repo/leadSends';
import { t3Start, type T3Options } from './t3';
import type { Project, TreeNode } from '../core/types';

/** Starts a T3 Code thread in a folder with a first message. Injected, so no test runs the t3 CLI. */
export type StartThread = (project: string, message: string, opts: StartOptions) => Promise<{ threadId: string }>;

/** The answer to a start that timed out: a thread may exist, so it is not started again. */
export const START_UNKNOWN = 'A thread may have been started. Do not run it again: read the brief and tell Aiden.';

/** What a second start meets while the first of the project is waiting on T3 Code. */
export const START_UNDER_WAY = 'A start for this project is under way. Wait for it to answer.';
/** The projects with a start waiting on T3 Code. Checked and set with no await between, so two starts at once cannot both go through. */
const underWay = new Set<number>();

const named = (value: string | undefined, fallback: string): string => (value !== undefined && value.trim() !== '' ? value.trim() : fallback);

/**
 * The start the server runs: T3 Code's, naming LEAD_START_PROVIDER and LEAD_START_MODEL (a start fails without them), or
 * the ones INPROGRESS_LEAD_PROVIDER and INPROGRESS_LEAD_MODEL give when set and not blank. `o` and `env` are for tests.
 */
export function defaultStart(o: T3Options = {}, env: Record<string, string | undefined> = process.env): StartThread {
  return (project, message, opts) =>
    t3Start(project, message, { ...opts, provider: named(env.INPROGRESS_LEAD_PROVIDER, LEAD_START_PROVIDER), model: named(env.INPROGRESS_LEAD_MODEL, LEAD_START_MODEL) }, o);
}

/** The provider and model a start names: INPROGRESS_LEAD_PROVIDER and INPROGRESS_LEAD_MODEL when set and not blank, else the defaults. */
export function startProviderModel(env: Record<string, string | undefined> = process.env): { provider: string; model: string } {
  return { provider: named(env.INPROGRESS_LEAD_PROVIDER, LEAD_START_PROVIDER), model: named(env.INPROGRESS_LEAD_MODEL, LEAD_START_MODEL) };
}

/** A restart's handoff: the lead's text for the fresh session, and the stopped session's branch and worktree. */
export interface RestartHandoff {
  text: string;
  branch: string | null;
  worktree: string | null;
}

/**
 * A start send's body, for `lead start` and for a restart alike: the first message startHandoff builds (the claim line, who
 * started it, not Aiden, not a go-ahead), with a restart's handoff, branch and worktree after it; the title startTitle
 * builds; the provider and model; a restart's worktree and branch; the step; and Aiden's words when the start was his.
 */
export function buildStartBody(i: {
  lead: string;
  projectName: string;
  node: TreeNode;
  goal: string;
  phase: string;
  aidenWords?: string;
  restart?: RestartHandoff;
}): StartBody {
  const first = startHandoff({
    lead: i.lead,
    projectName: i.projectName,
    stepId: i.node.id,
    stepTitle: i.node.title,
    what: i.node.what,
    why: i.node.why,
    goal: i.goal,
    phase: i.phase,
    onAidensWord: i.aidenWords !== undefined,
  });
  const r = i.restart;
  const message =
    r === undefined
      ? first
      : [first, '', 'This is a restart: a session before you stopped on this step. Its handoff:', '', r.text, '', `Branch: ${r.branch ?? '(not on record)'}`, `Worktree: ${r.worktree ?? '(not on record)'}`].join('\n');
  return {
    message,
    title: startTitle(i.node.id, i.node.title),
    ...startProviderModel(),
    ...(r?.worktree == null ? {} : { worktree: r.worktree }),
    ...(r?.branch == null ? {} : { branch: r.branch }),
    nodeId: i.node.id,
    ...(i.aidenWords === undefined ? {} : { aidenWords: i.aidenWords }),
  };
}

/**
 * The project's starts on the lead's own judgment (no words of Aiden's, not cleared) in the 24 hours before `nowMs`: what
 * LEAD_STARTS_PER_DAY limits. The start lines written before the sends (#743 task 8) count too, so a deploy resets nothing.
 * The day's thread start (retry key `morning-thread:...`) starts no step and does not count.
 */
export function ownStartsToday(ctx: Ctx, projectId: number, nowMs: number): number {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const sends = ctx.db
    .prepare(
      `SELECT COUNT(*) FROM lead_sends WHERE project_id = ? AND kind = 'start' AND state <> 'cleared' AND created_at >= ?
          AND (NOT json_valid(body) OR json_extract(body, '$.aidenWords') IS NULL)
          AND (retry_key IS NULL OR substr(retry_key, 1, length(?)) <> ?)`,
    )
    .pluck()
    .get(projectId, since, MORNING_THREAD_KEY, MORNING_THREAD_KEY) as number;
  const before = ctx.db
    .prepare(`SELECT COUNT(*) FROM lead_events e WHERE e.project_id = ? AND e.aiden_words IS NULL AND e.at >= ? AND ${LEGACY_START}`)
    .pluck()
    .get(projectId, since) as number;
  return sends + before;
}

/** The retry key prefix of the day's thread start (morning.ts): it starts no step, so it is no start of the lead's own. */
const MORNING_THREAD_KEY = 'morning-thread:';

const MINUTE_MS = 60 * 1000;
/** How long a started thread is given to claim its step: a second start of the step, and the in-flight count, wait that long. */
const CLAIM_WINDOW_MS = 10 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A start send of the step `?`: its body is checked as JSON before it is read. */
const START_OF_STEP = "kind = 'start' AND json_valid(body) AND json_extract(body, '$.nodeId') = ?";
/**
 * A `start` or `start_unknown` line (alias e) written before the sends (#743 task 8): no start send has its thread id, or
 * none of its step was written at or before it. Every start since writes its send first, so these are the old ones.
 */
const LEGACY_START = `(
  (e.kind = 'start' AND NOT EXISTS (SELECT 1 FROM lead_sends x WHERE x.project_id = e.project_id AND x.kind = 'start' AND x.result = e.text))
  OR (e.kind = 'start_unknown' AND NOT EXISTS (SELECT 1 FROM lead_sends x WHERE x.project_id = e.project_id AND x.kind = 'start' AND x.created_at <= e.at
        AND json_valid(x.body) AND json_extract(x.body, '$.nodeId') = e.node_id)))`;

export interface StartGuardInput {
  /** Aiden's words: without them the start is the lead's own judgment, under Starts and the limits. */
  aidenWords?: string;
  /** A session the live checks leave out: a restart's own stopped session. */
  exceptSession?: string;
}

/**
 * Every refusal of a start, as a 409 thrown before anything is written: the step's state, a session or thread already on it,
 * a start of it not yet settled, the project's intent, the step's What and Why, a folder, the in-flight limit, and for the
 * lead's own judgment the Starts switch, the open asks and the starts per day. Answers what the start needs. A restart
 * (stopped.ts) calls it too, so both refuse alike.
 */
export function startGuard(ctx: Ctx, project: Project, node: TreeNode, input: StartGuardInput): { folder: string; goal: string; phase: string } {
  if (node.projectId !== project.id) throw conflict(`#${node.id} is not in this project.`);
  if (node.parentId === null) throw conflict('The project itself cannot be started.');
  const ref_ = stepRef(node.id, node.title);
  if (node.status === 'done' || node.status === 'dropped') throw conflict(`#${node.id} is ${node.status}.`);
  if (node.status === 'parked') throw conflict(`#${node.id} is parked. Aiden unparks it first.`);
  const above = parkedAncestor(ctx, node.id);
  if (above !== null) throw conflict(`#${node.id} is under parked #${above}.`);
  if (liveSessionUnder(ctx, node.id, input.exceptSession)) throw conflict(`${ref_} already has a session working on it.`);

  const nowMs = Date.parse(ctx.now());
  const since = new Date(nowMs - CLAIM_WINDOW_MS).toISOString();
  const others = readProjectSessions(ctx, project.id).filter((s) => s.id !== input.exceptSession && isLive(s, nowMs));
  // A live session may carry a thread this step was started with and not yet have claimed the step (its focus is elsewhere).
  // The starts are lead_sends rows (src/server/lead/sends.ts), and before them `start` lines: a cleared send holds nothing.
  const carried = [
    ...(ctx.db.prepare(`SELECT result FROM lead_sends WHERE project_id = ? AND state = 'done' AND ${START_OF_STEP}`).pluck().all(project.id, node.id) as string[]),
    ...(ctx.db.prepare(`SELECT e.text FROM lead_events e WHERE e.project_id = ? AND e.node_id = ? AND e.kind = 'start' AND ${LEGACY_START}`).pluck().all(project.id, node.id) as string[]),
  ];
  const holder = others.find((s) => s.t3ThreadId !== null && carried.includes(s.t3ThreadId));
  if (holder !== undefined) throw conflict(`${ref_} already has a thread open (${holder.t3ThreadId}) that has not claimed it. Tell Aiden.`);
  // An intended or unknown start holds the step with no time limit: it may yet be a thread, and FIRST may yet give it its
  // first message. A done one holds it for the claim window, as the old start lines do.
  const unsettled = ctx.db
    .prepare(`SELECT state FROM lead_sends WHERE project_id = ? AND state IN ('intended', 'unknown') AND ${START_OF_STEP} ORDER BY created_at DESC, id DESC LIMIT 1`)
    .pluck()
    .get(project.id, node.id) as string | undefined;
  if (unsettled === 'unknown') throw conflict(`A start for ${ref_} may have made a thread, and is on the desk to be cleared. Clear it first.`);
  if (unsettled === 'intended') throw conflict(`A start for ${ref_} has not answered yet. Wait for it.`);
  const recent = ctx.db
    .prepare(
      `SELECT at FROM (
         SELECT created_at AS at FROM lead_sends WHERE project_id = ? AND state = 'done' AND created_at >= ? AND ${START_OF_STEP}
         UNION ALL SELECT e.at AS at FROM lead_events e WHERE e.project_id = ? AND e.node_id = ? AND e.at >= ? AND ${LEGACY_START}
       ) ORDER BY at DESC LIMIT 1`,
    )
    .pluck()
    .get(project.id, since, node.id, project.id, node.id, since) as string | undefined;
  if (recent !== undefined) {
    const minutes = Math.max(1, Math.round((nowMs - Date.parse(recent)) / MINUTE_MS));
    throw conflict(`A thread was started for ${ref_} ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago. Give it time to claim the step.`);
  }

  const { goal, phase } = intentHeadlines(project.intent);
  if (!goal || !phase) throw conflict('This project has no intent record yet, so nothing can be started.');
  if (!node.what.trim() || !node.why.trim()) throw conflict(`${ref_} has no What and Why yet. Tell Aiden.`);
  const [folder] = leadFolders(ctx, project.id);
  if (folder === undefined) throw conflict('This project has no folder on record, so no thread can be started.');

  // In flight: the project's live sessions, and the threads started in the claim window that no session carries yet.
  const unclaimed =
    (ctx.db
      .prepare(
        `SELECT COUNT(*) FROM lead_sends e
          WHERE e.project_id = ? AND e.kind = 'start' AND e.state <> 'cleared' AND e.created_at >= ?
            AND (e.result IS NULL OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.t3_thread_id = e.result))`,
      )
      .pluck()
      .get(project.id, since) as number) +
    (ctx.db
      .prepare(`SELECT COUNT(*) FROM lead_events e WHERE e.project_id = ? AND e.at >= ? AND ${LEGACY_START} AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.t3_thread_id = e.text)`)
      .pluck()
      .get(project.id, since) as number);
  const live = others.length;
  if (live + unclaimed >= IN_FLIGHT_LIMIT) {
    const notClaimed = unclaimed === 0 ? '' : ` (${unclaimed} started and not claimed yet)`;
    throw conflict(`${live + unclaimed} sessions are in flight${notClaimed}, and the limit is ${IN_FLIGHT_LIMIT}. Wait for one to end.`);
  }

  if (input.aidenWords === undefined) {
    if (!leadSwitches(ctx, project.id).starts.on) throw conflict("Starts is off for this project: starting a thread needs Aiden's words. Pass them with --aiden.");
    const open = aidenOpenAsks(ctx, project.id).project;
    if (open >= AIDEN_OPEN_LIMIT) throw conflict(`Aiden has ${open} open asks in this project, and the limit is ${AIDEN_OPEN_LIMIT}. Bring those to him first.`);
    const own = ownStartsToday(ctx, project.id, nowMs);
    if (own >= LEAD_STARTS_PER_DAY) {
      throw conflict(`You have started ${own} threads on your own judgment in the last 24 hours, and the limit is ${LEAD_STARTS_PER_DAY}. Ask Aiden.`);
    }
  }
  return { folder, goal, phase };
}

/**
 * The lead starts a T3 Code thread for a step: checked by startGuard (every refusal is a 409 thrown before anything is
 * started or written), written as an intended send and carried out by the sender outside any write, never repeated, then
 * logged in one write whatever it did. A start that may have made a thread answers START_UNKNOWN, any other failure
 * `Not started: <reason>`, both as a 502. Without Aiden's words the start is the lead's own judgment.
 */
export async function leadStart(
  ctx: Ctx,
  ref: string,
  as: string,
  instructions: number,
  input: { stepId: number; aidenWords?: string },
  sender: Sender,
): Promise<{ text: string; threadId: string }> {
  const project = requireLead(ctx, ref, as, instructions, true);
  if (underWay.has(project.id)) throw conflict(START_UNDER_WAY);
  // requireLead has matched `as` against the stored name, so it is set.
  const name = project.lead as string;
  const actor = `lead:${name}`;
  const node = requireNode(ctx, input.stepId);
  const ref_ = stepRef(node.id, node.title);
  const { folder, goal, phase } = startGuard(ctx, project, node, input.aidenWords === undefined ? {} : { aidenWords: input.aidenWords });

  const body = buildStartBody({ lead: name, projectName: project.name, node, goal, phase, ...(input.aidenWords === undefined ? {} : { aidenWords: input.aidenWords }) });
  let kind: LeadEventKind;
  let threadId = '';
  let reason = '';
  // Set before the first await, so a second start of the project that comes in while this one waits is refused.
  underWay.add(project.id);
  try {
    // Written as intended before the start, and carried out by the sender: a start that may have reached T3 Code is only
    // ever looked up by the marker in its title, never started again.
    const send = write(ctx, actor, () => intendSend(ctx.db, { projectId: project.id, kind: 'start', target: folder, body: JSON.stringify(body) }, ctx.now()));
    const outcome = await sender.perform(send.id, { clearIfNotSent: true });
    if (outcome.state === 'done') {
      threadId = outcome.result;
      kind = 'start';
    } else if (outcome.state === 'cleared' || outcome.state === 'waiting') {
      reason = reasonOf(outcome.reason);
      kind = 'start_failed';
      console.error(`InProgress: a thread for #${node.id} was not started: ${reason}`);
    } else {
      reason = outcome.state === 'lookup' ? reasonOf(outcome.reason) : 'the start was no longer intended';
      kind = 'start_unknown';
    }
    try {
      write(ctx, actor, (record) => {
        logLeadEvent(ctx, {
          projectId: project.id,
          lead: name,
          instructions,
          kind,
          nodeId: node.id,
          text: kind === 'start' ? threadId : reason,
          ...(input.aidenWords === undefined ? {} : { aidenWords: input.aidenWords }),
        });
        // The log line alone moves nothing on the project's stream: this is what makes an open Lead view read the brief again.
        record({ projectId: project.id, type: 'project.updated', entity: 'project', entityId: project.id, data: { changes: { started: kind } } });
      });
    } catch (err) {
      // The start has happened (or not) whatever the log says: the lead is still told which.
      console.error(`InProgress: a start for #${node.id} (${kind}) could not be logged: ${reasonOf(err)}`);
    }
  } finally {
    underWay.delete(project.id);
  }
  // After the commit: the sender carries out what waits behind this start (its wake never throws).
  void sender.wake();
  if (kind === 'start_unknown') throw badGateway(START_UNKNOWN);
  if (kind === 'start_failed') throw badGateway(`Not started: ${reason}`);
  return { text: `Started a thread for ${ref_}: ${threadId}. It claims the step on its first turn.`, threadId };
}
