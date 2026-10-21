import type { TaskState } from '../../core/taskState';
import type { After, Assignee, NodeInput, NodeKind, NodeLabel, NodeStatus, Project, RankBand, RankOp, TreeNode } from '../../core/types';
import { write, type Ctx, type RecordEvent } from '../db/tx';
import { badRequest, conflict, notFound } from '../errors';
import { definedOnly } from '../util';
import { clearNodeAsks } from './asks';
import { appendUnowned, dropFromQueue, getProjectById, inLiveProject, moveInQueue } from './projects';
import { placeInBand } from './rank';
import { parkedAncestor, shelvedAmong, subtreeIds } from './shelved';
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
  rank_band: RankBand | null;
  rank: number | null;
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
  rankBand: r.rank_band,
  rank: r.rank,
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
export function addNodes(
  ctx: Ctx,
  actor: string,
  input: { parentId: number; after?: After; nodes: NodeInput[]; check?: (parent: TreeNode) => void; band?: 'soon' },
): TreeNode[] {
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
    const top = input.nodes.map((n, i) => {
      const at = ids.length;
      add(n, parent.id, positions[i]);
      return ids[at];
    });
    renormalize(ctx, parent.id);
    // The window's quick-add (ranked Backlog spec section 3): each new open step goes to the bottom of Soon, in order. A
    // session's add (MCP, API) never sends a band, so its steps land unranked (R2).
    if (input.band) {
      const place = ctx.db.prepare('UPDATE nodes SET rank_band = ?, rank = ? WHERE id = ?');
      for (const [i, id] of top.entries()) {
        const status = input.nodes[i].status ?? 'todo';
        if (status === 'todo' || status === 'active' || status === 'blocked') place.run(input.band, placeInBand(ctx, parent.projectId, id, input.band, null), id);
      }
    }
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
    if (changes.parkedReason !== undefined) throw badRequest('parked_reason only goes with status "parked"');
    if (changes.parkedWhere !== undefined) throw badRequest('parked_where only goes with status "parked"');
    // Any status but parked clears the parked fields.
    next.parkedReason = '';
    next.parkedWhere = '';
  }
  const ts = ctx.now();
  next.parkedAt = next.status !== 'parked' ? null : parking ? ts : before.parkedAt;
  const completedAt = next.status === 'done' ? (before.status === 'done' ? before.completedAt : ts) : null;
  // A done, dropped or parked step has no driver (spec 1.1), cleared in the same UPDATE.
  const driver = next.status === 'done' || next.status === 'dropped' || next.status === 'parked' ? null : before.driverSessionId;
  // Parking drops the step's band and rank (ranked Backlog R5), and it comes back unranked, in Needs Triage; a step parked
  // by a build from before ranks may still carry one, so leaving parked clears it too. Shelved children keep theirs.
  if (parking || (before.status === 'parked' && next.status !== 'parked')) {
    next.rankBand = null;
    next.rank = null;
  }
  // Before the UPDATE, so the event's queue change reads the steps as they were in Next. Once the step is parked its
  // whole subtree is shelved, so every step under it leaves the stored queue too, and unparking does not bring it back.
  if (parking) dropFromQueue(ctx, record, before.projectId, subtreeIds(ctx, id), 'park');
  ctx.db
    .prepare(
      'UPDATE nodes SET title = ?, kind = ?, status = ?, assignee = ?, body = ?, outcome = ?, label = ?, updated_at = ?, completed_at = ?, driver_session_id = ?, parked_reason = ?, parked_where = ?, parked_at = ?, rank_band = ?, rank = ? WHERE id = ?',
    )
    .run(next.title, next.kind, next.status, next.assignee, next.body, next.outcome, next.label, ts, completedAt, driver, next.parkedReason, next.parkedWhere, next.parkedAt, next.rankBand, next.rank, id);
  // Before node.updated, which stays the project's newest event. Every path to done comes through here.
  if (next.status === 'done' && before.status !== 'done') closeNodeTasks(ctx, record, before.projectId, id);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  // The parked and rank fields change with the status as well as when sent, so they are compared whether or not the
  // patch names them.
  const keys = new Set<keyof TreeNode>([...(Object.keys(changes) as (keyof NodePatch)[]), 'parkedReason', 'parkedWhere', 'parkedAt', 'rankBand', 'rank']);
  for (const key of keys) {
    if (before[key] !== next[key]) diff[key] = { from: before[key], to: next[key] };
  }
  record({ projectId: before.projectId, type: 'node.updated', entity: 'node', entityId: id, data: { changes: diff } });
  return requireNode(ctx, id);
}

/**
 * The window's Park: parks step `id` with `reason` (required) and `where` (optional), as update_node with status
 * "parked" does: its driver and open asks are cleared, and it and every step under it leave the stored queue. `check`
 * runs on the step as read inside the write. A step already parked answers as it stands, writing nothing (as Done does).
 */
export function parkNode(ctx: Ctx, actor: string, id: number, input: { reason: string; where?: string }, check: (before: TreeNode) => void): TreeNode {
  return write(ctx, actor, (record) => {
    const before = requireNode(ctx, id);
    check(before);
    if (before.status === 'parked') return before;
    return patchWithAsks(ctx, record, actor, before, { status: 'parked', parkedReason: input.reason, parkedWhere: input.where ?? '' });
  });
}

/**
 * The window's Unpark and "to Next": step `id` goes back to todo with its parked fields cleared, and with `toNext` it is
 * appended to the unowned queue in the same write. `check` runs on the step as read inside the write. A step that is not
 * parked answers as it stands, writing nothing. With `toNext`, a step still under a parked step is refused: it would stay
 * shelved, so Next would not show it.
 */
export function unparkNode(ctx: Ctx, actor: string, id: number, toNext: boolean, check: (before: TreeNode) => void): TreeNode {
  return write(ctx, actor, (record) => {
    const before = requireNode(ctx, id);
    check(before);
    if (before.status !== 'parked') return before;
    const above = toNext ? parkedAncestor(ctx, id) : null;
    if (above !== null) throw badRequest(`#${id} is under parked #${above}`, `Unpark #${above} first.`);
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

export function moveNode(ctx: Ctx, actor: string, id: number, input: { parentId: number; after?: After; check?: (node: TreeNode, parent: TreeNode) => void }): TreeNode {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, id);
    if (node.parentId === null) throw badRequest(`#${id} is the project root and cannot be moved`);
    const parent = requireNode(ctx, input.parentId);
    // The caller's own test of the step and its new parent, run in this write so neither can go stale before the move.
    input.check?.(node, parent);
    if (parent.projectId !== node.projectId) throw badRequest(`#${parent.id} is in a different project than #${id}`);
    for (let cur: TreeNode | undefined = parent; cur; cur = cur.parentId === null ? undefined : findNode(ctx, cur.parentId)) {
      if (cur.id === id) throw badRequest(`Cannot move #${id} under its own descendant #${parent.id}`);
    }
    if (input.after === id) throw badRequest(`Cannot place #${id} after itself`);
    const [position] = insertPositions(siblings(ctx, parent.id, id), input.after ?? 'end', 1);
    // Under a parked or shelved parent the moved steps are shelved: they leave the stored queue, as parking takes them out,
    // so unparking the parent does not bring them back to Next.
    if (shelvedAmong(ctx, [parent.id]).size) dropFromQueue(ctx, record, node.projectId, subtreeIds(ctx, id), 'move');
    ctx.db.prepare('UPDATE nodes SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?').run(parent.id, position, ctx.now(), id);
    renormalize(ctx, parent.id);
    record({ projectId: node.projectId, type: 'node.moved', entity: 'node', entityId: id, data: { fromParentId: node.parentId, toParentId: parent.id } });
    return requireNode(ctx, id);
  });
}

/** Why step `node` cannot take a rank change, or null when it can: open, not shelved, and not a group. */
function notRankable(ctx: Ctx, node: TreeNode): string | null {
  if (node.parentId === null) return 'is the project root';
  if (node.status !== 'todo' && node.status !== 'active' && node.status !== 'blocked') return `is ${node.status}`;
  if (shelvedAmong(ctx, [node.id]).size) return 'is under a parked step';
  if (ctx.db.prepare("SELECT 1 FROM nodes WHERE parent_id = ? AND status IN ('todo', 'active', 'blocked')").get(node.id) !== undefined) return 'has open steps under it';
  return null;
}

/**
 * The window's rank change (ranked Backlog spec section 2), in one write. `to: 'next'` is the queue move before `before`
 * in the unowned queue, the band untouched. Soon or someday takes the step out of the queue, whoever owns its entry, and
 * places it in that band before `before` (null: at the end), with `updated_at` set and one node.updated; the queue's
 * project.updated comes first, as parking orders them. A step of another project, the root, one that is not open, a
 * shelved step or one with open steps under it is refused (409), and so is a `before` that is not in the band named.
 */
export function applyRankOp(ctx: Ctx, actor: string, projectId: number, op: RankOp): { node: TreeNode; project: Project } {
  return write(ctx, actor, (record) => {
    const node = findNode(ctx, op.node);
    if (node?.projectId !== projectId) throw conflict(`#${op.node} is not in this project`, 'Reload the window.');
    const why = notRankable(ctx, node);
    if (why) throw conflict(`#${op.node} ${why}`, 'Reload the window.');
    if (op.to === 'next') {
      moveInQueue(ctx, record, projectId, op.node, op.before);
      return { node, project: getProjectById(ctx, projectId)! };
    }
    const rank = placeInBand(ctx, projectId, op.node, op.to, op.before);
    dropFromQueue(ctx, record, projectId, [op.node], 'rank');
    ctx.db.prepare('UPDATE nodes SET rank_band = ?, rank = ?, updated_at = ? WHERE id = ?').run(op.to, rank, ctx.now(), op.node);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (node.rankBand !== op.to) changes.rankBand = { from: node.rankBand, to: op.to };
    if (node.rank !== rank) changes.rank = { from: node.rank, to: rank };
    record({ projectId, type: 'node.updated', entity: 'node', entityId: op.node, data: { changes } });
    return { node: requireNode(ctx, op.node), project: getProjectById(ctx, projectId)! };
  });
}

export function deleteNode(ctx: Ctx, actor: string, id: number, cascade = false, check?: (node: TreeNode, ids: number[]) => void): { ids: number[] } {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, id);
    if (node.parentId === null) throw badRequest(`#${id} is the project root; archive the project instead`);
    const ids = subtreeIds(ctx, id);
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
