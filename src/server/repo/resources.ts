import type { Resource, ResourceKind, ResourceMeta } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { badRequest, notFound } from '../errors';
import { requireNode } from './nodes';
import { inLiveProject } from './projects';

interface ResourceRow {
  id: number;
  project_id: number;
  node_id: number;
  kind: ResourceKind;
  title: string;
  content?: string | null;
  path: string | null;
  url: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  content_length: number | null;
}

const META = 'id, project_id, node_id, kind, title, path, url, session_id, created_at, updated_at, length(content) AS content_length';

const toMeta = (r: ResourceRow): ResourceMeta => ({
  id: r.id,
  projectId: r.project_id,
  nodeId: r.node_id,
  kind: r.kind,
  title: r.title,
  path: r.path,
  url: r.url,
  contentLength: r.content_length ?? 0,
  sessionId: r.session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface ResourceInput {
  nodeId: number;
  kind: ResourceKind;
  title: string;
  content?: string | null;
  path?: string | null;
  url?: string | null;
  sessionId?: string | null;
}

export interface ResourcePatch {
  nodeId?: number;
  kind?: ResourceKind;
  title?: string;
  content?: string | null;
  path?: string | null;
  url?: string | null;
}

const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/** A resource by id. A deleted project's resources are not found: reading, opening or editing one is refused. */
export function requireResource(ctx: Ctx, id: number): Resource {
  const row = ctx.db.prepare(`SELECT ${META}, content FROM resources WHERE id = ? AND ${inLiveProject('resources.project_id')}`).get(id) as ResourceRow | undefined;
  if (!row) throw notFound(`Resource r${id} not found`, 'get_node lists a node\'s resources.');
  return { ...toMeta(row), content: row.content ?? null };
}

export function listResourceMeta(ctx: Ctx, projectId: number): ResourceMeta[] {
  return (ctx.db.prepare(`SELECT ${META} FROM resources WHERE project_id = ? ORDER BY id`).all(projectId) as ResourceRow[]).map(toMeta);
}

export function listNodeResources(ctx: Ctx, nodeId: number): ResourceMeta[] {
  return (ctx.db.prepare(`SELECT ${META} FROM resources WHERE node_id = ? ORDER BY id`).all(nodeId) as ResourceRow[]).map(toMeta);
}

export function addResource(ctx: Ctx, actor: string, input: ResourceInput): Resource {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, input.nodeId);
    const content = input.content ?? null;
    const path = clean(input.path);
    const url = clean(input.url);
    if (content === null && !path && !url) throw badRequest('A resource needs content, a path, or a url');
    const title = input.title.trim();
    if (!title) throw badRequest('Resource title is empty');
    const ts = ctx.now();
    const info = ctx.db
      .prepare('INSERT INTO resources (project_id, node_id, kind, title, content, path, url, session_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(node.projectId, node.id, input.kind, title, content, path, url, input.sessionId ?? null, ts, ts);
    const resource = requireResource(ctx, Number(info.lastInsertRowid));
    record({ projectId: node.projectId, type: 'resource.created', entity: 'resource', entityId: resource.id, data: { nodeId: node.id, title, kind: input.kind } });
    return resource;
  });
}

export function updateResource(ctx: Ctx, actor: string, id: number, patch: ResourcePatch): Resource {
  return write(ctx, actor, (record) => {
    const before = requireResource(ctx, id);
    let nodeId = before.nodeId;
    if (patch.nodeId !== undefined && patch.nodeId !== before.nodeId) {
      const node = requireNode(ctx, patch.nodeId);
      if (node.projectId !== before.projectId) throw badRequest(`#${node.id} is in a different project than r${id}`);
      nodeId = node.id;
    }
    const next = {
      kind: patch.kind ?? before.kind,
      title: patch.title?.trim() || before.title,
      content: patch.content !== undefined ? patch.content : before.content,
      path: patch.path !== undefined ? clean(patch.path) : before.path,
      url: patch.url !== undefined ? clean(patch.url) : before.url,
    };
    if (next.content === null && !next.path && !next.url) throw badRequest('A resource needs content, a path, or a url');
    ctx.db
      .prepare('UPDATE resources SET node_id = ?, kind = ?, title = ?, content = ?, path = ?, url = ?, updated_at = ? WHERE id = ?')
      .run(nodeId, next.kind, next.title, next.content, next.path, next.url, ctx.now(), id);
    record({ projectId: before.projectId, type: 'resource.updated', entity: 'resource', entityId: id, data: { nodeId, fromNodeId: before.nodeId } });
    return requireResource(ctx, id);
  });
}

export function deleteResource(ctx: Ctx, actor: string, id: number): void {
  write(ctx, actor, (record) => {
    const before = requireResource(ctx, id);
    ctx.db.prepare('DELETE FROM resources WHERE id = ?').run(id);
    record({ projectId: before.projectId, type: 'resource.deleted', entity: 'resource', entityId: id, data: { nodeId: before.nodeId } });
  });
}
