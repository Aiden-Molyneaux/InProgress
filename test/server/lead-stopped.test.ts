import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION, LEAD_STARTS_PER_DAY } from '../../src/core/lead';
import { openDb } from '../../src/server/db/connection';
import { createCtx, write, type Ctx } from '../../src/server/db/tx';
import { applyVerdict } from '../../src/server/lead/apply';
import { DESK_STOPPED_MS, watchDesk } from '../../src/server/lead/desk';
import { deskUserMessage } from '../../src/server/lead/prompt';
import type { ReserveAnswer } from '../../src/server/lead/reserve';
import { createRunner, type TurnInput, type TurnWay } from '../../src/server/lead/runner';
import { createSender, parseStartBody, type Sender } from '../../src/server/lead/sends';
import { ASK_STOPPED_WAIT_MS, askStoppedKey, CAUSE_LIMIT, CAUSE_RESTARTS } from '../../src/server/lead/stopped';
import { leadAllow, leadIntent } from '../../src/server/lead-commands';
import { getDeskItem, type DeskItem } from '../../src/server/repo/desk';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
import { intendSend, sendByRetryKey } from '../../src/server/repo/leadSends';
import { addNodes, requireNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { claimStep, handleHookEvent } from '../../src/server/session-flow';
import { StandInT3 } from '../t3-stub';

const V = LEAD_INSTRUCTIONS_VERSION;
const BOUND = 'C:/personal/InGame';
const WORKTREE = 'C:/personal/InGame/.claude/worktrees/tabs';
const BRANCH = 'tabs';
const MIN = 60_000;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const verdictText = (answer: string, head = 'DECIDE') => `I read the thread.\n${head}\nKIND: ${head === 'DECIDE' ? 'TECHNICAL' : 'TASTE'}\nANSWER: ${answer}\nWHY: The thread says so.`;

/**
 * A project led by Progresser with its round on, a session s1 stopped on step "Build tabs" in its worktree and branch
 * (in T3 Code unless `inT3` is false), its stopped item on the desk, a stand-in T3 and a sender over it, and a runner whose
 * turns answer `answer` and whose apply is the server's.
 */
function world(opts: { inT3?: boolean; reserve?: ReserveAnswer; starts?: boolean } = {}) {
  let t = Date.parse('2026-11-25T02:00:00.000Z');
  const ctx: Ctx = createCtx(openDb(':memory:'), () => new Date(t).toISOString());
  cleanups.push(() => void ctx.db.close());
  const tick = (ms: number) => void (t += ms);
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, BOUND);
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  leadIntent(ctx, project.slug, 'Progresser', V, { intent: '## Goal\nShip the game.\n\n## Phase\nStore release.\n' });
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Build tabs', what: 'Tabs.', why: 'Players asked.' }] });
  leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
  // A restart is the lead's own start: it needs Starts on.
  if (opts.starts !== false) leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'starts', aidenWords: 'start things' });
  tick(MIN);
  const t3 = new StandInT3();
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: BOUND });
  claimStep(ctx, 'session:s1', 's1', step!.id);
  ctx.db.prepare('UPDATE sessions SET cwd = ?, branch = ?, t3_thread_id = ? WHERE id = ?').run(WORKTREE, BRANCH, opts.inT3 === false ? null : 'th_s1', 's1');
  if (opts.inT3 !== false) t3.threads.push({ threadId: 'th_s1', project: BOUND, title: '#2 Build tabs', messages: [], updatedAt: new Date(t).toISOString() });
  handleHookEvent(ctx, 's1', { event: 'stop', background: [] });
  tick(DESK_STOPPED_MS);
  expect(watchDesk(ctx).stopped).toBe(1);
  const item = getDeskItem(ctx.db, ctx.db.prepare("SELECT id FROM desk_items WHERE kind = 'stopped'").pluck().get() as number)!;
  const sender: Sender = createSender(ctx, { t3 }, { log: { info: () => undefined, error: () => undefined } });
  cleanups.push(() => sender.stop());
  let answer = verdictText('DONE: merged as #12.');
  const calls: TurnInput[] = [];
  const way: TurnWay = {
    name: 'headless',
    run: async (input) => {
      calls.push(input);
      return { text: answer, costUsd: 0.1, durationMs: 100, tokensIn: 1, tokensOut: 1, refusedTools: [], rateLimits: [], model: 'claude-opus-5-5' };
    },
  };
  const runner = createRunner(ctx, {
    way,
    model: 'claude-opus-5-5',
    home: 'C:/home',
    port: 4410,
    tickMs: 60 * 60 * 1000,
    apply: (c, turn, it, record) => applyVerdict(c, turn, it, record, { listed: () => false, reserveAllowsStart: () => opts.reserve ?? { ok: true } }),
    log: { info: () => undefined, error: () => undefined },
  });
  cleanups.push(() => runner.stop());
  const state = () => getDeskItem(ctx.db, item.id)!;
  /** One tick of the runner, then the sender carries out what it intended. */
  const round = async () => {
    runner.tick();
    await new Promise((r) => setImmediate(r));
    await sender.wake();
  };
  /** Ask, then let 30 minutes pass with no reply, and run the turn on `text` to its apply. */
  const unanswered = async (text: string) => {
    answer = text;
    await round();
    tick(ASK_STOPPED_WAIT_MS + MIN);
    await round();
    await vi.waitFor(() => expect(['done', 'waiting_aiden']).toContain(state().state));
  };
  const events = (kind: string) => ctx.db.prepare('SELECT node_id AS nodeId, session_id AS sessionId, text FROM lead_events WHERE kind = ? ORDER BY id').all(kind) as { nodeId: number; sessionId: string; text: string }[];
  const sends = (kind: string) => ctx.db.prepare('SELECT id FROM lead_sends WHERE kind = ? ORDER BY id').pluck().all(kind) as number[];
  return { ctx, tick, project, step: step!, item, t3, sender, runner, calls, state, round, unanswered, events, sends, setAnswer: (a: string) => void (answer = a) };
}

const ASK_BODY = (stepId: number) => `[From Progresser, the lead] Where does the work on #${stepId} stand? Reply in one line, then carry on.`;

describe('a stopped session', () => {
  it('is asked once in plain code, however many ticks, and its reply closes the item with no turn', async () => {
    const w = world();
    for (let i = 0; i < 4; i++) {
      await w.round();
      w.tick(5 * MIN);
    }
    expect(w.sends('relay')).toHaveLength(1);
    const send = sendByRetryKey(w.ctx.db, askStoppedKey(w.item.id))!;
    expect(send).toMatchObject({ kind: 'relay', target: 'th_s1', body: ASK_BODY(w.step.id), state: 'done' });
    expect(w.t3.threads[0]!.messages.map((m) => m.text)).toEqual([ASK_BODY(w.step.id)]);
    expect(w.state()).toMatchObject({ state: 'open', outcome: 'asked' });
    expect(w.events('asked')).toEqual([{ nodeId: w.step.id, sessionId: 's1', text: ASK_BODY(w.step.id) }]);
    // The session replies and moves again: the minute watch closes its item; it is left alone.
    handleHookEvent(w.ctx, 's1', { event: 'prompt' });
    w.tick(MIN);
    watchDesk(w.ctx);
    expect(w.state()).toMatchObject({ state: 'done', outcome: 'session moved on' });
    w.tick(ASK_STOPPED_WAIT_MS);
    await w.round();
    expect(w.calls).toHaveLength(0);
    expect(w.sends('relay')).toHaveLength(1);
  });

  it('with no reply in 30 minutes gets a turn naming its branch and worktree; RESTART writes the handoff, one start, a restart line', async () => {
    const w = world();
    await w.round();
    w.tick(ASK_STOPPED_WAIT_MS - MIN);
    await w.round();
    expect(w.calls).toHaveLength(0);
    await w.unanswered(verdictText('RESTART: Goal: tabs. Where: the tab bar renders. Done: the bar. Next: wire the panels.'));
    expect(w.calls).toHaveLength(1);
    const message = w.calls[0]!.userMessage;
    for (const words of ['s1', `step #${w.step.id}`, BRANCH, WORKTREE, 'did not answer', 'RESTART:', 'PARK:', 'DONE:']) expect(message).toContain(words);
    expect(deskUserMessage(w.ctx, w.item)).toContain(WORKTREE);
    const outcome = w.state().outcome!;
    expect(w.state().state).toBe('done');
    expect(outcome).toMatch(/^RESTART d\d+$/);
    const resource = w.ctx.db.prepare('SELECT kind, content, node_id AS nodeId FROM resources').get() as { kind: string; content: string; nodeId: number };
    expect(resource).toMatchObject({ kind: 'doc', nodeId: w.step.id });
    expect(resource.content).toContain('Next: wire the panels.');
    expect(resource.content).toContain(`Branch: ${BRANCH}`);
    expect(resource.content).toContain(`Worktree: ${WORKTREE}`);
    expect(w.sends('start')).toHaveLength(1);
    expect(w.t3.starts).toBe(1);
    const start = w.ctx.db.prepare("SELECT target, body, state FROM lead_sends WHERE kind = 'start'").get() as { target: string; body: string; state: string };
    expect(start.state).toBe('done');
    expect(start.target).toBe(BOUND);
    expect(parseStartBody(start.body)).toMatchObject({ message: resource.content, title: `#${w.step.id} Build tabs (restart)`, worktree: WORKTREE, branch: BRANCH, nodeId: w.step.id });
    expect(parseStartBody(start.body)!.aidenWords).toBeUndefined();
    expect(w.events('restart')).toHaveLength(1);
    const eventId = Number(outcome.slice('RESTART d'.length));
    expect(w.ctx.db.prepare('SELECT kind FROM lead_decisions WHERE event_id = ?').pluck().get(eventId)).toBe('restart');
    expect(requireNode(w.ctx, w.step.id).status).toBe('active');
  });

  /** Writes earlier restarts of the step, or earlier starts of the lead's own, before the turn. */
  const before = (w: ReturnType<typeof world>, what: 'restarts' | 'starts', n: number) =>
    write(w.ctx, 'test', () => {
      for (let i = 0; i < n; i++) {
        if (what === 'restarts') insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'restart', nodeId: w.step.id, text: 'earlier' }, w.ctx.now());
        else intendSend(w.ctx.db, { projectId: w.project.id, kind: 'start', target: BOUND, body: JSON.stringify({ message: 'm', title: 't', nodeId: 999 }) }, w.ctx.now());
      }
    });

  it('a third restart on the step is a PARK: two restarts tried', async () => {
    const w = world();
    before(w, 'restarts', 2);
    await w.unanswered(verdictText('RESTART: Goal: tabs.'));
    expect(w.state().outcome).toMatch(/^PARK d\d+$/);
    expect(requireNode(w.ctx, w.step.id)).toMatchObject({ status: 'parked', parkedReason: CAUSE_RESTARTS });
    expect(w.sends('start')).toHaveLength(0);
    expect(w.ctx.db.prepare('SELECT COUNT(*) FROM resources').pluck().get()).toBe(0);
  });

  it('the start limit reached is a PARK: the start limit or the reserve', async () => {
    const w = world();
    before(w, 'starts', LEAD_STARTS_PER_DAY);
    await w.unanswered(verdictText('RESTART: Goal: tabs.'));
    expect(w.state().outcome).toMatch(/^PARK d\d+$/);
    expect(requireNode(w.ctx, w.step.id)).toMatchObject({ status: 'parked', parkedReason: CAUSE_LIMIT });
    expect(w.sends('start')).toHaveLength(LEAD_STARTS_PER_DAY);
  });

  it('the reserve refusing is a PARK: the start limit or the reserve', async () => {
    const w = world({ reserve: { ok: false, why: 'past 95 percent of the week' } });
    await w.unanswered(verdictText('RESTART: Goal: tabs.'));
    expect(requireNode(w.ctx, w.step.id)).toMatchObject({ status: 'parked', parkedReason: CAUSE_LIMIT });
    expect(w.sends('start')).toHaveLength(0);
  });

  it('PARK parks the step with the cause, as a technical decision', async () => {
    const w = world();
    await w.unanswered(verdictText('PARK: the store account needs Aiden to sign in.'));
    const outcome = w.state().outcome!;
    expect(outcome).toMatch(/^PARK d\d+$/);
    expect(requireNode(w.ctx, w.step.id)).toMatchObject({ status: 'parked', parkedReason: 'the store account needs Aiden to sign in.' });
    expect(w.ctx.db.prepare('SELECT kind FROM lead_decisions WHERE event_id = ?').pluck().get(Number(outcome.slice('PARK d'.length)))).toBe('technical');
  });

  it('DONE leaves the step as it is and notes it for the morning list', async () => {
    const w = world();
    await w.unanswered(verdictText('DONE: merged as #12.'));
    expect(w.state()).toMatchObject({ state: 'done', outcome: 'DONE' });
    expect(requireNode(w.ctx, w.step.id).status).toBe('active');
    expect(w.events('done_noted')).toEqual([{ nodeId: w.step.id, sessionId: 's1', text: 'merged as #12.' }]);
  });

  it('an answer that is none of the three waits for Aiden', async () => {
    const w = world();
    await w.unanswered(verdictText('Let it carry on.'));
    expect(w.state()).toMatchObject({ state: 'waiting_aiden', outcome: 'unclear' });
    expect(requireNode(w.ctx, w.step.id).status).toBe('active');
  });

  it('not in T3 Code, cannot be asked: it goes straight to the turn', async () => {
    const w = world({ inT3: false });
    w.setAnswer(verdictText('DONE: merged as #12.'));
    await w.round();
    await vi.waitFor(() => expect(w.state().state).toBe('done'));
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.userMessage).toContain('could not be asked');
    expect(w.sends('relay')).toHaveLength(0);
    expect(w.events('asked')).toHaveLength(0);
  });
});

describe('a promise past its time', () => {
  it('is noted with the turn\'s answer as a promise_due line, and the item is done', () => {
    const w = world();
    const item = { ...w.item, kind: 'promise_due', ref: '7' } as DeskItem;
    const effect = write(w.ctx, 'lead:Progresser', (record) =>
      applyVerdict(w.ctx, { id: 0, verdict: 'DECIDE', kind: 'TECHNICAL', answer: 'Done it: the tabs ship tonight.', why: 'kept' } as never, item, record, { listed: () => false }),
    );
    expect(effect.itemState).toBe('done');
    expect(effect.outcome).toMatch(/^DECIDE noted \(e\d+\)$/);
    expect(w.ctx.db.prepare("SELECT ask_id AS askId, text FROM lead_events WHERE kind = 'promise_due'").get()).toEqual({ askId: 7, text: 'DECIDE: Done it: the tabs ship tonight.' });
  });
});

describe("a restart passes every refusal lead start has (S16)", () => {
  const restart = verdictText('RESTART: carry on from the tabs.');
  const parkedWith = (w: ReturnType<typeof world>, words: string, starts = 0) => {
    expect(w.state().outcome).toMatch(/^PARK d\d+$/);
    expect(w.sends('start')).toHaveLength(starts);
    expect(w.events('park').map((e) => e.text).join('\n')).toContain(words);
  };

  it('Starts off: a PARK with the reason', async () => {
    const w = world({ starts: false });
    await w.unanswered(restart);
    parkedWith(w, 'Starts is off');
  });

  it('another live session on the step: a PARK, while its own stopped session does not count', async () => {
    const w = world();
    const [child] = addNodes(w.ctx, 'test', { parentId: w.step.id, nodes: [{ title: 'Tab icons', what: 'Icons.', why: 'Looks.' }] });
    handleHookEvent(w.ctx, 's2', { event: 'start', source: 'startup', cwd: BOUND });
    claimStep(w.ctx, 'session:s2', 's2', child!.id);
    await w.unanswered(restart);
    parkedWith(w, 'already has a session working on it');
  });

  it('the in-flight limit: a PARK', async () => {
    const w = world();
    for (const id of ['x1', 'x2', 'x3']) handleHookEvent(w.ctx, id, { event: 'start', source: 'startup', cwd: BOUND });
    await w.unanswered(restart);
    parkedWith(w, 'sessions are in flight');
  });

  it('a step that is done: a PARK line, and the step stays done', async () => {
    const w = world();
    w.ctx.db.prepare("UPDATE nodes SET status = 'done' WHERE id = ?").run(w.step.id);
    await w.unanswered(restart);
    parkedWith(w, 'is done');
    expect(requireNode(w.ctx, w.step.id).status).toBe('done');
  });

  it('a start of the step still unanswered: a PARK', async () => {
    const w = world();
    write(w.ctx, 'test', () => intendSend(w.ctx.db, { projectId: w.project.id, kind: 'start', target: 'C:/elsewhere', body: JSON.stringify({ message: 'm', title: 't', nodeId: w.step.id }) }, w.ctx.now()));
    w.t3.down = true;
    await w.unanswered(restart);
    parkedWith(w, 'has not answered yet', 1);
  });
});
