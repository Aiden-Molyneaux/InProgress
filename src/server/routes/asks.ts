import type { FastifyInstance } from 'fastify';
import { actorOf, type Guard } from '../app';
import type { Ctx } from '../db/tx';
import { clearAsk, raiseAsk } from '../repo/asks';
import { askBody, clearAskBody, idParam } from '../schemas';

export function registerAskRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard): void {
  const guarded = { preHandler: requireToken };
  app.post('/api/nodes/:id/asks', guarded, async (req) => raiseAsk(ctx, actorOf(req), { nodeId: idParam.parse(req.params).id, ...askBody.parse(req.body) }));
  app.post('/api/asks/:id/clear', guarded, async (req) => clearAsk(ctx, actorOf(req), idParam.parse(req.params).id, clearAskBody.parse(req.body ?? {}).answer));
}
