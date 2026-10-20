import type { FastifyInstance } from 'fastify';
import { actorOf, type Guard } from '../app';
import type { Ctx } from '../db/tx';
import { addLog } from '../repo/logs';
import { addNodes, deleteNode, moveNode, requireNode, updateNode } from '../repo/nodes';
import { addBinding, createProject, removeBinding, setQueue, updateProject } from '../repo/projects';
import { checkPageRules, inspectNewPage, isPage, pageHead } from '../pages';
import { addResource, confirmPage, deleteResource, patchNeedsPageCheck, requireResource, updateResource } from '../repo/resources';
import {
  addNodesBody, bindingBody, createProjectBody, idParam, logBody, moveNodeBody, queueBody,
  resourceBody, resourcePatchBody, updateNodeBody, updateProjectBody,
} from '../schemas';

export function registerWriteRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard): void {
  const guarded = { preHandler: requireToken };
  const ref = (params: unknown) => (params as { ref: string }).ref;

  app.post('/api/projects', guarded, async (req, reply) => reply.code(201).send(createProject(ctx, actorOf(req), createProjectBody.parse(req.body))));
  app.patch('/api/projects/:ref', guarded, async (req) => updateProject(ctx, actorOf(req), ref(req.params), updateProjectBody.parse(req.body)));
  app.post('/api/projects/:ref/queue', guarded, async (req) => {
    const body = queueBody.parse(req.body);
    return setQueue(ctx, actorOf(req), ref(req.params), body.nodes, body.session && body.unowned !== true ? { sessionId: body.session } : 'unowned');
  });
  app.post('/api/projects/:ref/bindings', guarded, async (req, reply) => {
    const body = bindingBody.parse(req.body);
    return reply.code(201).send(addBinding(ctx, actorOf(req), ref(req.params), body.path, body.branchPattern));
  });
  app.delete('/api/bindings/:id', guarded, async (req) => {
    removeBinding(ctx, actorOf(req), idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/nodes', guarded, async (req, reply) => reply.code(201).send(addNodes(ctx, actorOf(req), addNodesBody.parse(req.body))));
  app.patch('/api/nodes/:id', guarded, async (req) => updateNode(ctx, actorOf(req), idParam.parse(req.params).id, updateNodeBody.parse(req.body)));
  app.post('/api/nodes/:id/move', guarded, async (req) => moveNode(ctx, actorOf(req), idParam.parse(req.params).id, moveNodeBody.parse(req.body)));
  app.delete('/api/nodes/:id', guarded, async (req) => {
    const cascade = ['1', 'true'].includes(String((req.query as { cascade?: string }).cascade));
    return deleteNode(ctx, actorOf(req), idParam.parse(req.params).id, cascade);
  });
  // A page is checked against its row rules before the disk is touched, then its file and repo; the write checks the rows again.
  app.post('/api/resources', guarded, async (req, reply) => {
    const body = resourceBody.parse(req.body);
    if (!isPage(body)) return reply.code(201).send(addResource(ctx, actorOf(req), body));
    checkPageRules(ctx, requireNode(ctx, body.nodeId).projectId, body);
    const { confirmedSha } = await inspectNewPage(body.path!.trim());
    return reply.code(201).send(addResource(ctx, actorOf(req), { ...body, confirmedSha }));
  });
  app.patch('/api/resources/:id', guarded, async (req) => {
    const id = idParam.parse(req.params).id;
    const patch = resourcePatchBody.parse(req.body);
    const before = requireResource(ctx, id);
    if (!patchNeedsPageCheck(before, patch)) return updateResource(ctx, actorOf(req), id, patch);
    const next = { kind: patch.kind ?? before.kind, content: patch.content !== undefined ? patch.content : before.content, path: patch.path !== undefined ? patch.path : before.path };
    checkPageRules(ctx, before.projectId, next);
    const { confirmedSha } = await inspectNewPage(next.path!.trim());
    return updateResource(ctx, actorOf(req), id, { ...patch, confirmedSha });
  });
  // Still accurate, for the scribe and Sigmund's receipt (#531): the page's claim holds at its repo's HEAD now.
  app.post('/api/resources/:id/confirm', guarded, async (req) => {
    const id = idParam.parse(req.params).id;
    return confirmPage(ctx, actorOf(req), id, await pageHead(requireResource(ctx, id)));
  });
  app.delete('/api/resources/:id', guarded, async (req) => {
    deleteResource(ctx, actorOf(req), idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/nodes/:id/log', guarded, async (req, reply) => {
    const body = logBody.parse(req.body);
    return reply.code(201).send(addLog(ctx, actorOf(req), idParam.parse(req.params).id, body.text, body.sessionId));
  });
}
