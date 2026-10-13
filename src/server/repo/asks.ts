import { ASK_KINDS, ASK_TRAIL_MS, type Ask, type AskKind } from '../../core/types';
import { msAgo, write, type Ctx, type RecordEvent } from '../db/tx';
import { badRequest, notFound } from '../errors';
import { patchNode, requireNode } from './nodes';
import { inLiveProject } from './projects';

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

/** Idempotent: the open ask with this node, kind and text, inserted if missing. Records ask.raised only when inserted. */
export function raiseAsk(ctx: Ctx, actor: string, input: RaiseAskInput): Ask {
  if (!(ASK_KINDS as readonly string[]).includes(input.kind)) {
    throw badRequest(`Unknown ask kind ${JSON.stringify(input.kind)}. Use one of: ${ASK_KINDS.join(', ')}.`);
  }
  const text = input.text.trim();
  if (!text) throw badRequest('An ask needs text: it is empty', 'Say what Aiden should answer, allow or look at.');
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, input.nodeId);
    if (node.parentId === null) throw badRequest(`#${node.id} is the project root`, 'Raise the ask on the step it concerns.');
    if (node.status === 'dropped') throw badRequest(`#${node.id} is dropped`, 'Reopen it first.');
    // The column references sessions(id): a session id InProgress does not track is stored as no session.
    const tracked = input.sessionId ? ctx.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(input.sessionId) !== undefined : false;
    const info = ctx.db
      .prepare('INSERT INTO asks (project_id, node_id, kind, text, session_id, raised_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .run(node.projectId, node.id, input.kind, text, tracked ? input.sessionId : null, ctx.now());
    const row = ctx.db.prepare('SELECT * FROM asks WHERE node_id = ? AND kind = ? AND text = ? AND cleared_at IS NULL').get(node.id, input.kind, text) as AskRow;
    const ask = toAsk(row);
    if (info.changes) record({ projectId: node.projectId, type: 'ask.raised', entity: 'ask', entityId: ask.id, data: { ask } });
    return ask;
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
    if (completeQuestion && node.kind === 'question' && node.status !== 'done' && node.status !== 'dropped') {
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

/** Cleared asks this session raised whose answer it has not been told yet, oldest cleared first. */
export function undeliveredAnswers(ctx: Ctx, sessionId: string): Ask[] {
  return (ctx.db
    .prepare(`SELECT * FROM asks WHERE session_id = ? AND cleared_at IS NOT NULL AND answer_delivered_at IS NULL AND ${inLiveProject('asks.project_id')} ORDER BY cleared_at, id`)
    .all(sessionId) as AskRow[]).map(toAsk);
}

/** Sets answer_delivered_at on these asks. Not an event: nobody watches it. */
export function markAnswersDelivered(ctx: Ctx, ids: number[]): void {
  if (!ids.length) return;
  ctx.db.prepare(`UPDATE asks SET answer_delivered_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`).run(ctx.now(), ...ids);
}
