import { ENDED_AGENT_MS, type CommandInfo, type CommandKind, type CommandOutcome } from '../../core/types';
import { msAgo, type Ctx } from '../db/tx';

/** At most this many commands per session reach the window. */
export const COMMANDS_LISTED = 30;

export interface CommandRow {
  session_id: string;
  task_id: string;
  tool_use_id: string | null;
  agent_id: string;
  kind: CommandKind;
  persistent: number;
  description: string | null;
  command_head: string | null;
  node_id: number | null;
  started_at: string;
  ended_at: string | null;
  outcome: CommandOutcome | null;
  exit_code: number | null;
}

export const toCommandInfo = (r: CommandRow): CommandInfo => ({
  taskId: r.task_id,
  kind: r.kind,
  agentId: r.agent_id,
  persistent: r.persistent === 1,
  description: r.description,
  commandHead: r.command_head,
  nodeId: r.node_id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  outcome: r.outcome,
  exitCode: r.exit_code,
});

/** Running commands and those ended less than ENDED_AGENT_MS ago: running first, then newest first, at most 30. */
export function listCommands(ctx: Ctx, sessionId: string): CommandInfo[] {
  return (ctx.db
    .prepare(
      `SELECT * FROM session_commands
       WHERE session_id = ? AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY (ended_at IS NULL) DESC, started_at DESC, task_id
       LIMIT ${COMMANDS_LISTED}`,
    )
    .all(sessionId, msAgo(ctx, ENDED_AGENT_MS)) as CommandRow[])
    .map(toCommandInfo);
}

/** At most this many rows per session are kept; the oldest ended ones go first. */
export const COMMANDS_KEPT = 200;
/**
 * A Stop's task list is captured before the hook reaches the server, so a command that started in that gap is missing
 * from it though it runs. Reconcile leaves a running row whose start is within this of the Stop's time (before or after).
 */
export const RECONCILE_GRACE_MS = 10_000;
/** An ended command is dropped this long after it ended. */
export const COMMANDS_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * A time as `toISOString()` writes it, with milliseconds: listCommands compares and orders these as text, which only
 * holds for that one form. Undefined for a time that does not parse, so the caller writes nothing.
 */
const isoOf = (time: string): string | undefined => {
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

export interface StartedCommand {
  taskId: string;
  toolUseId?: string;
  /** The subagent that ran it; none for the main thread. */
  agentId?: string;
  kind: CommandKind;
  persistent?: boolean;
  description?: string;
  commandHead?: string;
  startedAt: string;
  nodeId: number | null;
}

/**
 * PostToolUse on a command that went to the background. One row per (session, task id). A row that already exists (a Stop
 * reconcile inserted it, or a notice ended it before this async start landed) takes the tool call's `kind`, `persistent`
 * and node, which are exact here, and the earlier start time; its tool use, description, head and agent fill only when
 * missing. Its end (`ended_at`, `outcome`, `exit_code`) is never touched.
 */
export function startCommand(ctx: Ctx, sessionId: string, c: StartedCommand): void {
  const startedAt = isoOf(c.startedAt);
  if (startedAt === undefined) return;
  ctx.db
    .prepare(
      `INSERT INTO session_commands (session_id, task_id, tool_use_id, agent_id, kind, persistent, description, command_head, node_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, task_id) DO UPDATE SET
         kind = excluded.kind,
         persistent = excluded.persistent,
         tool_use_id = COALESCE(tool_use_id, excluded.tool_use_id),
         description = COALESCE(description, excluded.description),
         command_head = COALESCE(command_head, excluded.command_head),
         agent_id = CASE WHEN agent_id = '' THEN excluded.agent_id ELSE agent_id END,
         node_id = COALESCE(excluded.node_id, node_id),
         started_at = MIN(started_at, excluded.started_at)`,
    )
    .run(sessionId, c.taskId, c.toolUseId ?? null, c.agentId ?? '', c.kind, c.persistent ? 1 : 0, c.description ?? null, c.commandHead ?? null, c.nodeId, startedAt);
}

/**
 * Ends a running command, or replaces the `unknown` end a Stop reconcile gave it with the real one (outcome, time and
 * exit code). Any other end is final, a `session` end included. An id with no row is a no-op: it may be an agent's, or
 * stale. True when a row changed.
 */
export function endCommand(ctx: Ctx, sessionId: string, taskId: string, outcome: CommandOutcome, at: string, exitCode?: number): boolean {
  const endedAt = isoOf(at);
  if (endedAt === undefined) return false;
  return (
    ctx.db
      .prepare(
        `UPDATE session_commands SET ended_at = MAX(?, started_at), outcome = ?, exit_code = ?
         WHERE session_id = ? AND task_id = ? AND (ended_at IS NULL OR (outcome = 'unknown' AND ? != 'unknown'))`,
      )
      .run(endedAt, outcome, exitCode ?? null, sessionId, taskId, outcome).changes > 0
  );
}

export interface BackgroundEntry {
  taskId: string;
  type: string;
  description?: string;
  commandHead?: string;
}

/**
 * The Stop hook's list of the session's running background tasks (subagents' shells included: the list is session-wide).
 * Only `shell` and `monitor` entries count. A running command of the session that is not listed has ended without a
 * word: it ends as `unknown` at `at`, unless the list was cut at 50 (`truncated`). A listed one with no row is inserted,
 * started at `at`, with no agent and the Stop's focus; `ON CONFLICT DO NOTHING` so an ended row is never re-opened.
 * Returns the rows changed.
 */
export function reconcileCommands(ctx: Ctx, sessionId: string, background: BackgroundEntry[], at: string, opts: { truncated: boolean; nodeId: number | null }): number {
  const time = isoOf(at);
  if (time === undefined) return 0;
  const listed = background.filter((b) => b.type === 'shell' || b.type === 'monitor');
  let changed = 0;
  if (!opts.truncated) {
    const ids = new Set(listed.map((b) => b.taskId));
    const running = ctx.db.prepare('SELECT task_id, started_at FROM session_commands WHERE session_id = ? AND ended_at IS NULL').all(sessionId) as { task_id: string; started_at: string }[];
    const end = ctx.db.prepare("UPDATE session_commands SET ended_at = MAX(?, started_at), outcome = 'unknown' WHERE session_id = ? AND task_id = ? AND ended_at IS NULL");
    for (const { task_id, started_at } of running) {
      if (ids.has(task_id) || Math.abs(Date.parse(started_at) - Date.parse(time)) < RECONCILE_GRACE_MS) continue;
      changed += end.run(time, sessionId, task_id).changes;
    }
  }
  const insert = ctx.db.prepare(
    `INSERT INTO session_commands (session_id, task_id, agent_id, kind, persistent, description, command_head, node_id, started_at)
     VALUES (?, ?, '', ?, 0, ?, ?, ?, ?) ON CONFLICT (session_id, task_id) DO NOTHING`,
  );
  for (const b of listed) changed += insert.run(sessionId, b.taskId, b.type, b.description ?? null, b.commandHead ?? null, opts.nodeId, time).changes;
  return changed;
}

/** The session ended or was resumed: its running commands ended with it, as `session`, at `at`. Returns the rows changed. */
export function endSessionCommands(ctx: Ctx, sessionId: string, at: string): number {
  const endedAt = isoOf(at);
  if (endedAt === undefined) return 0;
  return ctx.db.prepare("UPDATE session_commands SET ended_at = ?, outcome = 'session' WHERE session_id = ? AND ended_at IS NULL").run(endedAt, sessionId).changes;
}

/** Drops commands that ended over 24 hours ago, then each session's oldest ended ones beyond 200 rows. Running rows never go. */
export function pruneCommands(ctx: Ctx): number {
  let removed = ctx.db.prepare('DELETE FROM session_commands WHERE ended_at IS NOT NULL AND ended_at < ?').run(msAgo(ctx, COMMANDS_RETENTION_MS)).changes;
  const over = ctx.db.prepare('SELECT session_id, COUNT(*) AS n FROM session_commands GROUP BY session_id HAVING n > ?').all(COMMANDS_KEPT) as { session_id: string; n: number }[];
  const drop = ctx.db.prepare(
    `DELETE FROM session_commands WHERE rowid IN (
       SELECT rowid FROM session_commands WHERE session_id = ? AND ended_at IS NOT NULL ORDER BY ended_at, started_at, task_id LIMIT ?)`,
  );
  for (const { session_id, n } of over) removed += drop.run(session_id, n - COMMANDS_KEPT).changes;
  return removed;
}
