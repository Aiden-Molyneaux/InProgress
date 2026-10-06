import type { After, Assignee, NodeInput, NodeKind, NodeLabel, NodeStatus, TreeNode } from '../../core/types';
import { write, type Ctx, type RecordEvent } from '../db/tx';
import { badRequest, notFound } from '../errors';
import { definedOnly } from '../util';
import { inLiveProject } from './projects';

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

export function addNodes(ctx: Ctx, actor: string, input: { parentId: number; after?: After; nodes: NodeInput[] }): TreeNode[] {
  if (input.nodes.length === 0) throw badRequest('nodes is empty');
  return write(ctx, actor, (record) => {
    const parent = requireNode(ctx, input.parentId);
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
}

export function updateNode(ctx: Ctx, actor: string, id: number, patch: NodePatch): TreeNode {
  return write(ctx, actor, (record) => patchNode(ctx, record, requireNode(ctx, id), patch));
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
  const ts = ctx.now();
  const completedAt = next.status === 'done' ? (before.status === 'done' ? before.completedAt : ts) : null;
  ctx.db
    .prepare('UPDATE nodes SET title = ?, kind = ?, status = ?, assignee = ?, body = ?, outcome = ?, label = ?, updated_at = ?, completed_at = ? WHERE id = ?')
    .run(next.title, next.kind, next.status, next.assignee, next.body, next.outcome, next.label, ts, completedAt, id);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(changes) as (keyof NodePatch)[]) {
    if (before[key] !== next[key]) diff[key] = { from: before[key], to: next[key] };
  }
  record({ projectId: before.projectId, type: 'node.updated', entity: 'node', entityId: id, data: { changes: diff } });
  return requireNode(ctx, id);
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

export function deleteNode(ctx: Ctx, actor: string, id: number, cascade = false): { ids: number[] } {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, id);
    if (node.parentId === null) throw badRequest(`#${id} is the project root; archive the project instead`);
    const ids = (
      ctx.db
        .prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub')
        .all(id) as { id: number }[]
    ).map((r) => r.id);
    if (ids.length > 1 && !cascade) {
      throw badRequest(`#${id} has ${ids.length - 1} descendant(s)`, 'Pass cascade: true to delete them too, or move them first.');
    }
    ctx.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    record({ projectId: node.projectId, type: 'node.deleted', entity: 'node', entityId: id, data: { ids, parentId: node.parentId } });
    return { ids };
  });
}
