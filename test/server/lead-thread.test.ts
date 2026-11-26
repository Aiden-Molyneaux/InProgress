import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { leadAllow, leadDisallow, leadSet } from '../../src/server/lead-commands';
import { leadSwitches, readLeadBrief } from '../../src/server/lead';
import { renderLeadBrief } from '../../src/server/lead-text';
import { leadBehindWatch } from '../../src/server/lead/behind';
import { leadScopeOf } from '../../src/server/lead/hold';
import { dayThreadOf } from '../../src/server/lead/morning';
import { createRunner, standInApply, THREAD_POLL_MS, threadWay, TurnRunError, type TurnInput } from '../../src/server/lead/runner';
import { turnWayOf } from '../../src/server/lead/settings';
import { windowLeadSwitch } from '../../src/server/lead/window';
import { addDeskItem, moveDeskItem } from '../../src/server/repo/desk';
import { intendSend, moveSend } from '../../src/server/repo/leadSends';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { handleHookEvent } from '../../src/server/session-flow';
import { StandInT3 } from '../t3-stub';

const V = LEAD_INSTRUCTIONS_VERSION;
const HOME = join('C:/test-home', 'inprogress');
const BOUND = 'C:/personal/InGame';
const DAY = 24 * 60 * 60_000;

function world() {
  let t = Date.parse('2026-11-25T09:00:00.000Z');
  const clock = () => new Date(t).toISOString();
  const ctx = createCtx(openDb(':memory:'), clock);
  ctx.home = HOME;
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, BOUND);
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Signing' }] });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const t3 = new StandInT3(clock);
  return { ctx, project, step: step!, t3, advance: (ms: number) => void (t += ms) };
}

const input = (w: ReturnType<typeof world>, id: number, turnId = 7): TurnInput => ({
  turnId,
  slug: w.project.slug,
  item: { id, projectId: w.project.id, kind: 'question', ref: '1', nodeId: null, createdAt: '', dueAt: null, state: 'leased', doneAt: null, outcome: null },
  systemPrompt: 'rules',
  userMessage: `The item ${id}.`,
  model: 'claude-opus-5-5',
  toolsEnv: { INPROGRESS_HOME: HOME, INPROGRESS_PORT: '1', INPROGRESS_LEAD_AS: 'Progresser' },
});

/** Answers the thread as its agent would: a message after the newest send. */
function agent(w: ReturnType<typeof world>, threadId: string, text: string): void {
  w.t3.threads.find((x) => x.threadId === threadId)!.messages.push({ role: 'assistant', text });
}

const wayOver = (w: ReturnType<typeof world>, threadId: string | undefined) =>
  threadWay({ send: (id, m) => w.t3.send(id, m), show: (id) => w.t3.show(id), dayThread: () => threadId, projectIdOf: () => w.project.id, pollMs: 5 });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the thread way', () => {
  it('sends the item to the day thread and returns the reply that starts with its heading', async () => {
    const w = world();
    const { threadId } = await w.t3.start(HOME, 'the list', { title: 'day' });
    const way = wayOver(w, threadId);
    const run = way.run(input(w, 12), new AbortController().signal);
    await pause(20);
    expect(w.t3.threads[0]!.messages.at(-1)!.text.split('\n')[0]).toBe('Desk item 12, turn 7. Answer in the four lines, starting your reply with "Desk item 12:".');
    agent(w, threadId, 'Desk item 12: I read step #1.\nDECIDE\nKIND: TECHNICAL\nANSWER: Port 4410.\nWHY: free.');
    const out = await run;
    expect(out.text).toBe('I read step #1.\nDECIDE\nKIND: TECHNICAL\nANSWER: Port 4410.\nWHY: free.');
    expect([out.costUsd, out.durationMs, out.tokensIn, out.tokensOut, out.rateLimits]).toEqual([null, null, null, null, []]);
    expect(way.name).toBe('thread');
  });

  it("ignores another item's reply and waits for its own", async () => {
    const w = world();
    const { threadId } = await w.t3.start(HOME, 'the list', {});
    const run = wayOver(w, threadId).run(input(w, 12), new AbortController().signal);
    await pause(20);
    agent(w, threadId, 'Desk item 13: I read step #2.\nDECIDE\nKIND: TECHNICAL\nANSWER: no\nWHY: no');
    let settled = false;
    void run.then(() => (settled = true), () => (settled = true));
    await pause(40);
    expect(settled).toBe(false);
    agent(w, threadId, 'Desk item 12: mine');
    expect((await run).text).toBe('mine');
  });

  it('is a runner fault with no day thread, or with T3 Code down', async () => {
    const w = world();
    await expect(wayOver(w, undefined).run(input(w, 12), new AbortController().signal)).rejects.toMatchObject({ runnerFault: true });
    const { threadId } = await w.t3.start(HOME, 'the list', {});
    w.t3.down = true;
    const err = await wayOver(w, threadId).run(input(w, 12), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnRunError);
    expect((err as TurnRunError).runnerFault).toBe(true);
  });

  it('stops polling on the abort, and says a reply with no lines was read', async () => {
    const w = world();
    const { threadId } = await w.t3.start(HOME, 'the list', {});
    const controller = new AbortController();
    const run = wayOver(w, threadId).run(input(w, 12), controller.signal);
    await pause(20);
    controller.abort(new Error('stop'));
    await expect(run).rejects.toMatchObject({ runnerFault: true, message: "the lead's thread did not answer in time" });
    const again = wayOver(w, threadId).run(input(w, 14, 8), new AbortController().signal);
    await pause(20);
    agent(w, threadId, 'Desk item 14:');
    await expect(again).rejects.toMatchObject({ runnerFault: false, partial: { resultRead: true } });
    expect(THREAD_POLL_MS).toBe(5000);
  });

  it("the runner uses it only for a project whose turn-way is thread, and the day's thread is the morning send's result", async () => {
    const w = world();
    expect(turnWayOf(w.ctx.db, w.project.id)).toBe('headless');
    leadSet(w.ctx, w.project.slug, 'Progresser', V, { key: 'turn-way', value: 'thread' });
    expect(turnWayOf(w.ctx.db, w.project.id)).toBe('thread');
    expect(() => leadSet(w.ctx, w.project.slug, 'Progresser', V, { key: 'turn-way', value: 'sideways' })).toThrow();
    const send = intendSend(w.ctx.db, { projectId: w.project.id, kind: 'start', target: join(HOME, 'lead', w.project.slug), retryKey: `morning-thread:${w.project.id}:2026-11-25`, body: '{}' }, w.ctx.now());
    expect(dayThreadOf(w.ctx, w.project.id, w.ctx.now())).toBeUndefined();
    moveSend(w.ctx.db, send.id, ['intended'], 'done', { result: 'th_9', now: w.ctx.now() });
    expect(dayThreadOf(w.ctx, w.project.id, w.ctx.now())).toBe('th_9');
    w.advance(DAY);
    expect(dayThreadOf(w.ctx, w.project.id, w.ctx.now())).toBeUndefined();
    const lines: string[] = [];
    const headless = { name: 'headless' as const, run: () => Promise.reject(new Error('headless ran')) };
    const thread = { name: 'thread' as const, run: () => Promise.reject(new Error('thread ran')) };
    const runner = createRunner(w.ctx, { way: headless, threadWay: thread, model: 'm', home: HOME, port: 1, apply: standInApply, holdBack: () => false, log: { info: (m) => lines.push(m), error: () => undefined } });
    leadAllow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'go' });
    addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'question', ref: '99', nodeId: w.step.id }, w.ctx.now());
    runner.kick(w.project.id);
    await runner.stop();
    expect(lines.some((m) => m.includes(', thread, until'))).toBe(true);
    expect(lines.some((m) => m.includes(', headless, until'))).toBe(false);
  });
});

describe('a thread turn with no reply by the lease abort', () => {
  /** A project with the round on, turn-way thread, a day thread that never answers, and a runner over the thread way. */
  async function silent(leaseMs?: number) {
    const w = world();
    leadSet(w.ctx, w.project.slug, 'Progresser', V, { key: 'turn-way', value: 'thread' });
    leadAllow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'go' });
    const { threadId } = await w.t3.start(HOME, 'the list', {});
    const lines: string[] = [];
    const errors: string[] = [];
    const real = wayOver(w, threadId);
    const runner = createRunner(w.ctx, {
      way: { name: 'headless', run: () => Promise.reject(new Error('headless ran')) },
      threadWay: real,
      model: 'm',
      home: HOME,
      port: 1,
      apply: standInApply,
      holdBack: () => false,
      ...(leaseMs === undefined ? {} : { leaseMs }),
      log: { info: (m) => lines.push(m), error: (m) => errors.push(m) },
    });
    const item = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'question', ref: '99', nodeId: w.step.id }, w.ctx.now()).item;
    return { w, runner, lines, errors, item };
  }

  it('is a runner fault: interrupted, the project backs off, and no second turn is sent to the thread', async () => {
    const { w, runner, lines, errors, item } = await silent(30_000);
    runner.kick(w.project.id);
    await pause(100);
    expect(lines.some((m) => m.includes('interrupted') && m.includes("the lead's thread did not answer in time"))).toBe(true);
    expect(errors.some((m) => m.includes('backs off'))).toBe(true);
    const sends = w.t3.sends;
    runner.kick(w.project.id);
    await pause(50);
    expect(w.t3.sends).toBe(sends);
    expect(item.id).toBeGreaterThan(0);
    await runner.stop();
  });

  it('stays an interruption, with no back-off, when the round switches off during the turn', async () => {
    const { w, runner, lines, errors } = await silent();
    runner.kick(w.project.id);
    await pause(50);
    expect(w.t3.sends).toBe(1);
    leadDisallow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'round' });
    runner.tick();
    await pause(100);
    expect(lines.some((m) => m.includes('interrupted') && m.includes('the item left the desk during the turn'))).toBe(true);
    expect(errors.some((m) => m.includes('backs off'))).toBe(false);
    await runner.stop();
  });

  it('stays an interruption, with no back-off, when the server stops during the turn', async () => {
    const { w, runner, lines, errors } = await silent();
    runner.kick(w.project.id);
    await pause(50);
    await runner.stop();
    expect(lines.some((m) => m.includes('interrupted') && m.includes('the server stopped during the turn'))).toBe(true);
    expect(errors.some((m) => m.includes('backs off'))).toBe(false);
  });
});

describe("the lead's folder", () => {
  it('registers no session and gives no briefing, as for an untracked folder', () => {
    const w = world();
    const cwd = join(HOME, 'lead', w.project.slug);
    expect(handleHookEvent(w.ctx, 's1', { event: 'start', source: 'startup', cwd, app: 't3' as const })).toEqual({ tracked: false });
    expect(handleHookEvent(w.ctx, 's1', { event: 'prompt', cwd: join(cwd, 'sub') })).toEqual({ tracked: false });
    expect(w.ctx.db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(0);
    // A bound folder still tracks.
    expect(handleHookEvent(w.ctx, 's2', { event: 'start', source: 'startup', cwd: BOUND, app: 't3' as const }).tracked).toBe(true);
  });

  it('the hold and permission hooks say nothing there, even for a session of the project with its round on', () => {
    const w = world();
    leadAllow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'go' });
    handleHookEvent(w.ctx, 's2', { event: 'start', source: 'startup', cwd: BOUND, app: 't3' as const });
    expect(leadScopeOf(w.ctx, 's2', BOUND)).toBeDefined();
    expect(leadScopeOf(w.ctx, 's2', join(HOME, 'lead', w.project.slug))).toBeUndefined();
    expect(leadScopeOf(w.ctx, null, join(HOME, 'lead', 'other'))).toBeUndefined();
  });
});

describe('the round in the window and the brief', () => {
  it('is switched in the window as an allow and a disallow with the window as actor and its words', () => {
    const w = world();
    const brief = () => renderLeadBrief(readLeadBrief(w.ctx, w.project.slug, null, new Date(w.ctx.now())));
    windowLeadSwitch(w.ctx, w.project.id, 'round', true);
    expect(leadSwitches(w.ctx, w.project.id).round).toMatchObject({ on: true, words: 'switched in the window' });
    expect(w.ctx.db.prepare("SELECT actor FROM events WHERE type = 'project.updated' ORDER BY id DESC").pluck().get()).toBe('window');
    expect(() => windowLeadSwitch(w.ctx, w.project.id, 'round', true)).toThrow('already on');
    expect(brief()).toContain('Switches: starts off · landing off · round on since');
    windowLeadSwitch(w.ctx, w.project.id, 'round', false);
    expect(leadSwitches(w.ctx, w.project.id).round.on).toBe(false);
    expect(brief()).toContain('landing off · round off');
  });
});

describe('the behind watch', () => {
  it('lists open items with a limit and behind ones, never done or waiting_aiden ones, with what Aiden can do', () => {
    const w = world();
    const now = w.ctx.now();
    const late = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'stopped', ref: 'sess-1@2026-11-25T08:00:00.000Z', nodeId: w.step.id, dueAt: '2026-11-25T08:30:00.000Z' }, now).item;
    const given = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'stuck', ref: 'abc', dueAt: null }, now).item;
    moveDeskItem(w.ctx.db, given.id, ['open'], 'behind', { now });
    const waiting = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'held', ref: 'h', dueAt: '2026-11-25T08:00:00.000Z', state: 'waiting_aiden' }, now).item;
    const done = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'promise_due', ref: 'p', dueAt: '2026-11-25T08:00:00.000Z' }, now).item;
    moveDeskItem(w.ctx.db, done.id, ['open'], 'done', { outcome: 'x', now });
    const rows = leadBehindWatch(w.ctx, w.project.id);
    expect(rows.map((r) => [r.id, r.state, r.what, r.sessionId, r.askId])).toEqual([
      [late.id, 'open', 'a stopped session', 'sess-1', null],
      [given.id, 'behind', 'a permission prompt', null, null],
    ]);
    expect(rows.find((r) => r.id === waiting.id)).toBeUndefined();
    expect(getProjectSnapshot(w.ctx, w.project.id).leadBehind).toHaveLength(2);
  });
});
