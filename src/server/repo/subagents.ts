import { ENDED_AGENT_MS, READER_AGENT_TYPES, TRAIL_MS, type SubagentInfo, type TrailAgent } from '../../core/types';
import type { Ctx } from '../db/tx';

/** How long a dispatch waits for its subagent to start; an older one (a launch that was denied, say) never pairs. */
export const DISPATCH_TTL_MS = 10 * 60 * 1000;

interface SubagentRow {
  session_id: string;
  agent_id: string;
  agent_type: string;
  started_at: string;
  description: string | null;
  model: string | null;
  node_id: number | null;
  tool_use_id: string | null;
  ended_at: string | null;
  ordinal: number | null;
  purpose: string | null;
  start_focus_id: number | null;
}

interface DispatchRow {
  session_id: string;
  tool_use_id: string;
  agent_type: string;
  description: string;
  model: string | null;
  node_id: number | null;
  agent_id: string | null;
  created_at: string;
  purpose: string | null;
}

export interface DispatchInput {
  toolUseId: string;
  agentType: string;
  description: string;
  model: string | null;
  nodeId: number | null;
  /** The prompt's first sentence, as the hook sent it; null when it sent none. */
  purpose: string | null;
}

/**
 * SQL for "this subagent row is not a reader", for a row aliased `a`: the trail and the past sessions it names leave
 * readers out. Built from READER_AGENT_TYPES, whose names are plain words.
 */
export const NOT_READER_SQL = `a.agent_type NOT IN (${READER_AGENT_TYPES.map((t) => `'${t}'`).join(', ')})`;

const before = (ctx: Ctx, ms: number) => new Date(Date.parse(ctx.now()) - ms).toISOString();

/**
 * One row as the UI has it: the live list and the trail share this, so a field added to one reaches both. Its node is
 * its dispatch's (the `#id`, else the focus at dispatch), else the focus at its start: the window, Details and task
 * attribution all read this one merge.
 */
const toInfo = (r: SubagentRow): SubagentInfo => ({
  agentId: r.agent_id,
  agentType: r.agent_type,
  startedAt: r.started_at,
  description: r.description,
  model: r.model,
  nodeId: r.node_id ?? r.start_focus_id,
  endedAt: r.ended_at,
  ordinal: r.ordinal,
  purpose: r.purpose,
});

/** A session's subagents that are running or stopped less than ENDED_AGENT_MS (5 minutes) ago, oldest first. */
export function listSubagents(ctx: Ctx, sessionId: string): SubagentInfo[] {
  return (ctx.db
    .prepare('SELECT * FROM session_subagents WHERE session_id = ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at, agent_id')
    .all(sessionId, before(ctx, ENDED_AGENT_MS)) as SubagentRow[])
    .map(toInfo);
}

/**
 * The trail's subagents: every subagent of the project's sessions, live or ended, that stopped less than 7 days ago,
 * oldest first. No 5-minute cut here: the client's clock decides when a live session's greyed badge becomes trail.
 * Readers (READER_AGENT_TYPES) leave no trail. A plain read.
 */
export function listTrailAgents(ctx: Ctx, projectId: number): TrailAgent[] {
  return (ctx.db
    .prepare(
      `SELECT a.* FROM session_subagents a JOIN sessions s ON s.id = a.session_id
       WHERE s.project_id = ? AND a.ended_at IS NOT NULL AND a.ended_at >= ? AND ${NOT_READER_SQL}
       ORDER BY a.started_at, a.session_id, a.agent_id`,
    )
    .all(projectId, before(ctx, TRAIL_MS)) as SubagentRow[])
    .map((r) => ({ ...toInfo(r), sessionId: r.session_id }));
}

/**
 * The node a subagent works on, if it is known: its dispatch's (named or inherited), else its session's focus when it
 * started. The same merge as toInfo, so its tasks land where its badge sits.
 */
export function subagentNode(ctx: Ctx, sessionId: string, agentId: string): number | null {
  const row = ctx.db.prepare('SELECT COALESCE(node_id, start_focus_id) AS node FROM session_subagents WHERE session_id = ? AND agent_id = ?').get(sessionId, agentId) as { node: number | null } | undefined;
  return row?.node ?? null;
}

const findSubagent = (ctx: Ctx, sessionId: string, agentId: string) =>
  ctx.db.prepare('SELECT * FROM session_subagents WHERE session_id = ? AND agent_id = ?').get(sessionId, agentId) as SubagentRow | undefined;
const findDispatch = (ctx: Ctx, sessionId: string, toolUseId: string) =>
  ctx.db.prepare('SELECT * FROM subagent_dispatches WHERE session_id = ? AND tool_use_id = ?').get(sessionId, toolUseId) as DispatchRow | undefined;
const dispatchOf = (ctx: Ctx, sessionId: string, agentId: string) =>
  ctx.db.prepare('SELECT * FROM subagent_dispatches WHERE session_id = ? AND agent_id = ?').get(sessionId, agentId) as DispatchRow | undefined;

function assign(ctx: Ctx, d: DispatchRow, agentId: string | null): void {
  ctx.db.prepare('UPDATE subagent_dispatches SET agent_id = ? WHERE session_id = ? AND tool_use_id = ?').run(agentId, d.session_id, d.tool_use_id);
}

/** Show a dispatch's description, model, node and purpose on the subagent row (or clear them when it has none). */
function show(ctx: Ctx, sessionId: string, agentId: string, d: DispatchRow | undefined): void {
  ctx.db
    .prepare('UPDATE session_subagents SET description = ?, model = ?, node_id = ?, tool_use_id = ?, purpose = ? WHERE session_id = ? AND agent_id = ?')
    .run(d?.description ?? null, d?.model ?? null, d?.node_id ?? null, d?.tool_use_id ?? null, d?.purpose ?? null, sessionId, agentId);
}

const forget = (ctx: Ctx, d: DispatchRow) => ctx.db.prepare('DELETE FROM subagent_dispatches WHERE session_id = ? AND tool_use_id = ?').run(d.session_id, d.tool_use_id);

/** The oldest dispatch of this type no agent has taken, from the last 10 minutes: first in, first out. */
function pairFifo(ctx: Ctx, sessionId: string, agentId: string, agentType: string): void {
  const d = ctx.db
    .prepare('SELECT * FROM subagent_dispatches WHERE session_id = ? AND agent_type = ? AND agent_id IS NULL AND created_at >= ? ORDER BY created_at, rowid LIMIT 1')
    .get(sessionId, agentType, before(ctx, DISPATCH_TTL_MS)) as DispatchRow | undefined;
  if (d) assign(ctx, d, agentId);
  show(ctx, sessionId, agentId, d);
}

/** PreToolUse on the Agent tool. A repeated tool_use_id (a retried POST) is ignored. */
export function recordDispatch(ctx: Ctx, sessionId: string, d: DispatchInput): void {
  ctx.db
    .prepare('INSERT OR IGNORE INTO subagent_dispatches (session_id, tool_use_id, agent_type, description, model, node_id, created_at, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, d.toolUseId, d.agentType, d.description, d.model, d.nodeId, ctx.now(), d.purpose);
}

/**
 * SubagentStart. A dispatch whose launch already named this agent pairs exactly (and is done with); otherwise the
 * oldest open dispatch of the agent's type pairs, and stays until a launch confirms or corrects it. An agent that
 * starts again (resumed) keeps what it had, its first start time included: the trail's "ran …" then spans its first
 * start to its last stop (a true run time would need a column of its own). `startFocusId` is the session's focus now:
 * every new row keeps it, paired or not, since a launch can still take its dispatch away; a resumed row keeps its
 * first one, as it keeps its first start time.
 */
export function startSubagent(ctx: Ctx, sessionId: string, agentId: string, agentType: string, at: string, startFocusId: number | null = null): void {
  const existing = findSubagent(ctx, sessionId, agentId);
  if (existing) {
    if (existing.ended_at) ctx.db.prepare('UPDATE session_subagents SET ended_at = NULL WHERE session_id = ? AND agent_id = ?').run(sessionId, agentId);
    return;
  }
  // Its number in the session: one past the highest given (rows from before migration 4 have none, which MAX skips). A
  // resumed agent returned above, keeping its own. Never reused while the session keeps a numbered row: once every row
  // has been pruned (7 days after it stopped) the count starts again at 1, which only a session that outlives all its
  // subagents by a week can see.
  ctx.db
    .prepare(
      `INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at, ordinal, start_focus_id)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM session_subagents WHERE session_id = ?), ?)`,
    )
    .run(sessionId, agentId, agentType, at, sessionId, startFocusId);
  const named = dispatchOf(ctx, sessionId, agentId);
  if (named) {
    show(ctx, sessionId, agentId, named);
    forget(ctx, named);
    return;
  }
  pairFifo(ctx, sessionId, agentId, agentType);
}

/** SubagentStop: the row stays, ended. The UI greys its badge for 5 minutes, then keeps it 7 days in the trail. */
export function stopSubagent(ctx: Ctx, sessionId: string, agentId: string, at: string): void {
  ctx.db.prepare('UPDATE session_subagents SET ended_at = ? WHERE session_id = ? AND agent_id = ? AND ended_at IS NULL').run(at, sessionId, agentId);
}

/**
 * PostToolUse on the Agent tool: dispatch `toolUseId` belongs to agent `agentId`. For a background agent this
 * arrives at launch, maybe before its SubagentStart; for a foreground one at completion. Either way the pairing
 * becomes exact: an agent that took this dispatch by mistake swaps with the one that should have had it (or, if
 * that one had none, takes the next open dispatch of its type). `model` (the model the launch reported) fills a
 * dispatch that named none.
 */
export function launchSubagent(ctx: Ctx, sessionId: string, toolUseId: string, agentId: string, model: string | null): void {
  const d = findDispatch(ctx, sessionId, toolUseId);
  const agent = findSubagent(ctx, sessionId, agentId);
  if (!d) {
    if (agent && model && !agent.model) ctx.db.prepare('UPDATE session_subagents SET model = ? WHERE session_id = ? AND agent_id = ?').run(model, sessionId, agentId);
    return;
  }
  if (model && !d.model) {
    ctx.db.prepare('UPDATE subagent_dispatches SET model = ? WHERE session_id = ? AND tool_use_id = ?').run(model, sessionId, toolUseId);
    d.model = model;
  }
  const holder = d.agent_id;
  if (holder !== agentId) {
    const held = dispatchOf(ctx, sessionId, agentId);
    assign(ctx, d, agentId);
    if (held) assign(ctx, held, holder);
    const loser = holder ? findSubagent(ctx, sessionId, holder) : undefined;
    if (holder && loser) {
      if (held) show(ctx, sessionId, holder, held);
      else pairFifo(ctx, sessionId, holder, loser.agent_type);
    }
  }
  if (agent) {
    show(ctx, sessionId, agentId, d);
    forget(ctx, d);
  }
}

/**
 * Session end (or a stale session's expiry): its running subagents end at `at`, while one that already stopped keeps
 * its own time, and its dispatches go. The rows stay as the trail.
 */
export function endSubagents(ctx: Ctx, sessionId: string, at: string): void {
  ctx.db.prepare('UPDATE session_subagents SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL').run(at, sessionId);
  ctx.db.prepare('DELETE FROM subagent_dispatches WHERE session_id = ?').run(sessionId);
}

/**
 * Drops subagents that stopped over 7 days ago (they have left the trail), then dispatches older than 10 minutes that
 * no known subagent holds (never started, or whose subagent was just dropped). A dispatch a known subagent holds stays:
 * a foreground agent's launch, which may correct it, only arrives when that agent finishes.
 */
export function pruneSubagents(ctx: Ctx): { dispatches: number; subagents: number } {
  const subagents = ctx.db.prepare('DELETE FROM session_subagents WHERE ended_at IS NOT NULL AND ended_at < ?').run(before(ctx, TRAIL_MS)).changes;
  const dispatches = ctx.db
    .prepare(
      `DELETE FROM subagent_dispatches WHERE created_at < ? AND (agent_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM session_subagents s WHERE s.session_id = subagent_dispatches.session_id AND s.agent_id = subagent_dispatches.agent_id))`,
    )
    .run(before(ctx, DISPATCH_TTL_MS)).changes;
  return { dispatches, subagents };
}
