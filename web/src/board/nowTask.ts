import type { WorkItem } from '../../../src/core/types';

/** A session's place in its own work: the in-progress task, its place among the session's tasks, and how many there are. */
export interface TaskProgress {
  item: WorkItem;
  /** One-based place of the in-progress task in the ordered list. */
  place: number;
  total: number;
}

/**
 * The session's own work items (not a subagent's), the focus step's first and then by position; the first one in progress
 * is the task shown as "Task n of m". Null when none is in progress.
 */
export function taskProgress(items: readonly WorkItem[], sessionId: string, focusNodeId: number): TaskProgress | null {
  const own = items
    .filter((w) => w.sessionId === sessionId && w.agentId === '')
    .sort((a, b) => (a.nodeId === focusNodeId ? 0 : 1) - (b.nodeId === focusNodeId ? 0 : 1) || a.position - b.position);
  const at = own.findIndex((w) => w.status === 'in_progress');
  return at < 0 ? null : { item: own[at], place: at + 1, total: own.length };
}
