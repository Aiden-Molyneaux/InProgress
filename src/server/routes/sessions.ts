import type { FastifyInstance } from 'fastify';
import { actorOf, type Guard } from '../app';
import type { Ctx } from '../db/tx';
import { findNode } from '../repo/nodes';
import { findSession } from '../repo/sessions';
import { setTasks } from '../repo/work';
import { claimBody, enrollBody, focusBody, hookBody, orchestrateBody, sessionParam, tasksBody } from '../schemas';
import { claimStep, enrollSession, handleHookEvent, orchestrate, setFocus } from '../session-flow';

export function registerSessionRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard): void {
  const guarded = { preHandler: requireToken };
  // The inprogress-step status line mod reads this every half minute: a session's claimed step, or null for an unknown
  // session, no claim, or a step since deleted. Unguarded like the other reads; it shows only what the window shows.
  app.get('/api/sessions/:id/step', async (req) => {
    const focus = findSession(ctx, sessionParam.parse(req.params).id)?.focusNodeId;
    const node = focus ? findNode(ctx, focus) : undefined;
    return { step: node ? { id: node.id, title: node.title, status: node.status } : null };
  });
  app.post('/api/sessions/:id/hook', guarded, async (req) => handleHookEvent(ctx, sessionParam.parse(req.params).id, hookBody.parse(req.body)));
  app.post('/api/sessions/:id/enroll', guarded, async (req) => {
    const body = enrollBody.parse(req.body);
    return enrollSession(ctx, actorOf(req), sessionParam.parse(req.params).id, body.project, body.title);
  });
  app.post('/api/sessions/:id/focus', guarded, async (req) => setFocus(ctx, actorOf(req), sessionParam.parse(req.params).id, focusBody.parse(req.body).nodeId));
  app.post('/api/sessions/:id/claim', guarded, async (req) => claimStep(ctx, actorOf(req), sessionParam.parse(req.params).id, claimBody.parse(req.body).nodeId));
  app.post('/api/sessions/:id/orchestrate', guarded, async (req) => orchestrate(ctx, actorOf(req), sessionParam.parse(req.params).id, { status: orchestrateBody.parse(req.body ?? {}).status === true }));
  app.post('/api/sessions/:id/tasks', guarded, async (req) => {
    const body = tasksBody.parse(req.body);
    return setTasks(ctx, actorOf(req), sessionParam.parse(req.params).id, body.nodeId, body.tasks);
  });
}
