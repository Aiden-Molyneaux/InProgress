import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { openDb } from '../../src/server/db/connection';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { leadAllow, leadDisallow } from '../../src/server/lead-commands';
import {
  ABORT_BEFORE_LEASE_END_MS, cmdQuote, createRunner, FAULT_BACKOFF_MS, headlessWay, killTree, resolveProgram, standInApply, taskkillPath, TurnRunError, type HeadlessOptions, type Runner, type TurnInput, type TurnOutput, type TurnWay,
} from '../../src/server/lead/runner';
import { clearAsk, raiseAskDetailed } from '../../src/server/repo/asks';
import { addDeskItem, getDeskItem, type DeskItem, type DeskItemKind } from '../../src/server/repo/desk';
import { applyTurn, getTurn, insertTurn, leaseItem, REOPENED_MARK, saveAnswer, type LeadTurn } from '../../src/server/repo/leadTurns';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { handleHookEvent } from '../../src/server/session-flow';

const V = LEAD_INSTRUCTIONS_VERSION;
const BOUND = 'C:/personal/InGame';
const MIN = 60_000;
const ANSWER = 'I read step #2.\nDECIDE\nKIND: TECHNICAL\nANSWER: Use port 4410.\nWHY: It is free.';
/** 2026-11-25T14:00:00Z and 2026-11-30T00:00:00Z in epoch seconds. */
const FIVE_RESET = Date.parse('2026-11-25T14:00:00.000Z') / 1000;
const WEEK_RESET = Date.parse('2026-11-30T00:00:00.000Z') / 1000;
const RATE = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.47, resetsAt: FIVE_RESET }, seven_day: { utilization: 0.31, resetsAt: WEEK_RESET }, seven_day_opus: { utilization: 0.12 } } };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A shared clock the test moves, a project led by Progresser with a step and its round on, and a desk to add to. */
function world(file = ':memory:') {
  let t = Date.parse('2026-11-25T09:00:00.000Z');
  const clock = () => new Date(t).toISOString();
  const ctx = createCtx(openDb(file), clock);
  cleanups.push(() => void ctx.db.close());
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, BOUND);
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Build tabs' }] });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
  const add = (kind: DeskItemKind = 'question', ref = `r${Math.random()}`): DeskItem => {
    t += 1000;
    return addDeskItem(ctx.db, { projectId: project.id, kind, ref, nodeId: step!.id, dueAt: new Date(t + 3 * MIN).toISOString() }, clock()).item;
  };
  return { ctx, project, step: step!, add, clock, tick: (ms: number) => void (t += ms), other: (f: string) => createCtx(openDb(f), clock) };
}

const output = (over: Partial<TurnOutput> = {}): TurnOutput => ({
  text: ANSWER,
  costUsd: 0.12,
  durationMs: 3400,
  tokensIn: 1000,
  tokensOut: 200,
  refusedTools: ['Read'],
  rateLimits: [RATE, RATE],
  model: 'claude-opus-5-5',
  ...over,
});

/** A way that answers at once (or throws), recording each input. */
function quickWay(make: (input: TurnInput) => TurnOutput = () => output()): TurnWay & { calls: TurnInput[] } {
  const calls: TurnInput[] = [];
  return {
    name: 'headless',
    calls,
    run: async (input) => {
      calls.push(input);
      return make(input);
    },
  };
}

/** A way whose runs wait until the test releases them (in order), and that ends a run on abort. */
function heldWay(): TurnWay & { calls: TurnInput[]; release(i: number, out?: TurnOutput): void } {
  const calls: TurnInput[] = [];
  const releases: ((out: TurnOutput) => void)[] = [];
  return {
    name: 'headless',
    calls,
    run: (input, signal) =>
      new Promise<TurnOutput>((resolve, reject) => {
        calls.push(input);
        releases.push(resolve);
        signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
      }),
    release: (i, out = output()) => releases[i]!(out),
  };
}

function runnerOn(ctx: Ctx, way: TurnWay, over: { apply?: (ctx: Ctx, turn: LeadTurn, item: DeskItem) => ReturnType<typeof standInApply>; leaseMs?: number } = {}) {
  const lines: string[] = [];
  const runner: Runner = createRunner(ctx, {
    way,
    model: 'claude-opus-5-5',
    home: 'C:/home',
    port: 4410,
    tickMs: 60 * 60 * 1000,
    ...(over.leaseMs === undefined ? {} : { leaseMs: over.leaseMs }),
    apply: over.apply ?? standInApply,
    log: { info: (m) => lines.push(m), error: (m) => lines.push(`ERROR ${m}`) },
  });
  cleanups.push(() => runner.stop());
  return { runner, lines };
}

const turnsOf = (ctx: Ctx, itemId: number) =>
  (ctx.db.prepare('SELECT id FROM lead_turns WHERE item_id = ? ORDER BY id').pluck().all(itemId) as number[]).map((id) => getTurn(ctx.db, id)!);

describe('the turn runner', () => {
  it('runs one item in one turn, applied once: the item done with the outcome, the turn with its costs, one reading per rate_limit_info', async () => {
    const w = world();
    const item = w.add();
    const way = quickWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('done'));
    expect(way.calls).toHaveLength(1);
    const input = way.calls[0]!;
    expect(input).toMatchObject({ slug: w.project.slug, model: 'claude-opus-5-5', item: { id: item.id } });
    expect(input.toolsEnv).toEqual({ INPROGRESS_HOME: 'C:/home', INPROGRESS_PORT: '4410', INPROGRESS_LEAD_AS: 'Progresser', INPROGRESS_LEAD_REPO: BOUND });
    expect(input.systemPrompt).toContain('Use at most eight tool calls.');
    expect(input.systemPrompt).toContain('Standing rulings');
    expect(input.userMessage).toContain(`Step #${w.step.id}: Build tabs`);
    expect(input.userMessage.trim().endsWith('Look before you answer.')).toBe(true);
    expect(getDeskItem(w.ctx.db, item.id)).toMatchObject({ state: 'done', outcome: 'DECIDE: Use port 4410.' });
    const turns = turnsOf(w.ctx, item.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      state: 'applied', way: 'headless', model: 'claude-opus-5-5', verdict: 'DECIDE', kind: 'TECHNICAL', answer: 'Use port 4410.', why: 'It is free.',
      costUsd: 0.12, durationMs: 3400, tokensIn: 1000, tokensOut: 200, refusedTools: ['Read'],
    });
    expect(turns[0]!.startedAt).not.toBeNull();
    expect(turns[0]!.finishedAt).not.toBeNull();
    const readings = w.ctx.db.prepare('SELECT * FROM usage_readings ORDER BY id').all();
    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({
      source: 'turn', turn_id: turns[0]!.id, model: 'claude-opus-5-5', window_used: 0.47, window_resets: '2026-11-25T14:00:00.000Z',
      week_used: 0.31, week_resets: '2026-11-30T00:00:00.000Z', other: '{"seven_day_opus":0.12}',
    });
    // Kicked again, nothing more runs.
    runner.kick(w.project.id);
    await new Promise((r) => setImmediate(r));
    expect(way.calls).toHaveLength(1);
  });

  it('wakes on a new desk item once started', async () => {
    const w = world();
    const way = quickWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.start();
    w.tick(MIN);
    handleHookEvent(w.ctx, 's1', { event: 'start', source: 'startup', cwd: BOUND });
    const { ask } = raiseAskDetailed(w.ctx, 'scribe:s1', { nodeId: w.step.id, kind: 'question', text: 'Which port?', sessionId: 's1' });
    await vi.waitFor(() => expect(way.calls).toHaveLength(1));
    expect(way.calls[0]!.userMessage).toContain('Which port?');
    expect(way.calls[0]!.userMessage).toContain('Session: s1');
    expect(way.calls[0]!.item.ref).toBe(String(ask.id));
  });

  it('applies an answer saved before a stop, at the next start, without running the turn again', async () => {
    const w = world();
    const item = w.add();
    const turn = leaseItem(w.ctx.db, item.id, { way: 'headless', model: 'claude-opus-5-5', leaseMs: 6 * MIN }, w.clock())!;
    expect(saveAnswer(w.ctx.db, turn.id, { verdict: 'CARD', kind: 'NONE', answer: 'The checks are green.', why: 'Landing is the check.' }, w.clock())).toBe(true);
    // The server stopped here. A new runner starts on the same database, well past the lease.
    w.tick(10 * MIN);
    const way = quickWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.start();
    expect(getTurn(w.ctx.db, turn.id)!.state).toBe('applied');
    expect(getDeskItem(w.ctx.db, item.id)).toMatchObject({ state: 'done', outcome: 'CARD: The checks are green.' });
    await new Promise((r) => setImmediate(r));
    expect(way.calls).toHaveLength(0);
    expect(turnsOf(w.ctx, item.id)).toHaveLength(1);
  });

  it('abandons a lease past its time with no answer, reopens the item and runs it again on the tick', async () => {
    const w = world();
    const item = w.add();
    const dead = leaseItem(w.ctx.db, item.id, { way: 'headless', leaseMs: 6 * MIN }, w.clock())!;
    const way = quickWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.tick();
    expect(way.calls).toHaveLength(0);
    w.tick(6 * MIN + 1000);
    runner.tick();
    expect(getTurn(w.ctx.db, dead.id)).toMatchObject({ state: 'abandoned', why: 'the lease ran out with no answer' });
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('done'));
    expect(way.calls).toHaveLength(1);
    expect(turnsOf(w.ctx, item.id).map((t) => t.state)).toEqual(['abandoned', 'applied']);
  });

  it('leaves an item behind after two failures and never leases it again', async () => {
    const w = world();
    const item = w.add();
    const dead = leaseItem(w.ctx.db, item.id, { way: 'headless', leaseMs: 6 * MIN }, w.clock())!;
    w.tick(7 * MIN);
    const way = quickWay(() => {
      throw new Error('claude exited with code 1');
    });
    const { runner } = runnerOn(w.ctx, way);
    runner.tick();
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('behind'));
    expect(getTurn(w.ctx.db, dead.id)!.state).toBe('abandoned');
    expect(turnsOf(w.ctx, item.id).map((t) => [t.state, t.why])).toEqual([
      ['abandoned', 'the lease ran out with no answer'],
      ['failed', 'the headless run failed: claude exited with code 1'],
    ]);
    runner.tick();
    runner.kick(w.project.id);
    await new Promise((r) => setImmediate(r));
    expect(way.calls).toHaveLength(1);
  });

  it('fails a turn whose answer does not parse, keeping its cost, and reopens the item', async () => {
    const w = world();
    const item = w.add();
    const way = quickWay(() => output({ text: 'decide\nKIND: TECHNICAL\nANSWER: x\nWHY: y' }));
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    await vi.waitFor(() => expect(turnsOf(w.ctx, item.id)[0]!.state).toBe('failed'));
    expect(turnsOf(w.ctx, item.id)[0]).toMatchObject({ costUsd: 0.12, tokensIn: 1000, why: expect.stringContaining('the answer did not parse: the verdict line is "decide"') });
    expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('open');
    // A failed item is not leased again at once: the next tick takes it, and its second failure leaves it behind.
    await new Promise((r) => setImmediate(r));
    expect(way.calls).toHaveLength(1);
    runner.tick();
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('behind'));
    expect(way.calls).toHaveLength(2);
  });

  it('two runners on one database, one item: the way runs once, one applies, the other finds it taken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lead-runner-'));
    const file = join(dir, 'inprogress.db');
    const w = world(file);
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const otherCtx = w.other(file);
    cleanups.push(() => void otherCtx.db.close());
    const item = w.add();
    const way = heldWay();
    const a = runnerOn(w.ctx, way);
    const b = runnerOn(otherCtx, way);
    a.runner.kick(w.project.id);
    b.runner.kick(w.project.id);
    b.runner.tick();
    expect(way.calls).toHaveLength(1);
    expect(leaseItem(otherCtx.db, item.id, { way: 'headless', leaseMs: 6 * MIN }, w.clock())).toBeUndefined();
    way.release(0);
    await vi.waitFor(() => expect(getDeskItem(otherCtx.db, item.id)!.state).toBe('done'));
    const [turn] = turnsOf(otherCtx, item.id);
    const effect = vi.fn(standInApply);
    expect(applyTurn(otherCtx.db, turn!.id, w.clock(), (t, i) => effect(otherCtx, t, i))).toBe(false);
    expect(effect).not.toHaveBeenCalled();
    expect(getTurn(otherCtx.db, turn!.id)!.state).toBe('applied');
    b.runner.tick();
    expect(way.calls).toHaveLength(1);
  });

  it('runs at most two reflex turns at once per project, and an old ask in its own lane beside them', async () => {
    const w = world();
    const [q1, q2, q3] = [w.add(), w.add(), w.add()];
    const old = w.add('old_ask', '77');
    const way = heldWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    expect(way.calls.map((c) => c.item.id)).toEqual([q1!.id, q2!.id, old.id]);
    expect(getDeskItem(w.ctx.db, q3!.id)!.state).toBe('open');
    runner.kick(w.project.id);
    expect(way.calls).toHaveLength(3);
    way.release(0);
    await vi.waitFor(() => expect(way.calls).toHaveLength(4));
    expect(way.calls[3]!.item.id).toBe(q3!.id);
    expect(getDeskItem(w.ctx.db, q1!.id)!.state).toBe('done');
    for (const i of [1, 2, 3]) way.release(i);
    await vi.waitFor(() => expect([q2, q3, old].map((i) => getDeskItem(w.ctx.db, i!.id)!.state)).toEqual(['done', 'done', 'done']));
  });

  it('abandons the turn of an item cleared while it ran, and applies nothing', async () => {
    const w = world();
    handleHookEvent(w.ctx, 's1', { event: 'start', source: 'startup', cwd: BOUND });
    w.tick(1000);
    const { ask } = raiseAskDetailed(w.ctx, 'scribe:s1', { nodeId: w.step.id, kind: 'question', text: 'Which port?', sessionId: 's1' });
    const item = w.ctx.db.prepare("SELECT id FROM desk_items WHERE kind = 'question' AND ref = ?").pluck().get(String(ask.id)) as number;
    const way = heldWay();
    const apply = vi.fn(standInApply);
    const { runner } = runnerOn(w.ctx, way, { apply });
    runner.kick(w.project.id);
    expect(way.calls).toHaveLength(1);
    clearAsk(w.ctx, 'window', ask.id, '4410');
    expect(getDeskItem(w.ctx.db, item)).toMatchObject({ state: 'done', outcome: 'cleared by window' });
    way.release(0);
    await vi.waitFor(() => expect(turnsOf(w.ctx, item)[0]!.state).toBe('abandoned'));
    expect(apply).not.toHaveBeenCalled();
    expect(turnsOf(w.ctx, item)[0]).toMatchObject({ verdict: 'DECIDE', answer: 'Use port 4410.' });
    expect(getDeskItem(w.ctx.db, item)).toMatchObject({ state: 'done', outcome: 'cleared by window' });
  });

  it('runs no turn for a project whose round is off', async () => {
    const w = world();
    const item = w.add();
    leadDisallow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'round' });
    const way = quickWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.start();
    runner.kick(w.project.id);
    await new Promise((r) => setImmediate(r));
    expect(way.calls).toHaveLength(0);
    expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('open');
    expect(turnsOf(w.ctx, item.id)).toHaveLength(0);
  });

  it('stopped mid-turn, aborts the run and interrupts the turn, the item open for the next start and not counted', async () => {
    const w = world();
    const item = w.add();
    const way = heldWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    expect(way.calls).toHaveLength(1);
    await runner.stop();
    expect(turnsOf(w.ctx, item.id)[0]).toMatchObject({ state: 'interrupted', why: 'the server stopped during the turn' });
    expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('open');
    runner.kick(w.project.id);
    expect(way.calls).toHaveLength(1);
  });

  it('stops within its deadline a run that ignores the abort', async () => {
    const w = world();
    w.add();
    const way: TurnWay = { name: 'headless', run: () => new Promise<TurnOutput>(() => undefined) };
    const { runner, lines } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    const t0 = Date.now();
    await runner.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(lines.some((l) => l.includes('did not end within'))).toBe(true);
  });

  it('fails a run still going 30 seconds before its lease ends, which counts against the item', async () => {
    const w = world();
    const item = w.add();
    const way = heldWay();
    const { runner } = runnerOn(w.ctx, way, { leaseMs: ABORT_BEFORE_LEASE_END_MS + 50 });
    runner.kick(w.project.id);
    await vi.waitFor(() => expect(turnsOf(w.ctx, item.id)[0]!.state).toBe('failed'));
    expect(turnsOf(w.ctx, item.id)[0]!.why).toContain('seconds before its lease ends');
    expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('open');
  });

  it('a runner fault interrupts the turn with its cost and readings, does not count as a failure, and backs the project off', async () => {
    const w = world();
    const [a, b] = [w.add(), w.add()];
    const way = quickWay(() => {
      throw new TurnRunError('the turn ended with error_during_execution: Not logged in', { rateLimits: [RATE], costUsd: 0.05, tokensIn: 10, tokensOut: 2, durationMs: 700, model: 'm' }, true);
    });
    const { runner, lines } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    await vi.waitFor(() => expect(way.calls).toHaveLength(2));
    await vi.waitFor(() => expect(turnsOf(w.ctx, b.id)[0]?.state).toBe('interrupted'));
    const [t] = turnsOf(w.ctx, a.id);
    expect(t).toMatchObject({ state: 'interrupted', costUsd: 0.05, tokensIn: 10, tokensOut: 2, durationMs: 700, why: expect.stringContaining('Not logged in') });
    expect(w.ctx.db.prepare('SELECT COUNT(*) FROM usage_readings WHERE turn_id = ?').pluck().get(t!.id)).toBe(1);
    expect([a, b].map((i) => getDeskItem(w.ctx.db, i.id)!.state)).toEqual(['open', 'open']);
    expect(lines.filter((l) => l.includes('backs off'))).toHaveLength(1);
    // Backed off: no lease for five minutes.
    runner.tick();
    w.tick(FAULT_BACKOFF_MS - 1000);
    runner.tick();
    await new Promise((r) => setImmediate(r));
    expect(way.calls).toHaveLength(2);
    // Then one try, not two at once.
    w.tick(2000);
    runner.tick();
    expect(way.calls).toHaveLength(3);
    await vi.waitFor(() => expect(turnsOf(w.ctx, a.id).length + turnsOf(w.ctx, b.id).length).toBe(3));
    await new Promise((r) => setImmediate(r));
    // A fault is not a failure: neither item has three in a row yet, so both stay open.
    expect([a, b].map((i) => getDeskItem(w.ctx.db, i.id)!.state)).toEqual(['open', 'open']);
  });

  it('stops at the next tick a run whose item left the desk, interrupting its turn', async () => {
    const w = world();
    handleHookEvent(w.ctx, 's1', { event: 'start', source: 'startup', cwd: BOUND });
    w.tick(1000);
    const { ask } = raiseAskDetailed(w.ctx, 'scribe:s1', { nodeId: w.step.id, kind: 'question', text: 'Which port?', sessionId: 's1' });
    const item = w.ctx.db.prepare("SELECT id FROM desk_items WHERE kind = 'question' AND ref = ?").pluck().get(String(ask.id)) as number;
    const way = heldWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    clearAsk(w.ctx, 'window', ask.id, '4410');
    runner.tick();
    await vi.waitFor(() => expect(turnsOf(w.ctx, item)[0]!.state).toBe('interrupted'));
    expect(turnsOf(w.ctx, item)[0]!.why).toBe('the item left the desk during the turn');
    expect(getDeskItem(w.ctx.db, item)).toMatchObject({ state: 'done', outcome: 'cleared by window' });
  });

  it('stops at the next tick a run whose project had its round switched off, the item open again', async () => {
    const w = world();
    const item = w.add();
    const way = heldWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    leadDisallow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'round' });
    runner.tick();
    await vi.waitFor(() => expect(turnsOf(w.ctx, item.id)[0]!.state).toBe('interrupted'));
    expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('open');
  });
  it('counts an error_max_turns run against the item: the turn fails', async () => {
    const w = world();
    const item = w.add();
    const way = quickWay(() => {
      throw new TurnRunError('the turn ended with error_max_turns: (no result text)', { rateLimits: [] }, false);
    });
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    await vi.waitFor(() => expect(turnsOf(w.ctx, item.id)[0]?.state).toBe('failed'));
    expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('open');
  });

  it('puts an item behind after three runner faults in a row, so it cannot hold its lane', async () => {
    const w = world();
    const item = w.add();
    const way = quickWay(() => {
      throw new TurnRunError('the turn ended with error_during_execution: Prompt is too long', { rateLimits: [] }, true);
    });
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(turnsOf(w.ctx, item.id)[i]?.state).toBe('interrupted'));
      expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('open');
      await new Promise((r) => setImmediate(r));
      w.tick(FAULT_BACKOFF_MS + 1000);
      runner.tick();
    }
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('behind'));
    expect(turnsOf(w.ctx, item.id).map((t) => t.state)).toEqual(['interrupted', 'interrupted', 'interrupted']);
    expect(turnsOf(w.ctx, item.id)[2]!.why).toMatch(/^the runner could not run the turn: /);
  });

  it("keeps a back-off a sibling's fault set when another run then ends ok (R1)", async () => {
    const w = world();
    const [a, b] = [w.add(), w.add()];
    const calls: TurnInput[] = [];
    let release: ((o: TurnOutput) => void) | undefined;
    const way: TurnWay = {
      name: 'headless',
      run: (input) => {
        calls.push(input);
        if (calls.length === 1) return new Promise<TurnOutput>((r) => (release = r));
        return Promise.reject(new TurnRunError('the turn ended with error_during_execution: Not logged in', { rateLimits: [] }, true));
      },
    };
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    expect(calls.map((c) => c.item.id)).toEqual([a.id, b.id]);
    await vi.waitFor(() => expect(turnsOf(w.ctx, b.id)[0]?.state).toBe('interrupted'));
    release!(output());
    await vi.waitFor(() => expect(turnsOf(w.ctx, a.id)[0]?.state).toBe('applied'));
    await new Promise((r) => setTimeout(r, 20));
    // Still backed off: b is not leased again until the back-off runs out.
    expect(calls).toHaveLength(2);
    w.tick(FAULT_BACKOFF_MS + 1000);
    runner.tick();
    expect(calls).toHaveLength(3);
  });

  it('drops an expired back-off when the one try ends failed, so the lanes fill again (R2)', async () => {
    const w = world();
    const a = w.add();
    const calls: TurnInput[] = [];
    const way: TurnWay = {
      name: 'headless',
      run: (input, signal) => {
        calls.push(input);
        if (calls.length === 1) return Promise.reject(new TurnRunError('the turn ended with error_during_execution: Not logged in', { rateLimits: [] }, true));
        if (calls.length === 2) return Promise.resolve(output({ text: 'nonsense' }));
        return new Promise<TurnOutput>((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }));
      },
    };
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    await vi.waitFor(() => expect(turnsOf(w.ctx, a.id)[0]?.state).toBe('interrupted'));
    w.tick(FAULT_BACKOFF_MS + 1000);
    runner.tick();
    await vi.waitFor(() => expect(turnsOf(w.ctx, a.id)[1]?.state).toBe('failed'));
    await new Promise((r) => setTimeout(r, 20));
    w.add();
    w.add();
    runner.tick();
    // Two reflex turns at once, not one at a time.
    expect(calls).toHaveLength(4);
  });

  it('keeps an expired back-off when the one try is interrupted because its item left, so still one try at a time (G2)', async () => {
    const w = world();
    const a = w.add();
    const calls: TurnInput[] = [];
    const way: TurnWay = {
      name: 'headless',
      run: (input, signal) => {
        calls.push(input);
        if (calls.length === 1) return Promise.reject(new TurnRunError('the turn ended with error_during_execution: Not logged in', { rateLimits: [] }, true));
        return new Promise<TurnOutput>((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }));
      },
    };
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    await vi.waitFor(() => expect(turnsOf(w.ctx, a.id)[0]?.state).toBe('interrupted'));
    w.tick(FAULT_BACKOFF_MS + 1000);
    runner.tick();
    expect(calls).toHaveLength(2);
    // The one try's item leaves the desk: its run is interrupted, which proves nothing about claude.
    w.ctx.db.prepare("UPDATE desk_items SET state = 'done', outcome = 'cleared by window' WHERE id = ?").run(a.id);
    runner.tick();
    await vi.waitFor(() => expect(turnsOf(w.ctx, a.id)[1]?.state).toBe('interrupted'));
    await new Promise((r) => setTimeout(r, 20));
    w.add();
    w.add();
    runner.tick();
    // Still one try at a time: one lease, not two.
    expect(calls).toHaveLength(3);
  });

  it('a run that fails with an error result (a result line read) drops an expired back-off; one killed with none does not (G2)', async () => {
    for (const resultRead of [true, false]) {
      const w = world();
      const a = w.add();
      const calls: TurnInput[] = [];
      const way: TurnWay = {
        name: 'headless',
        run: (input, signal) => {
          calls.push(input);
          if (calls.length === 1) return Promise.reject(new TurnRunError('the turn ended with error_during_execution: Not logged in', { rateLimits: [] }, true));
          if (calls.length === 2) return Promise.reject(new TurnRunError('the turn ended with error_max_turns: (no result text)', { rateLimits: [], ...(resultRead ? { resultRead } : {}) }, false));
          return new Promise<TurnOutput>((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }));
        },
      };
      const { runner } = runnerOn(w.ctx, way);
      runner.kick(w.project.id);
      await vi.waitFor(() => expect(turnsOf(w.ctx, a.id)[0]?.state).toBe('interrupted'));
      w.tick(FAULT_BACKOFF_MS + 1000);
      runner.tick();
      await vi.waitFor(() => expect(turnsOf(w.ctx, a.id)[1]?.state).toBe('failed'));
      await new Promise((r) => setTimeout(r, 20));
      w.add();
      w.add();
      runner.tick();
      expect(calls).toHaveLength(resultRead ? 4 : 3);
      await runner.stop();
    }
  });

  it('reopens the items a usage-limit stretch put behind at the first ok turn after it; an item behind on two real failures stays behind (G1)', async () => {
    const w = world();
    let mode: 'fail' | 'fault' | 'ok' = 'fail';
    const way = quickWay(() => {
      if (mode === 'fault') throw new TurnRunError('the turn ended with error_during_execution: Usage limit reached', { rateLimits: [] }, true);
      return output(mode === 'fail' ? { text: 'nonsense' } : {});
    });
    const { runner, lines } = runnerOn(w.ctx, way);
    // Two real failures: behind for good.
    const failing = w.add();
    runner.kick(w.project.id);
    await vi.waitFor(() => expect(turnsOf(w.ctx, failing.id)[0]?.state).toBe('failed'));
    await new Promise((r) => setImmediate(r));
    runner.tick();
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, failing.id)!.state).toBe('behind'));
    // The usage-limit stretch: three faults in a row put the next item behind.
    mode = 'fault';
    const limited = w.add();
    runner.kick(w.project.id);
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(turnsOf(w.ctx, limited.id)[i]?.state).toBe('interrupted'));
      await new Promise((r) => setImmediate(r));
      w.tick(FAULT_BACKOFF_MS + 1000);
      runner.tick();
    }
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, limited.id)!.state).toBe('behind'));
    // The limit lifts: the next turn ends ok, and the item behind on faults alone is open again and runs.
    mode = 'ok';
    await new Promise((r) => setImmediate(r));
    const fresh = w.add();
    w.tick(FAULT_BACKOFF_MS + 1000);
    runner.tick();
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, fresh.id)!.state).toBe('done'));
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, limited.id)!.state).toBe('done'));
    expect(turnsOf(w.ctx, limited.id).map((t) => t.state)).toEqual(['interrupted', 'interrupted', 'interrupted', 'applied']);
    expect(lines.some((l) => l.includes(`#${limited.id}, behind on runner faults, are open again`))).toBe(true);
    expect(getDeskItem(w.ctx.db, failing.id)!.state).toBe('behind');
  });
  it("T2: an item whose own fault reads as the runner's is reopened once; faulting again, it stays behind and backs the project off no more", async () => {
    const w = world();
    const tooLong = w.add();
    const way = quickWay((input) => {
      if (input.userMessage.includes(`#${tooLong.id},`)) throw new TurnRunError('the turn ended with error_during_execution: Prompt is too long', { rateLimits: [] }, true);
      return output({});
    });
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(turnsOf(w.ctx, tooLong.id)[i]?.state).toBe('interrupted'));
      await new Promise((r) => setImmediate(r));
      w.tick(FAULT_BACKOFF_MS + 1000);
      runner.tick();
    }
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, tooLong.id)!.state).toBe('behind'));
    // An ok turn: the item is reopened, once, and faults again.
    const ok = w.add();
    w.tick(FAULT_BACKOFF_MS + 1000);
    runner.tick();
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, ok.id)!.state).toBe('done'));
    await vi.waitFor(() => expect(turnsOf(w.ctx, tooLong.id)).toHaveLength(4));
    await vi.waitFor(() => expect(getDeskItem(w.ctx.db, tooLong.id)!.state).toBe('behind'));
    expect(turnsOf(w.ctx, tooLong.id)[2]!.why).toContain(REOPENED_MARK);
    // More ok turns: it stays behind, and is never run again.
    for (let i = 0; i < 2; i++) {
      const more = w.add();
      w.tick(FAULT_BACKOFF_MS + 1000);
      runner.tick();
      await vi.waitFor(() => expect(getDeskItem(w.ctx.db, more.id)!.state).toBe('done'));
    }
    await new Promise((r) => setImmediate(r));
    expect(getDeskItem(w.ctx.db, tooLong.id)!.state).toBe('behind');
    expect(turnsOf(w.ctx, tooLong.id)).toHaveLength(4);
  });
});

describe('leaseItem', () => {
  it('refuses an open item that already has a live turn, and leaves the item open', () => {
    const w = world();
    const item = w.add();
    insertTurn(w.ctx.db, { itemId: item.id, way: 'headless', leaseMs: MIN }, w.clock());
    expect(leaseItem(w.ctx.db, item.id, { way: 'headless', leaseMs: MIN }, w.clock())).toBeUndefined();
    expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('open');
  });
});

/** A stand-in for `claude`: records its argv, env, cwd and stdin, then prints a canned stream, fails, or hangs. */
const STUB = `
import { readFileSync, writeFileSync } from 'node:fs';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const file = (flag) => (argv.includes(flag) ? readFileSync(argv[argv.indexOf(flag) + 1], 'utf8') : null);
  writeFileSync(process.env.STUB_RECORD, JSON.stringify({ argv, env: process.env, cwd: process.cwd(), stdin, pid: process.pid, prompt: file('--system-prompt-file'), tools: file('--mcp-config') }));
  const mode = process.env.STUB_MODE;
  if (mode === 'noresult') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'x' }) + '\\n');
    process.stderr.write('starting\\nError: not logged in\\n');
    process.exit(3);
  }
  if (mode === 'hang') {
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === 'maxturns') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.02, duration_ms: 50, usage: { input_tokens: 5, output_tokens: 1 } }) + '\\n');
    return;
  }
  if (mode === 'iserror') {
    process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: ${JSON.stringify(RATE)} }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in', total_cost_usd: 0.01, duration_ms: 90, usage: { input_tokens: 5, output_tokens: 1 } }) + '\\n');
    return;
  }
  const out = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5-20261101' },
    { type: 'rate_limit_event', rate_limit_info: ${JSON.stringify(RATE)} },
    'not json at all',
    { type: 'assistant', message: { content: [] } },
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5 } } } },
    { type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(ANSWER)}, total_cost_usd: 0.23, duration_ms: 4100,
      usage: { input_tokens: 1500, output_tokens: 300 }, permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }] },
  ];
  process.stdout.write(out.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\\n') + (mode === 'linger' ? '\\n' : ''));
  // linger: the answer is out, but the program does not exit (an MCP server holding it open).
  if (mode === 'linger') setInterval(() => undefined, 1000);
});
`;

describe('the headless way', () => {
  function stubSetup(mode: string, claude?: (dir: string, stub: string) => string, extra: Partial<HeadlessOptions> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'lead-headless-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows can hold a killed stub's working folder for seconds after it ends: the scratch folder stays in the temp folder.
      }
    });
    const stub = join(dir, 'claude-stub.mjs');
    writeFileSync(stub, STUB);
    const record = join(dir, 'record.json');
    const env = {
      ...process.env,
      STUB_MODE: mode,
      STUB_RECORD: record,
      KEEP_ME: 'yes',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      claude_code_session_lowercase: 'x',
      CLAUDE_CODE_MESSAGING_EXTRA: 'x',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe',
      CLAUDE_CODE_OAUTH_TOKEN: 'token',
      CLAUDE_AGENT_SDK_VERSION: '1.0',
      T3CODE_THREAD_ID: 't',
      CLAUDE_PID: '123',
      CLAUDE_EFFORT: 'high',
    };
    const leadDir = (slug: string) => join(dir, 'home', 'lead', slug);
    const way = headlessWay({ claudePath: claude ? claude(dir, stub) : stub, leadDir, toolsEntry: 'C:/dist/lead/tools.js', env, ...extra });
    const input: TurnInput = {
      turnId: 7,
      slug: 'ingame',
      item: { id: 1, projectId: 1, kind: 'question', ref: '5', nodeId: 2, createdAt: '2026-11-25T09:00:00.000Z', dueAt: null, state: 'leased', doneAt: null, outcome: null },
      systemPrompt: 'You are the lead.\nAnswer in four lines.',
      userMessage: 'A session asks Aiden a question.\nLook before you answer.',
      model: 'claude-opus-5-5',
      toolsEnv: { INPROGRESS_HOME: 'C:/home', INPROGRESS_PORT: '4410', INPROGRESS_LEAD_AS: 'Progresser', INPROGRESS_LEAD_REPO: BOUND },
    };
    const read = () =>
      JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; env: Record<string, string>; cwd: string; stdin: string; pid: number; prompt: string | null; tools: string | null };
    return { dir, way, input, read, lead: leadDir('ingame'), record };
  }

  it('runs the program with the agreed argv, in the lead folder, without the session variables, and reads its stream', async () => {
    const s = stubSetup('ok');
    const out = await s.way.run(s.input, new AbortController().signal);
    const rec = s.read();
    const promptFile = join(s.lead, 'desk-turn-7.md');
    const toolsFile = join(s.lead, 'tools-7.json');
    expect(rec.argv).toEqual([
      '-p', '--model', 'claude-opus-5-5', '--system-prompt-file', promptFile, '--setting-sources', 'project', '--strict-mcp-config',
      '--mcp-config', toolsFile, '--tools', '', '--allowedTools', 'mcp__inprogress-lead', '--output-format', 'stream-json', '--verbose',
      '--max-turns', '14', '--no-session-persistence',
    ]);
    expect(rec.cwd.toLowerCase()).toBe(s.lead.toLowerCase());
    expect(rec.stdin).toBe(s.input.userMessage);
    const names = Object.keys(rec.env).map((k) => k.toUpperCase());
    const gone = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_LOWERCASE', 'CLAUDE_CODE_MESSAGING_EXTRA', 'CLAUDE_AGENT_SDK_VERSION', 'T3CODE_THREAD_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT'];
    for (const name of gone) expect(names).not.toContain(name);
    expect(rec.env).toMatchObject({ KEEP_ME: 'yes', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', CLAUDE_CODE_OAUTH_TOKEN: 'token' });
    expect(rec.prompt).toBe(s.input.systemPrompt);
    // The turn's own files are gone once it ends; the settings file stays for the next.
    expect(existsSync(promptFile)).toBe(false);
    expect(existsSync(toolsFile)).toBe(false);
    expect(JSON.parse(rec.tools!)).toEqual({
      mcpServers: { 'inprogress-lead': { command: process.execPath, args: ['C:/dist/lead/tools.js', 'ingame'], env: s.input.toolsEnv } },
    });
    expect(JSON.parse(readFileSync(join(s.lead, '.claude', 'settings.json'), 'utf8'))).toEqual({});
    expect(out).toEqual({
      text: ANSWER,
      costUsd: 0.23,
      durationMs: 4100,
      tokensIn: 1500,
      tokensOut: 300,
      refusedTools: ['Bash'],
      rateLimits: [RATE, { unifiedWindows: { five_hour: { utilization: 0.5 } } }],
      model: 'claude-opus-5-5-20261101',
    });
  });

  it('fails a run that exits without a result line, with the stderr tail, as a runner fault', async () => {
    const s = stubSetup('noresult');
    const err = await s.way.run(s.input, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnRunError);
    expect((err as TurnRunError).message).toMatch(/exited with code 3 and no result line: starting\s+Error: not logged in/);
    expect((err as TurnRunError).runnerFault).toBe(true);
  });

  it('fails an is_error result as a runner fault, keeping its cost and rate limits', async () => {
    const s = stubSetup('iserror');
    const err = (await s.way.run(s.input, new AbortController().signal).catch((e: unknown) => e)) as TurnRunError;
    expect(err).toBeInstanceOf(TurnRunError);
    expect(err.message).toBe('the turn ended with error_during_execution: Not logged in');
    expect(err.runnerFault).toBe(true);
    expect(err.partial).toMatchObject({ rateLimits: [RATE], costUsd: 0.01, durationMs: 90, tokensIn: 5, tokensOut: 1 });
  });

  it('fails a program that cannot start as a runner fault, and removes the turn files', async () => {
    const s = stubSetup('ok', (dir) => join(dir, 'no-such-claude.exe'));
    const err = (await s.way.run(s.input, new AbortController().signal).catch((e: unknown) => e)) as TurnRunError;
    expect(err).toBeInstanceOf(TurnRunError);
    expect(err.message).toContain('could not start');
    expect(err.runnerFault).toBe(true);
    expect(existsSync(join(s.lead, 'desk-turn-7.md'))).toBe(false);
  });

  it('answers from the result line of a run that lingers, killing it after', async () => {
    const s = stubSetup('linger');
    const out = await s.way.run(s.input, new AbortController().signal);
    expect(out.text).toBe(ANSWER);
    const { pid } = s.read();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 });
  }, 20_000);

  it.runIf(process.platform === 'win32')('runs a .cmd through cmd.exe with the same argv, and finds claude.cmd on PATH', async () => {
    const s = stubSetup('ok', (dir, stub) => {
      const cmd = join(dir, 'claude.cmd');
      writeFileSync(cmd, `@"${process.execPath}" "${stub}" %*\r\n`);
      return cmd;
    });
    const out = await s.way.run(s.input, new AbortController().signal);
    expect(out.text).toBe(ANSWER);
    expect(s.read().argv).toEqual([
      '-p', '--model', 'claude-opus-5-5', '--system-prompt-file', join(s.lead, 'desk-turn-7.md'), '--setting-sources', 'project', '--strict-mcp-config',
      '--mcp-config', join(s.lead, 'tools-7.json'), '--tools', '', '--allowedTools', 'mcp__inprogress-lead', '--output-format', 'stream-json', '--verbose',
      '--max-turns', '14', '--no-session-persistence',
    ]);
    expect(resolveProgram('claude', { PATH: s.dir }, 'win32')).toEqual({ command: join(s.dir, 'claude.cmd'), prefix: [], viaCmd: true });
  });

  it('fails an error_max_turns result as the item\'s failure, not a runner fault', async () => {
    const s = stubSetup('maxturns');
    const err = (await s.way.run(s.input, new AbortController().signal).catch((e: unknown) => e)) as TurnRunError;
    expect(err).toBeInstanceOf(TurnRunError);
    expect(err.message).toContain('error_max_turns');
    expect(err.runnerFault).toBe(false);
  });

  it('answers from a result line read before an abort, even when the run then hangs', async () => {
    const s = stubSetup('linger');
    const controller = new AbortController();
    const run = s.way.run(s.input, controller.signal);
    await vi.waitFor(() => expect(existsSync(s.record)).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 500));
    controller.abort(new Error('the server stopped during the turn'));
    expect((await run).text).toBe(ANSWER);
  }, 20_000);

  it('a disk fault writing the turn files is a runner fault, and removes what was written (R3)', async () => {
    const s = stubSetup('ok');
    mkdirSync(join(s.lead, 'tools-7.json'), { recursive: true });
    const err = (await s.way.run(s.input, new AbortController().signal).catch((e: unknown) => e)) as TurnRunError;
    expect(err).toBeInstanceOf(TurnRunError);
    expect(err.message).toContain('could not start');
    expect(err.runnerFault).toBe(true);
    expect(existsSync(join(s.lead, 'desk-turn-7.md'))).toBe(false);
  });

  it('a spawn that throws is a runner fault, and removes the turn files (R3)', async () => {
    const s = stubSetup('ok', (dir) => join(dir, 'bad\0name.js'));
    const err = (await s.way.run(s.input, new AbortController().signal).catch((e: unknown) => e)) as TurnRunError;
    expect(err).toBeInstanceOf(TurnRunError);
    expect(err.runnerFault).toBe(true);
    expect(existsSync(join(s.lead, 'desk-turn-7.md'))).toBe(false);
    expect(existsSync(join(s.lead, 'tools-7.json'))).toBe(false);
  });

  it('settles an aborted run whose kill did nothing, after the grace (R4)', async () => {
    const kills: (() => void)[] = [];
    const s = stubSetup('hang', undefined, { killTree: (_pid, kill) => void kills.push(kill), killGraceMs: 300 });
    const controller = new AbortController();
    const run = s.way.run(s.input, controller.signal);
    await vi.waitFor(() => expect(existsSync(s.record)).toBe(true), { timeout: 10_000 });
    const { pid } = s.read();
    // Ended before its folder is removed (cleanups run last first): Windows will not remove a folder a process runs in.
    cleanups.push(async () => {
      // The run's own fallback kill, through its ChildProcess, so the process and its handles are closed.
      kills[0]?.();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 });
    });
    controller.abort(new Error('the lease is ending'));
    await expect(run).rejects.toThrow('the lease is ending');
    expect(kills).toHaveLength(1);
    // The run was settled while its process still lived.
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it('quotes for cmd.exe: a quote and % are refused, ! passes (R6)', () => {
    expect(cmdQuote('wow!')).toBe('"wow!"');
    expect(() => cmdQuote('say "hi"')).toThrow(/quote, % or a line break/);
    expect(() => cmdQuote('100%')).toThrow(/quote, % or a line break/);
  });

  it('runs taskkill by its system path, and falls back to the kill when taskkill fails (R6)', async () => {
    expect(taskkillPath({ SystemRoot: 'C:\\Windows' })).toBe(join('C:\\Windows', 'System32', 'taskkill.exe'));
    expect(taskkillPath({})).toBe('taskkill');
    const kill = vi.fn();
    killTree(999_999, kill, { platform: 'win32', taskkill: join(tmpdir(), 'no-such-dir-xyz', 'taskkill.exe') });
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
  });

  it('kills the run on abort', async () => {
    const s = stubSetup('hang');
    const controller = new AbortController();
    const run = s.way.run(s.input, controller.signal);
    await vi.waitFor(() => expect(existsSync(s.record)).toBe(true), { timeout: 10_000 });
    const { pid } = s.read();
    controller.abort(new Error('the lease is ending'));
    await expect(run).rejects.toThrow('the lease is ending');
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 });
  });
});
