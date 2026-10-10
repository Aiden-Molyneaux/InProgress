/** Mirror the server's hookBody limits (src/server/schemas.ts). */
export const ID_MAX = 200;
export const TASK_ID_MAX = 100;
/** At most this many task blocks are read from one notice. */
export const NOTICE_TASKS_MAX = 20;

export interface NoticeTask {
  taskId: string;
  toolUseId?: string;
  status: 'completed' | 'failed' | 'killed';
  exitCode?: number;
}

/** A non-blank string, trimmed and clipped, else nothing. */
export const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * The task-notification blocks of a notice prompt: id, tool use id, status and the exit code the summary names. Only a
 * block's header is read: from its opening tag to the first of `<result>`, its closing tag or the next opening tag. An
 * agent's `<result>` is skipped whole, so a notification it quotes is never read as a task. A block with no closing tag
 * still has its header.
 */
export function noticeTasks(prompt: string): NoticeTask[] {
  const tasks: NoticeTask[] = [];
  const OPEN = '<task-notification>';
  let pos = 0;
  while (tasks.length < NOTICE_TASKS_MAX) {
    const open = prompt.indexOf(OPEN, pos);
    if (open < 0) break;
    const from = open + OPEN.length;
    const result = prompt.indexOf('<result>', from);
    const ends = [result, prompt.indexOf('</task-notification>', from), prompt.indexOf(OPEN, from)].filter((i) => i >= 0);
    const end = ends.length ? Math.min(...ends) : prompt.length;
    const header = prompt.slice(from, end);
    if (end === result) {
      const close = prompt.indexOf('</result>', result);
      pos = close < 0 ? prompt.length : close + '</result>'.length;
    } else pos = end;
    const field = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(header)?.[1];
    const taskId = text(field('task-id'), TASK_ID_MAX);
    const status = field('status')?.trim();
    if (!taskId || (status !== 'completed' && status !== 'failed' && status !== 'killed')) continue;
    const task: NoticeTask = { taskId, status };
    const toolUseId = text(field('tool-use-id'), ID_MAX);
    if (toolUseId) task.toolUseId = toolUseId;
    // The last one: a command's own name can say "exit code 0" ("Retry until exit code 0") before the real outcome.
    const exit = [...(field('summary') ?? '').matchAll(/exit code (-?\d+)/g)].pop()?.[1];
    if (exit !== undefined && Number.isSafeInteger(Number(exit))) task.exitCode = Number(exit);
    tasks.push(task);
  }
  return tasks;
}
