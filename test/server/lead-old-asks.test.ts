import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { buildApp } from '../../src/server/app';
import { openDb } from '../../src/server/db/connection';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { DECIDE_QUESTION_ONLY, leadAllow, leadUndo, WORK_PROJECT } from '../../src/server/lead-commands';
import { applyVerdict } from '../../src/server/lead/apply';
import { write as dbWrite } from '../../src/server/db/tx';
import { bringItem } from '../../src/server/repo/deskBring';
import { produceDeskItem } from '../../src/server/repo/deskProducers';
import { getSend, markTrying } from '../../src/server/repo/leadSends';
import { leadOldAskReading, leadOldAsks, leadOldAsksAll, leadOldAsksNext, leadsNoProject, NO_OLD_ASKS, oldReading, OLD_ASKS_WITH_AIDEN } from '../../src/server/lead/oldAsks';
import { createRunner, type TurnInput, type TurnOutput, type TurnWay } from '../../src/server/lead/runner';
import { createSender, type SenderT3 } from '../../src/server/lead/sends';
import { OLD_ASKS_DONE_LINE, voiceReadiness } from '../../src/server/lead/voice';
import { handleHookEvent } from '../../src/server/session-flow';
import { clearAsk, raiseAsk, requireAsk } from '../../src/server/repo/asks';
import { addDeskItem, getDeskItem, type DeskItem } from '../../src/server/repo/desk';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';

const V = LEAD_INSTRUCTIONS_VERSION;
const DAY = 24 * 60 * 60 * 1000;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * A clock the test moves (each read one second on), InProgress led by Progresser, Glimpse and Notes with no lead, and
 * Payroll under C:\work. Each has one step.
 */
function world() {
  let t = Date.parse('2026-11-25T09:00:00.000Z');
  const clock = () => new Date((t += 1000)).toISOString();
  const ctx = createCtx(openDb(':memory:'), clock);
  cleanups.push(() => void ctx.db.close());
  const make = (name: string, folder: string, title: string) => {
    const project = createProject(ctx, 'test', { name });
    addBinding(ctx, 'test', project.slug, folder);
    const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title }] });
    return { project, step: step! };
  };
  const ip = make('InProgress', 'C:/personal/InProgress', 'The desk');
  setProjectLead(ctx, 'window', ip.project.slug, 'Progresser');
  const glimpse = make('Glimpse', 'C:/personal/Glimpse', 'Login screen review');
  const notes = make('Notes', 'C:/personal/Notes', 'Sync');
  const work = make('Payroll', 'C:/work/Payroll', 'Export');
  /** An ask of Aiden's on the step, raised `daysAgo` days before the clock's start (in raise order when equal). */
  const ask = (on: { step: { id: number } }, text: string, daysAgo = 0) => {
    const a = raiseAsk(ctx, 'test', { nodeId: on.step.id, kind: 'question', text });
    if (daysAgo > 0) ctx.db.prepare('UPDATE asks SET raised_at = ? WHERE id = ?').run(new Date(Date.parse('2026-11-25T09:00:00.000Z') - daysAgo * DAY - a.id * 1000).toISOString(), a.id);
    return a;
  };
  const item = (askId: number) => ctx.db.prepare("SELECT * FROM desk_items WHERE kind = 'old_ask' AND ref = ?").all(String(askId)) as { id: number; state: string; node_id: number; project_id: number }[];
  const lines = () => ctx.db.prepare("SELECT id, project_id AS projectId, item_id AS itemId, retry_key AS retryKey, body FROM lead_sends WHERE kind = 'voice_line' ORDER BY id").all() as { id: number; projectId: number; itemId: number | null; retryKey: string; body: string }[];
  return { ctx, ip, glimpse, notes, work, ask, item, lines, tick: (ms: number) => void (t += ms) };
}

/** The app, with a sender whose T3 Code records nothing: no test reaches the real t3 CLI. */
function appOf(ctx: Ctx) {
  const fakeT3: SenderT3 = { list: async () => [], show: async () => ({ thread: {} as never, messages: [] }), start: async () => ({ threadId: 'x' }), send: async () => undefined };
  const sender = createSender(ctx, { t3: fakeT3 }, { log: { info: () => undefined, error: () => undefined } });
  const app = buildApp({ ctx, token: 't', uiToken: 'ui', version: 'test', sender });
  cleanups.push(() => app.close());
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: { authorization: 'Bearer t' }, payload: { as: 'Progresser', instructions: V, ...payload } });
  return { app, post };
}

describe('lead old-asks <project>: the old asks onto the desk', () => {
  it("an ask raised before the round's first switch-on is one item, open in the lead's project with the round on; asks raised after it are not old", () => {
    const w = world();
    const old = w.ask(w.ip, 'Which port?');
    leadAllow(w.ctx, w.ip.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
    const fresh = w.ask(w.ip, 'Which colour?');
    const res = leadOldAsks(w.ctx, w.ip.project.slug, 'Progresser', V);
    expect(res.text).toBe('Put 1 old asks on the desk: 1 for the round, 0 for the Voice.');
    expect(w.item(old.id)).toEqual([expect.objectContaining({ state: 'open', node_id: w.ip.step.id, project_id: w.ip.project.id })]);
    expect(w.item(fresh.id)).toEqual([]);
  });

  it('in a personal project with no lead every open ask (the round never on) waits on Aiden; a cleared ask is left out', () => {
    const w = world();
    const a = w.ask(w.glimpse, 'Login screen review?');
    const b = w.ask(w.glimpse, 'Keep the old logo?');
    const cleared = w.ask(w.glimpse, 'Done already?');
    w.ctx.db.prepare("UPDATE asks SET cleared_at = '2026-11-20T00:00:00.000Z' WHERE id = ?").run(cleared.id);
    expect(leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V).text).toBe('Put 2 old asks on the desk: 0 for the round, 2 for the Voice.');
    expect([a, b].map((x) => w.item(x.id).map((i) => i.state))).toEqual([['waiting_aiden'], ['waiting_aiden']]);
    expect(w.item(cleared.id)).toEqual([]);
  });

  it("in the lead's own project with the round off the item waits on Aiden", () => {
    const w = world();
    const a = w.ask(w.ip, 'Which port?');
    expect(leadOldAsks(w.ctx, w.ip.project.slug, 'Progresser', V).text).toBe('Put 1 old asks on the desk: 0 for the round, 1 for the Voice.');
    expect(w.item(a.id).map((i) => i.state)).toEqual(['waiting_aiden']);
  });

  it('a second run makes no second item, even once the first is done', () => {
    const w = world();
    const a = w.ask(w.glimpse, 'Login screen review?');
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    expect(leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V).text).toBe('Put 0 old asks on the desk: 0 for the round, 0 for the Voice.');
    w.ctx.db.prepare("UPDATE desk_items SET state = 'done' WHERE kind = 'old_ask'").run();
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    expect(w.item(a.id)).toHaveLength(1);
  });

  it('a C:\\work project is refused, through the route too, and nothing is made', async () => {
    const w = world();
    const a = w.ask(w.work, 'Which format?');
    expect(() => leadOldAsks(w.ctx, w.work.project.slug, 'Progresser', V)).toThrow(WORK_PROJECT);
    const { post } = appOf(w.ctx);
    const res = await post(`/api/lead/${w.work.project.slug}/old-asks`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: WORK_PROJECT });
    expect(w.item(a.id)).toEqual([]);
  });

  it('--all puts them on the desk in every personal project this lead may serve, and not in a C:\\work project or one another lead leads', async () => {
    const w = world();
    const g = [w.ask(w.glimpse, 'Login screen review?'), w.ask(w.glimpse, 'Keep the old logo?')];
    const own = w.ask(w.ip, 'Which port?');
    const work = w.ask(w.work, 'Which format?');
    setProjectLead(w.ctx, 'window', w.notes.project.slug, 'Other');
    const other = w.ask(w.notes, 'Sync now?');
    const { post } = appOf(w.ctx);
    const res = await post('/api/lead/old-asks/all', {});
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe(['InProgress: 1 old asks, 0 for the round, 1 for the Voice.', 'Glimpse: 2 old asks, 0 for the round, 2 for the Voice.', 'Put 3 old asks on the desk: 0 for the round, 3 for the Voice.'].join('\n'));
    expect([...g, own].map((a) => w.item(a.id).map((i) => i.state))).toEqual([['waiting_aiden'], ['waiting_aiden'], ['waiting_aiden']]);
    expect(w.item(work.id)).toEqual([]);
    expect(w.item(other.id)).toEqual([]);
    // Once each: a second run puts nothing, and names no project.
    expect(leadOldAsksAll(w.ctx, 'Progresser', V).text).toBe('Put 0 old asks on the desk: 0 for the round, 0 for the Voice.');
  });

  it("--all takes the lead's own project open when its round is on", () => {
    const w = world();
    const own = w.ask(w.ip, 'Which port?');
    leadAllow(w.ctx, w.ip.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
    expect(leadOldAsksAll(w.ctx, 'Progresser', V).text).toBe(['InProgress: 1 old asks, 1 for the round, 0 for the Voice.', 'Put 1 old asks on the desk: 1 for the round, 0 for the Voice.'].join('\n'));
    expect(w.item(own.id).map((i) => i.state)).toEqual(['open']);
  });

  it("a project led by another lead is refused", () => {
    const w = world();
    setProjectLead(w.ctx, 'window', w.notes.project.slug, 'Other');
    w.ask(w.notes, 'Sync now?');
    expect(() => leadOldAsks(w.ctx, w.notes.project.slug, 'Progresser', V)).toThrow(/no lead named Progresser/);
  });
});

describe('lead old-asks next: the old asks waiting on Aiden, to the Voice', () => {
  /** Glimpse with seven old asks, Notes with one between them in age, all on the desk waiting on Aiden. */
  function seven() {
    const w = world();
    const g = [19, 17, 15, 13, 11, 9, 7].map((d, i) => w.ask(w.glimpse, `Glimpse ask ${i + 1}`, d));
    const n = w.ask(w.notes, 'Notes ask', 14);
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    leadOldAsks(w.ctx, w.notes.project.slug, 'Progresser', V);
    return { ...w, g, n };
  }

  it('queues five lines, oldest ask first across projects, with "i of total" for their project and the reading when one is stored', () => {
    const w = seven();
    leadOldAskReading(w.ctx, w.glimpse.project.slug, 'Progresser', V, { askId: w.g[0]!.id, text: 'an older reading' });
    leadOldAskReading(w.ctx, w.glimpse.project.slug, 'Progresser', V, { askId: w.g[0]!.id, text: 'The lead would close it: the step was done and merged on 3 November' });
    const res = leadOldAsksNext(w.ctx, 'Progresser', V);
    expect(res.text).toBe('Queued 5 old asks for the Voice; 3 remain.');
    const lines = w.lines();
    const stepG = `#${w.glimpse.step.id} Login screen review`;
    expect(lines.map((l) => l.body)).toEqual([
      `Glimpse, 1 of 7: ${stepG}, 19 days old.\nThe lead would close it: the step was done and merged on 3 November. Say your answer.`,
      `Glimpse, 2 of 7: ${stepG}, 17 days old.\nSay your answer.`,
      `Glimpse, 3 of 7: ${stepG}, 15 days old.\nSay your answer.`,
      `Notes, 1 of 1: #${w.notes.step.id} Sync, 14 days old.\nSay your answer.`,
      `Glimpse, 4 of 7: ${stepG}, 13 days old.\nSay your answer.`,
    ]);
    const items = [w.g[0], w.g[1], w.g[2], w.n, w.g[3]].map((a) => w.item(a!.id)[0]!.id);
    expect(lines.map((l) => [l.itemId, l.retryKey])).toEqual(items.map((id) => [id, `voice:old:${id}`]));
    expect(lines.map((l) => l.projectId)).toEqual([w.glimpse, w.glimpse, w.glimpse, w.notes, w.glimpse].map((p) => p.project.id));
  });

  it('refuses a sixth while five wait on his answer, and queues only as many as bring the lines waiting back to five', () => {
    const w = seven();
    leadOldAsksNext(w.ctx, 'Progresser', V);
    expect(() => leadOldAsksNext(w.ctx, 'Progresser', V)).toThrow(OLD_ASKS_WITH_AIDEN);
    const answered = (...asks: { id: number }[]) => asks.forEach((a) => w.ctx.db.prepare("UPDATE desk_items SET state = 'done' WHERE id = ?").run(w.item(a.id)[0]!.id));
    // One answered: four wait, so a batch of five queues one.
    answered(w.g[0]!);
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe('Queued 1 old asks for the Voice; 2 remain.');
    expect(w.lines().at(-1)!.body).toMatch(/^Glimpse, 5 of 7: /);
    // Three more answered: two wait, so a batch of five queues the last two; a batch of one would queue one.
    answered(w.g[1]!, w.g[2]!, w.n);
    expect(leadOldAsksNext(w.ctx, 'Progresser', V, 1).text).toBe('Queued 1 old asks for the Voice; 1 remain.');
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe('Queued 1 old asks for the Voice; 0 remain.');
    expect(() => leadOldAsksNext(w.ctx, 'Progresser', V, 6)).toThrow(/from 1 to 5/);
  });

  it('says none remain once all are answered, and queues the done line once a day', () => {
    const w = seven();
    leadOldAsksNext(w.ctx, 'Progresser', V);
    // His answers: every item whose line went out is done.
    const all = () => w.ctx.db.prepare("UPDATE desk_items SET state = 'done' WHERE id IN (SELECT item_id FROM lead_sends WHERE retry_key LIKE 'voice:old:%')").run();
    all();
    leadOldAsksNext(w.ctx, 'Progresser', V);
    // With lines still waiting on him, nothing is done yet.
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe(NO_OLD_ASKS);
    expect(w.lines().filter((l) => l.body === OLD_ASKS_DONE_LINE)).toHaveLength(0);
    all();
    expect(leadOldAsksNext(w.ctx, 'Progresser', V)).toEqual({ text: NO_OLD_ASKS, queued: 0, remain: 0 });
    leadOldAsksNext(w.ctx, 'Progresser', V);
    const done = w.lines().filter((l) => l.body === OLD_ASKS_DONE_LINE);
    expect(done).toHaveLength(1);
    expect(done[0]!.retryKey).toMatch(/^voice:old:done:\d{4}-\d{2}-\d{2}$/);
  });

  it("leaves out an item in a C:\\work project or one another lead leads, and an open (round's) item", () => {
    const w = world();
    const own = w.ask(w.ip, 'Which port?', 3);
    leadAllow(w.ctx, w.ip.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
    leadOldAsks(w.ctx, w.ip.project.slug, 'Progresser', V);
    const work = w.ask(w.work, 'Which format?', 5);
    addDeskItem(w.ctx.db, { projectId: w.work.project.id, kind: 'old_ask', ref: String(work.id), nodeId: w.work.step.id, state: 'waiting_aiden' }, w.ctx.now());
    setProjectLead(w.ctx, 'window', w.notes.project.slug, 'Other');
    const other = w.ask(w.notes, 'Sync now?', 4);
    addDeskItem(w.ctx.db, { projectId: w.notes.project.id, kind: 'old_ask', ref: String(other.id), nodeId: w.notes.step.id, state: 'waiting_aiden' }, w.ctx.now());
    expect(w.item(own.id).map((i) => i.state)).toEqual(['open']);
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe(NO_OLD_ASKS);
    expect(w.lines()).toEqual([]);
  });
});

describe("his answer to an old ask's line", () => {
  it('lead answer --send answers its ask in his words and closes the item, in a project with no lead', async () => {
    const w = world();
    const a = w.ask(w.glimpse, 'Login screen review?', 19);
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    leadOldAsksNext(w.ctx, 'Progresser', V);
    const [line] = w.lines();
    const { post } = appOf(w.ctx);
    const res = await post(`/api/lead/${w.glimpse.project.slug}/answer`, { sendId: line!.id, aidenWords: 'close it' });
    expect(res.statusCode).toBe(200);
    expect(requireAsk(w.ctx, a.id)).toMatchObject({ answer: 'close it', answeredVia: 'lead' });
    expect(getDeskItem(w.ctx.db, line!.itemId!)).toMatchObject({ state: 'done', outcome: 'cleared by lead:Progresser' });
    const answer = w.ctx.db.prepare("SELECT aiden_words, text FROM lead_events WHERE kind = 'answer'").get() as { aiden_words: string; text: string };
    expect(answer.aiden_words).toBe('close it');
    expect(answer.text).toMatch(/^where voice; /);
  });

  it('the reading route stores the latest reading, refuses an ask of another project, and a C:\\work project', async () => {
    const w = world();
    const a = w.ask(w.glimpse, 'Login screen review?');
    const elsewhere = w.ask(w.notes, 'Sync now?');
    const workAsk = w.ask(w.work, 'Which format?');
    const { post } = appOf(w.ctx);
    const ok = await post(`/api/lead/${w.glimpse.project.slug}/old-asks/reading`, { askId: a.id, text: 'close it' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().text).toBe(`Stored your reading of a${a.id}.`);
    expect(w.ctx.db.prepare("SELECT ask_id, text FROM lead_events WHERE kind = 'old_reading'").all()).toEqual([{ ask_id: a.id, text: `a${a.id}: close it` }]);
    expect((await post(`/api/lead/${w.glimpse.project.slug}/old-asks/reading`, { askId: elsewhere.id, text: 'x' })).statusCode).toBe(409);
    expect((await post(`/api/lead/${w.work.project.slug}/old-asks/reading`, { askId: workAsk.id, text: 'x' })).statusCode).toBe(409);
    const next = await post('/api/lead/old-asks/next', { count: 2 });
    expect(next.statusCode).toBe(200);
    expect(next.json().text).toBe('No old asks remain.');
  });
});

describe('the runner and an open old ask, with the real apply', () => {
  const out = (text: string): TurnOutput => ({ text, costUsd: 0, durationMs: 1, tokensIn: 1, tokensOut: 1, refusedTools: [], rateLimits: [], model: 'claude-opus-5-5' });
  const DECIDE = 'DECIDE\nKIND: TECHNICAL\nANSWER: Use port 4410.\nWHY: It is free.';
  /** A runner on the real apply, its way answering each item with `answer(item)`, in the order the items were leased. */
  function runner(ctx: Ctx, answer: (item: DeskItem) => string) {
    const calls: TurnInput[] = [];
    const way: TurnWay = {
      name: 'headless',
      run: async (input) => {
        calls.push(input);
        return out(answer(input.item));
      },
    };
    const r = createRunner(ctx, { way, model: 'claude-opus-5-5', home: 'C:/home', port: 4410, tickMs: 60 * 60 * 1000, apply: (c, turn, item, record) => applyVerdict(c, turn, item, record), log: { info: () => undefined, error: () => undefined } });
    cleanups.push(() => r.stop());
    return { runner: r, calls };
  }

  it('leases the new item first and the old ask in its own lane beside it, though the old ask is older', async () => {
    const w = world();
    const old = w.ask(w.ip, 'Which port?', 2);
    leadAllow(w.ctx, w.ip.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
    leadOldAsks(w.ctx, w.ip.project.slug, 'Progresser', V);
    const oldItem = w.item(old.id)[0]!.id;
    w.tick(60_000);
    const fresh = w.ask(w.ip, 'Which colour?');
    const freshItem = addDeskItem(w.ctx.db, { projectId: w.ip.project.id, kind: 'question', ref: String(fresh.id), nodeId: w.ip.step.id }, w.ctx.now()).item;
    const { runner: r, calls } = runner(w.ctx, () => DECIDE);
    r.kick(w.ip.project.id);
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, oldItem)!.state).toBe('done'));
    expect(calls.map((c) => c.item.id)).toEqual([freshItem.id, oldItem]);
  });

  it('DECIDE on an old question decides it as a question; DECIDE on an old permission, AIDEN and CARD leave the ask open and the item for the Voice', async () => {
    const w = world();
    const q1 = w.ask(w.ip, 'Which port?', 4);
    const perm = raiseAsk(w.ctx, 'test', { nodeId: w.ip.step.id, kind: 'permission', text: 'May I delete the cache?' });
    const q2 = w.ask(w.ip, 'Which colour?', 2);
    const review = raiseAsk(w.ctx, 'test', { nodeId: w.ip.step.id, kind: 'review', text: 'Ship the desk?' });
    leadAllow(w.ctx, w.ip.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
    expect(leadOldAsks(w.ctx, w.ip.project.slug, 'Progresser', V).forRound).toBe(4);
    const verdicts: Record<string, string> = {
      [q1.id]: DECIDE,
      [perm.id]: 'DECIDE\nKIND: TECHNICAL\nANSWER: Allow it.\nWHY: It is a cache.',
      [q2.id]: 'AIDEN\nKIND: TASTE\nANSWER: Blue.\nWHY: A colour is his.',
      [review.id]: 'CARD\nKIND: NONE\nANSWER: The landing check decides.\nWHY: It is a review.',
    };
    const { runner: r } = runner(w.ctx, (item) => verdicts[item.ref]!);
    const items = [q1, perm, q2, review].map((a) => w.item(a.id)[0]!.id);
    r.kick(w.ip.project.id);
    await vi.waitFor(() => expect(items.map((id) => getDeskItem(w.ctx.db, id)!.state)).toEqual(['done', 'waiting_aiden', 'waiting_aiden', 'waiting_aiden']), { timeout: 5000 });
    expect(requireAsk(w.ctx, q1.id)).toMatchObject({ answer: 'Use port 4410.', answeredVia: 'lead_decided' });
    expect(getDeskItem(w.ctx.db, items[0]!)!.outcome).toMatch(/^DECIDE d\d+$/);
    for (const a of [perm, q2, review]) expect(requireAsk(w.ctx, a.id).clearedAt).toBeNull();
    expect(items.slice(1).map((id) => getDeskItem(w.ctx.db, id)!.outcome)).toEqual([`AIDEN for the Voice: ${DECIDE_QUESTION_ONLY}`, 'AIDEN for the Voice', 'CARD for the Voice']);
    // P6: with no reading stored, an AIDEN or CARD answer becomes the reading; a DECIDE refused for a permission writes none.
    expect([perm, q2, review].map((a) => oldReading(w.ctx, a.id))).toEqual([null, 'Blue.', 'The landing check decides.']);
    // No bring: nothing went to the Voice until next carries them.
    expect(w.lines()).toEqual([]);
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe('Queued 3 old asks for the Voice; 0 remain.');
    // Oldest ask first: the colour question was raised two days back, the permission and the review now.
    expect(w.lines().map((l) => l.itemId)).toEqual([items[2], items[1], items[3]]);
    expect(w.lines()[0]!.body).toMatch(/\nBlue\. Say your answer\.$/);
  });
});

describe('an old question decided by the round, and undone (P1, P3, P6)', () => {
  const out = (text: string): TurnOutput => ({ text, costUsd: 0, durationMs: 1, tokensIn: 1, tokensOut: 1, refusedTools: [], rateLimits: [], model: 'claude-opus-5-5' });
  const DECIDE = 'DECIDE\nKIND: TECHNICAL\nANSWER: Use port 4410.\nWHY: It is free.';
  function decideOld(state: 'ended' | 'idle', withSession = true) {
    const w = world();
    handleHookEvent(w.ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InProgress' });
    w.ctx.db.prepare("UPDATE sessions SET app = 't3', t3_thread_id = 'th_1', state = ? WHERE id = 's1'").run(state);
    const a = withSession ? raiseAsk(w.ctx, 'test', { nodeId: w.ip.step.id, kind: 'question', text: 'Which port?', sessionId: 's1' }) : w.ask(w.ip, 'Which port?', 3);
    leadAllow(w.ctx, w.ip.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
    leadOldAsks(w.ctx, w.ip.project.slug, 'Progresser', V);
    const itemId = w.item(a.id)[0]!.id;
    const way: TurnWay = { name: 'headless', run: async () => out(DECIDE) };
    const r = createRunner(w.ctx, { way, model: 'claude-opus-5-5', home: 'C:/home', port: 4410, tickMs: 60 * 60 * 1000, apply: (c, turn, it, record) => applyVerdict(c, turn, it, record), log: { info: () => undefined, error: () => undefined } });
    cleanups.push(() => r.stop());
    return { ...w, a, itemId, r };
  }
  const relays = (ctx: Ctx) => ctx.db.prepare("SELECT target, retry_key AS retryKey FROM lead_sends WHERE kind = 'relay' ORDER BY id").all() as { target: string; retryKey: string }[];
  const logs = (ctx: Ctx, nodeId: number) => ctx.db.prepare('SELECT text FROM log_entries WHERE node_id = ? ORDER BY id').pluck().all(nodeId) as string[];
  const decision = (ctx: Ctx, item: number) => Number(/^DECIDE d(\d+)$/.exec(getDeskItem(ctx.db, item)!.outcome ?? '')![1]);

  it("with its session ended: no relay to the old thread, the decision and its undo go in the step's log", async () => {
    const w = decideOld('ended');
    w.r.kick(w.ip.project.id);
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, w.itemId)!.state).toBe('done'));
    const d = decision(w.ctx, w.itemId);
    expect(relays(w.ctx)).toEqual([]);
    expect(logs(w.ctx, w.ip.step.id)).toEqual([`Progresser decided d${d}: Use port 4410. Why: It is free. Aiden can undo this with "undo d${d}".`]);
    leadUndo(w.ctx, w.ip.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'undo that' });
    expect(relays(w.ctx)).toEqual([]);
    expect(logs(w.ctx, w.ip.step.id).at(-1)).toBe(`Progresser: d${d} is withdrawn: a${w.a.id} is Aiden's again.`);
  });

  it('with its session live: the decision and its undo are relayed to its thread', async () => {
    const w = decideOld('idle');
    w.r.kick(w.ip.project.id);
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, w.itemId)!.state).toBe('done'));
    const d = decision(w.ctx, w.itemId);
    expect(relays(w.ctx)).toEqual([{ target: 'th_1', retryKey: `relay:d${d}` }]);
    leadUndo(w.ctx, w.ip.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'undo that' });
    expect(relays(w.ctx)).toEqual([{ target: 'th_1', retryKey: `relay:d${d}` }, { target: 'th_1', retryKey: `undo:d${d}` }]);
  });

  it('undone, the question raised again is an old ask waiting on Aiden, for next', async () => {
    const w = decideOld('ended', false);
    w.r.kick(w.ip.project.id);
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, w.itemId)!.state).toBe('done'));
    leadUndo(w.ctx, w.ip.project.slug, 'Progresser', V, { eventId: decision(w.ctx, w.itemId), aidenWords: 'undo that' });
    const again = w.ctx.db.prepare("SELECT id FROM asks WHERE cleared_at IS NULL AND text = 'Which port?'").pluck().get() as number;
    expect(again).not.toBe(w.a.id);
    expect(w.item(again).map((i) => i.state)).toEqual(['waiting_aiden']);
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe('Queued 1 old asks for the Voice; 0 remain.');
  });
});

describe('the Voice and the cap after the re-check (P2, P4, P5)', () => {
  it('a line put back to intended whose ask was answered meanwhile is cleared before the project gathers; one still open stays', () => {
    const w = world();
    const [a, b] = [w.ask(w.glimpse, 'one', 5), w.ask(w.glimpse, 'two', 4)];
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    leadOldAsksNext(w.ctx, 'Progresser', V);
    const [la, lb] = w.lines();
    // Answered while its line was being tried: closeAskItems left it, and the failed POST put it back (result cleared).
    w.ctx.db.prepare("UPDATE desk_items SET state = 'done' WHERE id = ?").run(w.item(a.id)[0]!.id);
    voiceReadiness(w.ctx, 'C:/no-such-home-for-this-test', getSend(w.ctx.db, lb!.id)!);
    expect([getSend(w.ctx.db, la!.id)!.state, getSend(w.ctx.db, lb!.id)!.state]).toEqual(['cleared', 'intended']);
    expect(w.item(b.id)[0]!.state).toBe('waiting_aiden');
  });

  it('a line he heard 24 hours ago with no answer stops counting against the cap; one heard 23 hours ago still counts', () => {
    const w = world();
    for (let i = 0; i < 7; i++) w.ask(w.glimpse, `ask ${i}`, 9 - i);
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    leadOldAsksNext(w.ctx, 'Progresser', V);
    const ids = w.lines().map((l) => l.id);
    const heard = (id: number, at: string) => w.ctx.db.prepare("UPDATE lead_sends SET state = 'done', done_at = ? WHERE id = ?").run(at, id);
    ids.slice(0, 4).forEach((id) => heard(id, '2026-11-24T08:00:00.000Z'));
    heard(ids[4]!, '2026-11-24T10:00:00.000Z');
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe('Queued 2 old asks for the Voice; 0 remain.');
  });

  it('after its second line ends unknown or cleared an old ask gets no third line: it stays for the window', () => {
    const w = world();
    const a = w.ask(w.glimpse, 'one', 5);
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    leadOldAsksNext(w.ctx, 'Progresser', V);
    const end = (state: string) => w.ctx.db.prepare("UPDATE lead_sends SET state = ? WHERE id = (SELECT MAX(id) FROM lead_sends WHERE kind = 'voice_line')").run(state);
    end('unknown');
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe('Queued 1 old asks for the Voice; 0 remain.');
    end('cleared');
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe(NO_OLD_ASKS);
    expect(w.lines().filter((l) => l.itemId === w.item(a.id)[0]!.id)).toHaveLength(2);
    expect(w.item(a.id)[0]!.state).toBe('waiting_aiden');
  });
});

describe("next's lines after Murr's review", () => {
  it('counts only lines of projects next still serves: an archived project frees its places, and the done line comes', () => {
    const w = world();
    for (let i = 0; i < 5; i++) w.ask(w.glimpse, `Glimpse ask ${i + 1}`, 10 - i);
    const n = w.ask(w.notes, 'Notes ask', 3);
    leadOldAsksAll(w.ctx, 'Progresser', V);
    leadOldAsksNext(w.ctx, 'Progresser', V);
    expect(() => leadOldAsksNext(w.ctx, 'Progresser', V)).toThrow(OLD_ASKS_WITH_AIDEN);
    w.ctx.db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(w.glimpse.project.id);
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe('Queued 1 old asks for the Voice; 0 remain.');
    w.ctx.db.prepare("UPDATE desk_items SET state = 'done' WHERE id = ?").run(w.item(n.id)[0]!.id);
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe(NO_OLD_ASKS);
    expect(w.lines().filter((l) => l.body === OLD_ASKS_DONE_LINE).map((l) => l.projectId)).toEqual([w.notes.project.id]);
  });

  it('an ask answered in the window clears its old line and its bring line before they are spoken; a line being tried is left', () => {
    const w = world();
    const a = w.ask(w.glimpse, 'Login screen review?', 5);
    const b = w.ask(w.glimpse, 'Keep the old logo?', 4);
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    leadOldAsksNext(w.ctx, 'Progresser', V);
    const [la, lb] = w.lines();
    markTrying(w.ctx.db, lb!.id, true);
    clearAsk(w.ctx, 'window', a.id, 'close it');
    clearAsk(w.ctx, 'window', b.id, 'keep it');
    const state = (id: number) => getSend(w.ctx.db, id)!.state;
    expect([state(la!.id), state(lb!.id)]).toEqual(['cleared', 'intended']);
    // A bring line too.
    const q = raiseAsk(w.ctx, 'test', { nodeId: w.ip.step.id, kind: 'question', text: 'Search or Find?' });
    dbWrite(w.ctx, 'test', () => {
      const { item } = produceDeskItem(w.ctx.db, { projectId: w.ip.project.id, kind: 'question', ref: String(q.id), nodeId: w.ip.step.id }, w.ctx.now());
      bringItem(w.ctx, item, { id: null, kind: 'TASTE', answer: 'Search' }, { tell: false });
    });
    const bring = w.lines().find((l) => l.retryKey.startsWith('voice:bring:'))!;
    expect(state(bring.id)).toBe('intended');
    clearAsk(w.ctx, 'window', q.id, 'find');
    expect(state(bring.id)).toBe('cleared');
  });

  it('"i of total" counts a done item whose ask went with its step', () => {
    const w = world();
    const [a, b, c] = [w.ask(w.glimpse, 'one', 9), w.ask(w.glimpse, 'two', 8), w.ask(w.glimpse, 'three', 7)];
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    w.ctx.db.prepare("UPDATE desk_items SET state = 'done', outcome = 'step deleted' WHERE id = ?").run(w.item(a.id)[0]!.id);
    w.ctx.db.prepare('DELETE FROM asks WHERE id = ?').run(a.id);
    leadOldAsksNext(w.ctx, 'Progresser', V);
    expect(w.lines().map((l) => l.body.split(':')[0])).toEqual(['Glimpse, 2 of 3', 'Glimpse, 3 of 3']);
    expect([b, c].map((x) => w.item(x.id)[0]!.id)).toEqual(w.lines().map((l) => l.itemId));
  });

  it('a line that ended unknown (a refused webhook) or cleared does not wait on him, and its item is queued again under a fresh key', () => {
    const w = world();
    const asks = [0, 1, 2, 3, 4].map((i) => w.ask(w.glimpse, `ask ${i}`, 9 - i));
    leadOldAsks(w.ctx, w.glimpse.project.slug, 'Progresser', V);
    leadOldAsksNext(w.ctx, 'Progresser', V);
    const [first, second] = w.lines();
    w.ctx.db.prepare("UPDATE lead_sends SET state = 'unknown' WHERE id = ?").run(first!.id);
    w.ctx.db.prepare("UPDATE lead_sends SET state = 'cleared' WHERE id = ?").run(second!.id);
    expect(leadOldAsksNext(w.ctx, 'Progresser', V).text).toBe('Queued 2 old asks for the Voice; 0 remain.');
    const again = w.lines().slice(5);
    const ids = asks.slice(0, 2).map((a) => w.item(a.id)[0]!.id);
    expect(again.map((l) => [l.itemId, l.retryKey])).toEqual(ids.map((id) => [id, `voice:old:${id}:2`]));
    expect(() => leadOldAsksNext(w.ctx, 'Progresser', V)).toThrow(OLD_ASKS_WITH_AIDEN);
  });

  it('next and --all refuse a name that leads no project, and older rules name the project the lead leads', async () => {
    const w = world();
    expect(() => leadOldAsksNext(w.ctx, 'Nobody', V)).toThrow(leadsNoProject('Nobody'));
    expect(() => leadOldAsksAll(w.ctx, 'Nobody', V)).toThrow('Nobody leads no project.');
    const { post } = appOf(w.ctx);
    expect((await post('/api/lead/old-asks/all', { as: 'Nobody' })).statusCode).toBe(409);
    const old = await post('/api/lead/old-asks/next', { instructions: V - 1 });
    expect(old.statusCode).toBe(409);
    expect(old.json().error).toContain(`Run "lead rules ${w.ip.project.slug} --as Progresser"`);
  });
});
