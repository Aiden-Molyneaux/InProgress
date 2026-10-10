import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { sessionActivity } from '../core/activity';
import { noticeTasks } from '../core/notices';
import { ENDED_AGENT_MS, type CommandOutcome, type EndReason, type SessionState } from '../core/types';
import { agentTranscriptPath, readAgentTail, type TranscriptEnding, type TranscriptTail } from '../lib/agent-transcript';
import { write, type Ctx } from './db/tx';
import { endCommand } from './repo/commands';
import { findSession } from './repo/sessions';
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
  /** Per session, how far into its transcript the command-end reader has got (watchCommandEnds). */
  commandOffsets: Map<string, { path: string; offset: number }>;
  /** Sessions whose transcript could not be read last time it was tried, so the failure is reported once. */
  unreadable: Set<string>;
}

export function createWatchState(): WatchState {
  return { lastTick: null, wokeAt: null, agents: new Map(), commandOffsets: new Map(), unreadable: new Set() };
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

/** The most the command-end reader takes from one transcript in one read; a first sight starts this far from the end. */
export const COMMAND_READ_MAX = 8 * 1024 * 1024;

/** Bytes `from` to `to` of a file, in one buffer. Throws when the file cannot be read. */
function readRange(path: string, from: number, to: number): Buffer {
  const buf = Buffer.allocUnsafe(to - from);
  const fd = openSync(path, 'r');
  try {
    let filled = 0;
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, from + filled);
      if (n === 0) break;
      filled += n;
    }
    return buf.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/**
 * Claude Code tells the model a background command finished with a notice, and the transcript records it as a
 * `queue-operation` `enqueue` line (the session's own notices reach the UserPromptSubmit hook, a subagent's command
 * only the transcript). So each tick reads the new lines of every live session's transcript that has a running command
 * (or one a Stop reconcile ended as `unknown` less than five minutes ago, which a real end repairs), and ends the
 * commands those lines name, at the line's own time, with its status and exit code. Per session it remembers a byte
 * offset (memory only, kept while the session lives): a first sight, a changed path or a file that shrank starts at most
 * 8 MB from the end, dropping the partial line it lands in; a partial last line waits for the next tick. A missing or
 * unreadable file changes nothing and is reported once; an id with no such row is skipped. All ends go in one write,
 * with one `session.updated` per session they touch.
 */
export function watchCommandEnds(ctx: Ctx, state: WatchState): { ended: { sessionId: string; taskId: string; outcome: CommandOutcome }[]; unreadable: { sessionId: string; path: string; code: string }[] } {
  const repairable = new Date(Date.parse(ctx.now()) - ENDED_AGENT_MS).toISOString();
  const open = "(c.ended_at IS NULL OR (c.outcome = 'unknown' AND c.ended_at >= ?))";
  const sessions = ctx.db
    .prepare(
      `SELECT s.id, s.transcript_path FROM sessions s
       WHERE s.state != 'ended' AND s.transcript_path IS NOT NULL
         AND EXISTS (SELECT 1 FROM session_commands c WHERE c.session_id = s.id AND ${open})
       ORDER BY s.id`,
    )
    .all(repairable) as { id: string; transcript_path: string }[];
  // An offset outlives a pause in commands (the next one must not re-read 8 MB); it goes with its session.
  const live = new Set((ctx.db.prepare("SELECT id FROM sessions WHERE state != 'ended'").all() as { id: string }[]).map((r) => r.id));
  for (const id of state.commandOffsets.keys()) if (!live.has(id)) state.commandOffsets.delete(id);
  for (const id of state.unreadable) if (!live.has(id)) state.unreadable.delete(id);
  const unreadable: { sessionId: string; path: string; code: string }[] = [];
  const failed = (sessionId: string, path: string, err: unknown) => {
    if (state.unreadable.has(sessionId)) return;
    state.unreadable.add(sessionId);
    unreadable.push({ sessionId, path, code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
  };
  const ends: { sessionId: string; taskId: string; outcome: CommandOutcome; exitCode?: number; at: string }[] = [];
  const offsets = new Map<string, { path: string; offset: number }>();
  for (const { id, transcript_path: path } of sessions) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch (err) {
      // Not there (yet, or any more): look again next tick, with the offset kept.
      failed(id, path, err);
      continue;
    }
    state.unreadable.delete(id);
    const seen = state.commandOffsets.get(id);
    let from = seen && seen.path === path && size >= seen.offset ? seen.offset : 0;
    let partial = false;
    if (size - from > COMMAND_READ_MAX) {
      from = size - COMMAND_READ_MAX;
      partial = true;
    }
    if (size === from) {
      offsets.set(id, { path, offset: from });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readRange(path, from, size);
    } catch (err) {
      // Unreadable (locked, say): keep the offset and try again next tick.
      failed(id, path, err);
      continue;
    }
    // Only whole lines: the last, partial one is read again once its newline is there.
    const last = bytes.lastIndexOf(0x0a);
    const lines = last < 0 ? '' : bytes.subarray(0, last + 1).toString('utf8');
    offsets.set(id, { path, offset: last < 0 ? (partial ? size : from) : from + last + 1 });
    const running = new Set((ctx.db.prepare(`SELECT c.task_id FROM session_commands c WHERE c.session_id = ? AND ${open}`).all(id, repairable) as { task_id: string }[]).map((r) => r.task_id));
    const rows = lines.split('\n');
    // The first line of a read that began mid-file may be cut in half.
    for (const text of partial ? rows.slice(1) : rows) {
      if (!running.size) break;
      if (!text.includes('"queue-operation"')) continue;
      let entry: { type?: unknown; operation?: unknown; content?: unknown; timestamp?: unknown };
      try {
        entry = JSON.parse(text);
      } catch {
        // The format is undocumented: a line that is not JSON is skipped, never an error.
        continue;
      }
      if (entry.type !== 'queue-operation' || entry.operation !== 'enqueue' || typeof entry.content !== 'string') continue;
      const stamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      const at = Number.isNaN(stamp) ? ctx.now() : new Date(stamp).toISOString();
      for (const t of noticeTasks(entry.content)) {
        if (!running.delete(t.taskId)) continue;
        ends.push({ sessionId: id, taskId: t.taskId, outcome: t.status, exitCode: t.exitCode, at });
      }
    }
  }
  const ended: { sessionId: string; taskId: string; outcome: CommandOutcome }[] = [];
  if (ends.length) {
    write(ctx, 'system', (record) => {
      const touched = new Set<string>();
      for (const e of ends) {
        if (!endCommand(ctx, e.sessionId, e.taskId, e.outcome, e.at, e.exitCode)) continue;
        ended.push({ sessionId: e.sessionId, taskId: e.taskId, outcome: e.outcome });
        touched.add(e.sessionId);
      }
      for (const sessionId of touched) {
        const session = findSession(ctx, sessionId)!;
        record({
          projectId: session.projectId,
          type: 'session.updated',
          entity: 'session',
          entityId: sessionId,
          data: { changed: ['commands'], state: session.state, activity: sessionActivity(session, Date.parse(ctx.now())) },
        });
      }
    });
  }
  // Remembered only once the ends are stored: a failed write reads the same lines again next tick.
  for (const [id, o] of offsets) state.commandOffsets.set(id, o);
  return { ended, unreadable };
}
