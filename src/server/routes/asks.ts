import type { FastifyInstance } from 'fastify';
import { actorOf, type Guard } from '../app';
import type { Ctx } from '../db/tx';
import { clearAsk, raiseAskDetailed } from '../repo/asks';
import { askBody, clearAskBody, idParam } from '../schemas';

export function registerAskRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard): void {
  const guarded = { preHandler: requireToken };
  app.post('/api/nodes/:id/asks', guarded, async (req) => {
    // The ask's own fields, plus whether it joined an open ask and whether the raising session was untracked (no answer comes back to it).
    const { ask, joined, untracked } = raiseAskDetailed(ctx, actorOf(req), { nodeId: idParam.parse(req.params).id, ...askBody.parse(req.body) });
    return { ...ask, joined, untracked };
  });
  app.post('/api/asks/:id/clear', guarded, async (req) => clearAsk(ctx, actorOf(req), idParam.parse(req.params).id, clearAskBody.parse(req.body ?? {}).answer));
}
