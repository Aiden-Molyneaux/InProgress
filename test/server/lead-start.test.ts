import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION, LEAD_START_MODEL, LEAD_START_PROVIDER } from '../../src/core/lead';
import { markedTitle } from '../../src/server/lead/sends';
import { startHandoff, startTitle } from '../../src/core/lead-start';
import { buildApp } from '../../src/server/app';
import { listLeadEvents, noLeadNamed, outOfDate } from '../../src/server/lead';
import { leadAllow, leadIntent } from '../../src/server/lead-commands';
import { START_UNDER_WAY, START_UNKNOWN, leadStart, type StartThread } from '../../src/server/lead-start';
import { raiseAsk } from '../../src/server/repo/asks';
import { maxEventId } from '../../src/server/repo/events';
import { addNodes, updateNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { claimStep, handleHookEvent } from '../../src/server/session-flow';
import { T3ArgumentRefused, T3Unavailable } from '../../src/server/t3';
import { makeCtx } from '../helpers';
import { senderOver } from '../t3-stub';

const BEARER = { authorization: 'Bearer t' };
const BOUND = 'C:/personal/InGame';
const V = LEAD_INSTRUCTIONS_VERSION;
const INTENT = '## Goal\nShip the game.\n\n## Phase\nStore release.\n';
const WORDS = 'yes, start it';

let counter = 0;
/** A fake `start`: each call answers a new thread id. No test runs the t3 CLI. */
const fake = () => vi.fn<StartThread>(async () => ({ threadId: `mcp:t${++counter}` }));

/**
 * A project led by Progresser with an intent record, a folder and a step of each kind a start meets, and another project.
 * `start` is a fake, passed to leadStart and to the app.
 */
function setup(start: StartThread = fake()) {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, BOUND);
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  leadIntent(ctx, project.slug, 'Progresser', V, { intent: INTENT });
  const ready = (title: string, extra: Record<string, unknown> = {}) => ({ title, what: `Do ${title}.`, why: `Because ${title}.`, ...extra });
  const [signing, privacy, dark, sound, empty] = addNodes(ctx, 'test', {
    parentId: project.rootNodeId,
    nodes: [ready('Play app signing'), ready('Privacy page'), ready('Dark mode'), ready('Sound'), { title: 'No words yet' }],
  });
  const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
  const [foreign] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [ready('Not ours')] });
  const app = buildApp({ ctx, token: 't', uiToken: 'ui-token', version: 'test', t3Start: start });
  const leadEvents = () => ctx.db.prepare('SELECT COUNT(*) FROM lead_events').pluck().get() as number;
  const on = () => leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'starts', aidenWords: 'start things' });
  const sender = senderOver(ctx, { start });
  const run = (stepId: number, aidenWords?: string, as = 'Progresser', instructions = V) =>
    leadStart(ctx, project.slug, as, instructions, { stepId, ...(aidenWords === undefined ? {} : { aidenWords }) }, sender);
  /** A session in the project focused on `nodeId`, carrying `thread` when given. */
  const session = (id: string, nodeId: number, thread?: string) => {
    handleHookEvent(ctx, id, { event: 'start', source: 'startup', cwd: BOUND, app: 't3', t3ThreadId: thread ?? `mcp:s-${id}` });
    claimStep(ctx, `session:${id}`, id, nodeId);
  };
  /** Runs `fn`, which must reject; answers what it threw, having checked that nothing was started or written. */
  const refused = async (fn: () => Promise<unknown>): Promise<{ status: number; message: string }> => {
    const mark = maxEventId(ctx);
    const count = leadEvents();
    const calls = (start as ReturnType<typeof fake>).mock.calls.length;
    let caught: unknown;
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
    expect(caught, 'it should have been refused').toBeDefined();
    expect((start as ReturnType<typeof fake>).mock.calls).toHaveLength(calls);
    expect(maxEventId(ctx)).toBe(mark);
    expect(leadEvents()).toBe(count);
    return caught as { status: number; message: string };
  };
  return { ctx, project, elsewhere, signing, privacy, dark, sound, empty, foreign, start, app, leadEvents, on, run, session, refused };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('leadStart: the start', () => {
  it("starts in the project's folder with the handoff and a title, logs one start line and answers its sentence (on his word)", async () => {
    const s = setup();
    const res = await s.run(s.signing.id, WORDS);
    expect(s.start).toHaveBeenCalledTimes(1);
    const handoff = startHandoff({
      lead: 'Progresser',
      projectName: 'InGame',
      stepId: s.signing.id,
      stepTitle: 'Play app signing',
      what: 'Do Play app signing.',
      why: 'Because Play app signing.',
      goal: 'Ship the game.',
      phase: 'Store release.',
      onAidensWord: true,
    });
    // The title ends with the send's marker (the first send: s1), and the provider and model are the send's own.
    expect(s.start).toHaveBeenCalledWith(BOUND, handoff, { title: markedTitle(startTitle(s.signing.id, 'Play app signing'), 1), provider: LEAD_START_PROVIDER, model: LEAD_START_MODEL });
    expect(res.text).toBe(`Started a thread for #${s.signing.id} Play app signing: ${res.threadId}. It claims the step on its first turn.`);
    const events = listLeadEvents(s.ctx, s.project.slug).filter((e) => e.kind === 'start');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'start', lead: 'Progresser', instructions: V, nodeId: s.signing.id, text: res.threadId, aidenWords: WORDS, sessionId: null });
  });

  it("starts on the lead's own judgment when Starts is on, with the handoff saying so and no words logged", async () => {
    const s = setup();
    s.on();
    await s.run(s.signing.id);
    expect(String((s.start as ReturnType<typeof fake>).mock.calls[0][1]).split('\n')[2]).toContain("on the lead's own judgment, under his mandate");
    expect(listLeadEvents(s.ctx, s.project.slug).find((e) => e.kind === 'start')).toMatchObject({ aidenWords: null });
  });

  it('answers a start that timed out with START_UNKNOWN, logs start_unknown, and never starts twice', async () => {
    const start = vi.fn<StartThread>(async () => {
      throw new T3Unavailable('t3 thread start failed: timed out after 60 s', true);
    });
    const s = setup(start);
    await expect(s.run(s.signing.id, WORDS)).rejects.toMatchObject({ status: 502, message: START_UNKNOWN });
    expect(START_UNKNOWN).toBe('A thread may have been started. Do not run it again: read the brief and tell Aiden.');
    expect(start).toHaveBeenCalledTimes(1);
    expect(listLeadEvents(s.ctx, s.project.slug).filter((e) => e.kind.startsWith('start')).map((e) => [e.kind, e.nodeId, e.aidenWords])).toEqual([['start_unknown', s.signing.id, WORDS]]);
    // The unknown start holds the step with no time limit: it may yet be a thread.
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: expect.stringContaining('A start for #') });
  });

  it('answers any other failure with Not started and the reason, and logs start_failed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [error, sentence] of [
      [new T3Unavailable('t3 thread start failed: exit 1: no such project.'), 'Not started: t3 thread start failed: exit 1: no such project'],
      [new T3ArgumentRefused('project is empty'), 'Not started: project is empty'],
    ] as [unknown, string][]) {
      const start = vi.fn<StartThread>(async () => {
        throw error;
      });
      const s = setup(start);
      await expect(s.run(s.signing.id, WORDS)).rejects.toMatchObject({ status: 502, message: sentence });
      expect(start).toHaveBeenCalledTimes(1);
      expect(listLeadEvents(s.ctx, s.project.slug).filter((e) => e.kind.startsWith('start')).map((e) => e.kind)).toEqual(['start_failed']);
      // A failure leaves nothing to wait on: the step can be started again.
      await expect(s.run(s.signing.id, WORDS)).rejects.toMatchObject({ status: 502 });
    }
    expect(logged).toHaveBeenCalled();
  });
});

describe('leadStart: the refusals, each with its sentence and nothing started or written', () => {
  it('another project, a missing step, the root, another lead, old instructions and a project with no lead', async () => {
    const s = setup();
    expect(await s.refused(() => s.run(s.foreign.id, WORDS))).toMatchObject({ status: 409, message: `#${s.foreign.id} is not in this project.` });
    expect(await s.refused(() => s.run(999_999, WORDS))).toMatchObject({ status: 404 });
    expect(await s.refused(() => s.run(s.project.rootNodeId, WORDS))).toMatchObject({ status: 409, message: 'The project itself cannot be started.' });
    expect(await s.refused(() => s.run(s.signing.id, WORDS, 'Rich'))).toMatchObject({ status: 409, message: noLeadNamed('Rich') });
    expect(await s.refused(() => s.run(s.signing.id, WORDS, 'Progresser', V - 1))).toMatchObject({ status: 409, message: outOfDate(V - 1, s.project.slug, 'Progresser') });
    setProjectLead(s.ctx, 'window', s.project.slug, null);
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: noLeadNamed('Progresser') });
  });

  it('a done, dropped or parked step, and one under a parked step', async () => {
    const s = setup();
    updateNode(s.ctx, 'test', s.signing.id, { status: 'done' });
    updateNode(s.ctx, 'test', s.privacy.id, { status: 'dropped' });
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: `#${s.signing.id} is done.` });
    expect(await s.refused(() => s.run(s.privacy.id, WORDS))).toMatchObject({ status: 409, message: `#${s.privacy.id} is dropped.` });
    const [parent] = addNodes(s.ctx, 'test', { parentId: s.project.rootNodeId, nodes: [{ title: 'Phase two' }] });
    const [child] = addNodes(s.ctx, 'test', { parentId: parent.id, nodes: [{ title: 'Child', what: 'w', why: 'y' }] });
    updateNode(s.ctx, 'test', s.dark.id, { status: 'parked', parkedReason: 'later' });
    expect(await s.refused(() => s.run(s.dark.id, WORDS))).toMatchObject({ status: 409, message: `#${s.dark.id} is parked. Aiden unparks it first.` });
    updateNode(s.ctx, 'test', parent.id, { status: 'parked', parkedReason: 'later' });
    expect(await s.refused(() => s.run(child.id, WORDS))).toMatchObject({ status: 409, message: `#${child.id} is under parked #${parent.id}.` });
  });

  it('a step with a live session on it or under it', async () => {
    const s = setup();
    s.session('s1', s.signing.id);
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: `#${s.signing.id} Play app signing already has a session working on it.` });
    const [parent] = addNodes(s.ctx, 'test', { parentId: s.project.rootNodeId, nodes: [{ title: 'Group', what: 'w', why: 'y' }] });
    const [under] = addNodes(s.ctx, 'test', { parentId: parent.id, nodes: [{ title: 'Under' }] });
    s.session('s2', under.id);
    expect(await s.refused(() => s.run(parent.id, WORDS))).toMatchObject({ status: 409, message: `#${parent.id} Group already has a session working on it.` });
  });

  it('the second of two starts at once, while the first waits on T3 Code: refused, and start ran once', async () => {
    let release: (v: { threadId: string }) => void = () => undefined;
    const slow = vi.fn<StartThread>(() => new Promise((resolve) => (release = resolve)));
    const s = setup(slow);
    // Same step and another step of the project: each is refused while the first is under way.
    const first = s.run(s.signing.id, WORDS);
    const [second, third] = await Promise.allSettled([s.run(s.signing.id, WORDS), s.run(s.privacy.id, WORDS)]);
    expect(second).toMatchObject({ status: 'rejected', reason: { status: 409, message: START_UNDER_WAY } });
    expect(third).toMatchObject({ status: 'rejected', reason: { status: 409, message: START_UNDER_WAY } });
    expect(slow).toHaveBeenCalledTimes(1);
    release({ threadId: 'mcp:slow' });
    await expect(first).resolves.toMatchObject({ threadId: 'mcp:slow' });
    // Once it has answered and logged, the project is free again, and the step waits on the thread it started.
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: expect.stringContaining('A thread was started for #') });
  });

  it('is free again after a start that failed', async () => {
    const boom = vi.fn<StartThread>(async () => {
      throw new T3Unavailable('nope');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = setup(boom);
    await expect(s.run(s.signing.id, WORDS)).rejects.toMatchObject({ status: 502 });
    await expect(s.run(s.signing.id, WORDS)).rejects.toMatchObject({ status: 502 });
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it('a step started in the last 10 minutes, but not one started 11 minutes ago', async () => {
    const s = setup();
    await s.run(s.signing.id, WORDS);
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({
      status: 409,
      message: `A thread was started for #${s.signing.id} Play app signing 1 minute ago. Give it time to claim the step.`,
    });
    const old = new Date(Date.parse(s.ctx.now()) - 11 * 60 * 1000).toISOString();
    s.ctx.db.prepare("UPDATE lead_sends SET created_at = ? WHERE kind = 'start'").run(old);
    await expect(s.run(s.signing.id, WORDS)).resolves.toMatchObject({ threadId: expect.any(String) });
    // Five minutes: the sentence counts them.
    const five = new Date(Date.parse(s.ctx.now()) - 5 * 60 * 1000).toISOString();
    s.ctx.db.prepare("UPDATE lead_sends SET created_at = ? WHERE kind = 'start' AND id = (SELECT MAX(id) FROM lead_sends)").run(five);
    expect((await s.refused(() => s.run(s.signing.id, WORDS))).message).toBe(`A thread was started for #${s.signing.id} Play app signing 5 minutes ago. Give it time to claim the step.`);
  });

  it('a project with no intent record, one with no Goal or no Phase', async () => {
    const s = setup();
    const none = 'This project has no intent record yet, so nothing can be started.';
    s.ctx.db.prepare("UPDATE projects SET intent = ''").run();
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: none });
    s.ctx.db.prepare('UPDATE projects SET intent = ?').run('## Goal\nShip the game.\n');
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: none });
    s.ctx.db.prepare('UPDATE projects SET intent = ?').run('## Phase\nStore release.\n');
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: none });
  });

  it('a step with no What or no Why', async () => {
    const s = setup();
    expect(await s.refused(() => s.run(s.empty.id, WORDS))).toMatchObject({ status: 409, message: `#${s.empty.id} No words yet has no What and Why yet. Tell Aiden.` });
    updateNode(s.ctx, 'test', s.empty.id, { what: 'Something.' });
    expect((await s.refused(() => s.run(s.empty.id, WORDS))).message).toContain('has no What and Why yet');
  });

  it('a project with no folder', async () => {
    const s = setup();
    s.ctx.db.prepare('DELETE FROM bindings').run();
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: 'This project has no folder on record, so no thread can be started.' });
  });

  it('a project with three sessions in flight, counting a started thread that no session carries yet (and not one that is carried)', async () => {
    const s = setup();
    const limit = (n: number, k: number) => `${n} sessions are in flight (${k} started and not claimed yet), and the limit is 3. Wait for one to end.`;
    // Two started threads, none claimed.
    const a = await s.run(s.signing.id, WORDS);
    await s.run(s.privacy.id, WORDS);
    // The first thread claims its step: one live session, one thread still unclaimed.
    s.session('s1', s.signing.id, a.threadId);
    await s.run(s.dark.id, WORDS);
    expect(await s.refused(() => s.run(s.sound.id, WORDS))).toMatchObject({ status: 409, message: limit(3, 2) });
  });

  it('counts a start that timed out (start_unknown) as in flight for 10 minutes, and in the daily cap', async () => {
    const unknown = vi.fn<StartThread>(async () => {
      throw new T3Unavailable('t3 thread start failed: timed out after 60 s', true);
    });
    const s = setup(unknown);
    s.on();
    for (const step of [s.signing, s.privacy, s.dark]) await expect(s.run(step.id)).rejects.toMatchObject({ status: 502, message: START_UNKNOWN });
    expect(await s.refused(() => s.run(s.sound.id, WORDS))).toMatchObject({
      status: 409,
      message: '3 sessions are in flight (3 started and not claimed yet), and the limit is 3. Wait for one to end.',
    });
    s.ctx.db.prepare("UPDATE lead_sends SET created_at = ? WHERE kind = 'start'").run(new Date(Date.parse(s.ctx.now()) - 11 * 60 * 1000).toISOString());
    expect(await s.refused(() => s.run(s.sound.id))).toMatchObject({
      status: 409,
      message: 'You have started 3 threads on your own judgment in the last 24 hours, and the limit is 3. Ask Aiden.',
    });
  });

  it('refuses a step while a live session carries the thread it was started with, whatever that session has claimed', async () => {
    const s = setup();
    const started = await s.run(s.signing.id, WORDS);
    s.ctx.db.prepare("UPDATE lead_sends SET created_at = ? WHERE kind = 'start'").run(new Date(Date.parse(s.ctx.now()) - 11 * 60 * 1000).toISOString());
    s.session('s1', s.dark.id, started.threadId);
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({
      status: 409,
      message: `#${s.signing.id} Play app signing already has a thread open (${started.threadId}) that has not claimed it. Tell Aiden.`,
    });
  });

  it('three live sessions', async () => {
    const s = setup();
    const [x, y, z] = addNodes(s.ctx, 'test', { parentId: s.project.rootNodeId, nodes: [{ title: 'X' }, { title: 'Y' }, { title: 'Z' }] });
    s.session('s1', x.id);
    s.session('s2', y.id);
    s.session('s3', z.id);
    expect(await s.refused(() => s.run(s.signing.id, WORDS))).toMatchObject({ status: 409, message: '3 sessions are in flight, and the limit is 3. Wait for one to end.' });
    expect(START_UNDER_WAY).toBe('A start for this project is under way. Wait for it to answer.');
  });
});

describe('leadStart: on the lead own judgment (no words of Aiden)', () => {
  it('is refused with Starts off, and Aiden words get past it', async () => {
    const s = setup();
    expect(await s.refused(() => s.run(s.signing.id))).toMatchObject({
      status: 409,
      message: "Starts is off for this project: starting a thread needs Aiden's words. Pass them with --aiden.",
    });
    await expect(s.run(s.signing.id, WORDS)).resolves.toBeDefined();
  });

  it('is held by five open asks in this project, never by asks in another', async () => {
    const s = setup();
    s.on();
    const [q] = addNodes(s.ctx, 'test', { parentId: s.elsewhere.rootNodeId, nodes: [{ title: 'Asker' }] });
    for (let i = 0; i < 5; i++) raiseAsk(s.ctx, 'test', { nodeId: q.id, kind: 'question', text: `Question ${i}?` });
    await expect(s.run(s.signing.id)).resolves.toBeDefined();
    const [here] = addNodes(s.ctx, 'test', { parentId: s.project.rootNodeId, nodes: [{ title: 'Asker here' }] });
    for (let i = 0; i < 5; i++) raiseAsk(s.ctx, 'test', { nodeId: here.id, kind: 'question', text: `Question ${i}?` });
    expect(await s.refused(() => s.run(s.privacy.id))).toMatchObject({ status: 409, message: 'Aiden has 5 open asks in this project, and the limit is 5. Bring those to him first.' });
    // His words are not held by it.
    await expect(s.run(s.privacy.id, WORDS)).resolves.toBeDefined();
  });

  it('is capped at three a day, counting only starts with no words of his, in this project, in the last 24 hours', async () => {
    const s = setup();
    s.on();
    const steps = [s.signing, s.privacy, s.dark];
    for (const step of steps) await s.run(step.id);
    // A start on his word does not count against the cap; it needs a free slot in flight, so end the sessions' room first.
    s.ctx.db.prepare("UPDATE lead_sends SET created_at = ? WHERE kind = 'start'").run(new Date(Date.parse(s.ctx.now()) - 11 * 60 * 1000).toISOString());
    expect(await s.refused(() => s.run(s.sound.id))).toMatchObject({
      status: 409,
      message: 'You have started 3 threads on your own judgment in the last 24 hours, and the limit is 3. Ask Aiden.',
    });
    // His words are not held by the cap, and the start with them does not count.
    await expect(s.run(s.sound.id, WORDS)).resolves.toBeDefined();
    // A start 25 hours old no longer counts: with the oldest of the three that old, a fourth on his own judgment is allowed.
    const [extra] = addNodes(s.ctx, 'test', { parentId: s.project.rootNodeId, nodes: [{ title: 'Extra', what: 'w', why: 'y' }] });
    s.ctx.db.prepare("UPDATE lead_sends SET created_at = ? WHERE kind = 'start'").run(new Date(Date.parse(s.ctx.now()) - 11 * 60 * 1000).toISOString());
    s.ctx.db.prepare("UPDATE lead_sends SET created_at = ? WHERE kind = 'start' AND id = (SELECT MIN(id) FROM lead_sends WHERE kind = 'start')").run(new Date(Date.parse(s.ctx.now()) - 25 * 60 * 60 * 1000).toISOString());
    await expect(s.run(extra.id)).resolves.toBeDefined();
  });
});

describe('the start route', () => {
  const post = (s: ReturnType<typeof setup>, payload: Record<string, unknown>, headers: Record<string, string> = BEARER) =>
    s.app.inject({ method: 'POST', url: `/api/lead/${s.project.slug}/start`, headers, payload });
  const who = { as: 'Progresser', instructions: V };

  it('is refused without the bearer token and for a bad body, starting nothing', async () => {
    const s = setup();
    // The intent record's own line is there already.
    const before = s.leadEvents();
    expect((await post(s, { ...who, stepId: s.signing.id, aidenWords: WORDS }, {})).statusCode).toBe(401);
    expect((await post(s, { ...who, stepId: 0 })).statusCode).toBe(400);
    expect((await post(s, { ...who })).statusCode).toBe(400);
    expect((await post(s, { ...who, stepId: s.signing.id, aidenWords: 'x'.repeat(2_001) })).statusCode).toBe(400);
    expect((await post(s, { ...who, stepId: s.signing.id, extra: true })).statusCode).toBe(400);
    expect(s.start).not.toHaveBeenCalled();
    expect(s.leadEvents()).toBe(before);
  });

  it("answers 200 with the sentence and thread id, starting through the app's t3Start", async () => {
    const s = setup();
    const res = await post(s, { ...who, stepId: s.signing.id, aidenWords: WORDS });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toMatch(/^Started a thread for #\d+ Play app signing: mcp:t\d+\. It claims the step on its first turn\.$/);
    expect(res.json().threadId).toMatch(/^mcp:t\d+$/);
    expect(s.start).toHaveBeenCalledTimes(1);
  });

  it('answers a refusal with 409 and its sentence, and a start that may have happened with 502', async () => {
    const s = setup();
    const refused = await post(s, { ...who, stepId: s.signing.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('Starts is off');
    expect(s.start).not.toHaveBeenCalled();
    const u = setup(
      vi.fn<StartThread>(async () => {
        throw new T3Unavailable('t3 thread start failed: timed out after 60 s', true);
      }),
    );
    const res = await post(u, { ...who, stepId: u.signing.id, aidenWords: WORDS });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe(START_UNKNOWN);
  });
});
