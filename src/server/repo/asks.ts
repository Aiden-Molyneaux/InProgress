import { ASK_KINDS, ASK_TRAIL_MS, STALE_SESSION_MS, type Ask, type AskKind } from '../../core/types';
import { msAgo, write, type Ctx, type RecordEvent } from '../db/tx';
import { badRequest, notFound } from '../errors';
import { patchNode, requireNode } from './nodes';
import { inLiveProject } from './projects';
import { parkedAncestor } from './shelved';

export interface RaiseAskInput {
  nodeId: number;
  kind: AskKind;
  text: string;
  sessionId?: string | null;
}

interface AskRow {
  id: number;
  project_id: number;
  node_id: number;
  kind: string;
  text: string;
  session_id: string | null;
  raised_at: string;
  cleared_at: string | null;
  cleared_by: string | null;
  answer: string;
  answer_delivered_at: string | null;
}

const toAsk = (r: AskRow): Ask => ({
  id: r.id,
  projectId: r.project_id,
  nodeId: r.node_id,
  kind: r.kind as AskKind,
  text: r.text,
  sessionId: r.session_id,
  raisedAt: r.raised_at,
  clearedAt: r.cleared_at,
  clearedBy: r.cleared_by,
  answer: r.answer,
  answerDeliveredAt: r.answer_delivered_at,
});

const getRow = (ctx: Ctx, id: number) =>
  ctx.db.prepare(`SELECT * FROM asks WHERE id = ? AND ${inLiveProject('asks.project_id')}`).get(id) as AskRow | undefined;

export function requireAsk(ctx: Ctx, id: number): Ask {
  const row = getRow(ctx, id);
  if (!row) throw notFound(`Ask a${id} not found`, 'The briefing and the window name asks as a<id>.');
  return toAsk(row);
}

/** What a raise tells its caller besides the ask: whether it joined an open one, and whether the raiser can hear back. */
export interface RaisedAsk {
  ask: Ask;
  /** The open ask already existed: nothing was inserted, and its answer goes to whoever raised it first. */
  joined: boolean;
  /** A session id was given that InProgress does not track: it is stored as no session, so no answer comes back to it. */
  untracked: boolean;
}

/** Idempotent: the open ask with this node, kind and text, inserted if missing. Records ask.raised only when inserted. */
export function raiseAsk(ctx: Ctx, actor: string, input: RaiseAskInput): Ask {
  return raiseAskDetailed(ctx, actor, input).ask;
}

/** raiseAsk, also saying whether the ask joined an existing one and whether the raising session was untracked. */
export function raiseAskDetailed(ctx: Ctx, actor: string, input: RaiseAskInput): RaisedAsk {
  if (!(ASK_KINDS as readonly string[]).includes(input.kind)) {
    throw badRequest(`Unknown ask kind ${JSON.stringify(input.kind)}. Use one of: ${ASK_KINDS.join(', ')}.`);
  }
  const text = input.text.trim();
  if (!text) throw badRequest('An ask needs text: it is empty', 'Say what Aiden should answer, allow or look at.');
  return write(ctx, actor, (record): RaisedAsk => {
    const node = requireNode(ctx, input.nodeId);
    if (node.parentId === null) throw badRequest(`#${node.id} is the project root`, 'Raise the ask on the step it concerns.');
    if (node.status === 'dropped') throw badRequest(`#${node.id} is dropped`, 'Reopen it first.');
    if (node.status === 'parked') throw badRequest(`#${node.id} is parked`, 'Unpark it first.');
    const parkedAbove = parkedAncestor(ctx, node.id);
    if (parkedAbove !== null) throw badRequest(`#${node.id} is under parked #${parkedAbove}`, `Unpark #${parkedAbove} first.`);
    // The column references sessions(id): a session id InProgress does not track is stored as no session.
    const tracked = input.sessionId ? ctx.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(input.sessionId) !== undefined : false;
    const info = ctx.db
      .prepare('INSERT INTO asks (project_id, node_id, kind, text, session_id, raised_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .run(node.projectId, node.id, input.kind, text, tracked ? input.sessionId : null, ctx.now());
    const row = ctx.db.prepare('SELECT * FROM asks WHERE node_id = ? AND kind = ? AND text = ? AND cleared_at IS NULL').get(node.id, input.kind, text) as AskRow;
    const ask = toAsk(row);
    if (info.changes) record({ projectId: node.projectId, type: 'ask.raised', entity: 'ask', entityId: ask.id, data: { ask } });
    return { ask, joined: !info.changes, untracked: !!input.sessionId && !tracked };
  });
}

/** Inside an open write: the idempotent clear of spec 1.2. */
function clearInWrite(ctx: Ctx, record: RecordEvent, actor: string, before: Ask, answer: string, completeQuestion = true): Ask {
  const first = before.clearedAt === null;
  const takesAnswer = before.answer === '' && answer !== '';
  if (!first && !takesAnswer) return before;
  ctx.db
    .prepare("UPDATE asks SET cleared_at = COALESCE(cleared_at, ?), cleared_by = COALESCE(cleared_by, ?), answer = CASE WHEN answer = '' THEN ? ELSE answer END WHERE id = ?")
    .run(ctx.now(), actor, answer, before.id);
  const ask = requireAsk(ctx, before.id);
  if (first) {
    record({ projectId: ask.projectId, type: 'ask.cleared', entity: 'ask', entityId: ask.id, data: { ask } });
    const node = requireNode(ctx, ask.nodeId);
    if (completeQuestion && node.kind === 'question' && node.status !== 'done' && node.status !== 'dropped' && node.status !== 'parked') {
      patchNode(ctx, record, node, { status: 'done', outcome: ask.answer || 'Answered' });
    }
  }
  return ask;
}

/** Idempotent (spec 1.2). Clearing a question node's ask marks the node done. */
export function clearAsk(ctx: Ctx, actor: string, askId: number, answer = ''): Ask {
  return write(ctx, actor, (record) => clearInWrite(ctx, record, actor, requireAsk(ctx, askId), answer.trim()));
}

/**
 * clearAsk's work for every open ask on a node, inside an open write (a drop, or a question node being finished).
 * The caller is changing the node itself, so the question-node completion is left out.
 */
export function clearNodeAsks(ctx: Ctx, record: RecordEvent, actor: string, nodeId: number, answer = ''): void {
  const open = ctx.db.prepare('SELECT * FROM asks WHERE node_id = ? AND cleared_at IS NULL').all(nodeId) as AskRow[];
  for (const row of open) clearInWrite(ctx, record, actor, toAsk(row), answer, false);
}

/** Open asks of the project and those cleared within ASK_TRAIL_MS, oldest raised first. */
export function listProjectAsks(ctx: Ctx, projectId: number): Ask[] {
  return (ctx.db
    .prepare('SELECT * FROM asks WHERE project_id = ? AND (cleared_at IS NULL OR cleared_at >= ?) ORDER BY raised_at, id')
    .all(projectId, msAgo(ctx, ASK_TRAIL_MS)) as AskRow[]).map(toAsk);
}

/** Asks of the project raised at or after `since` (ISO), oldest first, cleared or not: the digest reads the table, not the 7-day snapshot. */
export function listAsksRaisedSince(ctx: Ctx, projectId: number, since: string): Ask[] {
  return (ctx.db.prepare('SELECT * FROM asks WHERE project_id = ? AND raised_at >= ? ORDER BY raised_at, id').all(projectId, since) as AskRow[]).map(toAsk);
}

/** Asks of the project cleared at or after `since` (ISO), oldest cleared first. */
export function listAsksClearedSince(ctx: Ctx, projectId: number, since: string): Ask[] {
  return (ctx.db.prepare('SELECT * FROM asks WHERE project_id = ? AND cleared_at >= ? ORDER BY cleared_at, id').all(projectId, since) as AskRow[]).map(toAsk);
}

/**
 * The asker does not hold the ask (spec 2.1): the ask names no session, or its session is not live (ended, or not
 * heard from within STALE_SESSION_MS), or it is live with its focus on another step. Binds the stale cutoff.
 */
const ASKER_NOT_HOLDING =
  "NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = asks.session_id AND s.state != 'ended' AND s.last_seen_at >= ? AND s.focus_node_id = asks.node_id)";

/**
 * The driver route's conditions (spec 2): an answer, cleared within ASK_TRAIL_MS, whose asker does not hold it. Binds
 * the two cutoffs, in that order.
 */
const OWED_TO_DRIVER = `answer != '' AND cleared_at >= ? AND ${ASKER_NOT_HOLDING}`;

/**
 * A live session other than the bound one drives the ask's step (the live-driver rule of spec 1.2). Binds the session
 * id, then the stale cutoff.
 */
const OTHER_LIVE_DRIVER =
  "EXISTS (SELECT 1 FROM nodes n JOIN sessions d ON d.id = n.driver_session_id WHERE n.id = asks.node_id AND d.id != ? AND d.focus_node_id = n.id AND d.state != 'ended' AND d.last_seen_at >= ?)";

/**
 * Cleared asks this session is owed and has not been told yet, oldest cleared first.
 * The asker route: those it raised (answered or not), except the ones the driver route hands to another session: an
 * answer cleared within ASK_TRAIL_MS on a step another live session drives, while this one is not focused on it (it
 * moved off the work, so the answer follows the work to the driver). A clear with no answer, or one older than the
 * trail, stays the asker's.
 * The driver route: the answered ones on a step it drives, raised by another session that does not hold them. It
 * drives a step as the live-driver rule reads it (spec 1.2): the driver column names it and the step is its focus, so a
 * column left behind routes nothing. Exactly one route delivers each cleared ask.
 */
export function undeliveredAnswers(ctx: Ctx, sessionId: string): Ask[] {
  const stale = msAgo(ctx, STALE_SESSION_MS);
  const trail = msAgo(ctx, ASK_TRAIL_MS);
  return (ctx.db
    .prepare(
      `SELECT * FROM asks WHERE cleared_at IS NOT NULL AND answer_delivered_at IS NULL AND ${inLiveProject('asks.project_id')}` +
        ` AND ((session_id = ? AND NOT (answer != '' AND cleared_at >= ? AND COALESCE((SELECT focus_node_id FROM sessions WHERE id = ?), -1) != node_id AND ${OTHER_LIVE_DRIVER}))` +
        ` OR (node_id IN (SELECT id FROM nodes WHERE driver_session_id = ?) AND node_id = (SELECT focus_node_id FROM sessions WHERE id = ?)` +
        ` AND (session_id IS NULL OR session_id != ?) AND ${OWED_TO_DRIVER})) ORDER BY cleared_at, id`,
    )
    .all(sessionId, trail, sessionId, sessionId, stale, sessionId, sessionId, sessionId, trail, stale) as AskRow[]).map(toAsk);
}

/**
 * The answers owed on this step that nobody has been told, oldest cleared first: the driver route's asks for one step,
 * which a driving claim prints. It runs after the claim saves the claimer's focus, so the claimer holds its own asks
 * and they keep arriving through undeliveredAnswers; a take-over has cleared the old driver's focus in the same write,
 * so the old driver's answered asks on the step are owed here.
 */
export function owedAnswers(ctx: Ctx, nodeId: number): Ask[] {
  return (ctx.db
    .prepare(
      `SELECT * FROM asks WHERE node_id = ? AND cleared_at IS NOT NULL AND answer_delivered_at IS NULL AND ${inLiveProject('asks.project_id')}` +
        ` AND ${OWED_TO_DRIVER} ORDER BY cleared_at, id`,
    )
    .all(nodeId, msAgo(ctx, ASK_TRAIL_MS), msAgo(ctx, STALE_SESSION_MS)) as AskRow[]).map(toAsk);
}

/** Sets answer_delivered_at on these asks. Not an event: nobody watches it. */
export function markAnswersDelivered(ctx: Ctx, ids: number[]): void {
  if (!ids.length) return;
  ctx.db.prepare(`UPDATE asks SET answer_delivered_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`).run(ctx.now(), ...ids);
}
