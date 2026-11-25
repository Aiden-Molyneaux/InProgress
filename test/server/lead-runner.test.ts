import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { openDb } from '../../src/server/db/connection';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { leadAllow, leadDisallow } from '../../src/server/lead-commands';
import { createRunner, headlessWay, standInApply, type Runner, type TurnInput, type TurnOutput, type TurnWay } from '../../src/server/lead/runner';
import { clearAsk, raiseAskDetailed } from '../../src/server/repo/asks';
import { addDeskItem, getDeskItem, type DeskItem, type DeskItemKind } from '../../src/server/repo/desk';
import { applyTurn, getTurn, leaseItem, saveAnswer, type LeadTurn } from '../../src/server/repo/leadTurns';
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

function runnerOn(ctx: Ctx, way: TurnWay, over: { apply?: (ctx: Ctx, turn: LeadTurn, item: DeskItem) => ReturnType<typeof standInApply> } = {}) {
  const lines: string[] = [];
  const runner: Runner = createRunner(ctx, {
    way,
    model: 'claude-opus-5-5',
    home: 'C:/home',
    port: 4410,
    tickMs: 60 * 60 * 1000,
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
    // The kick after the failure takes the reopened item again, and its second failure leaves it behind.
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

  it('stopped mid-turn, aborts the run and abandons the turn, the item open for the next start', async () => {
    const w = world();
    const item = w.add();
    const way = heldWay();
    const { runner } = runnerOn(w.ctx, way);
    runner.kick(w.project.id);
    expect(way.calls).toHaveLength(1);
    await runner.stop();
    expect(turnsOf(w.ctx, item.id)[0]).toMatchObject({ state: 'abandoned', why: 'the server stopped during the turn' });
    expect(getDeskItem(w.ctx.db, item.id)!.state).toBe('open');
    runner.kick(w.project.id);
    expect(way.calls).toHaveLength(1);
  });
});

/** A stand-in for `claude`: records its argv, env, cwd and stdin, then prints a canned stream, fails, or hangs. */
const STUB = `
import { writeFileSync } from 'node:fs';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  writeFileSync(process.env.STUB_RECORD, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdin, pid: process.pid }));
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
  const out = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5-20261101' },
    { type: 'rate_limit_event', rate_limit_info: ${JSON.stringify(RATE)} },
    'not json at all',
    { type: 'assistant', message: { content: [] } },
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5 } } } },
    { type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(ANSWER)}, total_cost_usd: 0.23, duration_ms: 4100,
      usage: { input_tokens: 1500, output_tokens: 300 }, permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }] },
  ];
  process.stdout.write(out.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\\n'));
});
`;

describe('the headless way', () => {
  function stubSetup(mode: string) {
    const dir = mkdtempSync(join(tmpdir(), 'lead-headless-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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
      claude_code_lowercase: 'x',
      CLAUDE_AGENT_SDK_VERSION: '1.0',
      T3CODE_THREAD_ID: 't',
      CLAUDE_PID: '123',
      CLAUDE_EFFORT: 'high',
    };
    const leadDir = (slug: string) => join(dir, 'home', 'lead', slug);
    const way = headlessWay({ claudePath: stub, leadDir, toolsEntry: 'C:/dist/lead/tools.js', env });
    const input: TurnInput = {
      slug: 'ingame',
      item: { id: 1, projectId: 1, kind: 'question', ref: '5', nodeId: 2, createdAt: '2026-11-25T09:00:00.000Z', dueAt: null, state: 'leased', doneAt: null, outcome: null },
      systemPrompt: 'You are the lead.\nAnswer in four lines.',
      userMessage: 'A session asks Aiden a question.\nLook before you answer.',
      model: 'claude-opus-5-5',
      toolsEnv: { INPROGRESS_HOME: 'C:/home', INPROGRESS_PORT: '4410', INPROGRESS_LEAD_AS: 'Progresser', INPROGRESS_LEAD_REPO: BOUND },
    };
    const read = () => JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; env: Record<string, string>; cwd: string; stdin: string; pid: number };
    return { dir, way, input, read, lead: leadDir('ingame'), record };
  }

  it('runs the program with the agreed argv, in the lead folder, without the session variables, and reads its stream', async () => {
    const s = stubSetup('ok');
    const out = await s.way.run(s.input, new AbortController().signal);
    const rec = s.read();
    const promptFile = join(s.lead, 'desk-turn.md');
    const toolsFile = join(s.lead, 'tools.json');
    expect(rec.argv).toEqual([
      '-p', '--model', 'claude-opus-5-5', '--system-prompt-file', promptFile, '--setting-sources', 'project', '--strict-mcp-config',
      '--mcp-config', toolsFile, '--tools', '', '--allowedTools', 'mcp__inprogress-lead', '--output-format', 'stream-json', '--verbose',
      '--max-turns', '14', '--no-session-persistence',
    ]);
    expect(rec.cwd.toLowerCase()).toBe(s.lead.toLowerCase());
    expect(rec.stdin).toBe(s.input.userMessage);
    const names = Object.keys(rec.env).map((k) => k.toUpperCase());
    for (const gone of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_LOWERCASE', 'CLAUDE_AGENT_SDK_VERSION', 'T3CODE_THREAD_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT']) {
      expect(names).not.toContain(gone);
    }
    expect(rec.env.KEEP_ME).toBe('yes');
    expect(readFileSync(promptFile, 'utf8')).toBe(s.input.systemPrompt);
    expect(JSON.parse(readFileSync(toolsFile, 'utf8'))).toEqual({
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

  it('fails a run that exits without a result line, with the stderr tail', async () => {
    const s = stubSetup('noresult');
    await expect(s.way.run(s.input, new AbortController().signal)).rejects.toThrow(/exited with code 3 and no result line: starting\s+Error: not logged in/);
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
