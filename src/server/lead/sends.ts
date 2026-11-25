import { LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { write, type Ctx, type RecordEvent } from '../db/tx';
import { getDeskItem } from '../repo/desk';
import { produceDeskItem } from '../repo/deskProducers';
import { insertLeadEvent } from '../repo/leadEvents';
import { getSend, intendedSends, moveSend, type LeadSend } from '../repo/leadSends';
import { getProjectById } from '../repo/projects';
import { T3Unavailable, type T3Message, type T3Thread } from '../t3';

/*
 * Every action that leaves InProgress happens once (lead stage 1, #743, task 8). A send is a lead_sends row written as
 * intended before the action; the sender carries it out and moves it to done with its result. A send that may have reached
 * T3 Code is never sent again blindly: it is looked up (a start by the marker in its thread's title, a message by its text in
 * the thread), and one not found on two looks a minute apart becomes unknown and an `unknown_send` desk item.
 */

/** The longest title T3 Code is given (t3.ts cuts there): the marker is kept inside it. */
export const TITLE_MAX = 120;
/** How old an intended send must be before recovery looks it up. */
export const LOOKUP_AFTER_MS = 60 * 1000;
/** How far apart the two looks that find nothing must be. */
export const LOOKS_APART_MS = 60 * 1000;
/** The actor of the sender's own writes. */
const ACTOR = 'inprogress:sender';

/** The marker a start's thread title ends with: the send's id, which recovery finds in `t3 thread list`. */
export const sendMarker = (id: number): string => `[s${id}]`;

/** The title cut to leave room for ` [s<id>]`, then the marker: the cut takes the text, never the marker. */
export function markedTitle(title: string, id: number): string {
  const marker = ` ${sendMarker(id)}`;
  return Array.from(title).slice(0, TITLE_MAX - Array.from(marker).length).join('') + marker;
}

/** Whether a thread title carries this send's marker (t3.ts may strip the space before it when the text is blank). */
export const titleHasMarker = (title: string, id: number): boolean => title === sendMarker(id) || title.endsWith(` ${sendMarker(id)}`);

/** How a start is made: T3 Code's flags, each passed only when set. */
export interface StartOptions {
  title?: string;
  provider?: string;
  model?: string;
  worktree?: string;
  branch?: string;
}

/** A start send's body: the first message and the start's own fields, stored as JSON so a later try uses the same. */
export interface StartBody {
  message: string;
  title: string;
  provider?: string;
  model?: string;
  worktree?: string;
  branch?: string;
  /** The step it starts. */
  nodeId?: number;
  /** Aiden's words when the start was his; absent for the lead's own judgment. */
  aidenWords?: string;
}

/** A start send's body read back, or undefined when it is not a start body. */
export function parseStartBody(body: string): StartBody | undefined {
  try {
    const v = JSON.parse(body) as Partial<StartBody> | null;
    return v !== null && typeof v === 'object' && typeof v.message === 'string' && typeof v.title === 'string' ? (v as StartBody) : undefined;
  } catch {
    // Not JSON: not a start body, said by the undefined.
    return undefined;
  }
}

/** The step a send is about: a start's own, else its desk item's. */
function stepOf(ctx: Ctx, send: LeadSend): number | null {
  if (send.kind === 'start') return parseStartBody(send.body)?.nodeId ?? null;
  return send.itemId === null ? null : (getDeskItem(ctx.db, send.itemId)?.nodeId ?? null);
}

/** T3 Code as the sender reaches it: t3.ts's four calls in the server, a stand-in in tests. */
export interface SenderT3 {
  list(project: string): Promise<T3Thread[]>;
  show(threadId: string): Promise<{ thread: T3Thread; messages: T3Message[] }>;
  start(project: string, message: string, opts: StartOptions): Promise<{ threadId: string }>;
  send(threadId: string, message: string): Promise<void>;
}

export interface SenderDeps {
  t3: SenderT3;
  /** Sends a line to the Voice and answers its id (task 11). Without it a voice_line waits. */
  webhook?: (send: LeadSend) => Promise<string>;
}

export interface SenderLog {
  info(message: string): void;
  error(message: string): void;
}

export interface SenderOptions {
  log?: SenderLog;
}

/** What one perform did. */
export type PerformOutcome =
  /** Sent, and moved to done with its result (a start's thread id). */
  | { state: 'done'; result: string }
  /** Nothing reached T3 Code: still intended, tried again at the next tick. */
  | { state: 'waiting'; reason: string }
  /** Nothing reached T3 Code, and the caller asked for it to be cleared rather than tried again. */
  | { state: 'cleared'; reason: string }
  /** It may have been sent: still intended, and only ever looked up from now on. */
  | { state: 'lookup'; reason: string }
  /** The send is not intended (done, unknown, cleared or gone): nothing was done. */
  | { state: 'gone' };

export interface Sender {
  /**
   * Carries out one intended send. Two performs of one send in this process share one try. `clearIfNotSent` moves a send
   * that reached nothing to cleared (the caller tells its user it was not sent) instead of leaving it for the next tick.
   */
  perform(sendId: number, opts?: { clearIfNotSent?: boolean }): Promise<PerformOutcome>;
  /** The minute check: looks up every send that may have been sent, then carries out the rest. */
  tick(): Promise<void>;
  /** After the commit of a write that intends a send: carries out the intended sends, oldest first, one at a time per target. */
  wake(): Promise<void>;
  stop(): void;
  /** The project's threads, as T3 Code lists them; remembered for `listed`. */
  threads(project: string): Promise<T3Thread[]>;
  show(threadId: string): Promise<{ thread: T3Thread; messages: T3Message[] }>;
  /** Whether a `threads` read of this project listed the thread. */
  listed(project: string, threadId: string): boolean;
}

/** A voice_line with no webhook yet: nothing was sent, it waits. */
class NoWebhook extends Error {}

/** Whether a failure says nothing reached T3 Code: a refused argument, or a t3 failure whose outcome is known. */
const notSent = (err: unknown): boolean => err instanceof NoWebhook || err instanceof TypeError || (err instanceof T3Unavailable && !err.outcomeUnknown);

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 300);

/** Records a start found or confirmed after the fact, as leadStart records one: a `start` line with the thread id. */
export function recordStartInWrite(ctx: Ctx, record: RecordEvent, send: LeadSend, threadId: string): void {
  const project = getProjectById(ctx, send.projectId);
  if (project === undefined || project.lead === null || project.lead.trim() === '') return;
  const body = parseStartBody(send.body);
  insertLeadEvent(
    ctx.db,
    {
      projectId: project.id,
      lead: project.lead,
      instructions: LEAD_INSTRUCTIONS_VERSION,
      kind: 'start',
      ...(body?.nodeId === undefined ? {} : { nodeId: body.nodeId }),
      text: threadId,
      ...(body?.aidenWords === undefined ? {} : { aidenWords: body.aidenWords }),
    },
    ctx.now(),
  );
  record({ projectId: project.id, type: 'project.updated', entity: 'project', entityId: project.id, data: { changes: { started: 'start' } } });
}

const key = (project: string): string => project.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function createSender(ctx: Ctx, deps: SenderDeps, opts: SenderOptions = {}): Sender {
  const log = opts.log ?? { info: () => undefined, error: (m: string) => console.error(`InProgress: ${m}`) };
  const inFlight = new Map<number, Promise<PerformOutcome>>();
  // A send intended before this sender started may have been tried by the process before it: looked up, never sent again.
  const lookups = new Set<number>(intendedSends(ctx.db).map((s) => s.id));
  /** When each looked-up send was first not found (ms). */
  const misses = new Map<number, number>();
  const listedThreads = new Map<string, Set<string>>();
  let stopped = false;
  let draining: Promise<void> | undefined;
  let again = false;

  const threads = async (project: string): Promise<T3Thread[]> => {
    const list = await deps.t3.list(project);
    listedThreads.set(key(project), new Set(list.map((t) => t.threadId)));
    return list;
  };

  const act = async (send: LeadSend): Promise<string> => {
    if (send.kind === 'start') {
      const body = parseStartBody(send.body);
      if (body === undefined) throw new TypeError(`start send s${send.id} has no readable body`);
      const o: StartOptions = { title: markedTitle(body.title, send.id) };
      for (const k of ['provider', 'model', 'worktree', 'branch'] as const) if (body[k] !== undefined) o[k] = body[k];
      return (await deps.t3.start(send.target, body.message, o)).threadId;
    }
    if (send.kind === 'voice_line') {
      if (deps.webhook === undefined) throw new NoWebhook('no Voice webhook yet');
      return deps.webhook(send);
    }
    await deps.t3.send(send.target, send.body);
    return send.target;
  };

  const run = async (id: number, o: { clearIfNotSent?: boolean }): Promise<PerformOutcome> => {
    const send = getSend(ctx.db, id);
    if (send === undefined || send.state !== 'intended') return { state: 'gone' };
    if (lookups.has(id)) return { state: 'lookup', reason: 'it may have been sent before, so it is looked up, never sent again' };
    if (stopped) return { state: 'waiting', reason: 'the sender is stopped' };
    let result: string;
    try {
      result = await act(send);
    } catch (err) {
      const reason = reasonOf(err);
      if (notSent(err)) {
        if (o.clearIfNotSent) {
          write(ctx, ACTOR, () => moveSend(ctx.db, id, ['intended'], 'cleared', { now: ctx.now() }));
          return { state: 'cleared', reason };
        }
        if (!(err instanceof NoWebhook)) log.error(`send s${id} (${send.kind}) was not sent and waits for the next try: ${reason}`);
        return { state: 'waiting', reason };
      }
      lookups.add(id);
      log.error(`send s${id} (${send.kind}) may have been sent and will be looked up: ${reason}`);
      return { state: 'lookup', reason };
    }
    try {
      write(ctx, ACTOR, () => moveSend(ctx.db, id, ['intended'], 'done', { result, now: ctx.now() }));
    } catch (err) {
      // Sent, but not recorded: it must never go again, so recovery looks it up.
      lookups.add(id);
      log.error(`send s${id} (${send.kind}) was sent but could not be marked done, and will be looked up: ${reasonOf(err)}`);
    }
    return { state: 'done', result };
  };

  const perform = (id: number, o: { clearIfNotSent?: boolean } = {}): Promise<PerformOutcome> => {
    const running = inFlight.get(id);
    if (running !== undefined) return running;
    const p = run(id, o).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  };

  /** The send's result when T3 Code shows it happened, undefined when it does not. Throws when T3 Code does not answer. */
  const lookUp = async (send: LeadSend): Promise<string | undefined> => {
    if (send.kind === 'start') return (await threads(send.target)).find((t) => titleHasMarker(t.title, send.id))?.threadId;
    // A line to the Voice has nothing to look it up by: it is not found.
    if (send.kind === 'voice_line') return undefined;
    const { messages } = await deps.t3.show(send.target);
    return messages.some((m) => m.text === send.body) ? send.target : undefined;
  };

  const recover = async (send: LeadSend): Promise<void> => {
    let found: string | undefined;
    try {
      found = await lookUp(send);
    } catch (err) {
      // T3 Code not answering: it waits, and the look does not count.
      log.info(`send s${send.id} waits: T3 Code did not answer its lookup (${reasonOf(err)})`);
      return;
    }
    if (found !== undefined) {
      const threadId = found;
      write(ctx, ACTOR, (record) => {
        if (moveSend(ctx.db, send.id, ['intended'], 'done', { result: threadId, now: ctx.now() }) && send.kind === 'start') recordStartInWrite(ctx, record, send, threadId);
      });
      lookups.delete(send.id);
      misses.delete(send.id);
      log.info(`send s${send.id} (${send.kind}) was found and is done: ${threadId}`);
      return;
    }
    const nowMs = Date.parse(ctx.now());
    const first = misses.get(send.id);
    if (first === undefined) {
      misses.set(send.id, nowMs);
      return;
    }
    if (nowMs - first < LOOKS_APART_MS) return;
    write(ctx, ACTOR, () => {
      if (!moveSend(ctx.db, send.id, ['intended'], 'unknown', { now: ctx.now() })) return;
      produceDeskItem(ctx.db, { projectId: send.projectId, kind: 'unknown_send', ref: String(send.id), nodeId: stepOf(ctx, send) }, ctx.now());
    });
    lookups.delete(send.id);
    misses.delete(send.id);
    log.info(`send s${send.id} (${send.kind}) was not found on two looks: unknown, on the desk`);
  };

  const drainOnce = async (): Promise<void> => {
    const byTarget = new Map<string, LeadSend[]>();
    for (const s of intendedSends(ctx.db)) {
      if (lookups.has(s.id)) continue;
      const list = byTarget.get(s.target) ?? [];
      list.push(s);
      byTarget.set(s.target, list);
    }
    await Promise.all(
      [...byTarget.values()].map(async (list) => {
        // One at a time per target: a target with a send already under way waits for the next wake.
        if (list.some((s) => inFlight.has(s.id))) return;
        for (const s of list) {
          if (stopped) return;
          const o = await perform(s.id);
          // Oldest first: a send that did not go holds the ones after it.
          if (o.state !== 'done' && o.state !== 'gone') return;
        }
      }),
    );
  };

  const wake = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (draining !== undefined) {
      again = true;
      return draining;
    }
    draining = (async () => {
      do {
        again = false;
        await drainOnce();
      } while (again && !stopped);
    })()
      .catch((err: unknown) => log.error(`the sender could not carry out its sends: ${reasonOf(err)}`))
      .finally(() => {
        draining = undefined;
      });
    return draining;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const nowMs = Date.parse(ctx.now());
    for (const s of intendedSends(ctx.db)) {
      if (stopped) return;
      if (!lookups.has(s.id) || inFlight.has(s.id) || nowMs - Date.parse(s.createdAt) < LOOKUP_AFTER_MS) continue;
      try {
        await recover(s);
      } catch (err) {
        log.error(`send s${s.id} could not be looked up: ${reasonOf(err)}`);
      }
    }
    await wake();
  };

  return {
    perform,
    tick,
    wake,
    stop: () => {
      stopped = true;
    },
    threads,
    show: (threadId) => deps.t3.show(threadId),
    listed: (project, threadId) => listedThreads.get(key(project))?.has(threadId) ?? false,
  };
}
