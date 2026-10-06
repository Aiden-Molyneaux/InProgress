import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKER_QUIET_MS, SILENT_MS, WATCH_MS, createWatchState, watchAgents, watchInterval } from '../../src/server/agent-watch';
import { openDb } from '../../src/server/db/connection';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject } from '../../src/server/repo/projects';
import { findSession } from '../../src/server/repo/sessions';
import { handleHookEvent, type HookEventInput } from '../../src/server/session-flow';

const SEC = 1000;
const MIN = 60 * SEC;
const iso = (ms: number) => new Date(ms).toISOString();

const line = (o: object) => JSON.stringify(o);
const said = (timestamp: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working.' }] }, timestamp });
const interrupted = (timestamp: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp });
const apiError = (error: string, timestamp: string) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit" }] }, error, isApiErrorMessage: true, timestamp });

/**
 * A tracked session s1 whose transcript sits in a temp folder, a watcher of its own, and a clock the test moves by hand.
 * Agent transcripts are written where Claude Code puts them, each modified when its last line says.
 */
function setup() {
  let now = Date.parse('2026-10-06T09:00:00.000Z');
  const ctx = createCtx(openDb(':memory:'), () => iso(now));
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Play app signing', status: 'active' }] });
  const dir = mkdtempSync(join(tmpdir(), 'ip-watch-'));
  const transcriptPath = join(dir, 's1.jsonl');
  writeFileSync(transcriptPath, '');
  const hook = (input: HookEventInput, session = 's1') => handleHookEvent(ctx, session, input);
  hook({ event: 'start', source: 'startup', cwd: 'C:/personal/InGame', transcriptPath });
  hook({ event: 'prompt' });
  const state = createWatchState();
  const watch = () => watchAgents(ctx, state);
  /** Ticks every WATCH_MS for `ms`, as the server's timer does, and gathers what each tick ended. */
  const run = (ms: number) => {
    const ended: string[] = [];
    for (let t = 0; t < ms; t += WATCH_MS) {
      now += WATCH_MS;
      ended.push(...watch().ended.map((e) => `${e.agentId}:${e.reason}`));
    }
    return ended;
  };
  const fileOf = (agentId: string, workflow?: string) =>
    join(dir, 's1', 'subagents', ...(workflow ? ['workflows', workflow] : []), `agent-${agentId}.jsonl`);
  /** Writes an agent's transcript, `lines` given their times by `ago` (ms before the clock); modified at the last one. */
  const transcript = (agentId: string, lines: [(ts: string) => string, number][], workflow?: string) => {
    const file = fileOf(agentId, workflow);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, lines.map(([make, ago]) => `${make(iso(now - ago))}\n`).join(''));
    const last = new Date(now - lines[lines.length - 1][1]);
    utimesSync(file, last, last);
    return file;
  };
  /** The agent writes one more line now. */
  const append = (agentId: string, make: (ts: string) => string = said, workflow?: string) => {
    const file = fileOf(agentId, workflow);
    appendFileSync(file, `${make(iso(now))}\n`);
    utimesSync(file, new Date(now), new Date(now));
  };
  const start = (agentId: string, session = 's1') => hook({ event: 'subagent-start', agentId, agentType: 'general-purpose' }, session);
  const row = (agentId: string) =>
    ctx.db.prepare('SELECT ended_at, end_reason, last_active_at FROM session_subagents WHERE agent_id = ?').get(agentId) as { ended_at: string | null; end_reason: string | null; last_active_at: string | null };
  return { ctx, project, dir, hook, watch, run, transcript, append, start, row, tick: (ms: number) => (now += ms), now: () => now };
}

/** The `session.updated` events a call records, as their data. */
function events(ctx: Ctx, fn: () => void): unknown[] {
  const mark = maxEventId(ctx);
  fn();
  return listEventsSince(ctx, mark).filter((e) => e.type === 'session.updated').map((e) => ({ actor: e.actor, session: e.entityId, ...(e.data as object) }));
}

describe('watchAgents: transcript markers', () => {
  it('ends a subagent whose transcript ends on an interrupt once the file has been still for 60 s, at the marker', () => {
    const { watch, run, transcript, start, row, now } = setup();
    start('a1');
    transcript('a1', [[said, 5 * MIN], [interrupted, 30 * SEC]]);
    const marker = iso(now() - 30 * SEC);
    expect(watch().ended).toEqual([]);
    expect(row('a1').ended_at).toBeNull();
    expect(run(WATCH_MS)).toEqual(['a1:killed']);
    expect(row('a1')).toEqual({ ended_at: iso(now()), end_reason: 'killed', last_active_at: marker });
  });

  it('ends at once a subagent whose marker is older than 60 s, so phantoms carried across a restart end on the first tick', () => {
    const { watch, transcript, start, row } = setup();
    for (const id of ['k', 'l', 'e']) start(id);
    transcript('k', [[interrupted, 20 * 60 * MIN]]);
    transcript('l', [[said, 10 * 60 * MIN], [(ts) => apiError('rate_limit', ts), 10 * 60 * MIN]], 'wf_c62123e2-364');
    transcript('e', [[(ts) => apiError('server_error', ts), 2 * MIN]], 'wf_c62123e2-364');
    // In the session's order: by start, then id.
    expect(watch().ended).toEqual([
      { sessionId: 's1', agentId: 'e', reason: 'error' },
      { sessionId: 's1', agentId: 'k', reason: 'killed' },
      { sessionId: 's1', agentId: 'l', reason: 'limit' },
    ]);
    expect(['k', 'l', 'e'].map((id) => row(id).end_reason)).toEqual(['killed', 'limit', 'error']);
    expect(MARKER_QUIET_MS).toBe(60 * SEC);
  });

  it('records one session.updated per session whose subagents it ended, naming each and why', () => {
    const { ctx, hook, watch, transcript, start, dir } = setup();
    const otherPath = join(dir, 's2.jsonl');
    writeFileSync(otherPath, '');
    hook({ event: 'start', source: 'startup', cwd: 'C:/personal/InGame', transcriptPath: otherPath }, 's2');
    start('a1');
    start('a2');
    start('b1', 's2');
    transcript('a1', [[interrupted, 2 * MIN]]);
    transcript('a2', [[(ts) => apiError('rate_limit', ts), 2 * MIN]]);
    mkdirSync(join(dir, 's2', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 's2', 'subagents', 'agent-b1.jsonl'), `${interrupted(iso(Date.parse(ctx.now()) - 2 * MIN))}\n`);
    utimesSync(join(dir, 's2', 'subagents', 'agent-b1.jsonl'), new Date(Date.parse(ctx.now()) - 2 * MIN), new Date(Date.parse(ctx.now()) - 2 * MIN));
    expect(events(ctx, watch)).toEqual([
      { actor: 'system', session: 's1', changed: ['subagents'], state: 'working', ended: [{ agentId: 'a1', reason: 'killed' }, { agentId: 'a2', reason: 'limit' }] },
      { actor: 'system', session: 's2', changed: ['subagents'], state: 'idle', ended: [{ agentId: 'b1', reason: 'killed' }] },
    ]);
    // Nothing more to say on the next tick.
    expect(events(ctx, watch)).toEqual([]);
    expect(findSession(ctx, 's1')!.subagents.map((a) => [a.agentId, a.endReason])).toEqual([['a1', 'killed'], ['a2', 'limit']]);
  });
});

describe('watchAgents: silence', () => {
  it('ends a subagent that has written nothing for 20 minutes as silent, at its last line', () => {
    const { run, transcript, start, row, now } = setup();
    start('a1');
    transcript('a1', [[said, 30 * MIN], [said, 18 * MIN]]);
    const last = iso(now() - 18 * MIN);
    expect(run(MIN)).toEqual([]);
    expect(run(MIN)).toEqual(['a1:silent']);
    expect(row('a1')).toEqual({ ended_at: iso(now()), end_reason: 'silent', last_active_at: last });
    expect(SILENT_MS).toBe(20 * MIN);
  });

  it('holds the silence end while its session waits for a permission, and counts again from the answer', () => {
    const { hook, run, transcript, start } = setup();
    start('a1');
    transcript('a1', [[said, 25 * MIN]]);
    hook({ event: 'permission' });
    expect(run(10 * MIN)).toEqual([]);
    hook({ event: 'prompt' });
    expect(run(19 * MIN)).toEqual([]);
    expect(run(MIN)).toEqual(['a1:silent']);
  });

  it('restarts every silence count after a gap between ticks over 3 minutes, as when the machine slept', () => {
    const { watch, run, transcript, start, tick } = setup();
    start('a1');
    transcript('a1', [[said, 10 * MIN]]);
    expect(watch().ended).toEqual([]);
    tick(15 * MIN);
    // 25 minutes since its last line, but the watcher was asleep for 15 of them.
    expect(watch().ended).toEqual([]);
    expect(run(19 * MIN)).toEqual([]);
    expect(run(MIN)).toEqual(['a1:silent']);
  });

  it('never ends a subagent whose transcript is missing or unreadable, or whose session has no transcript', () => {
    const { ctx, hook, run, start, dir } = setup();
    start('a1');
    start('a2');
    mkdirSync(join(dir, 's1', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 's1', 'subagents', 'agent-a2.jsonl'), 'not a transcript line');
    utimesSync(join(dir, 's1', 'subagents', 'agent-a2.jsonl'), new Date(0), new Date(0));
    hook({ event: 'start', source: 'startup', cwd: 'C:/personal/InGame' }, 's3');
    start('c1', 's3');
    expect(run(60 * MIN)).toEqual([]);
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM session_subagents WHERE ended_at IS NOT NULL').get()).toEqual({ c: 0 });
  });
});

describe('watchAgents: coming back', () => {
  it('revives a subagent it ended as silent when a new line arrives', () => {
    const { ctx, run, watch, transcript, append, start, row } = setup();
    start('a1');
    transcript('a1', [[said, 20 * MIN]]);
    expect(run(MIN)).toEqual(['a1:silent']);
    append('a1');
    expect(events(ctx, () => expect(watch().revived).toEqual([{ sessionId: 's1', agentId: 'a1' }]))).toEqual([
      { actor: 'system', session: 's1', changed: ['subagents'], state: 'working' },
    ]);
    expect(row('a1')).toEqual({ ended_at: null, end_reason: null, last_active_at: null });
  });

  it('leaves a subagent at the usage limit on its line until it writes again', () => {
    const { run, watch, transcript, append, start, row } = setup();
    start('a1');
    transcript('a1', [[(ts) => apiError('rate_limit', ts), 2 * MIN]]);
    expect(watch().ended).toEqual([{ sessionId: 's1', agentId: 'a1', reason: 'limit' }]);
    expect(run(5 * 60 * MIN)).toEqual([]);
    expect(row('a1').end_reason).toBe('limit');
    // Resumed after the reset: its next line brings it back.
    append('a1');
    expect(watch().revived).toEqual([{ sessionId: 's1', agentId: 'a1' }]);
    expect(row('a1').ended_at).toBeNull();
  });

  it('lets a real SubagentStop win over a silent end, and a resumed start clear any end, which a new line then keeps', () => {
    const { hook, run, watch, transcript, append, start, row, now } = setup();
    start('a1');
    start('a2');
    transcript('a1', [[said, 20 * MIN]]);
    transcript('a2', [[interrupted, 2 * MIN]]);
    expect(run(MIN)).toEqual(['a1:silent', 'a2:killed']);
    hook({ event: 'subagent-stop', agentId: 'a1' });
    expect(row('a1')).toEqual({ ended_at: iso(now()), end_reason: null, last_active_at: null });
    start('a2');
    append('a2');
    expect(row('a2')).toEqual({ ended_at: null, end_reason: null, last_active_at: null });
    expect(watch()).toEqual({ ended: [], revived: [] });
    expect(run(10 * MIN)).toEqual([]);
  });

  it('never ends a resumed subagent again on the line it ended it on: it waits for a new one', () => {
    const { run, watch, transcript, append, start, row } = setup();
    start('a1');
    transcript('a1', [[interrupted, 2 * MIN]]);
    expect(watch().ended).toEqual([{ sessionId: 's1', agentId: 'a1', reason: 'killed' }]);
    // Resumed: the start arrives, and ticks run before the transcript's first new line.
    start('a1');
    expect(run(5 * MIN)).toEqual([]);
    expect(row('a1')).toEqual({ ended_at: null, end_reason: null, last_active_at: null });
    append('a1');
    expect(watch()).toEqual({ ended: [], revived: [] });
    expect(run(19 * MIN)).toEqual([]);
    expect(run(MIN)).toEqual(['a1:silent']);
  });

  it('counts the silence of a resumed subagent that never writes from when it saw the start, and ends it at the old line', () => {
    const { run, watch, transcript, start, row, now } = setup();
    start('a1');
    transcript('a1', [[interrupted, 2 * MIN]]);
    const marker = iso(now() - 2 * MIN);
    expect(watch().ended).toHaveLength(1);
    start('a1');
    // The first tick sees it running again; 20 minutes on from there, still nothing new.
    expect(run(20 * MIN)).toEqual([]);
    expect(run(MIN)).toEqual(['a1:silent']);
    expect(row('a1')).toMatchObject({ end_reason: 'silent', last_active_at: marker });
  });

  it("stops watching a session once it has ended, and leaves its subagents as the session's end left them", () => {
    const { hook, run, transcript, start, row } = setup();
    start('a1');
    start('a2');
    transcript('a1', [[interrupted, 2 * MIN]]);
    transcript('a2', [[said, 30 * MIN]]);
    hook({ event: 'end' });
    expect(run(30 * MIN)).toEqual([]);
    expect([row('a1').end_reason, row('a2').end_reason]).toEqual(['session', 'session']);
  });
});

describe('watchInterval', () => {
  it('ticks every minute, or as often as INPROGRESS_AGENT_WATCH_MS says when it is a positive whole number', () => {
    expect(WATCH_MS).toBe(MIN);
    expect(watchInterval({})).toBe(MIN);
    expect(watchInterval({ INPROGRESS_AGENT_WATCH_MS: '500' })).toBe(500);
    for (const bad of ['0', '-5', 'soon', '1.5', '']) expect(watchInterval({ INPROGRESS_AGENT_WATCH_MS: bad }), bad).toBe(MIN);
  });
});
