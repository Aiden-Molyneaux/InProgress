import type { FastifyInstance } from 'fastify';
import type { Guard } from '../app';
import type { Ctx } from '../db/tx';
import { badRequest, conflict, notFound } from '../errors';
import { deleteProject, listDeletedProjects, restoreProject } from '../project-lifecycle';
import { clearAsk } from '../repo/asks';
import { recordQuiet } from '../repo/events';
import { addNodes } from '../repo/nodes';
import { applyQueueOp, changeProject, getProjectById, resolveProject } from '../repo/projects';
import { idParam, windowClearBody, windowEventBody, windowNodeBody, windowProjectBody, windowQueueBody, windowRenameBody, WINDOW_EVENT_KEYS } from '../schemas';

/** Who the window's writes are recorded as: fixed here, never taken from a header. */
const ACTOR = 'window';

/**
 * The window's own writes: archive, unarchive, rename, delete and restore, behind requireUi (the window has no bearer
 * token). Delete and restore exist only here, never in MCP or the bearer API. Archive, unarchive and rename are the
 * scribe's update_project, with the same effects, and answer the same whether or not anything changed. Delete takes an
 * active project or an archived one (an active one is archived in the same write); delete and restore answer 409 on the
 * wrong state: already deleted, or not deleted.
 */
export function registerWindowRoutes(app: FastifyInstance, ctx: Ctx, requireUi: Guard): void {
  const guarded = { onRequest: requireUi };

  /**
   * The project the window means: the id it holds, checked against the slug it shows, since a purge frees the newest
   * project's id for the next one. A deleted project still counts here: delete and restore need it.
   */
  const targetBySlug = (params: unknown, slug: string): number => {
    const { id } = idParam.parse(params);
    const project = getProjectById(ctx, id);
    if (!project) throw notFound(`Project ${id} not found`, 'Reload the window.');
    if (project.slug !== slug) throw conflict('This project changed; reload', 'Reload the window: another project has this id now.');
    return id;
  };
  /** targetBySlug for a body that is only `{ slug }`. */
  const target = (params: unknown, body: unknown): number => targetBySlug(params, windowProjectBody.parse(body).slug);

  // Not /api/projects/deleted: that would shadow a project slugged "deleted". A plain read like /api/projects: a page on
  // another site cannot read the answer (no CORS headers).
  app.get('/api/deleted-projects', async () => listDeletedProjects(ctx));

  app.post('/api/ui/projects/:id/archive', guarded, async (req) => {
    const { project, endedSessions } = changeProject(ctx, ACTOR, target(req.params, req.body), { status: 'archived' });
    return { project, endedSessions: endedSessions.length };
  });
  app.post('/api/ui/projects/:id/unarchive', guarded, async (req) => ({
    project: changeProject(ctx, ACTOR, target(req.params, req.body), { status: 'active' }).project,
  }));
  // A rename changes the name only: the slug, so links, bindings and briefings, stays. A deleted project is not found
  // (404), as for unarchive; the same name again records nothing.
  app.post('/api/ui/projects/:id/rename', guarded, async (req) => {
    const { slug, name } = windowRenameBody.parse(req.body);
    return { project: changeProject(ctx, ACTOR, targetBySlug(req.params, slug), { name }).project };
  });
  // One queue operation applied to the stored queue (spec 2.5), never the list the window last saw.
  app.post('/api/ui/projects/:id/queue', guarded, async (req) => {
    const { slug, op } = windowQueueBody.parse(req.body);
    const projectId = targetBySlug(req.params, slug);
    // A deleted project is not found (404), as for rename.
    resolveProject(ctx, projectId);
    return { project: applyQueueOp(ctx, ACTOR, projectId, op) };
  });
  // Quick-add: a todo step with no label under `parent`, or the root.
  app.post('/api/ui/projects/:id/nodes', guarded, async (req) => {
    const { slug, title, parent } = windowNodeBody.parse(req.body);
    const projectId = targetBySlug(req.params, slug);
    const project = resolveProject(ctx, projectId);
    // A parent that does not exist reads as one outside this project; the rest is checked inside the write.
    if (parent !== null && ctx.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(parent) === undefined) throw badRequest(`#${parent} is not in this project`, 'Reload the window.');
    // The parent is checked inside addNodes' own write, so a parent dropped or moved in between cannot slip through.
    const [node] = addNodes(ctx, ACTOR, {
      parentId: parent ?? project.rootNodeId,
      nodes: [{ title }],
      check: (home) => {
        if (parent === null) return;
        if (home.projectId !== projectId) throw badRequest(`#${parent} is not in this project`, 'Reload the window.');
        if (home.status === 'dropped') throw badRequest(`#${parent} is dropped`, 'Reload the window.');
      },
    });
    return { node };
  });
  // Idempotent (spec 1.2): clearing twice answers the same; a 404 for an ask that does not exist.
  app.post('/api/ui/asks/:id/clear', guarded, async (req) => {
    const { id } = idParam.parse(req.params);
    const { answer } = windowClearBody.parse(req.body ?? {});
    return { ask: clearAsk(ctx, ACTOR, id, answer) };
  });
  // The window's measurements (spec 2.6): stored quietly, only the named keys, and strings cut short: never content.
  app.post('/api/ui/events', guarded, async (req, reply) => {
    const { name, projectId, data } = windowEventBody.parse(req.body);
    const kept: Record<string, string | number | boolean | null> = {};
    for (const key of WINDOW_EVENT_KEYS) {
      const value = data?.[key];
      if (value !== undefined) kept[key] = typeof value === 'string' ? value.slice(0, 200) : value;
    }
    recordQuiet(ctx, ACTOR, { projectId, type: `window.${name}`, entity: 'window', entityId: name, data: kept });
    return reply.code(204).send();
  });
  app.post('/api/ui/projects/:id/delete', guarded, async (req) => deleteProject(ctx, ACTOR, target(req.params, req.body)));
  app.post('/api/ui/projects/:id/restore', guarded, async (req) => ({ project: restoreProject(ctx, ACTOR, target(req.params, req.body)) }));
}
