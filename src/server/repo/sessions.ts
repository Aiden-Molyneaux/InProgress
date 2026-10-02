import { STALE_SESSION_MS, type Session, type SessionState } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { clearSubagents, listSubagents } from './subagents';

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
  subagents: listSubagents(ctx, r.id),
});

export function findSession(ctx: Ctx, id: string): Session | undefined {
  const row = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? toSession(ctx, row) : undefined;
}

/** Persist every column except subagents (which live in session_subagents). */
export function saveSession(ctx: Ctx, s: Session): void {
  ctx.db
    .prepare('UPDATE sessions SET project_id = ?, title = ?, cwd = ?, branch = ?, transcript_path = ?, state = ?, focus_node_id = ?, prompts_since_update = ?, last_seen_at = ?, ended_at = ? WHERE id = ?')
    .run(s.projectId, s.title, s.cwd, s.branch, s.transcriptPath, s.state, s.focusNodeId, s.promptsSinceUpdate, s.lastSeenAt, s.endedAt, s.id);
}

/**
 * Mark sessions not seen for 12 hours as ended, recording an event for each so the UI drops
 * their badges. Opens its own write(): never call this (or listProjectSessions /
 * getProjectSnapshot, which call it) from inside another write().
 */
export function expireStaleSessions(ctx: Ctx): void {
  const cutoff = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS).toISOString();
  const stale = ctx.db
    .prepare("SELECT id, project_id FROM sessions WHERE state != 'ended' AND last_seen_at < ?")
    .all(cutoff) as { id: string; project_id: number | null }[];
  if (!stale.length) return;
  write(ctx, 'system', (record) => {
    const now = ctx.now();
    for (const { id, project_id } of stale) {
      ctx.db.prepare("UPDATE sessions SET state = 'ended', ended_at = ? WHERE id = ?").run(now, id);
      clearSubagents(ctx, id);
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
