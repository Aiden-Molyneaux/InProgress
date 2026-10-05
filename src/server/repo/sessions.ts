import { STALE_SESSION_MS, TRAIL_MS, type PastSession, type Session, type SessionState } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { releaseQueue } from './projects';
import { endSubagents, listSubagents } from './subagents';

interface SessionRow {
  id: string;
  project_id: number | null;
  title: string | null;
  cwd: string | null;
  branch: string | null;
  transcript_path: string | null;
  state: SessionState;
  focus_node_id: number | null;
  prompts_since_update: number;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  slot: number | null;
}

const toSession = (ctx: Ctx, r: SessionRow): Session => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  cwd: r.cwd,
  branch: r.branch,
  transcriptPath: r.transcript_path,
  state: r.state,
  focusNodeId: r.focus_node_id,
  promptsSinceUpdate: r.prompts_since_update,
  startedAt: r.started_at,
  lastSeenAt: r.last_seen_at,
  endedAt: r.ended_at,
  slot: r.slot,
  subagents: listSubagents(ctx, r.id),
});

export function findSession(ctx: Ctx, id: string): Session | undefined {
  const row = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? toSession(ctx, row) : undefined;
}

/** Persist every column except subagents (which live in session_subagents). */
export function saveSession(ctx: Ctx, s: Session): void {
  ctx.db
    .prepare('UPDATE sessions SET project_id = ?, title = ?, cwd = ?, branch = ?, transcript_path = ?, state = ?, focus_node_id = ?, prompts_since_update = ?, last_seen_at = ?, ended_at = ?, slot = ? WHERE id = ?')
    .run(s.projectId, s.title, s.cwd, s.branch, s.transcriptPath, s.state, s.focusNodeId, s.promptsSinceUpdate, s.lastSeenAt, s.endedAt, s.slot, s.id);
}

/**
 * The slot for session `sessionId` in project `projectId`: `prefer` (the slot it has) when no other live session of the
 * project holds it, else the lowest slot none holds, from 0. Live means not ended and heard from within the stale limit,
 * the cutoff expireStaleSessions uses: expiry runs only on a snapshot read, never inside a write, so a session idle for
 * 12 hours may still read 'idle' here, and it holds no slot. No unique index backs this (a rolled-back v3 build that
 * revives a session would trip it): every flow that makes a session live calls this.
 */
export function assignSlot(ctx: Ctx, sessionId: string, projectId: number, prefer: number | null = null): number {
  const cutoff = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS).toISOString();
  const held = new Set(
    ctx.db
      .prepare("SELECT slot FROM sessions WHERE project_id = ? AND id != ? AND state != 'ended' AND last_seen_at >= ? AND slot IS NOT NULL")
      .pluck()
      .all(projectId, sessionId, cutoff) as number[],
  );
  if (prefer !== null && !held.has(prefer)) return prefer;
  let slot = 0;
  while (held.has(slot)) slot++;
  return slot;
}

/**
 * Mark sessions not seen for 12 hours as ended, recording an event for each so the UI drops
 * their badges. Opens its own write(): never call this (or listProjectSessions /
 * getProjectSnapshot, which call it) from inside another write().
 */
export function expireStaleSessions(ctx: Ctx): void {
  const cutoff = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS).toISOString();
  const stale = ctx.db
    .prepare("SELECT id, project_id, last_seen_at FROM sessions WHERE state != 'ended' AND last_seen_at < ?")
    .all(cutoff) as { id: string; project_id: number | null; last_seen_at: string }[];
  if (!stale.length) return;
  write(ctx, 'system', (record) => {
    const now = ctx.now();
    // Their Up next entries turn unowned all at once, keeping their stored order among them (one release each would
    // stack them in reverse). Recorded before the sessions' events, so the activity strip says they ended.
    releaseQueue(ctx, record, stale.map((s) => s.id));
    for (const { id, project_id, last_seen_at } of stale) {
      ctx.db.prepare("UPDATE sessions SET state = 'ended', ended_at = ? WHERE id = ?").run(now, id);
      // Its running subagents stopped when the session was last heard from, not 12 hours later: the trail says how long
      // they ran.
      endSubagents(ctx, id, last_seen_at);
      record({ projectId: project_id, type: 'session.updated', entity: 'session', entityId: id, data: { changed: ['state'], state: 'ended' } });
    }
  });
}

/**
 * Non-ended sessions of a project, newest first. Expires stale sessions first, which opens its
 * own write(): never call this from inside another write().
 */
export function listProjectSessions(ctx: Ctx, projectId: number): Session[] {
  expireStaleSessions(ctx);
  return (ctx.db.prepare("SELECT * FROM sessions WHERE project_id = ? AND state != 'ended' ORDER BY last_seen_at DESC").all(projectId) as SessionRow[])
    .map((r) => toSession(ctx, r));
}

/**
 * The project's ended sessions that the trail names, newest first: ones that ended less than 7 days ago leaving working
 * tasks here, or whose subagents stopped less than 7 days ago. A plain read.
 *
 * The end it shows is when the session was last heard from, if that came first: expiry stamps `ended_at` lazily, 12 hours
 * or more after the last hook. A hook `end` sets both to the same moment. The 7-day cutoffs stay on `ended_at`, as
 * pruneWorkItems counts them.
 */
export function listPastSessions(ctx: Ctx, projectId: number): PastSession[] {
  const cutoff = new Date(Date.parse(ctx.now()) - TRAIL_MS).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT id, title, focus_node_id, MIN(s.ended_at, s.last_seen_at) AS shown_end FROM sessions s
       WHERE s.project_id = ? AND s.state = 'ended' AND s.ended_at IS NOT NULL AND (
         (s.ended_at >= ? AND EXISTS (SELECT 1 FROM work_items w WHERE w.session_id = s.id AND w.project_id = s.project_id))
         -- The same agents as listTrailAgents: a filter added there (P6's readers, say) belongs here too.
         OR EXISTS (SELECT 1 FROM session_subagents a WHERE a.session_id = s.id AND a.ended_at IS NOT NULL AND a.ended_at >= ?))
       ORDER BY shown_end DESC, s.id`,
    )
    .all(projectId, cutoff, cutoff) as { id: string; title: string | null; focus_node_id: number | null; shown_end: string }[];
  return rows.map((r) => ({ id: r.id, title: r.title, focusNodeId: r.focus_node_id, endedAt: r.shown_end }));
}
