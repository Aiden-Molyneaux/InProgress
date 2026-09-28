import { STALE_SESSION_MS, type Binding, type Project, type ProjectSummary } from '../../core/types';
import { globMatch } from '../../lib/glob';
import { isUnder, normalizePath } from '../../lib/paths';
import { write, type Ctx } from '../db/tx';
import { badRequest, conflict, notFound } from '../errors';

interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  playbook: string;
  status: 'active' | 'archived';
  root_node_id: number;
  created_at: string;
  updated_at: string;
}

interface BindingRow {
  id: number;
  project_id: number;
  path: string;
  branch_pattern: string;
  created_at: string;
}

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  playbook: r.playbook,
  status: r.status,
  rootNodeId: r.root_node_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toBinding = (r: BindingRow): Binding => ({
  id: r.id,
  projectId: r.project_id,
  path: r.path,
  branchPattern: r.branch_pattern || null,
  createdAt: r.created_at,
});

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'project';
}

export function getProjectById(ctx: Ctx, id: number): Project | undefined {
  const row = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? toProject(row) : undefined;
}

export function resolveProject(ctx: Ctx, ref: string | number): Project {
  const text = String(ref).trim();
  let row: ProjectRow | undefined;
  if (/^\d+$/.test(text)) row = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(text)) as ProjectRow | undefined;
  row ??= ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(text.toLowerCase()) as ProjectRow | undefined;
  row ??= ctx.db.prepare('SELECT * FROM projects WHERE lower(name) = lower(?)').get(text) as ProjectRow | undefined;
  if (!row) {
    const slugs = (ctx.db.prepare('SELECT slug FROM projects ORDER BY slug').all() as { slug: string }[]).map((r) => r.slug);
    throw notFound(
      `Project "${text}" not found`,
      slugs.length ? `Known projects: ${slugs.join(', ')}` : 'No projects exist yet; create one first.',
    );
  }
  return toProject(row);
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  playbook?: string;
  slug?: string;
}

export function createProject(ctx: Ctx, actor: string, input: CreateProjectInput): Project {
  const name = input.name.trim();
  if (!name) throw badRequest('Project name is empty');
  return write(ctx, actor, (record) => {
    const base = slugify(input.slug?.trim() || name);
    let slug = base;
    for (let n = 2; ctx.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug); n++) slug = `${base}-${n}`;
    const ts = ctx.now();
    const description = input.description ?? '';
    const info = ctx.db
      .prepare("INSERT INTO projects (slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)")
      .run(slug, name, description, input.playbook ?? '', ts, ts);
    const projectId = Number(info.lastInsertRowid);
    const root = ctx.db
      .prepare("INSERT INTO nodes (project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (?, NULL, 1, 'goal', ?, ?, 'active', 'claude', '', ?, ?)")
      .run(projectId, name, description, ts, ts);
    const rootId = Number(root.lastInsertRowid);
    ctx.db.prepare('UPDATE projects SET root_node_id = ? WHERE id = ?').run(rootId, projectId);
    record({ projectId, type: 'project.created', entity: 'project', entityId: projectId, data: { slug, name } });
    record({ projectId, type: 'node.created', entity: 'node', entityId: rootId, data: { ids: [rootId], parentId: null } });
    return getProjectById(ctx, projectId)!;
  });
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  playbook?: string;
  status?: 'active' | 'archived';
}

export function updateProject(ctx: Ctx, actor: string, ref: string | number, patch: UpdateProjectInput): Project {
  return write(ctx, actor, (record) => {
    const before = resolveProject(ctx, ref);
    const next = {
      name: patch.name?.trim() || before.name,
      description: patch.description ?? before.description,
      playbook: patch.playbook ?? before.playbook,
      status: patch.status ?? before.status,
    };
    const ts = ctx.now();
    ctx.db
      .prepare('UPDATE projects SET name = ?, description = ?, playbook = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, next.playbook, next.status, ts, before.id);
    if (patch.name !== undefined || patch.description !== undefined) {
      ctx.db.prepare('UPDATE nodes SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(next.name, next.description, ts, before.rootNodeId);
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of ['name', 'description', 'playbook', 'status'] as const) {
      if (patch[key] !== undefined && before[key] !== next[key]) changes[key] = { from: before[key], to: next[key] };
    }
    record({ projectId: before.id, type: 'project.updated', entity: 'project', entityId: before.id, data: { changes } });
    if (changes.name || changes.description) {
      const rootChanges = { ...(changes.name ? { title: changes.name } : {}), ...(changes.description ? { body: changes.description } : {}) };
      record({ projectId: before.id, type: 'node.updated', entity: 'node', entityId: before.rootNodeId, data: { changes: rootChanges } });
    }
    return getProjectById(ctx, before.id)!;
  });
}

export function listProjectSummaries(ctx: Ctx): ProjectSummary[] {
  const liveSince = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id AND n.assignee = 'me' AND n.status IN ('todo','active','blocked')) AS needs_you,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.state != 'ended' AND s.last_seen_at >= ?) AS active_sessions,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.state = 'working' AND s.last_seen_at >= ?) AS working_sessions,
        (SELECT ts FROM events e WHERE e.project_id = p.id ORDER BY e.id DESC LIMIT 1) AS last_event_at
       FROM projects p`,
    )
    .all(liveSince, liveSince) as (ProjectRow & { needs_you: number; active_sessions: number; working_sessions: number; last_event_at: string | null })[];
  return rows
    .map((r) => ({ ...toProject(r), needsYou: r.needs_you, activeSessions: r.active_sessions, workingSessions: r.working_sessions, lastEventAt: r.last_event_at }))
    .sort((a, b) => b.workingSessions - a.workingSessions || (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''));
}

export function addBinding(ctx: Ctx, actor: string, ref: string | number, rawPath: string, branchPattern?: string | null): Binding {
  return write(ctx, actor, (record) => {
    const project = resolveProject(ctx, ref);
    const path = normalizePath(rawPath);
    if (!path) throw badRequest('Binding path is empty');
    const hint = 'Use the full folder path, e.g. C:/personal/InGame.';
    if (!/^[A-Za-z]:\//.test(path) && !path.startsWith('/')) throw badRequest(`Binding path must be absolute: ${path}`, hint);
    if (path.split('/').some((s) => s === '.' || s === '..')) throw badRequest(`Binding path must not contain . or .. segments: ${path}`, hint);
    const pattern = branchPattern?.trim() ?? '';
    const existing = ctx.db
      .prepare('SELECT * FROM bindings WHERE lower(path) = lower(?) AND lower(branch_pattern) = lower(?)')
      .get(path, pattern) as BindingRow | undefined;
    if (existing) {
      if (existing.project_id === project.id) return toBinding(existing);
      const owner = getProjectById(ctx, existing.project_id);
      throw conflict(
        `${path}${pattern ? ` (branch ${pattern})` : ''} is already bound to project ${owner?.slug ?? existing.project_id}`,
        'Unbind it first, or add a branch pattern to tell the projects apart.',
      );
    }
    const info = ctx.db
      .prepare('INSERT INTO bindings (project_id, path, branch_pattern, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, path, pattern, ctx.now());
    const binding = toBinding(ctx.db.prepare('SELECT * FROM bindings WHERE id = ?').get(Number(info.lastInsertRowid)) as BindingRow);
    record({ projectId: project.id, type: 'binding.created', entity: 'binding', entityId: binding.id, data: { path, branchPattern: binding.branchPattern } });
    return binding;
  });
}

export function removeBinding(ctx: Ctx, actor: string, id: number): void {
  write(ctx, actor, (record) => {
    const row = ctx.db.prepare('SELECT * FROM bindings WHERE id = ?').get(id) as BindingRow | undefined;
    if (!row) throw notFound(`Binding ${id} not found`, 'list_projects shows binding ids.');
    ctx.db.prepare('DELETE FROM bindings WHERE id = ?').run(id);
    record({ projectId: row.project_id, type: 'binding.deleted', entity: 'binding', entityId: id, data: { path: row.path } });
  });
}

export function listBindings(ctx: Ctx): Binding[] {
  return (ctx.db.prepare('SELECT * FROM bindings ORDER BY id').all() as BindingRow[]).map(toBinding);
}

export function resolveBinding(ctx: Ctx, cwd: string, branch?: string | null): Project | undefined {
  const rows = ctx.db
    .prepare("SELECT b.* FROM bindings b JOIN projects p ON p.id = b.project_id WHERE p.status = 'active' ORDER BY b.id")
    .all() as BindingRow[];
  let best: BindingRow | undefined;
  for (const row of rows) {
    if (!isUnder(cwd, row.path)) continue;
    if (row.branch_pattern && !(branch && globMatch(row.branch_pattern, branch))) continue;
    const longer = !best || row.path.length > best.path.length;
    const tieWithBranch = !!best && row.path.length === best.path.length && !!row.branch_pattern && !best.branch_pattern;
    if (longer || tieWithBranch) best = row;
  }
  return best ? getProjectById(ctx, best.project_id) : undefined;
}
