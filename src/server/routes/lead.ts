import type { FastifyInstance } from 'fastify';
import type { Guard } from '../app';
import type { Ctx } from '../db/tx';
import { badGateway, badRequest, conflict, notFound } from '../errors';
import { cliBesideServer, nodeCli } from '../../lib/task-command';
import { leadFolders, listLeadEvents, markLeadSeen, readLeadBrief, readLeadIntent, readLeadRules, requireLead } from '../lead';
import { leadAllow, leadDisallow, leadAnswer, leadDeskAdd, leadSeen, readYeses, requireAnswerLead, type CarriedYes, workProject, WORK_PROJECT, leadDecide, leadUndo, leadDrop, leadIntent, leadKept, leadPark, leadPromise, leadSet } from '../lead-commands';
import { readMorning } from '../lead/morning';
import { reserveAllowsStart } from '../lead/reserve';
import { importUsage, leadCounts, weekText } from '../lead/usage';
import { resolveProject } from '../repo/projects';
import { readDesk } from '../lead/desk';
import { holdBody, holdCheck, stuckWait } from '../lead/hold';
import { checkLanding, type LandingDeps } from '../lead/landing';
import { leadRelay, reasonOf, type RelaySend } from '../lead-relay';
import { defaultStart, leadStart, type StartThread } from '../lead-start';
import { createSender, type Sender } from '../lead/sends';
import { T3ArgumentRefused, T3Unavailable, t3List, t3Send, t3Show } from '../t3';
import { readLeadResource, readLeadStep } from '../lead-step';
import { renderLeadBrief } from '../lead-text';
import { leadAllowBody, leadDisallowBody, leadAnswerBody, leadBriefQuery, leadStuckBody, leadDecideBody, leadUndoBody, leadSetBody, leadImportUsageBody, leadCountsQuery, leadDropBody, leadIntentBody, leadKeptBody, leadLandingBody, leadParkBody, leadPromiseBody, leadReadQuery, leadRelayBody, leadStartBody, leadRulesQuery, leadSeenBody, leadStampBody, leadDeskAddBody, leadOldAsksBody, leadOldAsksNextBody, leadOldAsksReadingBody } from '../schemas';
import { leadOldAskReading, leadOldAsks, leadOldAsksAll, leadOldAsksNext } from '../lead/oldAsks';
import { VOICE_NOT_SET_UP, voiceSetUp } from '../lead/voice';
import { heldScope, leadAnswerItem, readSessionYeses, SAID_AT_NEEDED, voiceTarget } from '../lead/carry';
import { heldActions, playbookHeldLines } from '../../core/hold';

/** How many of a project's threads, newest first, the threads read lists. */
const THREADS_LISTED = 20;
/** How many of those, newest first, it opens to see whether they hold a message, and how many at a time. */
const THREADS_READ = 5;
const THREADS_AT_ONCE = 3;
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
export function registerLeadRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard, send?: RelaySend, start?: StartThread, landing?: LandingDeps, given?: Sender, home?: string): void {
  // One sender for the app's starts, relays and thread reads: the server's own when it runs one (main.ts), else the app's.
  const sender = given ?? createSender(ctx, { t3: { list: (p) => t3List(p), show: (id) => t3Show(id), start: start ?? defaultStart(), send: send ?? t3Send } });
  /** A T3 Code read for the lead's tools: a refused argument is a 400, T3 Code not answering a 502 with its reason. */
  const t3Read = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (err) {
      if (err instanceof T3ArgumentRefused) throw badRequest(err.message);
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
    const all = [...(await t3Read(() => sender.threads(folder)))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const threads = all.slice(0, THREADS_LISTED);
    // Each show is a CLI run: the newest few only, a few at a time, so the read ends inside the tool's wait.
    const said = threads.map(() => 'messages not opened');
    const opened = threads.slice(0, THREADS_READ);
    for (let i = 0; i < opened.length; i += THREADS_AT_ONCE) {
      await Promise.all(
        opened.slice(i, i + THREADS_AT_ONCE).map(async (t, j) => {
          try {
            said[i + j] = (await sender.show(t.threadId)).messages.some((m) => m.role === 'user') ? 'has a first message' : 'has no message';
          } catch (err) {
            said[i + j] = `could not read its messages: ${reasonOf(err)}`;
          }
        }),
      );
    }
    const lines = threads.map((t, i) => `${t.threadId}  "${t.title}"  updated ${t.updatedAt || '(unknown)'}  ${said[i]}`);
    if (lines.length === 0) return { text: 'No threads.' };
    const notOpened = threads.length - opened.length;
    if (notOpened > 0) lines.push(`${notOpened} of these were not opened: read one with thread.`);
    if (all.length > threads.length) lines.push(`${all.length - threads.length} older threads are not listed.`);
    return { text: lines.join('\n') };
  });
  app.get('/api/lead/:ref/thread/:id', async (req) => {
    const { ref, id } = req.params as { ref: string; id: string };
    const query = leadReadQuery.parse(req.query);
    const project = requireLead(ctx, ref, query.as, query.instructions, false);
    // Only a thread of this project: one its last threads read listed.
    const folder = leadFolders(ctx, project.id)[0];
    if (folder === undefined || !sender.listed(folder, id)) throw notFound(`Thread ${id} was not in this project's last threads read. Read threads first.`);
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
    return readLeadResource(ctx, ref, query.as, query.instructions, positiveId(id), home ?? ctx.home);
  });
  app.get('/api/lead/:ref/intent', async (req) => {
    const query = leadReadQuery.parse(req.query);
    return readLeadIntent(ctx, (req.params as { ref: string }).ref, query.as, query.instructions);
  });
  app.get('/api/lead/:ref/events', async (req) => ({ events: listLeadEvents(ctx, (req.params as { ref: string }).ref) }));
  // The lead's desk: its open items, oldest first, and their text. No lead check, like the log.
  app.get('/api/lead/:ref/desk', async (req) => readDesk(ctx, (req.params as { ref: string }).ref));
  // The morning list since the last one, the week's usage, and what reached Aiden per step closed: reads, no lead check.
  app.get('/api/lead/:ref/morning', async (req) => ({ text: readMorning(ctx, resolveProject(ctx, (req.params as { ref: string }).ref).id) }));
  app.get('/api/lead/:ref/week', async (req) => {
    resolveProject(ctx, (req.params as { ref: string }).ref);
    const text = weekText(ctx.db, ctx.now(), reserveAllowsStart(ctx, ctx.now()));
    // The Voice's set-up is the webhook file in the home; an app with no home (a test) says nothing of it.
    return { text: home === undefined || voiceSetUp(home) ? text : `${text}\n${VOICE_NOT_SET_UP}` };
  });
  app.get('/api/lead/:ref/counts', async (req) => {
    const project = resolveProject(ctx, (req.params as { ref: string }).ref);
    return leadCounts(ctx, project.id, leadCountsQuery.parse(req.query).since);
  });
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
    const { as, instructions, yes, sendId, askId: givenAsk, ...body } = leadAnswerBody.parse(req.body);
    // The lead and the C:\work refusal are checked first, so a refused answer starts no git.
    const { project } = requireAnswerLead(ctx, ref(req), as, instructions);
    if (workProject(ctx, project.id)) throw conflict(WORK_PROJECT);
    const now = ctx.now();
    // When he said it, as given, never after now.
    const given = body.saidAt === undefined ? undefined : new Date(Math.min(Date.parse(body.saidAt), Date.parse(now))).toISOString();
    const saidAt = given ?? now;
    let askId = givenAsk;
    // The time a yes is checked against: the work must have no commit after it (W8a). With no time of his, the line to
    // the Voice he replied to gives one: he cannot have said yes before it reached him.
    let anchor: string | undefined = given;
    // His reply to a line to the Voice is heard on the Voice unless the lead says otherwise.
    const input = sendId !== undefined && body.where === undefined ? { ...body, where: 'voice' as const } : body;
    if (sendId !== undefined) {
      // His reply to a line to the Voice: the line's send says what it was about.
      const target = voiceTarget(ctx, project, sendId);
      const reached = target.send.doneAt ?? undefined;
      // A line with no delivery time and no time of his gives no anchor: a yes then records none, as on an ask.
      if (reached !== undefined && (anchor === undefined || reached < anchor)) anchor = reached;
      if (target.kind === 'ask') askId = target.askId;
      else {
        // A closed item runs no git.
        if (target.item.state === 'done') throw conflict(`Desk item #${target.item.id} is already closed.`);
        const notes: string[] = [];
        if (input.says !== undefined) notes.push('--says was ignored: a reply to this line is his words alone.');
        let yeses: CarriedYes[] | undefined;
        if (target.kind === 'held' && yes !== undefined) {
          const held = heldScope(ctx, target.item);
          // His yes covers only what the held command does.
          const cwd = held.sessionId === null ? null : ((ctx.db.prepare('SELECT cwd FROM sessions WHERE id = ?').pluck().get(held.sessionId) as string | null | undefined) ?? null);
          const own = new Set(heldActions(held.command, playbookHeldLines(project.playbook), cwd).map((m) => m.action as string));
          const kept = yes.filter((a) => own.has(a));
          for (const a of yes.filter((a) => !own.has(a))) notes.push(`--yes ${a} was ignored: the held command is not a ${a}.`);
          if (target.item.nodeId === null) {
            if (kept.length) notes.push('No yes recorded: the held command is on no step.');
          } else if (kept.length) {
            yeses = anchor === undefined
              ? kept.map((action) => ({ action, patchId: null, why: SAID_AT_NEEDED }))
              : await readSessionYeses(ctx, ref(req), target.item.nodeId, held.sessionId, kept, anchor, landing);
          }
        } else if (yes !== undefined) notes.push('--yes was ignored: what he left to the lead takes no go-ahead.');
        const { says: _says, ...rest } = input;
        const res = leadAnswerItem(ctx, ref(req), as, instructions, target.item.id, { ...rest, saidAt, notes, ...(yeses === undefined ? {} : { yeses }) });
        if (res.carried) setImmediate(() => void sender.wake());
        return res;
      }
    }
    // A review's yes, only for the actions his words okayed (`yes`): keyed on the change's patch id, read now in its
    // session's folder, before the write. No `yes`, no yes; a `yes` with no time of his records none.
    let yeses: CarriedYes[] | undefined;
    if (yes !== undefined) {
      if (anchor !== undefined) yeses = await readYeses(ctx, ref(req), project.id, askId as number, yes, anchor, landing);
      else if (ctx.db.prepare("SELECT 1 FROM asks WHERE id = ? AND project_id = ? AND kind = 'review'").get(askId, project.id) !== undefined) {
        yeses = yes.map((action) => ({ action, patchId: null, why: SAID_AT_NEEDED }));
      }
    }
    const res = leadAnswer(ctx, ref(req), as, instructions, { ...input, askId: askId as number, saidAt, ...(yeses === undefined ? {} : { yeses }) });
    // The carried line is a send: carried out after the write commits (wake never throws).
    if (res.carried) setImmediate(() => void sender.wake());
    return res;
  });
  // The Voice passed Aiden's word on a line: its send is stamped seen. The round never waits on it.
  app.post('/api/lead/:ref/stamp', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadStampBody.parse(req.body);
    return leadSeen(ctx, ref(req), as, instructions, input);
  });
  // "You decide": Aiden's words on a step, put on the desk for the round.
  app.post('/api/lead/:ref/desk-add', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadDeskAddBody.parse(req.body);
    return leadDeskAdd(ctx, ref(req), as, instructions, input);
  });
  // The old asks (task 17): onto the desk, the lead's reading of one, and the next few to the Voice (across his projects).
  app.post('/api/lead/:ref/old-asks', { onRequest: requireToken }, async (req) => {
    const { as, instructions } = leadOldAsksBody.parse(req.body);
    return leadOldAsks(ctx, ref(req), as, instructions);
  });
  app.post('/api/lead/:ref/old-asks/reading', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadOldAsksReadingBody.parse(req.body);
    return leadOldAskReading(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/old-asks/all', { onRequest: requireToken }, async (req) => {
    const { as, instructions } = leadOldAsksBody.parse(req.body);
    return leadOldAsksAll(ctx, as, instructions);
  });
  app.post('/api/lead/old-asks/next', { onRequest: requireToken }, async (req) => {
    const { as, instructions, count } = leadOldAsksNextBody.parse(req.body);
    return leadOldAsksNext(ctx, as, instructions, count);
  });
  app.post('/api/lead/:ref/decide', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadDecideBody.parse(req.body);
    return leadDecide(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/:ref/undo', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadUndoBody.parse(req.body);
    return leadUndo(ctx, ref(req), as, instructions, input);
  });
  app.post('/api/lead/:ref/set', { onRequest: requireToken }, async (req) => {
    const { as, instructions, ...input } = leadSetBody.parse(req.body);
    return leadSet(ctx, ref(req), as, instructions, input);
  });
  // Stage 0's hourly usage readings, imported once from a file on this machine.
  app.post('/api/lead/usage/import', { onRequest: requireToken }, async (req) => {
    const { file } = leadImportUsageBody.parse(req.body);
    try {
      const r = importUsage(ctx, file);
      return { ...r, text: `Imported ${r.added} reading${r.added === 1 ? '' : 's'}; ${r.skipped} skipped.` };
    } catch (err) {
      throw badRequest(`Could not import ${file}: ${(err as Error).message}`);
    }
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
