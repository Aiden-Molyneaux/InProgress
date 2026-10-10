import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKER_QUIET_MS, SILENT_MS, WATCH_MS, createWatchState, watchAgents, watchCommandEnds, watchInterval } from '../../src/server/agent-watch';
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
    const { hook, run, watch, transcript, append, start, row } = setup();
    start('a1');
    start('a2');
    transcript('a1', [[interrupted, 2 * MIN]]);
    transcript('a2', [[said, 30 * SEC]]);
    // a1 ends by its marker while the session lives; a2 is still running when the session ends.
    expect(run(WATCH_MS)).toEqual(['a1:killed']);
    const killed = row('a1');
    hook({ event: 'end' });
    // Both write again after the end: neither comes back, and nothing ends again.
    append('a1');
    append('a2');
    expect(watch()).toEqual({ ended: [], revived: [] });
    expect(run(30 * MIN)).toEqual([]);
    expect(row('a1')).toEqual(killed);
    expect(row('a2').end_reason).toBe('session');
  });

  it('leaves what it ended before its session ended alone when the session comes back, until a SubagentStart', () => {
    const { hook, run, watch, transcript, append, start, row, tick } = setup();
    start('l');
    transcript('l', [[(ts) => apiError('rate_limit', ts), 2 * MIN]]);
    expect(run(WATCH_MS)).toEqual(['l:limit']);
    const limited = row('l');
    hook({ event: 'end' });
    tick(6 * 60 * MIN);
    hook({ event: 'start', source: 'resume' });
    // A newer line in the session's new life is not enough: the session's end closed it.
    append('l');
    expect(watch()).toEqual({ ended: [], revived: [] });
    expect(row('l')).toEqual(limited);
    // A SubagentStart brings it back, and the watcher watches it again.
    start('l');
    // The agent's own marker comes after the start, as it would in a real run.
    tick(SEC);
    append('l', interrupted);
    expect(run(2 * MIN)).toEqual(['l:killed']);
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

describe('watchCommandEnds', () => {
  const notice = (taskId: string, status: string, exit?: number, extra = '') =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_${taskId}</tool-use-id>\n<status>${status}</status>\n<summary>Background command "x" ${status}${exit === undefined ? '' : ` (exit code ${exit})`}</summary>${extra}\n</task-notification>`;
  const enqueue = (content: string, timestamp: string, operation = 'enqueue') => line({ type: 'queue-operation', operation, timestamp, sessionId: 's1', content });

  function commandsSetup() {
    const s = setup();
    const file = join(s.dir, 's1.jsonl');
    const state = createWatchState();
    const tickAll = () => watchCommandEnds(s.ctx, state);
    const ends = () => tickAll().ended;
    const begin = (taskId: string, session = 's1') => s.hook({ event: 'command-started', taskId, kind: 'shell', commandHead: 'npm run build' }, session);
    const row = (taskId: string) =>
      s.ctx.db.prepare('SELECT ended_at, outcome, exit_code FROM session_commands WHERE task_id = ?').get(taskId) as { ended_at: string | null; outcome: string | null; exit_code: number | null } | undefined;
    const push = (...lines: string[]) => appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
    return { ...s, file, state, ends, tickAll, begin, row, push };
  }

  it('ends a running command at the line time with its status and exit code', () => {
    const { begin, push, ends, row } = commandsSetup();
    begin('b1');
    begin('b2');
    push(enqueue(notice('b1', 'failed', 3), '2026-10-06T09:05:00.000Z'), enqueue(notice('b2', 'completed', 0), '2026-10-06T09:06:00.000Z'));
    expect(ends()).toEqual([{ sessionId: 's1', taskId: 'b1', outcome: 'failed' }, { sessionId: 's1', taskId: 'b2', outcome: 'completed' }]);
    expect(row('b1')).toEqual({ ended_at: '2026-10-06T09:05:00.000Z', outcome: 'failed', exit_code: 3 });
    expect(row('b2')).toEqual({ ended_at: '2026-10-06T09:06:00.000Z', outcome: 'completed', exit_code: 0 });
  });

  it('reads only new bytes on a second tick', () => {
    const { begin, push, ends, row, ctx } = commandsSetup();
    begin('b1');
    begin('b2');
    push(enqueue(notice('b1', 'completed', 0), '2026-10-06T09:05:00.000Z'));
    expect(ends()).toHaveLength(1);
    // Running again by hand: a re-read from the start would end it a second time.
    ctx.db.prepare('UPDATE session_commands SET ended_at = NULL, outcome = NULL, exit_code = NULL WHERE task_id = ?').run('b1');
    push(enqueue(notice('b2', 'killed'), '2026-10-06T09:07:00.000Z'));
    expect(ends()).toEqual([{ sessionId: 's1', taskId: 'b2', outcome: 'killed' }]);
    expect(row('b1')).toEqual({ ended_at: null, outcome: null, exit_code: null });
  });

  it('keeps a partial last line for the next tick', () => {
    const { begin, file, ends, row, push } = commandsSetup();
    begin('b1');
    const whole = enqueue(notice('b1', 'completed', 0), '2026-10-06T09:05:00.000Z');
    appendFileSync(file, whole.slice(0, 40));
    expect(ends()).toEqual([]);
    push(whole.slice(40));
    expect(ends()).toHaveLength(1);
    expect(row('b1')).toMatchObject({ outcome: 'completed' });
  });

  it('reads only the last 8 MB of a file it sees for the first time, dropping the partial first line', () => {
    const { begin, file, ends, row, ctx } = commandsSetup();
    begin('old');
    begin('new');
    const pad = line({ type: 'user', message: 'x'.repeat(1000) });
    const head = `${enqueue(notice('old', 'completed', 0), '2026-10-06T08:00:00.000Z')}\n`;
    writeFileSync(file, head + `${pad}\n`.repeat(Math.ceil((9 * 1024 * 1024) / (pad.length + 1))));
    appendFileSync(file, `${enqueue(notice('new', 'completed', 0), '2026-10-06T09:05:00.000Z')}\n`);
    expect(ends()).toEqual([{ sessionId: 's1', taskId: 'new', outcome: 'completed' }]);
    expect(row('old')).toMatchObject({ ended_at: null });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM session_commands WHERE ended_at IS NULL').get()).toEqual({ n: 1 });
  });

  it('starts over when the file shrinks', () => {
    const { begin, file, push, ends, row } = commandsSetup();
    begin('b1');
    begin('b2');
    push(enqueue(notice('b1', 'completed', 0), '2026-10-06T09:05:00.000Z'), line({ type: 'user', message: 'x'.repeat(2000) }));
    expect(ends()).toHaveLength(1);
    writeFileSync(file, `${enqueue(notice('b2', 'failed', 1), '2026-10-06T09:08:00.000Z')}\n`);
    expect(ends()).toEqual([{ sessionId: 's1', taskId: 'b2', outcome: 'failed' }]);
    expect(row('b2')).toMatchObject({ exit_code: 1 });
  });

  it('changes nothing for a missing transcript, and picks the file up when it appears', () => {
    const { begin, file, ends, row, push } = commandsSetup();
    begin('b1');
    rmSync(file);
    expect(ends()).toEqual([]);
    expect(row('b1')).toMatchObject({ ended_at: null });
    push(enqueue(notice('b1', 'completed', 0), '2026-10-06T09:05:00.000Z'));
    expect(ends()).toHaveLength(1);
  });

  it('ignores a non-enqueue line, bad JSON, an id with no row, and a notification quoted inside an agent result', () => {
    const { begin, push, ends, row } = commandsSetup();
    begin('b1');
    push(
      enqueue(notice('b1', 'completed', 0), '2026-10-06T09:05:00.000Z', 'dequeue'),
      '{"type":"queue-operation","operation":"enqueue" this is not json',
      enqueue(notice('bnorow1', 'completed', 0), '2026-10-06T09:05:00.000Z'),
      enqueue(`<task-notification>\n<task-id>a9f3c2d1e</task-id>\n<status>completed</status>\n<summary>Agent done</summary>\n<result>${notice('b1', 'failed', 9)}</result>\n</task-notification>`, '2026-10-06T09:05:00.000Z'),
      line({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-06T09:05:00.000Z', content: 42 }),
    );
    expect(ends()).toEqual([]);
    expect(row('b1')).toMatchObject({ ended_at: null });
    expect(row('bnorow1')).toBeUndefined();
  });

  it('records one session.updated per touched session with the activity', () => {
    const { ctx, hook, dir, begin, push, ends, state } = commandsSetup();
    const otherPath = join(dir, 's2.jsonl');
    writeFileSync(otherPath, '');
    hook({ event: 'start', source: 'startup', cwd: 'C:/personal/InGame', transcriptPath: otherPath }, 's2');
    begin('b1');
    begin('b2');
    begin('c1', 's2');
    push(enqueue(notice('b1', 'completed', 0), '2026-10-06T09:05:00.000Z'), enqueue(notice('b2', 'completed', 0), '2026-10-06T09:06:00.000Z'));
    appendFileSync(otherPath, `${enqueue(notice('zzzz99', 'completed', 0), '2026-10-06T09:06:00.000Z')}\n`);
    const out = events(ctx, () => watchCommandEnds(ctx, state));
    expect(out).toEqual([{ actor: 'system', session: 's1', changed: ['commands'], state: 'working', activity: 'working' }]);
    // Both sessions are live, so both keep their offsets.
    expect(ends()).toEqual([]);
    expect(state.commandOffsets.has('s1')).toBe(true);
    expect(state.commandOffsets.has('s2')).toBe(true);
  });

  it('does not read at all for a session without running commands', () => {
    const { push, ends, state, begin } = commandsSetup();
    push(enqueue(notice('b1', 'completed', 0), '2026-10-06T09:05:00.000Z'));
    expect(ends()).toEqual([]);
    expect(state.commandOffsets.size).toBe(0);
    begin('b1');
    // First sight is now: the whole file is read, and the earlier line still ends it.
    expect(ends()).toHaveLength(1);
  });

  it('keeps the offset of a live session with nothing running, so its next command does not re-read the file', () => {
    const { begin, push, ends, state, row } = commandsSetup();
    begin('b1');
    push(enqueue(notice('b1', 'completed', 0), '2026-10-06T09:05:00.000Z'), enqueue(notice('b2', 'completed', 0), '2026-10-06T09:06:00.000Z'));
    expect(ends()).toEqual([{ sessionId: 's1', taskId: 'b1', outcome: 'completed' }]);
    expect(ends()).toEqual([]);
    expect(state.commandOffsets.has('s1')).toBe(true);
    // b2's line is behind the offset: starting b2 now must not read it.
    begin('b2');
    expect(ends()).toEqual([]);
    expect(row('b2')).toMatchObject({ ended_at: null });
  });

  it('drops the offset once the session ends', () => {
    const { begin, hook, ends, state } = commandsSetup();
    begin('b1');
    expect(ends()).toEqual([]);
    expect(state.commandOffsets.has('s1')).toBe(true);
    hook({ event: 'end' });
    expect(ends()).toEqual([]);
    expect(state.commandOffsets.has('s1')).toBe(false);
  });

  it('repairs an unknown end from a notice within five minutes, at the line time', () => {
    const { begin, hook, tick, push, ends, row } = commandsSetup();
    begin('b1');
    tick(15 * SEC);
    hook({ event: 'stop', background: [] });
    expect(row('b1')).toMatchObject({ outcome: 'unknown' });
    push(enqueue(notice('b1', 'failed', 1), '2026-10-06T09:05:00.000Z'));
    expect(ends()).toEqual([{ sessionId: 's1', taskId: 'b1', outcome: 'failed' }]);
    expect(row('b1')).toEqual({ ended_at: '2026-10-06T09:05:00.000Z', outcome: 'failed', exit_code: 1 });
  });

  it('does not repair an unknown end older than five minutes', () => {
    const { begin, hook, tick, push, ends, row } = commandsSetup();
    begin('b1');
    tick(15 * SEC);
    hook({ event: 'stop', background: [] });
    tick(6 * MIN);
    push(enqueue(notice('b1', 'failed', 1), '2026-10-06T09:05:00.000Z'));
    expect(ends()).toEqual([]);
    expect(row('b1')).toMatchObject({ outcome: 'unknown' });
  });

  it('never stores an end before the start', () => {
    const { hook, tick, push, ends, row, ctx } = commandsSetup();
    tick(MIN);
    hook({ event: 'stop', background: [{ taskId: 'bnew', type: 'shell' }] });
    push(enqueue(notice('bnew', 'completed', 0), '2026-10-06T08:00:00.000Z'));
    expect(ends()).toHaveLength(1);
    const stored = ctx.db.prepare("SELECT started_at, ended_at FROM session_commands WHERE task_id = 'bnew'").get() as { started_at: string; ended_at: string };
    expect(stored.ended_at).toBe(stored.started_at);
    expect(row('bnew')).toMatchObject({ outcome: 'completed' });
  });

  it('reports an unreadable transcript once, and again after it has read well', () => {
    const { begin, file, tickAll } = commandsSetup();
    begin('b1');
    rmSync(file);
    const report = { sessionId: 's1', path: file, code: 'ENOENT' };
    expect(tickAll().unreadable).toEqual([report]);
    expect(tickAll().unreadable).toEqual([]);
    writeFileSync(file, '');
    expect(tickAll().unreadable).toEqual([]);
    rmSync(file);
    expect(tickAll().unreadable).toEqual([report]);
  });

  it('records the activity: busy while a counting command still runs, idle after the last ends', () => {
    const { ctx, hook, begin, push, state } = commandsSetup();
    begin('b1');
    begin('b2');
    hook({ event: 'stop' });
    push(enqueue(notice('b1', 'completed', 0), '2026-10-06T09:05:00.000Z'));
    expect(events(ctx, () => watchCommandEnds(ctx, state))).toEqual([{ actor: 'system', session: 's1', changed: ['commands'], state: 'idle', activity: 'busy' }]);
    push(enqueue(notice('b2', 'completed', 0), '2026-10-06T09:06:00.000Z'));
    expect(events(ctx, () => watchCommandEnds(ctx, state))).toEqual([{ actor: 'system', session: 's1', changed: ['commands'], state: 'idle', activity: 'idle' }]);
  });
});

describe('watchAgents: a stopped agent writing its last line', () => {
  it('leaves a killed agent ended when its transcript gains a line 30 s after the TaskStop end', () => {
    const { ctx, hook, watch, transcript, append, start, row, tick } = setup();
    start('a1');
    transcript('a1', [[said, MIN]]);
    // TaskStop's PostToolUse ends it as killed; the stopped agent then writes its interrupt line.
    hook({ event: 'agent-ended', agentId: 'a1', reason: 'killed' });
    const ended = row('a1');
    expect(ended.end_reason).toBe('killed');
    tick(30 * SEC);
    append('a1', interrupted);
    expect(watch().revived).toEqual([]);
    expect(row('a1')).toEqual(ended);
    expect(findSession(ctx, 's1')!.subagents[0].endReason).toBe('killed');
  });

  it('revives a killed agent whose transcript gains a line 90 s after the end', () => {
    const { hook, watch, transcript, append, start, row, tick } = setup();
    start('a1');
    transcript('a1', [[said, MIN]]);
    hook({ event: 'agent-ended', agentId: 'a1', reason: 'killed' });
    tick(90 * SEC);
    append('a1');
    expect(watch().revived).toEqual([{ sessionId: 's1', agentId: 'a1' }]);
    expect(row('a1')).toEqual({ ended_at: null, end_reason: null, last_active_at: null });
  });

  it('still revives a silent agent 30 s after its end line', () => {
    const { run, watch, transcript, append, start, row, tick } = setup();
    start('a1');
    transcript('a1', [[said, 20 * MIN]]);
    expect(run(MIN)).toEqual(['a1:silent']);
    tick(30 * SEC);
    append('a1');
    expect(watch().revived).toEqual([{ sessionId: 's1', agentId: 'a1' }]);
    expect(row('a1').ended_at).toBeNull();
  });
});

describe('watchAgents: a row a message revived', () => {
  const resumeMessage: HookEventInput = { event: 'agent-messaged', agentId: 'a1', resumed: true, summary: 'Carry on' };

  it('is not ended again by the marker it was killed on', () => {
    const { hook, run, transcript, start, row } = setup();
    start('a1');
    transcript('a1', [[interrupted, 5 * MIN]]);
    hook({ event: 'agent-ended', agentId: 'a1', reason: 'killed' });
    expect(row('a1').end_reason).toBe('killed');
    hook(resumeMessage);
    expect(row('a1').ended_at).toBeNull();
    expect(run(2 * MIN)).toEqual([]);
    expect(row('a1').ended_at).toBeNull();
  });

  it('is not ended silent at once for an old transcript, but is after SILENT_MS from the revive', () => {
    const { hook, run, transcript, start, row } = setup();
    start('a1');
    transcript('a1', [[said, 30 * MIN]]);
    hook({ event: 'subagent-stop', agentId: 'a1' });
    hook(resumeMessage);
    expect(run(SILENT_MS - 2 * MIN)).toEqual([]);
    expect(run(3 * MIN)).toEqual(['a1:silent']);
    expect(row('a1').end_reason).toBe('silent');
  });
});
