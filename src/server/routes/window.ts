import type { FastifyInstance } from 'fastify';
import type { Guard } from '../app';
import type { Ctx } from '../db/tx';
import { STALE_SESSION_MS, type TreeNode } from '../../core/types';
import { badRequest, conflict, notFound } from '../errors';
import { openInDesktop, resumeCommand, usableCwd, type DesktopSession, type OpenDesktopResult } from '../open-desktop';
import { findSession } from '../repo/sessions';
import { deleteProject, listDeletedProjects, restoreProject } from '../project-lifecycle';
import { clearAsk } from '../repo/asks';
import { recordQuiet } from '../repo/events';
import { addNodes, applyRankOp, deleteNode, finishNode, labelNode, moveNode, parkNode, unparkNode } from '../repo/nodes';
import { applyQueueOp, changeProject, getProjectById, isQueued, resolveProject } from '../repo/projects';
import { shelvedAmong } from '../repo/shelved';
import { idParam, sessionIdParam, windowClearBody, windowDoneBody, windowEventBody, windowLabelBody, windowMoveBody, windowNodeBody, windowParkBody, windowProjectBody, windowQueueBody, windowNodeParams, windowRankBody, windowRenameBody, windowUnparkBody, WINDOW_EVENT_KEYS } from '../schemas';

/** Who the window's writes are recorded as: fixed here, never taken from a header. */
const ACTOR = 'window';

/**
 * Why a step is not one the Backlog shows, or null when it is: done or dropped, worked on (a live session's focus, or
 * Aiden's own active step), or queued. The same rule as deriveBoard's Backlog column (src/core/board.ts): change both
 * together.
 */
function notInBacklog(ctx: Ctx, projectId: number, n: TreeNode): string | null {
  if (n.status === 'done' || n.status === 'dropped' || n.status === 'parked') return `is ${n.status}`;
  if (shelvedAmong(ctx, [n.id]).has(n.id)) return 'is under a parked step';
  const cutoff = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS).toISOString();
  const focused = ctx.db.prepare("SELECT 1 FROM sessions WHERE focus_node_id = ? AND state != 'ended' AND last_seen_at >= ?").get(n.id, cutoff) !== undefined;
  if (focused || (n.assignee === 'me' && n.status === 'active')) return 'is being worked on';
  if (isQueued(ctx, projectId, n.id)) return 'is in Next';
  return null;
}

/**
 * The session driving `n` now, or null: the one its driver column names, if it still has `n` as its focus and is live
 * (not ended, seen within STALE_SESSION_MS). The same live rule as notInBacklog.
 */
function liveDriver(ctx: Ctx, n: TreeNode): string | null {
  if (n.driverSessionId === null) return null;
  const cutoff = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS).toISOString();
  const live = ctx.db.prepare("SELECT 1 FROM sessions WHERE id = ? AND focus_node_id = ? AND state != 'ended' AND last_seen_at >= ?").get(n.driverSessionId, n.id, cutoff) !== undefined;
  return live ? n.driverSessionId : null;
}

/**
 * The window's own writes: archive, unarchive, rename, delete and restore, and a step's Done from Now, behind requireUi
 * (the window has no bearer token). Delete and restore exist only here, never in MCP or the bearer API. Archive, unarchive and rename are the
 * scribe's update_project, with the same effects, and answer the same whether or not anything changed. Delete takes an
 * active project or an archived one (an active one is archived in the same write); delete and restore answer 409 on the
 * wrong state: already deleted, or not deleted.
 */
export function registerWindowRoutes(app: FastifyInstance, ctx: Ctx, requireUi: Guard, openDesktop: (session: DesktopSession) => Promise<OpenDesktopResult> = openInDesktop): void {
  const guarded = { onRequest: requireUi };

  // "Open session" on the Board: the Claude desktop app opens the session. When it cannot, the answer carries the command
  // to resume it in a terminal, for the window to show (status 200: the request was fine, the open was not).
  app.post('/api/ui/sessions/:id/open-desktop', guarded, async (req) => {
    const { id } = sessionIdParam.parse(req.params);
    const session = findSession(ctx, id);
    if (!session) throw notFound(`Session ${id} not found`, 'Reload the window.');
    const result = await openDesktop({ id });
    if (result.ok) return { ok: true };
    // Resume is scoped to the folder the session ran in, so the copied command starts there; when it cannot cd there
    // itself (a folder gone, or one it cannot quote), the reason names the folder.
    const command = resumeCommand(id, usableCwd(session.cwd));
    const where = session.cwd && !command.startsWith('cd ') ? ` Start it from ${session.cwd}.` : '';
    return { ok: false, command, reason: `${result.reason}${where}` };
  });

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
  // A rank change (ranked Backlog spec section 2): to Next, or into Soon or Someday before a step of that band. Refusals
  // are 409, and the window puts the row back.
  app.post('/api/ui/projects/:id/rank', guarded, async (req) => {
    const { slug, op } = windowRankBody.parse(req.body);
    const projectId = targetBySlug(req.params, slug);
    // A deleted project is not found (404), as for the queue route.
    resolveProject(ctx, projectId);
    return applyRankOp(ctx, ACTOR, projectId, op);
  });
  // Quick-add: a todo step with no label under `parent`, or the root; with band 'soon', at the bottom of Soon.
  app.post('/api/ui/projects/:id/nodes', guarded, async (req) => {
    const { slug, title, parent, band } = windowNodeBody.parse(req.body);
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
      band,
    });
    return { node };
  });
  // The inspector's Label select: sets or clears the step's label, checked in the same write.
  app.post('/api/ui/projects/:id/nodes/:node/label', guarded, async (req) => {
    const { node } = windowNodeParams.parse(req.params);
    const { slug, label } = windowLabelBody.parse(req.body);
    const projectId = targetBySlug(req.params, slug);
    resolveProject(ctx, projectId);
    return {
      node: labelNode(ctx, ACTOR, node, label, (n) => {
        if (n.projectId !== projectId) throw conflict(`#${node} is not in this project`, 'Reload the window.');
      }),
    };
  });
  // The inspector's Phase select: moves the step to the end of `parent`'s steps, or the root's for null (No phase).
  // Refused (409) for a parked, shelved or dropped parent; the repo refuses the step itself or a step under it.
  app.post('/api/ui/projects/:id/nodes/:node/move', guarded, async (req) => {
    const { node } = windowNodeParams.parse(req.params);
    const { slug, parent } = windowMoveBody.parse(req.body);
    const projectId = targetBySlug(req.params, slug);
    const project = resolveProject(ctx, projectId);
    // A parent that does not exist reads as one outside this project, as for quick-add.
    if (parent !== null && ctx.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(parent) === undefined) throw conflict(`#${parent} is not in this project`, 'Reload the window.');
    return {
      node: moveNode(ctx, ACTOR, node, {
        parentId: parent ?? project.rootNodeId,
        check: (n, home) => {
          if (n.projectId !== projectId) throw conflict(`#${node} is not in this project`, 'Reload the window.');
          if (home.projectId !== projectId) throw conflict(`#${parent} is not in this project`, 'Reload the window.');
          if (home.status === 'dropped') throw conflict(`#${home.id} is dropped`, 'Reload the window.');
          if (shelvedAmong(ctx, [home.id]).size) throw conflict(`#${home.id} is parked or under a parked step`, 'Unpark it first.');
        },
      }),
    };
  });
  // Delete a step from the tree (the Backlog's Delete). Never one with steps under it: those may be done, and deleting
  // them would lose their history. Asks, resources and logs go with it (FK cascade); the queue drops it on read.
  app.post('/api/ui/projects/:id/nodes/:node/delete', guarded, async (req) => {
    const { node } = windowNodeParams.parse(req.params);
    const projectId = target(req.params, req.body);
    // A deleted project is not found (404), as for the queue route.
    resolveProject(ctx, projectId);
    // Checked inside deleteNode's own write, so a step moved or given children in between cannot slip through.
    return deleteNode(ctx, ACTOR, node, false, (n, ids) => {
      if (n.projectId !== projectId) throw badRequest(`#${node} is not in this project`, 'Reload the window.');
      if (ids.length > 1) throw badRequest(`#${node} has steps under it`, 'Move or delete them first.');
      const why = notInBacklog(ctx, projectId, n);
      if (why) throw badRequest(`#${node} ${why}`, 'Reload the window.');
    });
  });
  // Done on a Now box, with an optional outcome. A step with open steps under it is refused, and so is one a live session
  // now drives unless the window named that session (its `driver`); that session keeps its focus. Already done answers
  // as it stands, but an outcome sent for one with none stored fills it. Checked inside finishNode's own write, so a step
  // changed in between cannot slip through.
  app.post('/api/ui/projects/:id/nodes/:node/done', guarded, async (req) => {
    const { node } = windowNodeParams.parse(req.params);
    const { slug, outcome, driver } = windowDoneBody.parse(req.body);
    const projectId = targetBySlug(req.params, slug);
    // A deleted project is not found (404), as for the delete route.
    resolveProject(ctx, projectId);
    const done = finishNode(ctx, ACTOR, node, outcome, (n) => {
      if (n.projectId !== projectId) throw badRequest(`#${node} is not in this project`, 'Reload the window.');
      if (n.parentId === null) throw badRequest(`#${node} is the project root`, 'Reload the window.');
      if (n.status === 'done') return;
      if (n.status === 'dropped') throw badRequest(`#${node} is dropped`, 'Reload the window.');
      // A parked child is set aside, not unfinished: it does not hold the phase back. Its own children are not direct ones.
      const open = ctx.db.prepare("SELECT id FROM nodes WHERE parent_id = ? AND status NOT IN ('done', 'dropped', 'parked') ORDER BY id").all(n.id) as { id: number }[];
      if (open.length) throw badRequest(`#${node} has open steps under it: ${open.map((o) => `#${o.id}`).join(', ')}`, 'Finish or drop them first.');
      const live = liveDriver(ctx, n);
      if (live !== null && live !== driver) throw conflict(`A session is driving #${node} now`, 'Look again: the box names it.');
    });
    return { node: done };
  });
  // Park: set a step aside with a reason (required) and where its work lives (optional). It and every step under it
  // leave Next; its driver and open asks are cleared. Checked inside parkNode's own write.
  app.post('/api/ui/projects/:id/nodes/:node/park', guarded, async (req) => {
    const { node } = windowNodeParams.parse(req.params);
    const { slug, reason, where } = windowParkBody.parse(req.body);
    const projectId = targetBySlug(req.params, slug);
    // A deleted project is not found (404), as for the delete route.
    resolveProject(ctx, projectId);
    return {
      node: parkNode(ctx, ACTOR, node, { reason, where }, (n) => {
        if (n.projectId !== projectId) throw badRequest(`#${node} is not in this project`, 'Reload the window.');
      }),
    };
  });
  // Unpark: back to todo in the Backlog, or with toNext appended to the unowned Next in the same write.
  app.post('/api/ui/projects/:id/nodes/:node/unpark', guarded, async (req) => {
    const { node } = windowNodeParams.parse(req.params);
    const { slug, toNext } = windowUnparkBody.parse(req.body);
    const projectId = targetBySlug(req.params, slug);
    resolveProject(ctx, projectId);
    return {
      node: unparkNode(ctx, ACTOR, node, toNext ?? false, (n) => {
        if (n.projectId !== projectId) throw badRequest(`#${node} is not in this project`, 'Reload the window.');
      }),
    };
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
