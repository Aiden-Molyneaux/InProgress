import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../db/tx';
import { listLeadEvents, markLeadSeen, readLeadBrief, requireLead } from '../lead';
import { renderLeadBrief } from '../lead-text';
import { leadBriefQuery } from '../schemas';

/**
 * The lead's reads. Plain reads like the other GET routes: no CORS headers, so a page on another site cannot read them.
 * With `as` the brief is a lead's: the project must have that lead, or the answer is a 409 and nothing is written.
 * Without `as` it is the window's: no lead check, and it never marks the brief as read.
 */
export function registerLeadRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/lead/:ref/brief', async (req) => {
    const { ref } = req.params as { ref: string };
    const query = leadBriefQuery.parse(req.query);
    const now = new Date(ctx.now());
    if (query.as === undefined) {
      const brief = readLeadBrief(ctx, ref, null, now);
      return { brief, text: renderLeadBrief(brief) };
    }
    const project = requireLead(ctx, ref, query.as, query.instructions!, false);
    const brief = readLeadBrief(ctx, project.slug, query.instructions!, now);
    // After the brief is built, so this look does not empty its own landed and said lists.
    if (query.mark === '1') markLeadSeen(ctx, project.slug, now);
    return { brief, text: renderLeadBrief(brief) };
  });
  app.get('/api/lead/:ref/events', async (req) => ({ events: listLeadEvents(ctx, (req.params as { ref: string }).ref) }));
}
