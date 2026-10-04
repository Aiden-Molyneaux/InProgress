import type { WorkItem, WorkStatus } from '../core/types';
import { ApiClientError, createClient } from '../lib/client';

export interface TasksArgs {
  session: string;
  nodeId?: number;
  tasks: { subject: string; status: WorkStatus }[];
}

const FLAG_STATUS = new Map<string, WorkStatus>([
  ['--done', 'completed'],
  ['--doing', 'in_progress'],
  ['--todo', 'pending'],
]);

/** The step is shown bare: an unquoted `#` starts a comment in Bash and PowerShell. */
export const TASKS_USAGE = 'Usage: inprogress tasks [<step id>] --session <session id> [--done "<subject>"] [--doing "<subject>"] [--todo "<subject>"] ...';

/**
 * What a session can do when nothing answers. This command never starts the server: bare `node` may not be the Node
 * better-sqlite3 was built for. The session-start hook, the scribe's MCP server, `start`, `open` and `doctor` start it,
 * and of those a session can reach the scribe.
 */
export const TASKS_NOT_RUNNING_HINT = 'InProgress is not running. A brief to the inprogress-scribe starts it; run this command again after that.';
/** The server is up but answered too slowly; it may have applied the write, which a second run repeats harmlessly. */
export const TASKS_TIMEOUT_HINT = 'InProgress was too slow to answer. Running this command again is safe, because the list is replaced whole.';

const isFlag = (arg: string): boolean => arg === '--session' || FLAG_STATUS.has(arg);

/** `[<step id>] --session <id> [--done|--doing|--todo "<subject>"]...`, flags in list order. The step may carry a `#`. */
export function parseTasksArgs(args: string[]): TasksArgs | { error: string } {
  let session: string | undefined;
  let nodeId: number | undefined;
  const tasks: TasksArgs['tasks'] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const status = FLAG_STATUS.get(arg);
    if (arg === '--session' || status) {
      const value = args[i + 1]?.trim();
      // Another of this command's flags means this one's value was left out; any other text, `--x` included, is a value.
      if (!value || isFlag(value)) return { error: status ? `${arg} needs a subject` : '--session needs the session id' };
      i++;
      if (status) tasks.push({ subject: value, status });
      else if (session !== undefined) return { error: '--session is given twice' };
      else session = value;
      continue;
    }
    if (arg.startsWith('--')) return { error: `Unknown flag ${arg}` };
    const step = /^#?([1-9]\d*)$/.exec(arg.trim());
    if (!step) return { error: `Not a step id: ${arg}` };
    if (nodeId !== undefined) return { error: 'Name at most one step' };
    nodeId = Number(step[1]);
  }
  if (session === undefined) return { error: 'Missing --session <session id>' };
  return { session, ...(nodeId === undefined ? {} : { nodeId }), tasks };
}

const COUNTED: [WorkStatus, string][] = [
  ['completed', 'done'],
  ['in_progress', 'in progress'],
  ['pending', 'pending'],
];

/** `#88: 2 done · 1 in progress · 1 pending`; zero parts left out; `#88: no tasks` when empty. */
export function formatTaskCounts(nodeId: number, tasks: Pick<WorkItem, 'status'>[]): string {
  const parts = COUNTED.map(([status, word]) => [tasks.filter((t) => t.status === status).length, word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`);
  return `#${nodeId}: ${parts.length ? parts.join(' · ') : 'no tasks'}`;
}

/**
 * `inprogress tasks`: replaces this session's own working tasks on a step (its focus when no step is named) and prints
 * the counts. Bad arguments print the usage and return 1; a refusal or an unreachable server throws an ApiClientError,
 * which main.ts prints with its hint before exiting 1.
 */
export async function runTasks(args: string[], out: (line: string) => void, o: { baseUrl: string; token?: string; timeoutMs?: number }): Promise<number> {
  const parsed = parseTasksArgs(args);
  if ('error' in parsed) {
    out(parsed.error);
    out(TASKS_USAGE);
    return 1;
  }
  const { session, nodeId, tasks } = parsed;
  try {
    const res = await createClient({ baseUrl: o.baseUrl, token: o.token, timeoutMs: o.timeoutMs }).post<{ nodeId: number; tasks: WorkItem[] }>(
      `/api/sessions/${encodeURIComponent(session)}/tasks`,
      { ...(nodeId === undefined ? {} : { nodeId }), tasks },
      // Not `scribe:`: this write must not reset the stale-update nudge, because the plan may still be behind.
      { actor: `session:${session}` },
    );
    out(formatTaskCounts(res.nodeId, res.tasks));
    return 0;
  } catch (err) {
    // The client's own hint names `inprogress start`, which a session cannot run by that name. After a timeout the
    // server is up and may have acted; anything else at status 0 means nothing answered.
    if (err instanceof ApiClientError && err.status === 0) {
      throw new ApiClientError(0, err.message, err.code === 'TIMEOUT' ? TASKS_TIMEOUT_HINT : TASKS_NOT_RUNNING_HINT, err.code);
    }
    throw err;
  }
}
