import { STALE_SESSION_MS, type Binding, type Project, type ProjectSummary, type QueueEntry } from '../../core/types';
import { globMatch } from '../../lib/glob';
import { isUnder, normalizePath } from '../../lib/paths';
import { write, type Ctx, type RecordEvent } from '../db/tx';
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
  queue: string;
}

interface BindingRow {
  id: number;
  project_id: number;
  path: string;
  branch_pattern: string;
  created_at: string;
}

const isNodeId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** One stored entry: `{ "node": 82, "session": "3fa9…" }` (session null: unowned), or a bare node id from before owners. */
function toEntry(item: unknown): QueueEntry | undefined {
  if (isNodeId(item)) return { nodeId: item, sessionId: null };
  if (typeof item !== 'object' || item === null) return undefined;
  const { node, session } = item as { node?: unknown; session?: unknown };
  if (!isNodeId(node)) return undefined;
  if (session === null || session === undefined) return { nodeId: node, sessionId: null };
  return typeof session === 'string' && session ? { nodeId: node, sessionId: session } : undefined;
}

/**
 * The stored queue, as set_queue and releaseQueue last left it. Both shapes read: a bare number is an unowned entry.
 * Anything else is skipped, and a node listed twice keeps its first place. A build from before owned entries keeps only
 * bare numbers, so it reads the object shape as an empty queue: that is the rollback.
 */
function parseQueue(json: string | undefined): QueueEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(json ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const entries: QueueEntry[] = [];
  for (const item of value) {
    const entry = toEntry(item);
    if (!entry || seen.has(entry.nodeId)) continue;
    seen.add(entry.nodeId);
    entries.push(entry);
  }
  return entries;
}

/** The stored JSON: every entry in the object shape. */
const queueJson = (queue: QueueEntry[]): string => JSON.stringify(queue.map((e) => ({ node: e.nodeId, session: e.sessionId })));

/** Which of `ids` are open steps of the project: not done, dropped or deleted. */
function openSteps(ctx: Ctx, projectId: number, ids: number[]): Set<number> {
  if (!ids.length) return new Set();
  return new Set(
    ctx.db
      .prepare(`SELECT id FROM nodes WHERE project_id = ? AND status NOT IN ('done', 'dropped') AND id IN (${ids.map(() => '?').join(', ')})`)
      .pluck()
      .all(projectId, ...ids) as number[],
  );
}

/** The queue as it is read: deleted, done and dropped nodes leave it on their own. */
function liveQueue(ctx: Ctx, projectId: number, json: string | undefined): QueueEntry[] {
  const entries = parseQueue(json);
  const open = openSteps(ctx, projectId, entries.map((e) => e.nodeId));
  return entries.filter((e) => open.has(e.nodeId));
}

const isOwned = (e: QueueEntry) => e.sessionId !== null;

/** Owned entries first, then the unowned ones, each part keeping its order. */
const ownedFirst = (queue: QueueEntry[]): QueueEntry[] => [...queue.filter(isOwned), ...queue.filter((e) => !isOwned(e))];

/**
 * `queue` with `nodes` as the entries of `sessionId` (null: the unowned ones), replacing only its old entries: in place
 * of its first old entry, or, when it had none, after the last owned entry. A node is in the queue once, so each one
 * given leaves wherever it was. Splices every stored entry, not just the open ones, so a step that is reopened takes its
 * old place again.
 */
function spliceQueue(queue: QueueEntry[], nodes: number[], sessionId: string | null): QueueEntry[] {
  const given = new Set(nodes);
  const first = queue.findIndex((e) => e.sessionId === sessionId);
  const kept: QueueEntry[] = [];
  let at = -1;
  queue.forEach((e, i) => {
    if (i === first) at = kept.length;
    if (e.sessionId !== sessionId && !given.has(e.nodeId)) kept.push(e);
  });
  if (at < 0) at = kept.reduce((after, e, i) => (isOwned(e) ? i + 1 : after), 0);
  return ownedFirst([...kept.slice(0, at), ...nodes.map((nodeId) => ({ nodeId, sessionId })), ...kept.slice(at)]);
}

/**
 * `queue` with the entries of the sessions in `released` turned unowned, at the head of the unowned part, keeping their
 * stored order (so several sessions released at once read as queueView showed them before). An entry whose step is not
 * in `open` (done, dropped or deleted) is dropped instead: with no owner left, nothing would reopen it into place, and
 * the stored unowned part keeps open steps only. A live owner's own finished entries are left where they are.
 */
function releaseEntries(queue: QueueEntry[], released: ReadonlySet<string>, open: ReadonlySet<number>): QueueEntry[] {
  const isReleased = (e: QueueEntry) => e.sessionId !== null && released.has(e.sessionId);
  const freed = queue.filter((e) => isReleased(e) && open.has(e.nodeId)).map((e) => ({ nodeId: e.nodeId, sessionId: null }));
  const rest = queue.filter((e) => !isReleased(e));
  return [...rest.filter(isOwned), ...freed, ...rest.filter((e) => !isOwned(e))];
}

/**
 * Stores `next` as the project's queue when its JSON differs from the stored `before`, recording project.updated with
 * the queue as read before and after.
 */
function storeQueue(ctx: Ctx, record: RecordEvent, projectId: number, before: string, next: QueueEntry[]): void {
  const json = queueJson(next);
  if (json === before) return;
  const from = liveQueue(ctx, projectId, before);
  ctx.db.prepare('UPDATE projects SET queue = ?, updated_at = ? WHERE id = ?').run(json, ctx.now(), projectId);
  record({ projectId, type: 'project.updated', entity: 'project', entityId: projectId, data: { changes: { queue: { from, to: liveQueue(ctx, projectId, json) } } } });
}

export const toProject = (r: ProjectRow, queue: QueueEntry[] = parseQueue(r.queue)): Project => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  playbook: r.playbook,
  status: r.status,
  rootNodeId: r.root_node_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  queue,
});

const readProject = (ctx: Ctx, r: ProjectRow): Project => toProject(r, liveQueue(ctx, r.id, r.queue));

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
  return row ? readProject(ctx, row) : undefined;
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
  return readProject(ctx, row);
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

/** Whose entries a set_queue write replaces: a session's own order (`queue:`), or the unowned one (`later:`). */
export type QueueOwner = { sessionId: string } | 'unowned';

/**
 * Sets one owner's part of the order Claude plans to work in: node ids of this project, first one next (an id given
 * twice keeps its first place; an empty list clears that part). Other owners' entries stay where they are, except that a
 * node is in the queue once: one given here leaves wherever it was. A session must be tracked in the project. One that
 * has ended or gone stale owns nothing, so its steps, then its old entries, go to the head of the unowned part, as
 * releaseQueue would put them. Done and dropped nodes stay out of the queue as it is read.
 */
export function setQueue(ctx: Ctx, actor: string, ref: string | number, nodes: number[], owner: QueueOwner): Project {
  return write(ctx, actor, (record) => {
    const project = resolveProject(ctx, ref);
    const ids = [...new Set(nodes)];
    const node = ctx.db.prepare('SELECT project_id FROM nodes WHERE id = ?');
    for (const id of ids) {
      if ((node.get(id) as { project_id: number } | undefined)?.project_id !== project.id) {
        throw badRequest(`#${id} is not in project ${project.slug}`, 'Use get_outline to find the right #id.');
      }
    }
    let sessionId: string | null = null;
    let gone = false;
    if (owner !== 'unowned') {
      // A direct read: listProjectSessions would expire stale sessions in a write of its own, inside this one.
      const s = ctx.db.prepare('SELECT project_id, state, last_seen_at FROM sessions WHERE id = ?').get(owner.sessionId) as
        | { project_id: number | null; state: string; last_seen_at: string }
        | undefined;
      if (s?.project_id !== project.id) {
        const home = s?.project_id == null ? undefined : (ctx.db.prepare('SELECT slug FROM projects WHERE id = ?').pluck().get(s.project_id) as string | undefined);
        if (home) {
          throw badRequest(`Session ${owner.sessionId} is tracked in project ${home}, not ${project.slug}`, `Check the project the brief names: this session's own order belongs in ${home}. Use enroll_session only if the session has really moved here.`);
        }
        throw badRequest(`Session ${owner.sessionId} is not tracked in project ${project.slug}`, 'Track it here with enroll_session first, or pass unowned: true to set the unowned order.');
      }
      sessionId = owner.sessionId;
      const cutoff = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS).toISOString();
      gone = s.state === 'ended' || s.last_seen_at < cutoff;
    }
    const row = ctx.db.prepare('SELECT queue FROM projects WHERE id = ?').get(project.id) as { queue: string };
    const stored = parseQueue(row.queue);
    let next: QueueEntry[];
    if (gone) {
      // It owns nothing any more: release its old entries, put these in as its own, and release those too. All of them
      // end up unowned at the head of the unowned part, these first, as releaseQueue would leave them.
      const self = new Set([sessionId!]);
      const open = openSteps(ctx, project.id, [...stored.map((e) => e.nodeId), ...ids]);
      next = releaseEntries(spliceQueue(releaseEntries(stored, self, open), ids, sessionId), self, open);
    } else {
      next = spliceQueue(stored, ids, sessionId);
    }
    storeQueue(ctx, record, project.id, row.queue, next);
    return getProjectById(ctx, project.id)!;
  });
}

/**
 * A session ended, went stale or moved to another project: its entries turn unowned and move to the head of the unowned
 * part, in order, in every project whose queue holds any; those whose step is no longer open are dropped. Sessions
 * released together (a batch of expiries) keep their stored order among themselves. Records project.updated for each
 * queue it changes. Call inside an open write.
 */
export function releaseQueue(ctx: Ctx, record: RecordEvent, sessions: string | readonly string[]): void {
  const released = new Set(typeof sessions === 'string' ? [sessions] : sessions);
  if (!released.size) return;
  // Every write stores exactly this text for a session's entries.
  const needles = [...released].map((id) => `"session":${JSON.stringify(id)}`);
  const rows = (ctx.db.prepare(`SELECT id, queue FROM projects WHERE instr(queue, '"session":"') > 0`).all() as { id: number; queue: string }[])
    .filter((row) => needles.some((needle) => row.queue.includes(needle)));
  for (const row of rows) {
    const queue = parseQueue(row.queue);
    storeQueue(ctx, record, row.id, row.queue, releaseEntries(queue, released, openSteps(ctx, row.id, queue.map((e) => e.nodeId))));
  }
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
    .map((r) => ({ ...readProject(ctx, r), needsYou: r.needs_you, activeSessions: r.active_sessions, workingSessions: r.working_sessions, lastEventAt: r.last_event_at }))
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
