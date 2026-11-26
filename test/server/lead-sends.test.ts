import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { startTitle } from '../../src/core/lead-start';
import { buildApp } from '../../src/server/app';
import { openDb } from '../../src/server/db/connection';
import { createCtx, write, type Ctx } from '../../src/server/db/tx';
import { listLeadEvents } from '../../src/server/lead';
import { leadAllow, leadIntent } from '../../src/server/lead-commands';
import { leadRelay, RELAY_UNKNOWN } from '../../src/server/lead-relay';
import { START_UNDER_WAY, START_UNKNOWN, leadStart, ownStartsToday } from '../../src/server/lead-start';
import { applyVerdict } from '../../src/server/lead/apply';
import { deskUserMessage } from '../../src/server/lead/prompt';
import { createSender, markedTitle, sendMarker, TITLE_MAX, type Sender, type SenderT3 } from '../../src/server/lead/sends';
import { createLeadToolsServer } from '../../src/server/lead/tools';
import { raiseAsk } from '../../src/server/repo/asks';
import { askOf, bringNext } from '../../src/server/repo/deskBring';
import { produceDeskItem } from '../../src/server/repo/deskProducers';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
import { getDeskItem, moveDeskItem, type DeskItem } from '../../src/server/repo/desk';
import { getSend, intendSend, markTrying, moveSend, sendByRetryKey } from '../../src/server/repo/leadSends';
import type { LeadTurn } from '../../src/server/repo/leadTurns';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { claimStep, handleHookEvent } from '../../src/server/session-flow';
import { T3ArgumentRefused, t3Start } from '../../src/server/t3';
import { StandInT3 } from '../t3-stub';

const BOUND = 'C:/personal/InGame';
const V = LEAD_INSTRUCTIONS_VERSION;
const WORDS = 'yes, start it';
const MINUTE = 60 * 1000;

/** A project led by Progresser with a folder, an intent record and four ready steps; a clock the test moves; a stand-in T3. */
function setup() {
  let t = Date.parse('2026-11-25T12:00:00.000Z');
  const ctx: Ctx = createCtx(openDb(':memory:'), () => new Date(t).toISOString());
  const advance = (ms: number) => {
    t += ms;
  };
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, BOUND);
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  leadIntent(ctx, project.slug, 'Progresser', V, { intent: '## Goal\nShip the game.\n\n## Phase\nStore release.\n' });
  const ready = (title: string) => ({ title, what: `Do ${title}.`, why: `Because ${title}.` });
  const steps = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [ready('Signing'), ready('Privacy'), ready('Dark mode'), ready('Sound')] });
  const t3 = new StandInT3(() => ctx.now());
  const log = { info: () => undefined, error: () => undefined };
  /** A sender over the stand-in: a new one is a server restart. */
  const sender = (): Sender => createSender(ctx, { t3 }, { log });
  /** A start send written as leadStart writes one, for step `i`. */
  const intendStart = (i = 0): number =>
    write(ctx, 'test', () =>
      intendSend(ctx.db, { projectId: project.id, kind: 'start', target: BOUND, body: JSON.stringify({ message: `Start step ${steps[i].id}`, title: startTitle(steps[i].id, steps[i].title), nodeId: steps[i].id }) }, ctx.now()),
    ).id;
  const items = (): DeskItem[] =>
    (ctx.db.prepare("SELECT id FROM desk_items WHERE kind = 'unknown_send' ORDER BY id").pluck().all() as number[]).map((id) => getDeskItem(ctx.db, id)!);
  /** The lead's verdict on a desk item, applied as the runner applies one. */
  const verdict = (item: DeskItem, answer: string, s: Sender, head = 'DECIDE') =>
    write(ctx, 'lead:Progresser', (record) =>
      applyVerdict(ctx, { id: 0, verdict: head, kind: head === 'DECIDE' ? 'TECHNICAL' : 'TASTE', answer, why: 'read the thread' } as LeadTurn, item, record, s),
    { immediate: true });
  const start = (s: Sender, i = 0, aidenWords: string | undefined = WORDS) =>
    leadStart(ctx, project.slug, 'Progresser', V, { stepId: steps[i].id, ...(aidenWords === undefined ? {} : { aidenWords }) }, s);
  return { ctx, advance, project, steps, t3, sender, intendStart, items, verdict, start };
}

/** Lets a perform that was not awaited reach T3 Code. */
const settle = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("P2's six cases, against the stand-in T3 Code", () => {
  it('A: the process dies after the start reached T3 Code; the next process finds it by its marker, and starts nothing', async () => {
    const s = setup();
    const first = s.sender();
    const id = s.intendStart();
    s.t3.nextStart = 'hang';
    void first.perform(id);
    await settle();
    first.stop();
    // The restart: a new sender looks the send up, never sends it again.
    const second = s.sender();
    expect(await second.perform(id)).toMatchObject({ state: 'lookup' });
    await second.tick();
    expect(getSend(s.ctx.db, id)?.state).toBe('intended');
    s.advance(MINUTE + 1000);
    await second.tick();
    expect(s.t3.stats()).toEqual({ threads: 1, messages: 1 });
    expect(s.t3.starts).toBe(1);
    expect(getSend(s.ctx.db, id)).toMatchObject({ state: 'done', result: 'th_1' });
    expect(listLeadEvents(s.ctx, s.project.slug).filter((e) => e.kind === 'start').map((e) => [e.text, e.nodeId])).toEqual([['th_1', s.steps[0].id]]);
    expect(s.items()).toHaveLength(0);
  });

  it('F: recovery run twice more after A changes nothing', async () => {
    const s = setup();
    const first = s.sender();
    const id = s.intendStart();
    s.t3.nextStart = 'hang';
    void first.perform(id);
    await settle();
    first.stop();
    const second = s.sender();
    s.advance(MINUTE + 1000);
    await second.tick();
    for (let i = 0; i < 2; i++) {
      s.advance(MINUTE + 1000);
      await second.tick();
      await s.sender().tick();
    }
    expect(s.t3.stats()).toEqual({ threads: 1, messages: 1 });
    expect(s.t3.starts).toBe(1);
    expect(getSend(s.ctx.db, id)?.state).toBe('done');
  });

  it('B: the process dies before the start; two looks a minute apart find nothing, the lead says NOT FOUND, and the step starts once', async () => {
    const s = setup();
    const id = s.intendStart();
    // It died after marking the send as tried and before the start reached T3 Code.
    write(s.ctx, 'test', () => markTrying(s.ctx.db, id, true));
    const after = s.sender();
    s.advance(MINUTE + 1000);
    await after.tick();
    // A second look less than a minute after the first does not count.
    s.advance(30 * 1000);
    await after.tick();
    expect(getSend(s.ctx.db, id)?.state).toBe('intended');
    s.advance(31 * 1000);
    await after.tick();
    expect(getSend(s.ctx.db, id)?.state).toBe('unknown');
    s.advance(MINUTE + 1000);
    await after.tick();
    const items = s.items();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ref: String(id), nodeId: s.steps[0].id, state: 'open' });
    expect(s.t3.starts).toBe(0);
    // While unknown the step holds its claim, with no time limit: it cannot be started again.
    s.advance(60 * MINUTE);
    await expect(s.start(after)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('is on the desk to be cleared') });
    expect(s.verdict(items[0], 'NOT FOUND', after)).toEqual({ itemState: 'done', outcome: 'NOT FOUND' });
    expect(getSend(s.ctx.db, id)?.state).toBe('cleared');
    await expect(s.start(after)).resolves.toMatchObject({ threadId: 'th_1' });
    expect(s.t3.stats()).toEqual({ threads: 1, messages: 1 });
  });

  it('C: the start reached T3 Code with no first message and its answer was lost; the lead says FIRST, and it ends as one session with one first message', async () => {
    const s = setup();
    const sender = s.sender();
    const id = s.intendStart();
    s.t3.nextStart = 'lost-bare';
    expect(await sender.perform(id)).toMatchObject({ state: 'lookup' });
    // T3 Code goes down: the looks wait and do not count.
    s.t3.down = true;
    for (let i = 0; i < 3; i++) {
      s.advance(MINUTE + 1000);
      await sender.tick();
    }
    expect(getSend(s.ctx.db, id)?.state).toBe('intended');
    expect(s.items()).toHaveLength(0);
    s.t3.down = false;
    s.advance(MINUTE + 1000);
    await sender.tick();
    s.advance(MINUTE + 1000);
    await sender.tick();
    expect(getSend(s.ctx.db, id)?.state).toBe('unknown');
    const [item] = s.items();
    const message = deskUserMessage(s.ctx, item);
    expect(message).toContain(`The send s${id}: a start`);
    expect(message).toContain(sendMarker(id));
    expect(message).toContain(`Start step ${s.steps[0].id}`);
    expect(message).toContain('FIRST <thread id>');
    // A thread that T3 Code's list did not show is unclear, and Aiden's.
    expect(s.verdict(item, 'FIRST th_9', sender)).toMatchObject({ itemState: 'waiting_aiden', outcome: expect.stringMatching(/^unclear/) });
    expect(getSend(s.ctx.db, id)?.state).toBe('unknown');
    // The lead's threads read, then FIRST.
    expect((await sender.threads(BOUND)).map((t) => t.threadId)).toEqual(['th_1']);
    expect(s.verdict(item, 'FIRST th_1', sender)).toEqual({ itemState: 'done', outcome: 'FIRST th_1' });
    expect(getSend(s.ctx.db, id)).toMatchObject({ state: 'done', result: 'th_1' });
    await sender.wake();
    for (let i = 0; i < 2; i++) {
      s.advance(MINUTE + 1000);
      await sender.tick();
      await s.sender().tick();
    }
    expect(s.t3.stats()).toEqual({ threads: 1, messages: 1 });
    expect(s.t3.starts).toBe(1);
    const [only] = s.t3.threads[0].messages;
    expect(only.text).toBe(`Start step ${s.steps[0].id}\n${sendMarker(id + 1)}`);
    expect(getSend(s.ctx.db, id + 1)).toMatchObject({ kind: 'relay', state: 'done', target: 'th_1' });
  });

  it('D: the same send performed twice at once is sent once, and two starts of one step at once start once', async () => {
    const s = setup();
    const sender = s.sender();
    const id = s.intendStart();
    const [a, b] = await Promise.all([sender.perform(id), sender.perform(id)]);
    expect(a).toEqual({ state: 'done', result: 'th_1' });
    expect(b).toEqual(a);
    expect(await sender.perform(id)).toEqual({ state: 'gone' });
    const [x, y] = await Promise.allSettled([s.start(sender, 1), s.start(sender, 1)]);
    expect(x).toMatchObject({ status: 'fulfilled' });
    expect(y).toMatchObject({ status: 'rejected', reason: { status: 409, message: START_UNDER_WAY } });
    expect(s.t3.starts).toBe(2);
  });

  it('E: the last free place, taken by two starts at once, is taken once', async () => {
    const s = setup();
    const sender = s.sender();
    await s.start(sender, 0);
    await s.start(sender, 1);
    const results = await Promise.allSettled([s.start(sender, 2), s.start(sender, 3)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(s.t3.starts).toBe(3);
    // The place is taken: a later start finds no room.
    await expect(s.start(sender, 3)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('the limit is 3') });
  });
});

describe('the sender', () => {
  it('waits without counting while T3 Code refuses a start, then sends it at the next tick', async () => {
    const s = setup();
    const sender = s.sender();
    const id = s.intendStart();
    s.t3.down = true;
    expect(await sender.perform(id)).toMatchObject({ state: 'waiting' });
    s.advance(5 * MINUTE);
    await sender.tick();
    expect(getSend(s.ctx.db, id)?.state).toBe('intended');
    s.t3.down = false;
    await sender.tick();
    expect(getSend(s.ctx.db, id)).toMatchObject({ state: 'done', result: 'th_1' });
    expect(s.t3.starts).toBe(1);
  });

  it('a message whose answer was lost is found by its text in the thread, not sent again', async () => {
    const s = setup();
    const sender = s.sender();
    const started = await sender.perform(s.intendStart());
    expect(started).toMatchObject({ state: 'done' });
    const id = write(s.ctx, 'test', () => intendSend(s.ctx.db, { projectId: s.project.id, kind: 'relay', target: 'th_1', body: 'carry on' }, s.ctx.now())).id;
    s.t3.nextSend = 'lost';
    expect(await sender.perform(id)).toMatchObject({ state: 'lookup' });
    s.advance(MINUTE + 1000);
    await sender.tick();
    expect(getSend(s.ctx.db, id)).toMatchObject({ state: 'done', result: 'th_1' });
    expect(s.t3.sends).toBe(1);
  });

  it('wake sends oldest first, one at a time per target, and a send that waits holds the ones after it', async () => {
    const s = setup();
    const sender = s.sender();
    await sender.perform(s.intendStart());
    const body = (text: string) => write(s.ctx, 'test', () => intendSend(s.ctx.db, { projectId: s.project.id, kind: 'relay', target: 'th_1', body: text }, s.ctx.now())).id;
    body('one');
    body('two');
    await sender.wake();
    expect(s.t3.threads[0].messages.slice(1).map((m) => m.text)).toEqual(['one', 'two']);
    s.t3.down = true;
    const three = body('three');
    const four = body('four');
    await sender.wake();
    s.t3.down = false;
    expect(getSend(s.ctx.db, four)?.state).toBe('intended');
    await sender.wake();
    expect(s.t3.threads[0].messages.slice(1).map((m) => m.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(getSend(s.ctx.db, three)?.state).toBe('done');
  });

  it('a voice line waits until there is a webhook', async () => {
    const s = setup();
    const sender = s.sender();
    const id = write(s.ctx, 'test', () => intendSend(s.ctx.db, { projectId: s.project.id, kind: 'voice_line', target: 'webhook', body: 'hello' }, s.ctx.now())).id;
    expect(await sender.perform(id)).toMatchObject({ state: 'waiting' });
    const voiced = createSender(s.ctx, { t3: s.t3, webhook: async () => 'v1' }, { log: { info: () => undefined, error: () => undefined } });
    // It was never tried (nothing reached anyone), so a new sender simply sends it.
    expect(getSend(s.ctx.db, id)?.result).toBeNull();
    expect(await voiced.perform(id)).toEqual({ state: 'done', result: 'v1' });
  });

  it('FOUND records the start; AIDEN waits on Aiden with what is known', async () => {
    const s = setup();
    const sender = s.sender();
    const id = s.intendStart();
    s.t3.nextStart = 'lost-bare';
    await sender.perform(id);
    s.advance(MINUTE + 1000);
    await sender.tick();
    s.advance(MINUTE + 1000);
    await sender.tick();
    const [item] = s.items();
    expect(s.verdict(item, 'whatever', sender, 'AIDEN')).toEqual({ itemState: 'waiting_aiden', outcome: expect.stringContaining(`AIDEN (s${id}: a start to ${BOUND}`) });
    await sender.threads(BOUND);
    expect(s.verdict(item, 'FOUND th_1', sender)).toEqual({ itemState: 'done', outcome: 'FOUND th_1' });
    expect(listLeadEvents(s.ctx, s.project.slug).filter((e) => e.kind === 'start').map((e) => e.text)).toEqual(['th_1']);
    expect(s.t3.stats()).toEqual({ threads: 1, messages: 0 });
  });
});

describe("the lead's T3 Code reads", () => {
  it('threads lists the project threads newest first with whether each holds a message; thread shows one; T3 Code down is a 502', async () => {
    const s = setup();
    const sender = s.sender();
    await sender.perform(s.intendStart(0));
    s.advance(1000);
    s.t3.nextStart = 'lost-bare';
    await sender.perform(s.intendStart(1));
    const app = buildApp({ ctx: s.ctx, token: 't', uiToken: 'u', version: 'test', sender });
    const q = `as=Progresser&instructions=${V}`;
    const list = await app.inject({ method: 'GET', url: `/api/lead/${s.project.slug}/threads?${q}` });
    expect(list.statusCode).toBe(200);
    const lines = (list.json() as { text: string }).text.split('\n');
    expect(lines[0]).toMatch(/^th_2 {2}"" {2}updated .* has no message$/);
    expect(lines[1]).toMatch(/^th_1 {2}".*\[s1\]" {2}updated .* has a first message$/);
    expect(sender.listed(BOUND, 'th_2')).toBe(true);
    const one = await app.inject({ method: 'GET', url: `/api/lead/${s.project.slug}/thread/th_1?${q}` });
    expect((one.json() as { text: string }).text).toContain(`user: Start step ${s.steps[0].id}`);
    s.t3.down = true;
    const down = await app.inject({ method: 'GET', url: `/api/lead/${s.project.slug}/threads?${q}` });
    expect(down.statusCode).toBe(502);
    await app.close();
  });
});

describe('the title marker', () => {
  it('survives a title of 120 code points and more, through t3Start', async () => {
    const long = '\u{1F680}'.repeat(50) + 'x'.repeat(200);
    const title = markedTitle(long, 4321);
    expect(Array.from(title)).toHaveLength(TITLE_MAX);
    expect(title.endsWith(` ${sendMarker(4321)}`)).toBe(true);
    let args: string[] = [];
    await t3Start('C:/p', 'go', { title }, { cliPath: 't3', platform: 'linux', run: async (_f, a) => ((args = a), '{"threadId":"x"}') });
    expect(args[args.indexOf('--title') + 1]).toBe(title);
    expect(markedTitle('short', 7)).toBe('short [s7]');
  });
});

describe('lead start and lead relay through the sender', () => {
  it('a start whose answer T3 Code lost leaves no second start, and recovery finds it', async () => {
    const s = setup();
    const sender = s.sender();
    s.t3.nextStart = 'lost';
    await expect(s.start(sender)).rejects.toMatchObject({ status: 502, message: START_UNKNOWN });
    await expect(s.start(sender)).rejects.toMatchObject({ status: 409 });
    s.advance(MINUTE + 1000);
    await sender.tick();
    expect(s.t3.starts).toBe(1);
    expect(s.ctx.db.prepare("SELECT state, result FROM lead_sends WHERE kind = 'start'").all()).toEqual([{ state: 'done', result: 'th_1' }]);
  });

  it('a relay whose answer T3 Code lost is not sent again, and recovery finds it', async () => {
    const s = setup();
    const sender = s.sender();
    const { threadId } = await s.start(sender);
    handleHookEvent(s.ctx, 's1', { event: 'start', source: 'startup', cwd: BOUND, app: 't3', t3ThreadId: threadId });
    claimStep(s.ctx, 'session:s1', 's1', s.steps[0].id);
    s.t3.nextSend = 'lost';
    await expect(leadRelay(s.ctx, s.project.slug, 'Progresser', V, { stepId: s.steps[0].id, message: 'Ship it?' }, sender)).rejects.toMatchObject({ status: 502, message: RELAY_UNKNOWN });
    s.advance(MINUTE + 1000);
    await sender.tick();
    expect(s.t3.sends).toBe(1);
    expect(s.ctx.db.prepare("SELECT state FROM lead_sends WHERE kind = 'relay'").pluck().all()).toEqual(['done']);
  });
});

describe('the fix round after Murr on task 8', () => {
  const quiet = { info: () => undefined, error: () => undefined };
  /** An intended relay to `thread`, as the apply writes one. */
  const intendRelay = (s: ReturnType<typeof setup>, thread: string, body: string, retryKey?: string) =>
    write(s.ctx, 'test', () => intendSend(s.ctx.db, { projectId: s.project.id, kind: 'relay', target: thread, body, ...(retryKey === undefined ? {} : { retryKey }) }, s.ctx.now())).id;
  /** Two looks a minute apart that find nothing, so the send goes unknown and its item onto the desk. */
  const twoLooks = async (s: ReturnType<typeof setup>, sender: Sender) => {
    for (let i = 0; i < 2; i++) {
      s.advance(MINUTE + 1000);
      await sender.tick();
    }
  };
  const lostStart = async (s: ReturnType<typeof setup>, sender: Sender, i = 0) => {
    const id = s.intendStart(i);
    s.t3.nextStart = 'lost-bare';
    await sender.perform(id);
    await twoLooks(s, sender);
    return id;
  };

  it('S1: an unknown_send item whose send id equals an open ask id brings nothing, and keeps its outcome', () => {
    const s = setup();
    leadAllow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
    const ask = raiseAsk(s.ctx, 'scribe:s1', { nodeId: s.steps[0].id, kind: 'question', text: 'Which one?' });
    const sendId = s.intendStart();
    expect(sendId).toBe(ask.id);
    const item = write(s.ctx, 'test', () => {
      const made = produceDeskItem(s.ctx.db, { projectId: s.project.id, kind: 'unknown_send', ref: String(sendId), nodeId: s.steps[0].id }, s.ctx.now()).item;
      moveDeskItem(s.ctx.db, made.id, ['open'], 'waiting_aiden', { outcome: 'AIDEN (s1)', now: s.ctx.now() });
      return made;
    });
    expect(askOf(s.ctx, getDeskItem(s.ctx.db, item.id)!)).toBeUndefined();
    expect(askOf(s.ctx, { ...getDeskItem(s.ctx.db, item.id)!, kind: 'question' })).toMatchObject({ id: ask.id });
    expect(write(s.ctx, 'test', () => bringNext(s.ctx, s.project.id))).toEqual([]);
    expect(getDeskItem(s.ctx.db, item.id)).toMatchObject({ state: 'waiting_aiden', outcome: 'AIDEN (s1)' });
  });

  it('S2: threads lists at most the 20 newest, opens at most the 5 newest, and says how many were not opened', async () => {
    const s = setup();
    for (let i = 0; i < 25; i++) {
      s.t3.threads.push({ threadId: `t${i}`, project: BOUND, title: `T${i}`, messages: [], updatedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() });
    }
    const sender = s.sender();
    const shown = vi.spyOn(s.t3, 'show');
    const app = buildApp({ ctx: s.ctx, token: 't', uiToken: 'u', version: 'test', sender });
    const text = (await app.inject({ method: 'GET', url: `/api/lead/${s.project.slug}/threads?as=Progresser&instructions=${V}` })).json().text as string;
    const lines = text.split('\n');
    expect(lines.filter((l) => /^t\d+ /.test(l))).toHaveLength(20);
    expect(lines[0]).toMatch(/^t24 /);
    expect(shown).toHaveBeenCalledTimes(5);
    expect(text).toContain('15 of these were not opened');
    expect(text).toContain('5 older threads are not listed');
    await app.close();
  });

  it('S2: the threads and thread tools wait two minutes for their answer', async () => {
    const seen: unknown[] = [];
    const client = { get: async (_path: string, co?: unknown) => (seen.push(co), { text: 'ok' }) } as unknown as Parameters<typeof createLeadToolsServer>[0]['client'];
    const server = createLeadToolsServer({ slug: 'ingame', client, as: 'Progresser', instructions: V });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(clientSide);
    await c.callTool({ name: 'threads', arguments: {} });
    await c.callTool({ name: 'thread', arguments: { id: 'th_1' } });
    expect(seen).toEqual([{ timeoutMs: 120000 }, { timeoutMs: 120000 }]);
    await c.close();
  });

  it("S3: FOUND or FIRST is unclear when the step has a newer start, a live session, or the thread is another start's", async () => {
    const s = setup();
    const sender = s.sender();
    const id = await lostStart(s, sender);
    const [item] = s.items();
    await sender.threads(BOUND);
    // A newer start of the step, not cleared.
    const newer = s.intendStart();
    expect(s.verdict(item, 'FIRST th_1', sender)).toMatchObject({ itemState: 'waiting_aiden', outcome: expect.stringContaining(`newer start, s${newer}`) });
    write(s.ctx, 'test', () => moveSend(s.ctx.db, newer, ['intended'], 'cleared', { now: s.ctx.now() }));
    // A live session on the step.
    handleHookEvent(s.ctx, 'other', { event: 'start', source: 'startup', cwd: BOUND });
    claimStep(s.ctx, 'session:other', 'other', s.steps[0].id);
    expect(s.verdict(item, 'FIRST th_1', sender)).toMatchObject({ itemState: 'waiting_aiden', outcome: expect.stringContaining('a live session works on the step') });
    s.ctx.db.prepare("UPDATE sessions SET state = 'ended' WHERE id = 'other'").run();
    // The thread is already another start's.
    const otherStep = s.intendStart(1);
    s.ctx.db.prepare("UPDATE lead_sends SET result = 'th_1', state = 'done' WHERE id = ?").run(otherStep);
    expect(s.verdict(item, 'FOUND th_1', sender)).toMatchObject({ itemState: 'waiting_aiden', outcome: expect.stringContaining(`already s${otherStep}'s`) });
    expect(getSend(s.ctx.db, id)?.state).toBe('unknown');
  });

  it('S4 and S5: a refused argument clears the send and holds nothing; any other TypeError may have been sent', async () => {
    const s = setup();
    const refusing: SenderT3 = {
      list: (p) => s.t3.list(p),
      show: (t) => s.t3.show(t),
      start: (p, m, o) => s.t3.start(p, m, o),
      send: async () => {
        throw new T3ArgumentRefused('threadId holds a character that cannot go on the t3 command line');
      },
    };
    const sender = createSender(s.ctx, { t3: refusing }, { log: quiet });
    const bad = intendRelay(s, BOUND, 'one');
    const behind = s.intendStart();
    await sender.wake();
    expect(getSend(s.ctx.db, bad)?.state).toBe('cleared');
    expect(getSend(s.ctx.db, behind)?.state).toBe('done');
    const typeErr = createSender(
      s.ctx,
      {
        t3: {
          ...refusing,
          send: async () => {
            throw new TypeError('fetch failed');
          },
        },
      },
      { log: quiet },
    );
    const id = intendRelay(s, 'th_1', 'two');
    expect(await typeErr.perform(id, { clearIfNotSent: true })).toMatchObject({ state: 'lookup' });
    expect(getSend(s.ctx.db, id)).toMatchObject({ state: 'intended', result: 'trying' });
  });

  it('S5: a start whose body cannot be read is cleared, with one log line', async () => {
    const s = setup();
    const errors: string[] = [];
    const sender = createSender(s.ctx, { t3: s.t3 }, { log: { info: () => undefined, error: (m) => void errors.push(m) } });
    const id = write(s.ctx, 'test', () => intendSend(s.ctx.db, { projectId: s.project.id, kind: 'start', target: BOUND, body: 'not json' }, s.ctx.now())).id;
    await sender.wake();
    await sender.tick();
    expect(getSend(s.ctx.db, id)?.state).toBe('cleared');
    expect(errors).toHaveLength(1);
    expect(s.t3.starts).toBe(0);
  });

  it('S6: a show that fails while the list answers counts as not found; with T3 Code down it waits', async () => {
    const s = setup();
    const sender = s.sender();
    const id = intendRelay(s, 'th_gone', 'hello');
    write(s.ctx, 'test', () => markTrying(s.ctx.db, id, true));
    s.t3.down = true;
    for (let i = 0; i < 3; i++) {
      s.advance(MINUTE + 1000);
      await sender.tick();
    }
    expect(getSend(s.ctx.db, id)?.state).toBe('intended');
    s.t3.down = false;
    await twoLooks(s, sender);
    expect(getSend(s.ctx.db, id)?.state).toBe('unknown');
  });

  it('S7: a message is found only at or after its send was written; an earlier one with the same text is not it', async () => {
    const s = setup();
    const sender = s.sender();
    await sender.perform(s.intendStart());
    s.t3.threads[0].messages.push({ role: 'user', text: 'same words', createdAt: s.ctx.now() });
    s.advance(1000);
    const id = intendRelay(s, 'th_1', 'same words');
    write(s.ctx, 'test', () => markTrying(s.ctx.db, id, true));
    await twoLooks(s, sender);
    expect(getSend(s.ctx.db, id)?.state).toBe('unknown');
    // With no time from T3 Code, the text alone finds it.
    const id2 = intendRelay(s, 'th_1', 'timeless');
    write(s.ctx, 'test', () => markTrying(s.ctx.db, id2, true));
    s.t3.threads[0].messages.push({ role: 'user', text: 'timeless' });
    s.advance(MINUTE + 1000);
    await sender.tick();
    expect(getSend(s.ctx.db, id2)).toMatchObject({ state: 'done', result: 'th_1' });
  });

  it("S8: NOT FOUND on a relay sends it once more under <key>:again and logs send_cleared; a second NOT FOUND is Aiden's", async () => {
    const s = setup();
    const sender = s.sender();
    await sender.perform(s.intendStart());
    const id = intendRelay(s, 'th_1', 'carry on', 'relay:d7');
    s.t3.nextSend = 'lost';
    await sender.perform(id);
    s.t3.threads[0].messages.pop();
    await twoLooks(s, sender);
    const [item] = s.items();
    const message = deskUserMessage(s.ctx, item);
    expect(message).toContain('DELIVERED th_1');
    expect(message).not.toContain('FIRST <thread id>');
    expect(s.verdict(item, 'NOT FOUND', sender)).toMatchObject({ itemState: 'done', outcome: expect.stringMatching(/^NOT FOUND, sent again as s\d+$/) });
    expect(getSend(s.ctx.db, id)?.state).toBe('cleared');
    const again = sendByRetryKey(s.ctx.db, 'relay:d7:again')!;
    expect(again).toMatchObject({ state: 'intended', target: 'th_1', body: 'carry on', kind: 'relay' });
    expect(s.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'send_cleared'").pluck().all()).toEqual([`s${id}: NOT FOUND, sent again as s${again.id}`]);
    // It goes, its answer is lost again, and it is not found again: Aiden's.
    s.t3.nextSend = 'lost';
    await sender.perform(again.id);
    s.t3.threads[0].messages.pop();
    await twoLooks(s, sender);
    const second = s.items().find((i) => i.ref === String(again.id))!;
    expect(s.verdict(second, 'NOT FOUND', sender)).toMatchObject({ itemState: 'waiting_aiden', outcome: expect.stringMatching(/^NOT FOUND again/) });
    expect(getSend(s.ctx.db, again.id)?.state).toBe('unknown');
    // DELIVERED names its own thread.
    expect(s.verdict(second, 'DELIVERED th_9', sender)).toMatchObject({ itemState: 'waiting_aiden' });
    expect(s.verdict(second, 'DELIVERED th_1', sender)).toEqual({ itemState: 'done', outcome: 'DELIVERED th_1' });
  });

  it('S9: start lines written before the sends still hold the step and count toward the day', async () => {
    const s = setup();
    const sender = s.sender();
    write(s.ctx, 'test', () => insertLeadEvent(s.ctx.db, { projectId: s.project.id, lead: 'Progresser', instructions: V, kind: 'start_unknown', nodeId: s.steps[0].id, text: 'timed out' }, s.ctx.now()));
    write(s.ctx, 'test', () => insertLeadEvent(s.ctx.db, { projectId: s.project.id, lead: 'Progresser', instructions: V, kind: 'start', nodeId: s.steps[1].id, text: 'th_old' }, s.ctx.now()));
    s.advance(MINUTE);
    await expect(s.start(sender, 0)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('A thread was started for #') });
    await expect(s.start(sender, 1)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('A thread was started for #') });
    expect(ownStartsToday(s.ctx, s.project.id, Date.parse(s.ctx.now()))).toBe(2);
    expect(s.t3.starts).toBe(0);
  });

  it('S10: a start asked while the sender is stopping is cleared', async () => {
    const s = setup();
    const sender = s.sender();
    sender.stop();
    await expect(s.start(sender)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Not started') });
    expect(s.ctx.db.prepare("SELECT state FROM lead_sends WHERE kind = 'start'").pluck().all()).toEqual(['cleared']);
  });

  it('S11: a thread with the marker that has not moved since before the send was written is not it', async () => {
    const s = setup();
    const sender = s.sender();
    const id = s.intendStart();
    write(s.ctx, 'test', () => markTrying(s.ctx.db, id, true));
    s.t3.threads.push({ threadId: 'th_old', project: BOUND, title: `Old ${sendMarker(id)}`, messages: [], updatedAt: '2026-01-01T00:00:00.000Z' });
    await twoLooks(s, sender);
    expect(getSend(s.ctx.db, id)?.state).toBe('unknown');
  });

  it("S12: thread answers 404 for a thread the project's last threads read did not list", async () => {
    const s = setup();
    const sender = s.sender();
    await sender.perform(s.intendStart());
    s.t3.threads.push({ threadId: 'th_x', project: 'C:/elsewhere', title: 'Not ours', messages: [], updatedAt: s.ctx.now() });
    const app = buildApp({ ctx: s.ctx, token: 't', uiToken: 'u', version: 'test', sender });
    const q = `as=Progresser&instructions=${V}`;
    expect((await app.inject({ method: 'GET', url: `/api/lead/${s.project.slug}/thread/th_1?${q}` })).statusCode).toBe(404);
    await app.inject({ method: 'GET', url: `/api/lead/${s.project.slug}/threads?${q}` });
    expect((await app.inject({ method: 'GET', url: `/api/lead/${s.project.slug}/thread/th_1?${q}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/lead/${s.project.slug}/thread/th_x?${q}` })).statusCode).toBe(404);
    await app.close();
  });

  it('S13: after a restart a send never tried is simply sent, and one marked trying is only looked up', async () => {
    const s = setup();
    const never = s.intendStart(0);
    const tried = s.intendStart(1);
    write(s.ctx, 'test', () => markTrying(s.ctx.db, tried, true));
    const sender = s.sender();
    expect(await sender.perform(never)).toMatchObject({ state: 'done' });
    expect(await sender.perform(tried)).toMatchObject({ state: 'lookup' });
    expect(s.t3.starts).toBe(1);
  });

  it('S14: lead start wakes the sender after its commit, so a send waiting behind it goes', async () => {
    const s = setup();
    const sender = s.sender();
    await sender.perform(s.intendStart(1));
    s.advance(1000);
    const waiting = intendRelay(s, 'th_1', 'waiting');
    await s.start(sender, 0);
    await vi.waitFor(() => expect(getSend(s.ctx.db, waiting)?.state).toBe('done'));
  });
});

describe('the day thread start (Y8)', () => {
  it('is not counted in ownStartsToday: it starts no step', () => {
    const s = setup();
    write(s.ctx, 'test', () => intendSend(s.ctx.db, { projectId: s.project.id, kind: 'start', target: BOUND, retryKey: `morning-thread:${s.project.id}:2026-11-25`, body: JSON.stringify({ message: 'm', title: 't' }) }, s.ctx.now()));
    expect(ownStartsToday(s.ctx, s.project.id, Date.parse(s.ctx.now()))).toBe(0);
    s.intendStart();
    expect(ownStartsToday(s.ctx, s.project.id, Date.parse(s.ctx.now()))).toBe(1);
  });
});
