import type { TaskState } from '../../core/taskState';
import type { After, Assignee, NodeInput, NodeKind, NodeLabel, NodeStatus, TreeNode } from '../../core/types';
import { write, type Ctx, type RecordEvent } from '../db/tx';
import { badRequest, notFound } from '../errors';
import { definedOnly } from '../util';
import { clearNodeAsks } from './asks';
import { appendUnowned, dropFromQueue, inLiveProject } from './projects';
import { closeNodeTasks } from './work';

interface NodeRow {
  id: number;
  project_id: number;
  parent_id: number | null;
  position: number;
  kind: NodeKind;
  title: string;
  body: string;
  status: NodeStatus;
  assignee: Assignee;
  outcome: string;
  label: NodeLabel | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  driver_session_id: string | null;
  board_state: TaskState | null;
  state_since: string | null;
  hue: number | null;
  parked_reason: string;
  parked_where: string;
  parked_at: string | null;
}

export const toNode = (r: NodeRow): TreeNode => ({
  id: r.id,
  projectId: r.project_id,
  parentId: r.parent_id,
  position: r.position,
  kind: r.kind,
  title: r.title,
  body: r.body,
  status: r.status,
  assignee: r.assignee,
  outcome: r.outcome,
  label: r.label,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  driverSessionId: r.driver_session_id,
  boardState: r.board_state,
  stateSince: r.state_since,
  hue: r.hue,
  parkedReason: r.parked_reason,
  parkedWhere: r.parked_where,
  parkedAt: r.parked_at,
});

/** A step by id. A deleted project's steps are not found, so every read and write by id refuses them. */
export function findNode(ctx: Ctx, id: number): TreeNode | undefined {
  const row = ctx.db.prepare(`SELECT * FROM nodes WHERE id = ? AND ${inLiveProject('nodes.project_id')}`).get(id) as NodeRow | undefined;
  return row ? toNode(row) : undefined;
}

export function requireNode(ctx: Ctx, id: number): TreeNode {
  const node = findNode(ctx, id);
  if (!node) throw notFound(`Node #${id} not found`, 'Use get_outline or search to find the right #id.');
  return node;
}

/** The node a leading `#id` names (`#57 Write the guide`), when that node is in the project. */
export function leadingNode(ctx: Ctx, text: string | undefined, projectId: number | null): number | undefined {
  const m = /^\s*#(\d+)\b/.exec(text ?? '');
  if (!m || projectId === null) return undefined;
  const node = findNode(ctx, Number(m[1]));
  return node?.projectId === projectId ? node.id : undefined;
}

export function listNodes(ctx: Ctx, projectId: number): TreeNode[] {
  return (ctx.db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY parent_id, position, id').all(projectId) as NodeRow[]).map(toNode);
}

function siblings(ctx: Ctx, parentId: number, excludeId?: number): { id: number; position: number }[] {
  return (ctx.db.prepare('SELECT id, position FROM nodes WHERE parent_id = ? ORDER BY position, id').all(parentId) as { id: number; position: number }[])
    .filter((s) => s.id !== excludeId);
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export function insertPositions(sibs: { id: number; position: number }[], after: After, count: number): number[] {
  const idx = sibs.findIndex((s) => s.id === after);
  if (typeof after === 'number' && idx < 0) throw badRequest(`#${after} is not a child of this parent`, 'after must be a sibling #id, "start", or "end".');
  if (sibs.length === 0) return range(count).map((i) => i + 1);
  if (after === 'end') {
    const last = sibs[sibs.length - 1].position;
    return range(count).map((i) => last + i + 1);
  }
  if (after === 'start') {
    const first = sibs[0].position;
    return range(count).map((i) => first - (count - i));
  }
  const lo = sibs[idx].position;
  const hi = sibs[idx + 1]?.position;
  if (hi === undefined) return range(count).map((i) => lo + i + 1);
  const step = (hi - lo) / (count + 1);
  return range(count).map((i) => lo + step * (i + 1));
}

function renormalize(ctx: Ctx, parentId: number): void {
  const sibs = siblings(ctx, parentId);
  const tight = sibs.some((s, i) => i > 0 && s.position - sibs[i - 1].position < 1e-6);
  if (!tight) return;
  const update = ctx.db.prepare('UPDATE nodes SET position = ? WHERE id = ?');
  sibs.forEach((s, i) => update.run(i + 1, s.id));
}

/**
 * Adds `nodes` (with their children) under `parentId`.
 * The nodes it returns are read inside the write, before write() runs the Board reconcile: their boardState, stateSince
 * and hue predate this write. Only a snapshot (or a read after the write) carries the current values.
 */
export function addNodes(ctx: Ctx, actor: string, input: { parentId: number; after?: After; nodes: NodeInput[]; check?: (parent: TreeNode) => void }): TreeNode[] {
  if (input.nodes.length === 0) throw badRequest('nodes is empty');
  return write(ctx, actor, (record) => {
    const parent = requireNode(ctx, input.parentId);
    // The caller's own test of the parent, run in this write so it cannot go stale before the insert.
    input.check?.(parent);
    const positions = insertPositions(siblings(ctx, parent.id), input.after ?? 'end', input.nodes.length);
    const ts = ctx.now();
    const insert = ctx.db.prepare(
      'INSERT INTO nodes (project_id, parent_id, position, kind, title, body, status, assignee, outcome, label, created_at, updated_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const ids: number[] = [];
    const add = (n: NodeInput, parentId: number, position: number) => {
      const title = n.title.trim();
      if (!title) throw badRequest('A node title is empty');
      const status = n.status ?? 'todo';
      if (status === 'parked') throw badRequest('A new step cannot start parked', 'Add it, then park it with update_node: status "parked" and a parked_reason.');
      const info = insert.run(parent.projectId, parentId, position, n.kind ?? 'task', title, n.body ?? '', status, n.assignee ?? 'claude', n.outcome ?? '', n.label ?? null, ts, ts, status === 'done' ? ts : null);
      const id = Number(info.lastInsertRowid);
      ids.push(id);
      (n.children ?? []).forEach((child, i) => add(child, id, i + 1));
    };
    input.nodes.forEach((n, i) => add(n, parent.id, positions[i]));
    renormalize(ctx, parent.id);
    record({ projectId: parent.projectId, type: 'node.created', entity: 'node', entityId: ids[0], data: { ids, parentId: parent.id } });
    return ids.map((id) => requireNode(ctx, id));
  });
}

export interface NodePatch {
  title?: string;
  kind?: NodeKind;
  status?: NodeStatus;
  assignee?: Assignee;
  body?: string;
  outcome?: string;
  /** null clears it. */
  label?: NodeLabel | null;
  /** Why the step is set aside: required (trimmed, non-empty) to enter `parked`, editable while it stays parked. */
  parkedReason?: string;
  /** Where its work lives (a branch, worktree or commit); only with `parked`. */
  parkedWhere?: string;
}

/** The ids among `ids` that are shelved: parked, or under a parked ancestor. One recursive walk up `parent_id`. */
export function shelvedAmong(ctx: Ctx, ids: number[]): Set<number> {
  if (!ids.length) return new Set();
  return new Set(
    ctx.db
      .prepare(
        `WITH RECURSIVE up(start, id) AS (
           SELECT id, id FROM nodes WHERE id IN (${ids.map(() => '?').join(', ')})
           UNION ALL
           SELECT up.start, n.parent_id FROM up JOIN nodes n ON n.id = up.id WHERE n.parent_id IS NOT NULL
         )
         SELECT DISTINCT up.start FROM up JOIN nodes p ON p.id = up.id WHERE p.status = 'parked'`,
      )
      .pluck()
      .all(...ids) as number[],
  );
}

/** Step `id` and every step under it. */
function subtreeIds(ctx: Ctx, id: number): number[] {
  return ctx.db
    .prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub')
    .pluck()
    .all(id) as number[];
}

/**
 * Applies `patch` to step `id`, clearing its asks when it is dropped or parked, or a question node is finished.
 * The node it returns is read inside the write, before write() runs the Board reconcile: its boardState, stateSince
 * and hue predate this write. Only a snapshot (or a read after the write) carries the current values.
 */
export function updateNode(ctx: Ctx, actor: string, id: number, patch: NodePatch): TreeNode {
  return write(ctx, actor, (record) => patchWithAsks(ctx, record, actor, requireNode(ctx, id), patch));
}

/** The body of updateNode, inside a write() already open: the drop, park and question-node ask clearing, then patchNode. */
function patchWithAsks(ctx: Ctx, record: RecordEvent, actor: string, before: TreeNode, patch: NodePatch): TreeNode {
  // Before patchNode, so node.updated stays the project's newest event (the activity strip shows it).
  if ((patch.status === 'dropped' || patch.status === 'parked') && before.status !== patch.status) {
    // A dropped or parked step's asks are moot (spec 1.2); a finished one's stay, a review ask most of all.
    clearNodeAsks(ctx, record, actor, before.id);
  } else if ((patch.kind ?? before.kind) === 'question' && patch.status === 'done' && before.status !== 'done') {
    // A question node and its migrated ask are one question: finishing the node answers the ask.
    clearNodeAsks(ctx, record, actor, before.id, (patch.outcome ?? before.outcome).trim());
  }
  return patchNode(ctx, record, before, patch);
}

/**
 * The window's Done: marks step `id` done, with `outcome` when it has text (an empty one leaves any existing outcome as
 * it is). `check` runs on the step as read inside the write. A step already done answers as it stands and writes nothing,
 * except that an outcome sent for one whose stored outcome is empty fills it (so a later Done with an outcome is not lost).
 */
export function finishNode(ctx: Ctx, actor: string, id: number, outcome: string | undefined, check: (before: TreeNode) => void): TreeNode {
  return write(ctx, actor, (record) => {
    const before = requireNode(ctx, id);
    check(before);
    const text = outcome?.trim() ?? '';
    if (before.status === 'done') return text && !before.outcome.trim() ? patchNode(ctx, record, before, { outcome: text }) : before;
    return patchWithAsks(ctx, record, actor, before, text ? { status: 'done', outcome: text } : { status: 'done' });
  });
}

/**
 * updateNode's work, inside a write() already open (write() never nests): applies `patch` to `before`, as read in this
 * write, and records node.updated with the changed fields. setFocus uses it to make a focused step active in its own
 * write. A patch moves `updatedAt`, which the needs-you age counts from; logs, resources and work items never do.
 */
export function patchNode(ctx: Ctx, record: RecordEvent, before: TreeNode, patch: NodePatch): TreeNode {
  const id = before.id;
  const changes = definedOnly(patch);
  if (before.parentId === null && (changes.title !== undefined || changes.body !== undefined)) {
    throw badRequest(`#${id} is the project root; its title and body mirror the project`, 'Rename or re-describe it with update_project.');
  }
  if (changes.title !== undefined) changes.title = changes.title.trim();
  const next = { ...before, ...changes };
  if (!next.title) throw badRequest('title is empty');
  if (before.parentId === null && next.kind !== 'goal') throw badRequest(`#${id} is the project root; its kind stays "goal"`);
  const parking = next.status === 'parked' && before.status !== 'parked';
  if (next.status === 'parked') {
    if (parking && before.parentId === null) throw badRequest(`#${id} is the project root; only a step can be parked`);
    if (parking && (before.status === 'done' || before.status === 'dropped')) throw badRequest(`#${id} is ${before.status}; only an open step can be parked`);
    // Entering parked needs a reason; staying parked keeps the stored reason and where unless new ones are sent.
    next.parkedReason = (changes.parkedReason ?? (parking ? '' : before.parkedReason)).trim();
    if (!next.parkedReason) throw badRequest('parked_reason is required to park a step', 'Say why it is set aside.');
    next.parkedWhere = (changes.parkedWhere ?? (parking ? '' : before.parkedWhere)).trim();
  } else {
    if (changes.parkedReason !== undefined || changes.parkedWhere !== undefined) throw badRequest('parked_reason only goes with status "parked"');
    // Any status but parked clears the parked fields.
    next.parkedReason = '';
    next.parkedWhere = '';
  }
  const ts = ctx.now();
  next.parkedAt = next.status !== 'parked' ? null : parking ? ts : before.parkedAt;
  const completedAt = next.status === 'done' ? (before.status === 'done' ? before.completedAt : ts) : null;
  // A done, dropped or parked step has no driver (spec 1.1), cleared in the same UPDATE.
  const driver = next.status === 'done' || next.status === 'dropped' || next.status === 'parked' ? null : before.driverSessionId;
  // Before the UPDATE, so the event's queue change reads the steps as they were in Next. Once the step is parked its
  // whole subtree is shelved, so every step under it leaves the stored queue too, and unparking does not bring it back.
  if (parking) dropFromQueue(ctx, record, before.projectId, subtreeIds(ctx, id));
  ctx.db
    .prepare(
      'UPDATE nodes SET title = ?, kind = ?, status = ?, assignee = ?, body = ?, outcome = ?, label = ?, updated_at = ?, completed_at = ?, driver_session_id = ?, parked_reason = ?, parked_where = ?, parked_at = ? WHERE id = ?',
    )
    .run(next.title, next.kind, next.status, next.assignee, next.body, next.outcome, next.label, ts, completedAt, driver, next.parkedReason, next.parkedWhere, next.parkedAt, id);
  // Before node.updated, which stays the project's newest event. Every path to done comes through here.
  if (next.status === 'done' && before.status !== 'done') closeNodeTasks(ctx, record, before.projectId, id);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  // The parked fields change with the status as well as when sent, so they are compared whether or not the patch names them.
  const keys = new Set<keyof TreeNode>([...(Object.keys(changes) as (keyof NodePatch)[]), 'parkedReason', 'parkedWhere', 'parkedAt']);
  for (const key of keys) {
    if (before[key] !== next[key]) diff[key] = { from: before[key], to: next[key] };
  }
  record({ projectId: before.projectId, type: 'node.updated', entity: 'node', entityId: id, data: { changes: diff } });
  return requireNode(ctx, id);
}

/**
 * The window's Park: parks step `id` with `reason` (required) and `where` (optional), as update_node with status
 * "parked" does: its driver and open asks are cleared, and it and every step under it leave the stored queue. `check`
 * runs on the step as read inside the write. A step already parked is refused.
 */
export function parkNode(ctx: Ctx, actor: string, id: number, input: { reason: string; where?: string }, check: (before: TreeNode) => void): TreeNode {
  return write(ctx, actor, (record) => {
    const before = requireNode(ctx, id);
    check(before);
    if (before.status === 'parked') throw badRequest(`#${id} is already parked`, 'Reload the window.');
    return patchWithAsks(ctx, record, actor, before, { status: 'parked', parkedReason: input.reason, parkedWhere: input.where ?? '' });
  });
}

/**
 * The window's Unpark and "to Next": step `id` goes back to todo with its parked fields cleared, and with `toNext` it is
 * appended to the unowned queue in the same write. `check` runs on the step as read inside the write. A step that is not
 * parked is refused.
 */
export function unparkNode(ctx: Ctx, actor: string, id: number, toNext: boolean, check: (before: TreeNode) => void): TreeNode {
  return write(ctx, actor, (record) => {
    const before = requireNode(ctx, id);
    check(before);
    if (before.status !== 'parked') throw badRequest(`#${id} is not parked`, 'Reload the window.');
    const node = patchNode(ctx, record, before, { status: 'todo' });
    // After the status change, so the queue event reads the step as open again.
    if (toNext) appendUnowned(ctx, record, before.projectId, id);
    return node;
  });
}

/**
 * Sets or clears the session that drives `node`, inside a write() already open, and records node.updated with the
 * change. A driver change is not an edit of the step, so updatedAt (where the needs-you age counts from) stays. No-op
 * when the driver is already `sessionId`.
 */
export function setDriver(ctx: Ctx, record: RecordEvent, node: TreeNode, sessionId: string | null): void {
  if (node.driverSessionId === sessionId) return;
  ctx.db.prepare('UPDATE nodes SET driver_session_id = ? WHERE id = ?').run(sessionId, node.id);
  record({
    projectId: node.projectId,
    type: 'node.updated',
    entity: 'node',
    entityId: node.id,
    data: { changes: { driverSessionId: { from: node.driverSessionId, to: sessionId } } },
  });
}

export function moveNode(ctx: Ctx, actor: string, id: number, input: { parentId: number; after?: After }): TreeNode {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, id);
    if (node.parentId === null) throw badRequest(`#${id} is the project root and cannot be moved`);
    const parent = requireNode(ctx, input.parentId);
    if (parent.projectId !== node.projectId) throw badRequest(`#${parent.id} is in a different project than #${id}`);
    for (let cur: TreeNode | undefined = parent; cur; cur = cur.parentId === null ? undefined : findNode(ctx, cur.parentId)) {
      if (cur.id === id) throw badRequest(`Cannot move #${id} under its own descendant #${parent.id}`);
    }
    if (input.after === id) throw badRequest(`Cannot place #${id} after itself`);
    const [position] = insertPositions(siblings(ctx, parent.id, id), input.after ?? 'end', 1);
    ctx.db.prepare('UPDATE nodes SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?').run(parent.id, position, ctx.now(), id);
    renormalize(ctx, parent.id);
    record({ projectId: node.projectId, type: 'node.moved', entity: 'node', entityId: id, data: { fromParentId: node.parentId, toParentId: parent.id } });
    return requireNode(ctx, id);
  });
}

export function deleteNode(ctx: Ctx, actor: string, id: number, cascade = false, check?: (node: TreeNode, ids: number[]) => void): { ids: number[] } {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, id);
    if (node.parentId === null) throw badRequest(`#${id} is the project root; archive the project instead`);
    const ids = (
      ctx.db
        .prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub')
        .all(id) as { id: number }[]
    ).map((r) => r.id);
    // The caller's own test of the node and its subtree, run in this write so it cannot go stale before the delete.
    check?.(node, ids);
    if (ids.length > 1 && !cascade) {
      throw badRequest(`#${id} has ${ids.length - 1} descendant(s)`, 'Pass cascade: true to delete them too, or move them first.');
    }
    ctx.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    record({ projectId: node.projectId, type: 'node.deleted', entity: 'node', entityId: id, data: { ids, parentId: node.parentId } });
    return { ids };
  });
}
