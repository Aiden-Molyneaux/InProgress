import { isLive } from '../core/board';
import { AIDEN_OPEN_LIMIT, IN_FLIGHT_LIMIT, LEAD_START_MODEL, LEAD_START_PROVIDER, LEAD_STARTS_PER_DAY, type LeadEventKind } from '../core/lead';
import { startHandoff, startTitle } from '../core/lead-start';
import { stepRef } from '../core/step-ref';
import { write, type Ctx } from './db/tx';
import { badGateway, conflict } from './errors';
import { leadFolders, leadSwitches, logLeadEvent, requireLead } from './lead';
import { reasonOf } from './lead-relay';
import { intentHeadlines } from './lead-text';
import { requireNode } from './repo/nodes';
import { listProjectSummaries } from './repo/projects';
import { liveSessionUnder, readProjectSessions } from './repo/sessions';
import { parkedAncestor } from './repo/shelved';
import { T3Unavailable, t3Start, type T3Options } from './t3';

/** Starts a T3 Code thread in a folder with a first message. Injected, so no test runs the t3 CLI. */
export type StartThread = (project: string, message: string, opts: { title?: string }) => Promise<{ threadId: string }>;

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

const MINUTE_MS = 60 * 1000;
/** How long a started thread is given to claim its step: a second start of the step, and the in-flight count, wait that long. */
const CLAIM_WINDOW_MS = 10 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The lead starts a T3 Code thread for a step: checked (every refusal is a 409 thrown before anything is started or written),
 * started outside any write (write() cannot hold an await) and never repeated, then logged in one write whatever it did. A start
 * that timed out after it may have made a thread answers START_UNKNOWN, any other failure `Not started: <reason>`, both as a 502.
 * Without Aiden's words the start is the lead's own judgment: it needs Starts on, and stays inside the daily and open-ask limits.
 */
export async function leadStart(
  ctx: Ctx,
  ref: string,
  as: string,
  instructions: number,
  input: { stepId: number; aidenWords?: string },
  start: StartThread = defaultStart(),
): Promise<{ text: string; threadId: string }> {
  const project = requireLead(ctx, ref, as, instructions, true);
  if (underWay.has(project.id)) throw conflict(START_UNDER_WAY);
  // requireLead has matched `as` against the stored name, so it is set.
  const name = project.lead as string;
  const actor = `lead:${name}`;
  const node = requireNode(ctx, input.stepId);
  if (node.projectId !== project.id) throw conflict(`#${node.id} is not in this project.`);
  if (node.parentId === null) throw conflict('The project itself cannot be started.');
  const ref_ = stepRef(node.id, node.title);
  if (node.status === 'done' || node.status === 'dropped') throw conflict(`#${node.id} is ${node.status}.`);
  if (node.status === 'parked') throw conflict(`#${node.id} is parked. Aiden unparks it first.`);
  const above = parkedAncestor(ctx, node.id);
  if (above !== null) throw conflict(`#${node.id} is under parked #${above}.`);
  if (liveSessionUnder(ctx, node.id)) throw conflict(`${ref_} already has a session working on it.`);

  const nowMs = Date.parse(ctx.now());
  // A live session may carry a thread this step was started with and not yet have claimed the step (its focus is elsewhere).
  const carried = ctx.db
    .prepare("SELECT e.text FROM lead_events e WHERE e.project_id = ? AND e.node_id = ? AND e.kind = 'start' ORDER BY e.at DESC, e.id DESC")
    .pluck()
    .all(project.id, node.id) as string[];
  const holder = readProjectSessions(ctx, project.id).find((s) => isLive(s, nowMs) && s.t3ThreadId !== null && carried.includes(s.t3ThreadId));
  if (holder !== undefined) throw conflict(`${ref_} already has a thread open (${holder.t3ThreadId}) that has not claimed it. Look at that thread first.`);
  const recent = ctx.db
    .prepare("SELECT at FROM lead_events WHERE project_id = ? AND node_id = ? AND kind IN ('start', 'start_unknown') AND at >= ? ORDER BY at DESC, id DESC LIMIT 1")
    .get(project.id, node.id, new Date(nowMs - CLAIM_WINDOW_MS).toISOString()) as { at: string } | undefined;
  if (recent !== undefined) {
    const minutes = Math.max(1, Math.round((nowMs - Date.parse(recent.at)) / MINUTE_MS));
    throw conflict(`A thread was started for ${ref_} ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago. Give it time to claim the step.`);
  }

  const { goal, phase } = intentHeadlines(project.intent);
  if (!goal || !phase) throw conflict('This project has no intent record yet, so nothing can be started.');
  if (!node.what.trim() || !node.why.trim()) throw conflict(`${ref_} has no What and Why yet. Tell Aiden.`);
  const [folder] = leadFolders(ctx, project.id);
  if (folder === undefined) throw conflict('This project has no folder on record, so no thread can be started.');

  // In flight: the project's live sessions, and the threads started in the claim window that no session carries yet.
  const live = readProjectSessions(ctx, project.id).filter((s) => isLive(s, nowMs)).length;
  const unclaimed = ctx.db
    .prepare(
      `SELECT COUNT(*) FROM lead_events e
        WHERE e.project_id = ? AND e.kind IN ('start', 'start_unknown') AND e.at >= ?
          AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.t3_thread_id = e.text)`,
    )
    .pluck()
    .get(project.id, new Date(nowMs - CLAIM_WINDOW_MS).toISOString()) as number;
  if (live + unclaimed >= IN_FLIGHT_LIMIT) {
    const notClaimed = unclaimed === 0 ? '' : ` (${unclaimed} started and not claimed yet)`;
    throw conflict(`${live + unclaimed} sessions are in flight${notClaimed}, and the limit is ${IN_FLIGHT_LIMIT}. Wait for one to end.`);
  }

  if (input.aidenWords === undefined) {
    if (!leadSwitches(ctx, project.id).starts.on) throw conflict("Starts is off for this project: starting a thread needs Aiden's words. Pass them with --aiden.");
    const open = listProjectSummaries(ctx)
      .filter((p) => p.status === 'active')
      .reduce((sum, p) => sum + p.openAsks, 0);
    if (open >= AIDEN_OPEN_LIMIT) throw conflict(`Aiden has ${open} open asks, and the limit is ${AIDEN_OPEN_LIMIT}. Bring those to him first.`);
    const own = ctx.db
      .prepare("SELECT COUNT(*) FROM lead_events WHERE project_id = ? AND kind IN ('start', 'start_unknown') AND aiden_words IS NULL AND at >= ?")
      .pluck()
      .get(project.id, new Date(nowMs - DAY_MS).toISOString()) as number;
    if (own >= LEAD_STARTS_PER_DAY) {
      throw conflict(`You have started ${own} threads on your own judgment in the last 24 hours, and the limit is ${LEAD_STARTS_PER_DAY}. Ask Aiden.`);
    }
  }

  const message = startHandoff({
    lead: name,
    projectName: project.name,
    stepId: node.id,
    stepTitle: node.title,
    what: node.what,
    why: node.why,
    goal,
    phase,
    onAidensWord: input.aidenWords !== undefined,
  });
  let kind: LeadEventKind;
  let threadId = '';
  let reason = '';
  // Set before the first await, so a second start of the project that comes in while this one waits is refused.
  underWay.add(project.id);
  try {
    try {
      threadId = (await start(folder, message, { title: startTitle(node.id, node.title) })).threadId;
      kind = 'start';
    } catch (err) {
      reason = reasonOf(err);
      if (err instanceof T3Unavailable && err.outcomeUnknown) kind = 'start_unknown';
      else {
        kind = 'start_failed';
        console.error(`InProgress: a thread for #${node.id} was not started: ${reason}`);
      }
    }
    try {
      write(ctx, actor, () =>
        logLeadEvent(ctx, {
          projectId: project.id,
          lead: name,
          instructions,
          kind,
          nodeId: node.id,
          text: kind === 'start' ? threadId : reason,
          ...(input.aidenWords === undefined ? {} : { aidenWords: input.aidenWords }),
        }),
      );
    } catch (err) {
      // The start has happened (or not) whatever the log says: the lead is still told which.
      console.error(`InProgress: a start for #${node.id} (${kind}) could not be logged: ${reasonOf(err)}`);
    }
  } finally {
    underWay.delete(project.id);
  }
  if (kind === 'start_unknown') throw badGateway(START_UNKNOWN);
  if (kind === 'start_failed') throw badGateway(`Not started: ${reason}`);
  return { text: `Started a thread for ${ref_}: ${threadId}. It claims the step on its first turn.`, threadId };
}
