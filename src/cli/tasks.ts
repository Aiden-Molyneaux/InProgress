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
 * What a session can do when the server does not answer. This command never starts the server: bare `node` may not be
 * the Node better-sqlite3 was built for, so only the hooks, deploy and `start` start it.
 */
export const TASKS_UNREACHABLE_HINT = 'InProgress starts with the next prompt: run this command again then.';

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
      // A value that is itself a flag means this one's value was left out.
      if (!value || value.startsWith('--')) return { error: status ? `${arg} needs a subject` : '--session needs the session id' };
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
export async function runTasks(args: string[], out: (line: string) => void, o: { baseUrl: string; token?: string }): Promise<number> {
  const parsed = parseTasksArgs(args);
  if ('error' in parsed) {
    out(parsed.error);
    out(TASKS_USAGE);
    return 1;
  }
  const { session, nodeId, tasks } = parsed;
  try {
    const res = await createClient({ baseUrl: o.baseUrl, token: o.token }).post<{ nodeId: number; tasks: WorkItem[] }>(
      `/api/sessions/${encodeURIComponent(session)}/tasks`,
      { ...(nodeId === undefined ? {} : { nodeId }), tasks },
      // Not `scribe:`: this write must not reset the stale-update nudge, because the plan may still be behind.
      { actor: `session:${session}` },
    );
    out(formatTaskCounts(res.nodeId, res.tasks));
    return 0;
  } catch (err) {
    // The client's own hint names `inprogress start`, which a session cannot run by that name. The list is replaced
    // whole, so running the command again is safe even after a timeout that the server did act on.
    if (err instanceof ApiClientError && err.status === 0) throw new ApiClientError(0, err.message, TASKS_UNREACHABLE_HINT, err.code);
    throw err;
  }
}
