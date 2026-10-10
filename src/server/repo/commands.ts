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
