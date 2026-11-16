import type { FastifyInstance } from 'fastify';
import type { Guard } from '../app';
import type { Ctx } from '../db/tx';
import { cliBesideServer, nodeCli } from '../../lib/task-command';
import { listLeadEvents, markLeadSeen, readLeadBrief, readLeadRules, requireLead } from '../lead';
import { leadAnswer, leadDrop, leadIntent, leadKept, leadPark, leadPromise } from '../lead-commands';
import { leadRelay, type RelaySend } from '../lead-relay';
import { renderLeadBrief } from '../lead-text';
import { leadAnswerBody, leadBriefQuery, leadDropBody, leadIntentBody, leadKeptBody, leadParkBody, leadPromiseBody, leadRelayBody, leadRulesQuery, leadSeenBody } from '../schemas';

/**
 * The lead's reads, and its writes. The reads are plain GETs like the other reads: no CORS headers, so a page on another
 * site cannot read them. With `as` the brief is a lead's: the project must have that lead, or the answer is a 409 and
 * nothing is written. Without `as` it is the window's: no lead check, and it never marks. Marking the brief as read and the
 * lead's seven commands are writes, so they are POSTs behind the bearer token guard. `send` is how a relay reaches a T3
 * Code thread: the t3 CLI unless the app was given another.
 */
export function registerLeadRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard, send?: RelaySend): void {
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
    return { brief, text: renderLeadBrief(brief) };
  });
  // The lead's rules, with its name and the project's filled in: a read like the brief, with the same lead check.
  app.get('/api/lead/:ref/rules', async (req) => {
    const { ref } = req.params as { ref: string };
    const query = leadRulesQuery.parse(req.query);
    return readLeadRules(ctx, ref, query.as, nodeCli(cliBesideServer()));
  });
  app.get('/api/lead/:ref/events', async (req) => ({ events: listLeadEvents(ctx, (req.params as { ref: string }).ref) }));
  // The lead has read the brief: the next one counts what landed and what was said from here.
  app.post('/api/lead/:ref/seen', { onRequest: requireToken }, async (req) => {
    const body = leadSeenBody.parse(req.body);
    const project = requireLead(ctx, (req.params as { ref: string }).ref, body.as, body.instructions, false);
    const now = new Date(ctx.now());
    // The look is the time of the brief the lead read, when it sends one, so what landed after that brief was built is
    // in the next one. A time ahead of the clock would hide what lands until then: it counts as now.
    const at = body.at !== undefined && Date.parse(body.at) < now.getTime() ? new Date(body.at) : now;
    return { seenAt: markLeadSeen(ctx, project.slug, at) };
  });
  // The lead's commands: each a POST behind the bearer token guard, checked, performed and logged in one write. Each answers
  // what its command returns, `text` being the sentence the CLI prints.
  const ref = (req: { params: unknown }): string => (req.params as { ref: string }).ref;
  app.post('/api/lead/:ref/answer', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadAnswerBody.parse(req.body);
    return leadAnswer(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/:ref/park', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadParkBody.parse(req.body);
    return leadPark(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/:ref/drop', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadDropBody.parse(req.body);
    return leadDrop(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/:ref/promise', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadPromiseBody.parse(req.body);
    return leadPromise(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/:ref/kept', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadKeptBody.parse(req.body);
    return leadKept(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/:ref/intent', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadIntentBody.parse(req.body);
    return leadIntent(ctx, ref(req), as, instructions, input);
  });
  // The relay is checked, then sent, then logged: the send runs outside any write, and is logged whatever it did.
  app.post('/api/lead/:ref/relay', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadRelayBody.parse(req.body);
    return leadRelay(ctx, ref(req), as, instructions, input, send);
  });
}
