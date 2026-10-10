import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DELETED_RETENTION_MS, type DeletedProject, type Project } from '../core/types';
import { isUnder, normalizePath } from '../lib/paths';
import { write, type Ctx } from './db/tx';
import { conflict, notFound } from './errors';
import { pruneCommands } from './repo/commands';
import { EVENTS_RETENTION_DAYS, pruneEvents } from './repo/events';
import { applyProjectChange, endProjectSessions, getProjectById, purgeAtOf } from './repo/projects';
import { pruneSubagents } from './repo/subagents';
import { pruneWorkItems } from './repo/work';

/*
 * Deleting a project, from the window only. A delete is soft: the project, archived by then (an active one is archived
 * in the same write), is hidden everywhere (repo/projects filters on deleted_at) and Recently deleted can restore it for
 * 30 days. After that, maintenance purges it for good, with InProgress's own copies of its files. File handling lives
 * here, out of the repo layer.
 */

/** Where maintenance reports: the server's logger in main.ts. */
export interface MaintenanceLog {
  info(message: string): void;
  error(message: string): void;
}

interface LifecycleRow {
  id: number;
  slug: string;
  name: string;
  status: 'active' | 'archived';
  deleted_at: string | null;
}

const readRow = (ctx: Ctx, id: number) =>
  ctx.db.prepare('SELECT id, slug, name, status, deleted_at FROM projects WHERE id = ?').get(id) as LifecycleRow | undefined;

/** Deleted at or before this moment: past the 30 days, so no longer restorable and due to be purged. */
const retentionCutoff = (ctx: Ctx) => new Date(Date.parse(ctx.now()) - DELETED_RETENTION_MS).toISOString();

export interface DeleteResult {
  id: number;
  slug: string;
  deletedAt: string;
  purgeAt: string;
}

/**
 * Soft-deletes a project: hidden from now on, purged after 30 days. A deleted project is always archived, so a build
 * from before migration 8 shows it as an archived one. An active project is archived first, in the same write, exactly
 * as an archive does it (applyProjectChange): its live sessions end, their own Up next entries go, and the archive's
 * events come before the delete's. An archived one has any session an older build left live in it ended the same
 * way. Its bindings stay, inert, for a restore, which brings it back archived.
 */
export function deleteProject(ctx: Ctx, actor: string, id: number): DeleteResult {
  return write(ctx, actor, (record) => {
    const row = readRow(ctx, id);
    if (!row) throw notFound(`Project ${id} not found`, 'Reload the window.');
    if (row.deleted_at) throw conflict(`Project ${row.slug} is already deleted`, 'Restore it from Recently deleted in the window.');
    if (row.status === 'active') applyProjectChange(ctx, record, getProjectById(ctx, id)!, { status: 'archived' });
    else endProjectSessions(ctx, record, id);
    const deletedAt = ctx.now();
    const purgeAt = purgeAtOf(deletedAt);
    ctx.db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?').run(deletedAt, deletedAt, id);
    record({ projectId: id, type: 'project.deleted', entity: 'project', entityId: id, data: { slug: row.slug, name: row.name, purgeAt } });
    return { id, slug: row.slug, deletedAt, purgeAt };
  });
}

/**
 * Brings a deleted project back within its 30 days, still archived: it returns under Archived, with its slug (kept
 * while it was deleted) and whatever bindings no other project took meanwhile. Past the 30 days it is refused even if
 * the purge has not run yet.
 */
export function restoreProject(ctx: Ctx, actor: string, id: number): Project {
  return write(ctx, actor, (record) => {
    const row = readRow(ctx, id);
    if (!row) throw notFound(`Project ${id} not found`, 'Reload the window.');
    if (!row.deleted_at) throw conflict(`Project ${row.slug} is not deleted`, 'Reload the window.');
    if (row.deleted_at <= retentionCutoff(ctx)) throw conflict(`Project ${row.slug} is past its 30 days`, 'It is about to be removed for good and can no longer be restored.');
    ctx.db.prepare('UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(ctx.now(), id);
    record({ projectId: id, type: 'project.restored', entity: 'project', entityId: id, data: { slug: row.slug, name: row.name } });
    return getProjectById(ctx, id)!;
  });
}

/** Recently deleted: projects deleted less than 30 days ago, newest first. One past its date is left out before the purge runs. */
export function listDeletedProjects(ctx: Ctx): DeletedProject[] {
  const rows = ctx.db
    .prepare('SELECT id, slug, name, deleted_at FROM projects WHERE deleted_at IS NOT NULL AND deleted_at > ? ORDER BY deleted_at DESC, id DESC')
    .all(retentionCutoff(ctx)) as { id: number; slug: string; name: string; deleted_at: string }[];
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, deletedAt: r.deleted_at, purgeAt: purgeAtOf(r.deleted_at) }));
}

/**
 * A resource path as an absolute local path inside `root` (the home's resources folder), or undefined: a relative,
 * UNC or device path, `root` itself, or anything outside it (a repo file) never counts. `..` segments are resolved
 * first. Nothing on disk is touched.
 */
function ownPath(raw: string, root: string): string | undefined {
  const path = normalizePath(raw);
  if (path.startsWith('//')) return undefined;
  if (process.platform === 'win32' ? !/^[A-Za-z]:\//.test(path) : !isAbsolute(path)) return undefined;
  const full = resolve(path);
  if (!isUnder(full, root) || normalizePath(full).toLowerCase() === normalizePath(root).toLowerCase()) return undefined;
  return full;
}

const pathKey = (path: string) => normalizePath(path).toLowerCase();

/**
 * After a purge has committed: removes the files its resources named that are InProgress's own copies, under
 * `<home>/resources/`, plain files (not folders or links) whose real path is still inside that folder (a junction must
 * not lead out), and named by no surviving resource. Then the project's own folder there, if that left it empty. A file
 * written there but never attached stays. Never throws: what it cannot remove is logged. Returns how many files went.
 */
function removeOwnFiles(ctx: Ctx, home: string, slug: string, paths: readonly string[], log: MaintenanceLog): number {
  const root = resolve(home, 'resources');
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    // No resources folder: nothing of InProgress's to remove.
    return 0;
  }
  const surviving = new Set(
    (ctx.db.prepare('SELECT path FROM resources WHERE path IS NOT NULL').pluck().all() as string[])
      .map((p) => ownPath(p, root))
      .filter((p): p is string => p !== undefined)
      .map(pathKey),
  );
  let removed = 0;
  for (const raw of new Set(paths)) {
    const file = ownPath(raw, root);
    if (!file || surviving.has(pathKey(file))) continue;
    try {
      if (!lstatSync(file).isFile()) continue;
      const real = realpathSync(file);
      if (!isUnder(real, realRoot) || pathKey(real) === pathKey(realRoot)) continue;
      unlinkSync(file);
      removed++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.error(`Could not remove ${file}: ${(err as Error).message}`);
    }
  }
  // Its own folder, once nothing is left in it. A slug is [a-z0-9-] only (slugify), so this stays inside root.
  const folder = join(root, slug);
  try {
    if (lstatSync(folder).isDirectory() && readdirSync(folder).length === 0) rmdirSync(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.error(`Could not remove ${folder}: ${(err as Error).message}`);
  }
  return removed;
}

/**
 * Removes every project deleted 30 or more days ago, for good, each in its own write: its events (they have no foreign
 * key), its sessions (the key would only set them to no project, and such a row never binds again; deleting them takes
 * their subagents, dispatches and working tasks), then the project row, which takes its bindings, steps, logs,
 * resources and working tasks, and clears links to its steps held elsewhere. Records project.purged under no project:
 * under the project, event pruning would keep it forever as that project's newest event. Then InProgress's own copies
 * of its files go (removeOwnFiles). A project restored meanwhile is left alone.
 */
export function purgeDeletedProjects(ctx: Ctx, home: string, log: MaintenanceLog): { projects: number; files: number } {
  const due = ctx.db
    .prepare('SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY id')
    .pluck()
    .all(retentionCutoff(ctx)) as number[];
  let projects = 0;
  let files = 0;
  for (const id of due) {
    const purged = write(ctx, 'system', (record) => {
      const row = readRow(ctx, id);
      if (!row?.deleted_at || row.deleted_at > retentionCutoff(ctx)) return undefined;
      const paths = ctx.db.prepare('SELECT path FROM resources WHERE project_id = ? AND path IS NOT NULL').pluck().all(id) as string[];
      ctx.db.prepare('DELETE FROM events WHERE project_id = ?').run(id);
      ctx.db.prepare('DELETE FROM sessions WHERE project_id = ?').run(id);
      ctx.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      record({ projectId: null, type: 'project.purged', entity: 'project', entityId: id, data: { id, slug: row.slug, name: row.name } });
      return { slug: row.slug, paths };
    });
    if (!purged) continue;
    projects++;
    files += removeOwnFiles(ctx, home, purged.slug, purged.paths, log);
  }
  return { projects, files };
}

/**
 * The server's housekeeping, at start (after the backup, so the newest backup still holds anything about to go) and
 * every few hours after: purge deleted projects past their 30 days, prune events older than 30 days, and prune the live
 * work that has left the trail. Never throws: each job that fails is logged, and the next one still runs.
 */
export function runMaintenance(ctx: Ctx, home: string, log: MaintenanceLog): void {
  try {
    const { projects, files } = purgeDeletedProjects(ctx, home, log);
    if (projects) log.info(`Purged ${projects} deleted project${projects === 1 ? '' : 's'} past ${projects === 1 ? 'its' : 'their'} 30 days, and ${files} of ${projects === 1 ? 'its' : 'their'} files`);
  } catch (err) {
    log.error(`Could not purge deleted projects: ${(err as Error).message}`);
  }
  try {
    log.info(`Pruned ${pruneEvents(ctx)} events older than ${EVENTS_RETENTION_DAYS} days`);
  } catch (err) {
    log.error(`Could not prune old events: ${(err as Error).message}`);
  }
  try {
    const { dispatches, subagents } = pruneSubagents(ctx);
    const tasks = pruneWorkItems(ctx);
    pruneCommands(ctx);
    log.info(`Pruned ${dispatches} unpaired dispatches, ${subagents} ended subagents and ${tasks} working tasks of sessions ended over a week ago`);
  } catch (err) {
    log.error(`Could not prune live work: ${(err as Error).message}`);
  }
}
