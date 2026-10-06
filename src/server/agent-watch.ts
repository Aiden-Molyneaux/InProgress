import { statSync } from 'node:fs';
import type { EndReason, SessionState } from '../core/types';
import { agentTranscriptPath, readAgentTail, type TranscriptEnding, type TranscriptTail } from '../lib/agent-transcript';
import { write, type Ctx } from './db/tx';
import { ENDED_THIS_LIFE_SQL, endAgent, reviveAgent } from './repo/subagents';

/**
 * The transcript watcher (#125). Claude Code fires no SubagentStop when a subagent hits the usage limit or an API error,
 * or is stopped, so the server reads each running subagent's own transcript on a timer: a last line that marks such an
 * end ends it with that reason, 20 minutes with no new line ends it as `silent`, and a new line from one it ended
 * brings it back. The file format is undocumented: a missing or unreadable file never ends anything.
 */

/** How often the server's timer ticks: a handful of stats a minute; the window's own clock is 30 s. */
export const WATCH_MS = 60 * 1000;
/** A marker ends its subagent once the file has been still this long: a resumed or still-writing agent gets one tick. */
export const MARKER_QUIET_MS = 60 * 1000;
/** No new line for this long ends a subagent as `silent`; its next line undoes it. */
export const SILENT_MS = 20 * 60 * 1000;
/** A gap between ticks over this long (a sleeping machine) restarts every silence count. */
export const WAKE_GAP_MS = 3 * 60 * 1000;

/** The interval the server ticks at: INPROGRESS_AGENT_WATCH_MS when it is a positive whole number (e2e), else WATCH_MS. */
export function watchInterval(env: Record<string, string | undefined>): number {
  const value = env.INPROGRESS_AGENT_WATCH_MS ?? '';
  return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : WATCH_MS;
}

/** What the watcher remembers of one subagent between ticks. Memory only: a restart reads every file afresh. */
interface Watched {
  path?: string;
  /** The file's mtime when `tail` was read: the tail is read again only when it moves. */
  mtimeMs?: number;
  tail?: TranscriptTail;
  /** Silence counts from no earlier than this: the last tick its session waited for a permission. */
  heldAt?: number;
  /** The last sign of life the watcher ended it on. While the file says nothing newer, its marker never ends it again. */
  endedOn?: string;
  /** When the watcher first saw it running again on `endedOn` (a resumed start): its silence counts from there. */
  revivedAt?: number;
}

export interface WatchState {
  /** When the last tick ran, for the wake rule. */
  lastTick: number | null;
  /** When the last wake gap was seen: every silence counts from no earlier than this. */
  wokeAt: number | null;
  agents: Map<string, Watched>;
}

export function createWatchState(): WatchState {
  return { lastTick: null, wokeAt: null, agents: new Map() };
}

export interface WatchResult {
  ended: { sessionId: string; agentId: string; reason: WatchedReason }[];
  revived: { sessionId: string; agentId: string }[];
}

type WatchedReason = Exclude<EndReason, 'session'>;

interface WatchRow {
  session_id: string;
  agent_id: string;
  ended_at: string | null;
  last_active_at: string | null;
  transcript_path: string;
  state: SessionState;
}

const REASON: Record<TranscriptEnding, WatchedReason> = { killed: 'killed', limit: 'limit', error: 'error' };

const mtimeOf = (path: string): number | undefined => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * One tick. Takes the running subagents of live sessions that have a transcript, and the ones it ended itself
 * (`limit`, `error`, `killed`, `silent`) in their session's current life (ENDED_THIS_LIFE_SQL: a session's end closes
 * them, and one that comes back leaves them as its end did, until a SubagentStart): a stat each, and a tail read only
 * when the file moved. Rules:
 * - a last line that marks an end (`killed`, `limit`, `error`) ends a running subagent once the file has been still for
 *   MARKER_QUIET_MS, with its last sign of life (that line's time, else the file's) and `ended_at` = now;
 * - SILENT_MS with no change to the file ends it as `silent`, unless its session waits for a permission (a prompt inside
 *   the subagent writes nothing), counted again from the last tick that saw the permission;
 * - a gap between ticks over WAKE_GAP_MS restarts every silence count;
 * - a subagent it ended that writes a newer line runs again;
 * - a missing or unreadable file changes nothing.
 * All flips go in one write, with one `session.updated` per session they touch (`changed: ['subagents']`, its state,
 * and `ended: [{ agentId, reason }]` when any ended), so the window refetches.
 */
export function watchAgents(ctx: Ctx, state: WatchState): WatchResult {
  const now = Date.parse(ctx.now());
  if (state.lastTick !== null && now - state.lastTick > WAKE_GAP_MS) state.wokeAt = now;
  state.lastTick = now;
  const rows = ctx.db
    .prepare(
      `SELECT a.session_id, a.agent_id, a.ended_at, a.last_active_at, s.transcript_path, s.state
       FROM session_subagents a JOIN sessions s ON s.id = a.session_id
       WHERE s.state != 'ended' AND s.transcript_path IS NOT NULL
         AND (a.ended_at IS NULL OR (a.end_reason IN ('limit', 'error', 'killed', 'silent') AND ${ENDED_THIS_LIFE_SQL}))
       ORDER BY a.session_id, a.started_at, a.agent_id`,
    )
    .all() as WatchRow[];
  const ends: { row: WatchRow; reason: WatchedReason; lastActive: string; w: Watched }[] = [];
  const revives: { row: WatchRow; w: Watched }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.session_id}\u0000${row.agent_id}`;
    seen.add(key);
    const w = state.agents.get(key) ?? {};
    state.agents.set(key, w);
    w.path ??= agentTranscriptPath(row.transcript_path, row.agent_id);
    const mtime = w.path === undefined ? undefined : mtimeOf(w.path);
    if (w.path === undefined || mtime === undefined) {
      // Not there (yet, or any more): look again next tick, and never end anything for it.
      w.path = undefined;
      continue;
    }
    if (w.tail === undefined || w.mtimeMs !== mtime) {
      w.tail = readAgentTail(w.path);
      w.mtimeMs = mtime;
    }
    if (!w.tail) continue;
    const lastActive = w.tail.lastAt ?? new Date(mtime).toISOString();
    if (row.ended_at !== null) {
      // One it ended: a newer line than the one it ended on means it lives.
      const since = row.last_active_at ?? row.ended_at;
      if (Date.parse(lastActive) > Date.parse(since)) revives.push({ row, w });
      continue;
    }
    // Running. On the very line the watcher ended it on, a start revived it (resumed): wait for a new line.
    const sameLine = w.endedOn === lastActive;
    if (!sameLine) {
      w.endedOn = undefined;
      w.revivedAt = undefined;
    } else w.revivedAt ??= now;
    if (w.tail.ending && !sameLine && now - mtime >= MARKER_QUIET_MS) {
      ends.push({ row, reason: REASON[w.tail.ending], lastActive, w });
      continue;
    }
    if (row.state === 'permission') {
      w.heldAt = now;
      continue;
    }
    const from = Math.max(mtime, w.heldAt ?? -Infinity, state.wokeAt ?? -Infinity, w.revivedAt ?? -Infinity);
    if (now - from >= SILENT_MS) ends.push({ row, reason: 'silent', lastActive, w });
  }
  for (const key of state.agents.keys()) if (!seen.has(key)) state.agents.delete(key);

  const result: WatchResult = { ended: [], revived: [] };
  if (!ends.length && !revives.length) return result;
  write(ctx, 'system', (record) => {
    const at = ctx.now();
    const touched = new Map<string, { agentId: string; reason: WatchedReason }[]>();
    for (const { row, reason, lastActive, w } of ends) {
      if (!endAgent(ctx, row.session_id, row.agent_id, reason, at, lastActive)) continue;
      w.endedOn = lastActive;
      w.revivedAt = undefined;
      w.heldAt = undefined;
      result.ended.push({ sessionId: row.session_id, agentId: row.agent_id, reason });
      touched.set(row.session_id, [...(touched.get(row.session_id) ?? []), { agentId: row.agent_id, reason }]);
    }
    for (const { row, w } of revives) {
      if (!reviveAgent(ctx, row.session_id, row.agent_id)) continue;
      w.endedOn = undefined;
      w.revivedAt = undefined;
      w.heldAt = undefined;
      result.revived.push({ sessionId: row.session_id, agentId: row.agent_id });
      touched.set(row.session_id, touched.get(row.session_id) ?? []);
    }
    for (const [sessionId, ended] of touched) {
      const session = ctx.db.prepare('SELECT project_id, state FROM sessions WHERE id = ?').get(sessionId) as { project_id: number | null; state: SessionState };
      record({
        projectId: session.project_id,
        type: 'session.updated',
        entity: 'session',
        entityId: sessionId,
        data: { changed: ['subagents'], state: session.state, ...(ended.length ? { ended } : {}) },
      });
    }
  });
  return result;
}
