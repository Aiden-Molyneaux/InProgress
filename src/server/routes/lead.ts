import type { FastifyInstance } from 'fastify';
import type { Guard } from '../app';
import type { Ctx } from '../db/tx';
import { badGateway, badRequest } from '../errors';
import { cliBesideServer, nodeCli } from '../../lib/task-command';
import { leadFolders, listLeadEvents, markLeadSeen, readLeadBrief, readLeadIntent, readLeadRules, requireLead } from '../lead';
import { leadAllow, leadDisallow, leadAnswer, leadDecide, leadUndo, leadDrop, leadIntent, leadKept, leadPark, leadPromise } from '../lead-commands';
import { readDesk } from '../lead/desk';
import { holdBody, holdCheck, stuckWait } from '../lead/hold';
import { checkLanding, type LandingDeps } from '../lead/landing';
import { leadRelay, reasonOf, type RelaySend } from '../lead-relay';
import { defaultStart, leadStart, type StartThread } from '../lead-start';
import { createSender, type Sender } from '../lead/sends';
import { T3Unavailable, t3List, t3Send, t3Show } from '../t3';
import { readLeadResource, readLeadStep } from '../lead-step';
import { renderLeadBrief } from '../lead-text';
import { leadAllowBody, leadDisallowBody, leadAnswerBody, leadBriefQuery, leadStuckBody, leadDecideBody, leadUndoBody, leadDropBody, leadIntentBody, leadKeptBody, leadLandingBody, leadParkBody, leadPromiseBody, leadReadQuery, leadRelayBody, leadStartBody, leadRulesQuery, leadSeenBody } from '../schemas';

/** How many of a project's threads, newest first, the threads read opens to see whether they hold a message. */
const THREADS_READ = 10;
/** The most a thread read answers. */
const THREAD_MAX_BYTES = 40 * 1024;
/** The text cut to THREAD_MAX_BYTES, with a last line saying so. */
function capText(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= THREAD_MAX_BYTES) return text;
  return `${bytes.subarray(0, THREAD_MAX_BYTES).toString('utf8').replace(/�+$/, '')}\n[Cut: the thread was ${bytes.length} bytes and the limit is ${THREAD_MAX_BYTES}.]`;
}

/** A route's `:id`: a whole number above 0, or a 400. */
function positiveId(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw badRequest(`${text} is not an id`);
  return Number(text);
}

/**
 * The lead's reads, and its writes. The reads are plain GETs like the other reads: no CORS headers, so a page on another
 * site cannot read them. With `as` the brief is a lead's: the project must have that lead, or the answer is a 409 and
 * nothing is written. Without `as` it is the window's: no lead check, and it never marks. Marking the brief as read and the
 * lead's seven commands are writes, so they are POSTs behind the bearer token guard. `send` is how a relay reaches a T3
 * Code thread: the t3 CLI unless the app was given another.
 */
export function registerLeadRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard, send?: RelaySend, start?: StartThread, landing?: LandingDeps, given?: Sender): void {
  // One sender for the app's starts, relays and thread reads: the server's own when it runs one (main.ts), else the app's.
  const sender = given ?? createSender(ctx, { t3: { list: (p) => t3List(p), show: (id) => t3Show(id), start: start ?? defaultStart(), send: send ?? t3Send } });
  /** A T3 Code read for the lead's tools: a refused argument is a 400, T3 Code not answering a 502 with its reason. */
  const t3Read = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (err) {
      if (err instanceof TypeError) throw badRequest(err.message);
      if (err instanceof T3Unavailable) throw badGateway(`T3 Code is not answering: ${reasonOf(err)}`);
      throw err;
    }
  };
  // The lead's reads of T3 Code, for clearing an unknown send: the project's threads (the newest read for a first message), and one thread.
  app.get('/api/lead/:ref/threads', async (req) => {
    const { ref } = req.params as { ref: string };
    const query = leadReadQuery.parse(req.query);
    const project = requireLead(ctx, ref, query.as, query.instructions, false);
    const [folder] = leadFolders(ctx, project.id);
    if (folder === undefined) return { text: 'This project has no folder on record.' };
    const threads = [...(await t3Read(() => sender.threads(folder)))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const lines: string[] = [];
    for (const [i, t] of threads.entries()) {
      let said = 'messages not read (only the newest ' + THREADS_READ + ' are)';
      if (i < THREADS_READ) {
        try {
          said = (await sender.show(t.threadId)).messages.some((m) => m.role === 'user') ? 'has a first message' : 'has no message';
        } catch (err) {
          said = `could not read its messages: ${reasonOf(err)}`;
        }
      }
      lines.push(`${t.threadId}  "${t.title}"  updated ${t.updatedAt || '(unknown)'}  ${said}`);
    }
    return { text: lines.length === 0 ? 'No threads.' : lines.join('\n') };
  });
  app.get('/api/lead/:ref/thread/:id', async (req) => {
    const { ref, id } = req.params as { ref: string; id: string };
    const query = leadReadQuery.parse(req.query);
    requireLead(ctx, ref, query.as, query.instructions, false);
    const { thread, messages } = await t3Read(() => sender.show(id));
    const text = [`${thread.threadId}  "${thread.title}"  updated ${thread.updatedAt || '(unknown)'}`, ...messages.map((m) => `${m.role}: ${m.text}`)].join('\n\n');
    return { text: capText(text) };
  });
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
  // The lead's reads of one step, one document and the intent record: the same lead check, any instructions version.
  app.get('/api/lead/:ref/step/:id', async (req) => {
    const { ref, id } = req.params as { ref: string; id: string };
    const query = leadReadQuery.parse(req.query);
    return readLeadStep(ctx, ref, query.as, query.instructions, positiveId(id), new Date(ctx.now()));
  });
  app.get('/api/lead/:ref/resource/:id', async (req) => {
    const { ref, id } = req.params as { ref: string; id: string };
    const query = leadReadQuery.parse(req.query);
    return readLeadResource(ctx, ref, query.as, query.instructions, positiveId(id));
  });
  app.get('/api/lead/:ref/intent', async (req) => {
    const query = leadReadQuery.parse(req.query);
    return readLeadIntent(ctx, (req.params as { ref: string }).ref, query.as, query.instructions);
  });
  app.get('/api/lead/:ref/events', async (req) => ({ events: listLeadEvents(ctx, (req.params as { ref: string }).ref) }));
  // The lead's desk: its open items, oldest first, and their text. No lead check, like the log.
  app.get('/api/lead/:ref/desk', async (req) => readDesk(ctx, (req.params as { ref: string }).ref));
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
  app.post('/api/lead/:ref/decide', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadDecideBody.parse(req.body);
    return leadDecide(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/:ref/undo', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadUndoBody.parse(req.body);
    return leadUndo(ctx, ref(req), as, instructions, input);
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
  // The landing check: git read in the session's folder, judged in plain code with no model. Held or clear, it answers 200.
  app.post('/api/lead/:ref/landing', { onRequest: requireToken }, async (req) => {
    const body = leadLandingBody.parse(req.body);
    return checkLanding(ctx, { ref: ref(req), ...body });
  });
  // The hold and permission hooks (task 7): the project is the session's, else the folder's, so these take no :ref. Each
  // says nothing when that project has no lead or its round is off. A held command is answered in seconds; a permission
  // request waits up to 170 s for the lead's verdict.
  app.post('/api/lead/hold', { onRequest: requireToken }, async (req) => holdCheck(ctx, holdBody.parse(req.body), landing));
  app.post('/api/lead/stuck', { onRequest: requireToken }, async (req, reply) => {
    const body = leadStuckBody.parse(req.body);
    // The hook gave up (its timeout, a cancelled call): the wait stops; the item stays on the desk.
    let gone = false;
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) gone = true;
    });
    return stuckWait(ctx, body, { gone: () => gone });
  });
  // The two switches: only ever on Aiden's words, turned on by the lead on his word and logged with it.
  app.post('/api/lead/:ref/allow', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadAllowBody.parse(req.body);
    return leadAllow(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/:ref/disallow', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadDisallowBody.parse(req.body);
    return leadDisallow(ctx, ref(req), as, instructions, input);
  });
  // The relay is checked, then sent, then logged: the send runs outside any write, and is logged whatever it did.
  app.post('/api/lead/:ref/relay', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadRelayBody.parse(req.body);
    return leadRelay(ctx, ref(req), as, instructions, input, sender);
  });
  // A start is checked, then made, then logged, as a relay is: the t3 call runs outside any write and is never repeated.
  app.post('/api/lead/:ref/start', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadStartBody.parse(req.body);
    return leadStart(ctx, ref(req), as, instructions, input, sender);
  });
}
