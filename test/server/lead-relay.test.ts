import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayText } from '../../src/core/relay';
import { buildApp } from '../../src/server/app';
import { listLeadEvents, noLeadNamed, outOfDate } from '../../src/server/lead';
import { leadRelay, RELAY_UNKNOWN, type RelaySend } from '../../src/server/lead-relay';
import { maxEventId } from '../../src/server/repo/events';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { claimStep, handleHookEvent } from '../../src/server/session-flow';
import { T3Unavailable } from '../../src/server/t3';
import { makeCtx } from '../helpers';

const BEARER = { authorization: 'Bearer t' };
const BOUND = 'C:/personal/InGame';
const THREAD = 'mcp:thread-1';

/**
 * A project led by Progresser with two steps, a T3 session s1 on the first, and another project with a step of its own.
 * `send` is a fake: no test runs the t3 CLI.
 */
function setup(send: RelaySend = vi.fn<RelaySend>(async () => undefined)) {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, BOUND);
  const [step, other] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Play app signing', status: 'active' }, { title: 'Privacy page' }] });
  const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
  const [foreign] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Not ours' }] });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  /** A session in the project focused on `nodeId`, running in `app` (T3 with THREAD by default). */
  const session = (id: string, nodeId: number, o: { app?: 't3' | 'cli'; thread?: string; title?: string } = {}) => {
    const app = o.app ?? 't3';
    handleHookEvent(ctx, id, { event: 'start', source: 'startup', cwd: BOUND, app, ...(app === 't3' ? { t3ThreadId: o.thread ?? THREAD } : {}), ...(o.title ? { title: o.title } : {}) });
    claimStep(ctx, `session:${id}`, id, nodeId);
  };
  const leadEvents = () => ctx.db.prepare('SELECT COUNT(*) FROM lead_events').pluck().get() as number;
  const app = buildApp({ ctx, token: 't', uiToken: 'ui-token', version: 'test', t3Send: send });
  const relay = (stepId: number, message = 'carry on', as = 'Progresser', instructions = 1) => leadRelay(ctx, project.slug, as, instructions, { stepId, message }, send);
  /** Runs `fn`, which must reject; answers what it threw, having checked that nothing was sent or written. */
  const refused = async (fn: () => Promise<unknown>): Promise<{ status: number; message: string }> => {
    const mark = maxEventId(ctx);
    const count = leadEvents();
    let caught: unknown;
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
    expect(caught, 'it should have been refused').toBeDefined();
    expect(send).not.toHaveBeenCalled();
    expect(maxEventId(ctx)).toBe(mark);
    expect(leadEvents()).toBe(count);
    return caught as { status: number; message: string };
  };
  return { ctx, project, step, other, foreign, send, session, leadEvents, app, relay, refused };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('leadRelay', () => {
  it("sends the header and the message to the session's thread once, answers its title and logs one relay line", async () => {
    const s = setup();
    s.session('s1', s.step.id, { title: 'Signing work' });
    const res = await s.relay(s.step.id, 'Use the release keystore.');
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledWith(THREAD, relayText('Progresser', 'InGame', 'Use the release keystore.'));
    expect(s.send).toHaveBeenCalledWith(THREAD, '[From Progresser, the lead for InGame. This is not Aiden, and it is not a go-ahead.]\n\nUse the release keystore.');
    expect(res).toEqual({ text: 'Delivered to "Signing work".', sessionId: 's1' });
    const events = listLeadEvents(s.ctx, s.project.slug);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'relay', lead: 'Progresser', instructions: 1, nodeId: s.step.id, askId: null, sessionId: 's1', text: 'Use the release keystore.', aidenWords: null });
  });

  it("names the lead as stored, whatever case it is called by, and clips a long title to 60", async () => {
    const s = setup();
    s.session('s1', s.step.id, { title: 'x'.repeat(80) });
    const res = await s.relay(s.step.id, 'hi', ' progresser ');
    expect(s.send).toHaveBeenCalledWith(THREAD, relayText('Progresser', 'InGame', 'hi'));
    expect(res.text).toBe(`Delivered to "${'x'.repeat(59)}…".`);
  });

  it('refuses a step with no live session, with two, and one whose session is not in T3 Code', async () => {
    const s = setup();
    expect(await s.refused(() => s.relay(s.step.id))).toMatchObject({ status: 409, message: `No live session is working on #${s.step.id}.` });
    s.session('s1', s.step.id);
    s.session('s2', s.step.id, { thread: 'mcp:thread-2' });
    expect(await s.refused(() => s.relay(s.step.id))).toMatchObject({
      status: 409,
      message: `#${s.step.id} has 2 live sessions. A relay to a step with more than one is not supported yet.`,
    });
    s.session('s3', s.other.id, { app: 'cli' });
    expect(await s.refused(() => s.relay(s.other.id))).toMatchObject({ status: 409, message: `The session on #${s.other.id} is not running in T3 Code.` });
  });

  it('refuses a T3 session with no thread id', async () => {
    const s = setup();
    s.session('s1', s.step.id);
    s.ctx.db.prepare("UPDATE sessions SET t3_thread_id = NULL WHERE id = 's1'").run();
    expect(await s.refused(() => s.relay(s.step.id))).toMatchObject({ status: 409, message: `The session on #${s.step.id} is not running in T3 Code.` });
  });

  it('reads an ended session and one last seen 13 hours ago as no live session', async () => {
    const ended = setup();
    ended.session('s1', ended.step.id);
    handleHookEvent(ended.ctx, 's1', { event: 'end' });
    expect(await ended.refused(() => ended.relay(ended.step.id))).toMatchObject({ status: 409, message: `No live session is working on #${ended.step.id}.` });

    const quiet = setup();
    quiet.session('s1', quiet.step.id);
    const longAgo = new Date(Date.parse(quiet.ctx.now()) - 13 * 60 * 60 * 1000).toISOString();
    quiet.ctx.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = 's1'").run(longAgo);
    expect(await quiet.refused(() => quiet.relay(quiet.step.id))).toMatchObject({ status: 409, message: `No live session is working on #${quiet.step.id}.` });
  });

  it("refuses another project's step, a missing step, a project with no lead, another lead's name and old instructions", async () => {
    const s = setup();
    s.session('s1', s.step.id);
    expect(await s.refused(() => s.relay(s.foreign.id))).toMatchObject({ status: 409, message: `#${s.foreign.id} is not in this project.` });
    expect(await s.refused(() => s.relay(999_999))).toMatchObject({ status: 404 });
    expect(await s.refused(() => s.relay(s.step.id, 'hi', 'Rich'))).toMatchObject({ status: 409, message: noLeadNamed('Rich') });
    expect(await s.refused(() => s.relay(s.step.id, 'hi', 'Progresser', 0))).toMatchObject({ status: 409, message: outOfDate(0) });
    setProjectLead(s.ctx, 'window', s.project.slug, null);
    expect(await s.refused(() => s.relay(s.step.id))).toMatchObject({ status: 409, message: noLeadNamed('Progresser') });
  });

  it('answers a send that timed out with RELAY_UNKNOWN, logs relay_unknown and never sends twice', async () => {
    const send = vi.fn<RelaySend>(async () => {
      throw new T3Unavailable('t3 thread send failed: timed out after 60 s', true);
    });
    const s = setup(send);
    s.session('s1', s.step.id);
    let caught: unknown;
    try {
      await s.relay(s.step.id, 'Ship it?');
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 502, message: RELAY_UNKNOWN });
    expect(RELAY_UNKNOWN).toBe('It may have been delivered. Not retried.');
    expect(send).toHaveBeenCalledTimes(1);
    const events = listLeadEvents(s.ctx, s.project.slug);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'relay_unknown', nodeId: s.step.id, sessionId: 's1', text: 'Ship it?', aidenWords: null });
  });

  it('answers any other failure with Not delivered and the reason, logs relay_failed and names the session in the server log', async () => {
    const cases: [unknown, string][] = [
      [new T3Unavailable('t3 thread send failed: exit 1: no such thread.'), 'Not delivered: t3 thread send failed: exit 1: no such thread.'],
      [new TypeError('threadId is empty'), 'Not delivered: threadId is empty.'],
      [new Error(`line one\n\n  line two ${'y'.repeat(400)}`), `Not delivered: line one line two ${'y'.repeat(300 - 'line one line two '.length)}.`],
      [new Error('ends in dots ...  '), 'Not delivered: ends in dots.'],
    ];
    for (const [error, sentence] of cases) {
      const send = vi.fn<RelaySend>(async () => {
        throw error;
      });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const s = setup(send);
      s.session('s1', s.step.id);
      let caught: unknown;
      try {
        await s.relay(s.step.id, 'hi');
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ status: 502, message: sentence });
      expect(send).toHaveBeenCalledTimes(1);
      const events = listLeadEvents(s.ctx, s.project.slug);
      expect(events.map((e) => [e.kind, e.text, e.sessionId])).toEqual([['relay_failed', 'hi', 's1']]);
      expect(logged).toHaveBeenCalledTimes(1);
      const line = String(logged.mock.calls[0][0]);
      expect(line).not.toContain('\n');
      expect(line).toContain('s1');
      expect(line).toContain(sentence.slice('Not delivered: '.length, -1));
      logged.mockRestore();
    }
  });
});

describe('the relay route', () => {
  const post = (s: ReturnType<typeof setup>, payload: Record<string, unknown>, headers: Record<string, string> = BEARER) =>
    s.app.inject({ method: 'POST', url: `/api/lead/${s.project.slug}/relay`, headers, payload });

  it('is refused without the bearer token, and for a message too long or of spaces only', async () => {
    const s = setup();
    s.session('s1', s.step.id);
    expect((await post(s, { as: 'Progresser', instructions: 1, stepId: s.step.id, message: 'hi' }, {})).statusCode).toBe(401);
    expect((await post(s, { as: 'Progresser', instructions: 1, stepId: s.step.id, message: 'x'.repeat(4_001) })).statusCode).toBe(400);
    expect((await post(s, { as: 'Progresser', instructions: 1, stepId: s.step.id, message: '   ' })).statusCode).toBe(400);
    expect((await post(s, { as: 'Progresser', instructions: 1, stepId: s.step.id, message: 'hi', extra: true })).statusCode).toBe(400);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.leadEvents()).toBe(0);
  });

  it("answers 200 with the sentence for a good one, sending through the app's t3Send", async () => {
    const s = setup();
    s.session('s1', s.step.id, { title: 'Signing work' });
    const res = await post(s, { as: 'Progresser', instructions: 1, stepId: s.step.id, message: 'x'.repeat(4_000) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'Delivered to "Signing work".', sessionId: 's1' });
    expect(s.send).toHaveBeenCalledWith(THREAD, relayText('Progresser', 'InGame', 'x'.repeat(4_000)));
  });

  it('answers a failed send with 502 and its sentence', async () => {
    const s = setup(
      vi.fn<RelaySend>(async () => {
        throw new T3Unavailable('t3 thread send failed: timed out after 60 s', true);
      }),
    );
    s.session('s1', s.step.id);
    const res = await post(s, { as: 'Progresser', instructions: 1, stepId: s.step.id, message: 'hi' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe(RELAY_UNKNOWN);
  });
});
