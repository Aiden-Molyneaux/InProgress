import type { FastifyInstance } from 'fastify';
import { actorOf, type Guard } from '../app';
import type { Ctx } from '../db/tx';
import { enrollBody, focusBody, hookBody, sessionParam } from '../schemas';
import { enrollSession, handleHookEvent, setFocus } from '../session-flow';

export function registerSessionRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard): void {
  const guarded = { preHandler: requireToken };
  app.post('/api/sessions/:id/hook', guarded, async (req) => handleHookEvent(ctx, sessionParam.parse(req.params).id, hookBody.parse(req.body)));
  app.post('/api/sessions/:id/enroll', guarded, async (req) => {
    const body = enrollBody.parse(req.body);
    return enrollSession(ctx, actorOf(req), sessionParam.parse(req.params).id, body.project, body.title);
  });
  app.post('/api/sessions/:id/focus', guarded, async (req) => setFocus(ctx, actorOf(req), sessionParam.parse(req.params).id, focusBody.parse(req.body).nodeId));
}
