import { TRAIL_MS, type Session, type WorkItem, type WorkStatus } from '../../core/types';
import { write, type Ctx, type RecordEvent } from '../db/tx';
import { badRequest, notFound } from '../errors';
import { findNode, leadingNode } from './nodes';
import { getProjectById, isTracking, notTracked } from './projects';
import { findSession } from './sessions';
import { shelvedAmong } from './shelved';
import { subagentNode } from './subagents';

interface WorkRow {
  id: number;
  project_id: number;
  node_id: number;
  session_id: string;
  agent_id: string;
  task_key: string;
  subject: string;
  status: WorkStatus;
  blocks: string;
  position: number;
  created_at: string;
  updated_at: string;
}

/** A row read with its session's end: `ended_at` is when that session ended, null while it is live. */
type WorkRowWithEnd = WorkRow & { ended_at: string | null };

/** A change to one task list entry, as the post-tool hook reports it. */
export interface TaskChange {
  /** The subagent whose task list it is on; '' for the main session's. */
  agentId: string;
  taskKey: string;
  subject?: string;
  status?: WorkStatus | 'deleted';
  addBlocks?: string[];
  addBlockedBy?: string[];
}

export interface TaskInput {
  subject: string;
  status: WorkStatus;
}

function parseKeys(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

const findItem = (ctx: Ctx, sessionId: string, agentId: string, taskKey: string) =>
  ctx.db.prepare('SELECT * FROM work_items WHERE session_id = ? AND agent_id = ? AND task_key = ?').get(sessionId, agentId, taskKey) as WorkRow | undefined;

const nextPosition = (ctx: Ctx, nodeId: number): number =>
  (ctx.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM work_items WHERE node_id = ?').get(nodeId) as { p: number }).p;

/** A done, dropped or shelved step (parked, or under a parked one): a session's focus stays on a step it has finished or that was set aside, so new tasks must not follow it there. */
const isClosed = (ctx: Ctx, node: { id: number; status: string }) =>
  node.status === 'done' || node.status === 'dropped' || shelvedAmong(ctx, [node.id]).has(node.id);

/**
 * Where a new working task goes, decided once: a leading `#id` in the subject when that node is in the session's
 * project; for a subagent's task, the subagent's node; then the session's focus; then the project root. A done or
 * dropped subagent node or focus sends the task to the root (not on to the main session's focus, for a subagent).
 */
function attribute(ctx: Ctx, session: Session, agentId: string, subject: string): { projectId: number; nodeId: number } | undefined {
  const projectId = session.projectId;
  if (projectId === null) return undefined;
  const inProject = (id: number | null | undefined) => {
    const node = id == null ? undefined : findNode(ctx, id);
    return node?.projectId === projectId ? node : undefined;
  };
  const named = leadingNode(ctx, subject, projectId);
  const home = named === undefined ? ((agentId ? inProject(subagentNode(ctx, session.id, agentId)) : undefined) ?? inProject(session.focusNodeId)) : undefined;
  const nodeId = named ?? (home && !isClosed(ctx, home) ? home.id : getProjectById(ctx, projectId)?.rootNodeId);
  return nodeId === undefined ? undefined : { projectId, nodeId };
}

function insertItem(ctx: Ctx, session: Session, agentId: string, taskKey: string, subject: string, status: WorkStatus): number | undefined {
  const where = attribute(ctx, session, agentId, subject);
  if (!where) return undefined;
  const now = ctx.now();
  ctx.db
    .prepare('INSERT INTO work_items (project_id, node_id, session_id, agent_id, task_key, subject, status, blocks, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'[]\', ?, ?, ?)')
    .run(where.projectId, where.nodeId, session.id, agentId, taskKey, subject, status, nextPosition(ctx, where.nodeId), now, now);
  return where.nodeId;
}

/**
 * TaskCreate: a new pending task. A create on a key the list already holds (a retried post, or a task list Claude
 * Code started over) replaces that task, attributed afresh. Returns the nodes whose working tasks changed.
 */
export function taskCreated(ctx: Ctx, session: Session, agentId: string, taskKey: string, rawSubject: string): number[] {
  const subject = rawSubject.trim();
  if (!subject) return [];
  const old = findItem(ctx, session.id, agentId, taskKey);
  if (old) {
    if (old.subject === subject && old.status === 'pending' && old.blocks === '[]') return [];
    ctx.db.prepare('DELETE FROM work_items WHERE id = ?').run(old.id);
  }
  const nodeId = insertItem(ctx, session, agentId, taskKey, subject, 'pending');
  return [...new Set([...(old ? [old.node_id] : []), ...(nodeId === undefined ? [] : [nodeId])])];
}

/**
 * TaskUpdate: status, subject and blocks links; `deleted` removes the task. A task this list never saw (created
 * before the hooks were installed, say) is picked up when the update names its subject, and ignored otherwise.
 * Returns the nodes whose working tasks changed.
 */
export function taskUpdated(ctx: Ctx, session: Session, change: TaskChange): number[] {
  const { agentId, taskKey } = change;
  let item = findItem(ctx, session.id, agentId, taskKey);
  if (change.status === 'deleted') {
    if (!item) return [];
    ctx.db.prepare('DELETE FROM work_items WHERE id = ?').run(item.id);
    return [item.node_id];
  }
  const touched = new Set<number>();
  const subject = change.subject?.trim();
  if (!item) {
    if (!subject) return [];
    const nodeId = insertItem(ctx, session, agentId, taskKey, subject, change.status ?? 'pending');
    if (nodeId === undefined) return [];
    touched.add(nodeId);
    item = findItem(ctx, session.id, agentId, taskKey)!;
  }
  const blocks = parseKeys(item.blocks);
  const addTo = (list: string[], keys: string[], self: string) => {
    for (const k of keys) if (k !== self && !list.includes(k)) list.push(k);
  };
  addTo(blocks, change.addBlocks ?? [], taskKey);
  // A task ticked on a done step stays ticked: Claude Code still holds it as open and may send it back.
  const reopensOnDone = item.status === 'completed' && change.status !== undefined && change.status !== 'completed' && findNode(ctx, item.node_id)?.status === 'done';
  const next = { subject: subject || item.subject, status: reopensOnDone ? item.status : change.status ?? item.status, blocks: JSON.stringify(blocks) };
  if (next.subject !== item.subject || next.status !== item.status || next.blocks !== item.blocks) {
    ctx.db.prepare('UPDATE work_items SET subject = ?, status = ?, blocks = ?, updated_at = ? WHERE id = ?').run(next.subject, next.status, next.blocks, ctx.now(), item.id);
    touched.add(item.node_id);
  }
  // "Blocked by k" is "k blocks this one": the link lives on k.
  for (const k of change.addBlockedBy ?? []) {
    const blocker = k === taskKey ? undefined : findItem(ctx, session.id, agentId, k);
    if (!blocker) continue;
    const list = parseKeys(blocker.blocks);
    if (list.includes(taskKey)) continue;
    list.push(taskKey);
    ctx.db.prepare('UPDATE work_items SET blocks = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), ctx.now(), blocker.id);
    touched.add(blocker.node_id);
  }
  return [...touched];
}

function toItems(rows: WorkRowWithEnd[]): WorkItem[] {
  const idOf = new Map(rows.map((r) => [`${r.session_id}\u0000${r.agent_id}\u0000${r.task_key}`, r.id]));
  return rows.map((r) => ({
    id: r.id,
    nodeId: r.node_id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    subject: r.subject,
    status: r.status,
    blocks: parseKeys(r.blocks)
      .map((k) => idOf.get(`${r.session_id}\u0000${r.agent_id}\u0000${k}`))
      .filter((id): id is number => id !== undefined),
    position: r.position,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  }));
}

/** The columns of a work row, plus its session's end (null unless the session has ended). */
const WITH_END = "w.*, CASE WHEN s.state = 'ended' THEN s.ended_at END AS ended_at FROM work_items w JOIN sessions s ON s.id = w.session_id";

/**
 * The project's working tasks, by node, then position: those of its live sessions, and, as the trail, those of its
 * sessions that ended less than 7 days ago. Only while the session still belongs to the project: a session moved to
 * another project takes its old tasks out of view. A plain read.
 */
export function listWorkItems(ctx: Ctx, projectId: number): WorkItem[] {
  const cutoff = new Date(Date.parse(ctx.now()) - TRAIL_MS).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT ${WITH_END}
       WHERE w.project_id = ? AND s.project_id = w.project_id AND (s.state != 'ended' OR s.ended_at >= ?)
       ORDER BY w.node_id, w.position, w.id`,
    )
    .all(projectId, cutoff) as WorkRowWithEnd[];
  return toItems(rows);
}

const ownList = (ctx: Ctx, sessionId: string, nodeId: number): WorkRowWithEnd[] =>
  ctx.db
    .prepare(`SELECT ${WITH_END} WHERE w.session_id = ? AND w.agent_id = '' AND w.node_id = ? ORDER BY w.position, w.id`)
    .all(sessionId, nodeId) as WorkRowWithEnd[];

/**
 * The tasks command, run by a main session where the task tools are absent: replaces the session's own working tasks
 * on a node with this list, in order (an empty list clears them). With no node it uses the session's focus, or the
 * project root once that focus is done or dropped, as the task tools do. Its
 * subagents' lists stay as they are. The hints are for that main session: it has the CLI, none of the scribe's tools,
 * and a shell where an unquoted `#` starts a comment.
 */
export function setTasks(ctx: Ctx, actor: string, sessionId: string, requested: number | undefined, tasks: TaskInput[]): { nodeId: number; tasks: WorkItem[] } {
  return write(ctx, actor, (record) => {
    const session = findSession(ctx, sessionId);
    if (!session || session.projectId === null) {
      throw badRequest(`Session ${sessionId} is not tracked`, 'Check --session against the session id in your InProgress briefing; an untracked session opts in through the inprogress skill first.');
    }
    if (!isTracking(ctx, session.projectId)) {
      throw notTracked(ctx, sessionId, session.projectId, 'InProgress stopped tracking this session when its project was archived; there is nothing to keep current, so skip the tasks command.');
    }
    const findStep = () => `Find the right step id with the CLI command: outline ${getProjectById(ctx, session.projectId!)?.slug ?? '<project>'}`;
    const focus = session.focusNodeId === null ? undefined : findNode(ctx, session.focusNodeId);
    const nodeId = requested ?? (focus && isClosed(ctx, focus) ? getProjectById(ctx, session.projectId)?.rootNodeId ?? focus.id : session.focusNodeId);
    if (nodeId === null) throw badRequest('This session has no focus', 'Name the step: tasks <id> …');
    const node = findNode(ctx, nodeId);
    if (!node) throw notFound(`Node #${nodeId} not found`, findStep());
    if (node.projectId !== session.projectId) throw badRequest(`#${nodeId} is not in this session's project`, findStep());
    const list = tasks.map((t) => ({ subject: t.subject.trim(), status: t.status }));
    if (list.some((t) => !t.subject)) throw badRequest('A task subject is empty');
    const before = ownList(ctx, sessionId, nodeId);
    const same = before.length === list.length && before.every((r, i) => r.subject === list[i].subject && r.status === list[i].status);
    if (!same) {
      ctx.db.prepare("DELETE FROM work_items WHERE session_id = ? AND agent_id = '' AND node_id = ?").run(sessionId, nodeId);
      const now = ctx.now();
      const first = nextPosition(ctx, nodeId);
      const insert = ctx.db.prepare(
        "INSERT INTO work_items (project_id, node_id, session_id, agent_id, task_key, subject, status, blocks, position, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, '[]', ?, ?, ?)",
      );
      // Keys of their own, so they never collide with the task tools' numeric ids.
      list.forEach((t, i) => insert.run(node.projectId, nodeId, sessionId, `set:${nodeId}:${i + 1}`, t.subject, t.status, first + i, now, now));
      record({ projectId: node.projectId, type: 'work.updated', entity: 'node', entityId: nodeId, data: { nodeId } });
    }
    return { nodeId, tasks: toItems(ownList(ctx, sessionId, nodeId)) };
  });
}

/**
 * Ticks every open working task on a node, whoever owns it (a main session or a subagent, live or ended), inside a
 * write already open: patchNode calls it when a step goes to done, so a done step shows no open tasks. Records
 * work.updated when any changed.
 */
export function closeNodeTasks(ctx: Ctx, record: RecordEvent, projectId: number, nodeId: number): void {
  const { changes } = ctx.db
    .prepare("UPDATE work_items SET status = 'completed', updated_at = ? WHERE node_id = ? AND status != 'completed'")
    .run(ctx.now(), nodeId);
  if (changes > 0) record({ projectId, type: 'work.updated', entity: 'node', entityId: nodeId, data: { nodeId } });
}

/** Drops the working tasks of sessions that ended more than a week ago: they have left the trail. Returns how many went. */
export function pruneWorkItems(ctx: Ctx): number {
  const cutoff = new Date(Date.parse(ctx.now()) - TRAIL_MS).toISOString();
  return ctx.db
    .prepare("DELETE FROM work_items WHERE session_id IN (SELECT id FROM sessions WHERE state = 'ended' AND ended_at IS NOT NULL AND ended_at < ?)")
    .run(cutoff).changes;
}
