import type { FastifyInstance } from 'fastify';
import { actorOf, type Guard } from '../app';
import type { Ctx } from '../db/tx';
import { setTasks } from '../repo/work';
import { claimBody, enrollBody, focusBody, hookBody, orchestrateBody, sessionParam, tasksBody } from '../schemas';
import { claimStep, enrollSession, handleHookEvent, orchestrate, setFocus } from '../session-flow';

export function registerSessionRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard): void {
  const guarded = { preHandler: requireToken };
  app.post('/api/sessions/:id/hook', guarded, async (req) => handleHookEvent(ctx, sessionParam.parse(req.params).id, hookBody.parse(req.body)));
  app.post('/api/sessions/:id/enroll', guarded, async (req) => {
    const body = enrollBody.parse(req.body);
    return enrollSession(ctx, actorOf(req), sessionParam.parse(req.params).id, body.project, body.title);
  });
  app.post('/api/sessions/:id/focus', guarded, async (req) => setFocus(ctx, actorOf(req), sessionParam.parse(req.params).id, focusBody.parse(req.body).nodeId));
  app.post('/api/sessions/:id/claim', guarded, async (req) => {
    const { nodeId, takeOver } = claimBody.parse(req.body);
    return claimStep(ctx, actorOf(req), sessionParam.parse(req.params).id, nodeId, { takeOver });
  });
  app.post('/api/sessions/:id/orchestrate', guarded, async (req) => orchestrate(ctx, actorOf(req), sessionParam.parse(req.params).id, { status: orchestrateBody.parse(req.body ?? {}).status === true }));
  app.post('/api/sessions/:id/tasks', guarded, async (req) => {
    const body = tasksBody.parse(req.body);
    return setTasks(ctx, actorOf(req), sessionParam.parse(req.params).id, body.nodeId, body.tasks);
  });
}
