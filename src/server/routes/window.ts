import type { FastifyInstance } from 'fastify';
import type { Guard } from '../app';
import type { Ctx } from '../db/tx';
import { conflict, notFound } from '../errors';
import { deleteProject, listDeletedProjects, restoreProject } from '../project-lifecycle';
import { changeProject, getProjectById } from '../repo/projects';
import { idParam, windowProjectBody } from '../schemas';

/** Who the window's writes are recorded as: fixed here, never taken from a header. */
const ACTOR = 'window';

/**
 * The window's own writes: archive, unarchive, delete and restore, behind requireUi (the window has no bearer token).
 * Delete and restore exist only here, never in MCP or the bearer API. Archive and unarchive are the scribe's
 * update_project, with the same effects, and answer the same whether or not anything changed. Delete takes an active
 * project or an archived one (an active one is archived in the same write); delete and restore answer 409 on the wrong
 * state: already deleted, or not deleted.
 */
export function registerWindowRoutes(app: FastifyInstance, ctx: Ctx, requireUi: Guard): void {
  const guarded = { onRequest: requireUi };

  /**
   * The project the window means: the id it holds, checked against the slug it shows, since a purge frees the newest
   * project's id for the next one. A deleted project still counts here: delete and restore need it.
   */
  const target = (params: unknown, body: unknown): number => {
    const { id } = idParam.parse(params);
    const { slug } = windowProjectBody.parse(body);
    const project = getProjectById(ctx, id);
    if (!project) throw notFound(`Project ${id} not found`, 'Reload the window.');
    if (project.slug !== slug) throw conflict('This project changed; reload', 'Reload the window: another project has this id now.');
    return id;
  };

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
  app.post('/api/ui/projects/:id/delete', guarded, async (req) => deleteProject(ctx, ACTOR, target(req.params, req.body)));
  app.post('/api/ui/projects/:id/restore', guarded, async (req) => ({ project: restoreProject(ctx, ACTOR, target(req.params, req.body)) }));
}
