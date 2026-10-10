import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { COMMANDS_LISTED, RECONCILE_GRACE_MS, endCommand, endSessionCommands, listCommands, pruneCommands, reconcileCommands, startCommand } from '../../src/server/repo/commands';

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** Two sessions in a database with a fixed clock; commands go in by raw SQL (the writers come later). */
function setup() {
  const ctx = createCtx(openDb(':memory:'), () => new Date(NOW).toISOString());
  for (const id of ['s1', 's2']) ctx.db.prepare("INSERT INTO sessions (id, state, started_at, last_seen_at) VALUES (?, 'working', 't', 't')").run(id);
  const insert = (taskId: string, startedAt: string, endedAt: string | null = null, session = 's1') =>
    ctx.db
      .prepare("INSERT INTO session_commands (session_id, task_id, kind, started_at, ended_at, outcome) VALUES (?, ?, 'shell', ?, ?, ?)")
      .run(session, taskId, startedAt, endedAt, endedAt ? 'completed' : null);
  return { ctx, insert };
}

describe('listCommands', () => {
  it('lists running commands and those ended in the last five minutes', () => {
    const { ctx, insert } = setup();
    insert('running', ago(10 * MIN));
    insert('recent', ago(20 * MIN), ago(4 * MIN));
    insert('old', ago(30 * MIN), ago(6 * MIN));
    expect(listCommands(ctx, 's1').map((c) => c.taskId).sort()).toEqual(['recent', 'running']);
  });

  it('lists running first, then newest first', () => {
    const { ctx, insert } = setup();
    insert('ended', ago(1 * MIN), ago(30 * 1000));
    insert('older', ago(20 * MIN));
    insert('newer', ago(10 * MIN));
    expect(listCommands(ctx, 's1').map((c) => c.taskId)).toEqual(['newer', 'older', 'ended']);
  });

  it('lists at most 30', () => {
    const { ctx, insert } = setup();
    for (let i = 0; i < 35; i++) insert(`t${String(i).padStart(2, '0')}`, ago((100 - i) * MIN));
    const listed = listCommands(ctx, 's1');
    expect(COMMANDS_LISTED).toBe(30);
    expect(listed).toHaveLength(30);
    expect(listed[0].taskId).toBe('t34');
    expect(listed[29].taskId).toBe('t05');
  });

  it('maps a row to CommandInfo', () => {
    const { ctx, insert } = setup();
    ctx.db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 't', 't')").run();
    ctx.db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (7, 1, NULL, 1, 'goal', 'P', 't', 't')").run();
    ctx.db
      .prepare(
        `INSERT INTO session_commands (session_id, task_id, tool_use_id, agent_id, kind, persistent, description, command_head, node_id, started_at, ended_at, outcome, exit_code)
         VALUES ('s1', 'bfull', 'toolu_1', 'a1', 'monitor', 1, 'Watch the build', 'npm run build', 7, ?, ?, 'completed', 0)`,
      )
      .run(ago(3 * MIN), ago(1 * MIN));
    insert('bmain', ago(2 * MIN));
    const byId = Object.fromEntries(listCommands(ctx, 's1').map((c) => [c.taskId, c]));
    expect(byId.bfull).toEqual({
      taskId: 'bfull', kind: 'monitor', agentId: 'a1', persistent: true, description: 'Watch the build', commandHead: 'npm run build',
      nodeId: 7, startedAt: ago(3 * MIN), endedAt: ago(1 * MIN), outcome: 'completed', exitCode: 0,
    });
    expect(byId.bmain).toMatchObject({ agentId: '', persistent: false, kind: 'shell', endedAt: null, outcome: null, exitCode: null });
  });

  it("lists only this session's commands", () => {
    const { ctx, insert } = setup();
    insert('mine', ago(MIN));
    insert('theirs', ago(MIN), null, 's2');
    expect(listCommands(ctx, 's1').map((c) => c.taskId)).toEqual(['mine']);
    expect(listCommands(ctx, 's2').map((c) => c.taskId)).toEqual(['theirs']);
  });
});

const HOUR = 60 * MIN;

/** The stored row of a command, raw. */
const rowOf = (ctx: ReturnType<typeof setup>['ctx'], taskId: string, session = 's1') =>
  ctx.db.prepare('SELECT * FROM session_commands WHERE session_id = ? AND task_id = ?').get(session, taskId) as Record<string, unknown> | undefined;
const started = (taskId: string, over: Record<string, unknown> = {}) => ({ taskId, kind: 'shell' as const, startedAt: ago(5 * MIN), nodeId: null, ...over });

describe('startCommand and endCommand', () => {
  it('starts a running row and ends it', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('b1', { toolUseId: 'toolu_1', description: 'Build', commandHead: 'npm run build', persistent: false }));
    expect(rowOf(ctx, 'b1')).toMatchObject({ kind: 'shell', tool_use_id: 'toolu_1', description: 'Build', command_head: 'npm run build', agent_id: '', ended_at: null, outcome: null });
    expect(endCommand(ctx, 's1', 'b1', 'failed', ago(MIN), 2)).toBe(true);
    expect(rowOf(ctx, 'b1')).toMatchObject({ ended_at: ago(MIN), outcome: 'failed', exit_code: 2 });
  });

  it('keeps a row ended when its start lands late, filling what is missing and taking the earlier start', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('b1', { startedAt: ago(2 * MIN) }));
    endCommand(ctx, 's1', 'b1', 'completed', ago(MIN), 0);
    startCommand(ctx, 's1', started('b1', { startedAt: ago(4 * MIN), description: 'Late', toolUseId: 'toolu_2', agentId: 'a1', commandHead: 'npm test' }));
    expect(rowOf(ctx, 'b1')).toMatchObject({ ended_at: ago(MIN), outcome: 'completed', exit_code: 0, description: 'Late', tool_use_id: 'toolu_2', agent_id: 'a1', command_head: 'npm test', started_at: ago(4 * MIN) });
  });

  it('fills only what is missing: a second start does not overwrite a description, a tool use or an agent', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('b1', { description: 'First', toolUseId: 'toolu_1', agentId: 'a1', commandHead: 'one' }));
    startCommand(ctx, 's1', started('b1', { description: 'Second', toolUseId: 'toolu_2', agentId: 'a2', commandHead: 'two', startedAt: ago(MIN) }));
    expect(rowOf(ctx, 'b1')).toMatchObject({ description: 'First', tool_use_id: 'toolu_1', agent_id: 'a1', command_head: 'one', started_at: ago(5 * MIN) });
  });

  it("a start after a reconcile insert takes the tool's kind, persistence, node and the earlier time", () => {
    const { ctx } = setup();
    ctx.db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 't', 't')").run();
    ctx.db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (7, 1, NULL, 1, 'goal', 'P', 't', 't')").run();
    reconcileCommands(ctx, 's1', [{ taskId: 'bmon', type: 'monitor', description: 'Watch' }], ago(MIN), { truncated: false, nodeId: null });
    expect(rowOf(ctx, 'bmon')).toMatchObject({ kind: 'monitor', persistent: 0, node_id: null, started_at: ago(MIN), agent_id: '' });
    startCommand(ctx, 's1', started('bmon', { kind: 'monitor', persistent: true, nodeId: 7, startedAt: ago(10 * MIN), agentId: 'a1' }));
    expect(rowOf(ctx, 'bmon')).toMatchObject({ kind: 'monitor', persistent: 1, node_id: 7, started_at: ago(10 * MIN), agent_id: 'a1', ended_at: null });
  });

  it('a start with no node keeps the node a reconcile gave the row', () => {
    const { ctx } = setup();
    ctx.db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 't', 't')").run();
    ctx.db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (7, 1, NULL, 1, 'goal', 'P', 't', 't')").run();
    reconcileCommands(ctx, 's1', [{ taskId: 'b1', type: 'shell' }], ago(MIN), { truncated: false, nodeId: 7 });
    startCommand(ctx, 's1', started('b1', { nodeId: null }));
    expect(rowOf(ctx, 'b1')).toMatchObject({ node_id: 7 });
  });

  it('never stores an end before the start', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('b1', { startedAt: ago(MIN) }));
    expect(endCommand(ctx, 's1', 'b1', 'completed', ago(5 * MIN), 0)).toBe(true);
    expect(rowOf(ctx, 'b1')).toMatchObject({ started_at: ago(MIN), ended_at: ago(MIN) });
  });

  it('endCommand on an unknown id is a no-op returning false', () => {
    const { ctx } = setup();
    expect(endCommand(ctx, 's1', 'nope', 'completed', ago(MIN))).toBe(false);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM session_commands').get()).toEqual({ n: 0 });
  });

  it('a notice replaces an unknown end, and ending an ended row again changes nothing', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('b1'));
    reconcileCommands(ctx, 's1', [], ago(3 * MIN), { truncated: false, nodeId: null });
    expect(rowOf(ctx, 'b1')).toMatchObject({ outcome: 'unknown', ended_at: ago(3 * MIN) });
    expect(endCommand(ctx, 's1', 'b1', 'failed', ago(2 * MIN), 1)).toBe(true);
    expect(rowOf(ctx, 'b1')).toMatchObject({ outcome: 'failed', ended_at: ago(2 * MIN), exit_code: 1 });
    expect(endCommand(ctx, 's1', 'b1', 'completed', ago(MIN), 0)).toBe(false);
    expect(rowOf(ctx, 'b1')).toMatchObject({ outcome: 'failed', exit_code: 1 });
  });

  it('a session end is final', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('b1'));
    endSessionCommands(ctx, 's1', ago(2 * MIN));
    expect(endCommand(ctx, 's1', 'b1', 'completed', ago(MIN), 0)).toBe(false);
    expect(rowOf(ctx, 'b1')).toMatchObject({ outcome: 'session', ended_at: ago(2 * MIN) });
  });

  it('stores a non-ISO time in the millisecond form, and writes nothing for an invalid one', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('b1', { startedAt: '2026-10-09T12:00:00Z' }));
    expect(rowOf(ctx, 'b1')!.started_at).toBe('2026-10-09T12:00:00.000Z');
    expect(endCommand(ctx, 's1', 'b1', 'completed', '2026-10-09T12:00:01Z')).toBe(true);
    expect(rowOf(ctx, 'b1')!.ended_at).toBe('2026-10-09T12:00:01.000Z');
    startCommand(ctx, 's1', started('b2', { startedAt: 'not a date' }));
    expect(rowOf(ctx, 'b2')).toBeUndefined();
    expect(endCommand(ctx, 's1', 'b1', 'failed', 'nope')).toBe(false);
  });

  it('keeps listCommands ordering over writer-made rows', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('early', { startedAt: '2026-10-09T11:00:00Z' }));
    startCommand(ctx, 's1', started('late', { startedAt: '2026-10-09T11:00:00.500Z' }));
    expect(listCommands(ctx, 's1').map((c) => c.taskId)).toEqual(['late', 'early']);
  });
});

describe('reconcileCommands', () => {
  const none = { truncated: false, nodeId: null };

  it('ends a missing running row as unknown and keeps a listed one', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('gone'));
    startCommand(ctx, 's1', started('kept'));
    expect(reconcileCommands(ctx, 's1', [{ taskId: 'kept', type: 'shell' }], ago(MIN), none)).toBe(1);
    expect(rowOf(ctx, 'gone')).toMatchObject({ outcome: 'unknown', ended_at: ago(MIN) });
    expect(rowOf(ctx, 'kept')).toMatchObject({ outcome: null, ended_at: null });
  });

  it('inserts a listed command it lacks, with no agent, the Stop time and the focus', () => {
    const { ctx } = setup();
    ctx.db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 't', 't')").run();
    ctx.db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, created_at, updated_at) VALUES (7, 1, NULL, 1, 'goal', 'P', 't', 't')").run();
    expect(reconcileCommands(ctx, 's1', [{ taskId: 'bnew', type: 'shell', description: 'Merge', commandHead: 'git merge' }], ago(MIN), { truncated: false, nodeId: 7 })).toBe(1);
    expect(rowOf(ctx, 'bnew')).toMatchObject({ kind: 'shell', agent_id: '', started_at: ago(MIN), node_id: 7, description: 'Merge', command_head: 'git merge', ended_at: null });
  });

  it('leaves a command that started within 10 seconds of the Stop, and ends one that started 11 before', () => {
    const { ctx } = setup();
    expect(RECONCILE_GRACE_MS).toBe(10_000);
    // The Stop is at ago(MIN).
    startCommand(ctx, 's1', started('fresh', { startedAt: ago(MIN + 3000) }));
    startCommand(ctx, 's1', started('older', { startedAt: ago(MIN + 11_000) }));
    startCommand(ctx, 's1', started('after', { startedAt: ago(MIN - 3000) }));
    expect(reconcileCommands(ctx, 's1', [], ago(MIN), none)).toBe(1);
    expect(rowOf(ctx, 'fresh')).toMatchObject({ ended_at: null });
    expect(rowOf(ctx, 'after')).toMatchObject({ ended_at: null });
    expect(rowOf(ctx, 'older')).toMatchObject({ outcome: 'unknown' });
  });

  it('ignores subagent and workflow entries', () => {
    const { ctx } = setup();
    expect(reconcileCommands(ctx, 's1', [{ taskId: 'a1', type: 'subagent' }, { taskId: 'w1', type: 'workflow' }], ago(MIN), none)).toBe(0);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM session_commands').get()).toEqual({ n: 0 });
  });

  it('ends nothing when the list was truncated, but still inserts', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('running'));
    reconcileCommands(ctx, 's1', [{ taskId: 'other', type: 'shell' }], ago(MIN), { truncated: true, nodeId: null });
    expect(rowOf(ctx, 'running')).toMatchObject({ ended_at: null });
    expect(rowOf(ctx, 'other')).toBeDefined();
  });

  it('never re-opens an ended row that is listed', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('b1'));
    endCommand(ctx, 's1', 'b1', 'completed', ago(2 * MIN), 0);
    expect(reconcileCommands(ctx, 's1', [{ taskId: 'b1', type: 'shell' }], ago(MIN), none)).toBe(0);
    expect(rowOf(ctx, 'b1')).toMatchObject({ outcome: 'completed', ended_at: ago(2 * MIN) });
  });

  it("ends a subagent's missing shell too, and only this session's", () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('sub', { agentId: 'a1' }));
    startCommand(ctx, 's2', started('other'));
    reconcileCommands(ctx, 's1', [], ago(MIN), none);
    expect(rowOf(ctx, 'sub')).toMatchObject({ outcome: 'unknown' });
    expect(rowOf(ctx, 'other', 's2')).toMatchObject({ ended_at: null });
  });
});

describe('endSessionCommands', () => {
  it('ends running rows as session at the time, leaving ended ones', () => {
    const { ctx } = setup();
    startCommand(ctx, 's1', started('run'));
    startCommand(ctx, 's1', started('done'));
    endCommand(ctx, 's1', 'done', 'completed', ago(3 * MIN), 0);
    startCommand(ctx, 's2', started('theirs'));
    expect(endSessionCommands(ctx, 's1', ago(MIN))).toBe(1);
    expect(rowOf(ctx, 'run')).toMatchObject({ outcome: 'session', ended_at: ago(MIN) });
    expect(rowOf(ctx, 'done')).toMatchObject({ outcome: 'completed', ended_at: ago(3 * MIN) });
    expect(rowOf(ctx, 'theirs', 's2')).toMatchObject({ ended_at: null });
  });
});

describe('pruneCommands', () => {
  it('removes ended rows over 24 hours old and keeps running ones', () => {
    const { ctx, insert } = setup();
    insert('old', ago(30 * HOUR), ago(25 * HOUR));
    insert('fresh', ago(30 * HOUR), ago(23 * HOUR));
    insert('running', ago(48 * HOUR));
    pruneCommands(ctx);
    expect(['old', 'fresh', 'running'].filter((t) => rowOf(ctx, t))).toEqual(['fresh', 'running']);
  });

  it('keeps at most 200 rows per session, dropping the oldest ended first and never a running one', () => {
    const { ctx, insert } = setup();
    for (let i = 0; i < 210; i++) insert(`e${String(i).padStart(3, '0')}`, ago(23 * HOUR - i * 1000), ago(22 * HOUR - i * 1000));
    for (let i = 0; i < 5; i++) insert(`r${i}`, ago(40 * HOUR + i));
    insert('other', ago(HOUR), ago(30 * MIN), 's2');
    pruneCommands(ctx);
    const count = (s: string) => (ctx.db.prepare('SELECT COUNT(*) AS n FROM session_commands WHERE session_id = ?').get(s) as { n: number }).n;
    expect(count('s1')).toBe(200);
    expect(rowOf(ctx, 'e000')).toBeUndefined();
    expect(rowOf(ctx, 'e014')).toBeUndefined();
    expect(rowOf(ctx, 'e015')).toBeDefined();
    for (let i = 0; i < 5; i++) expect(rowOf(ctx, `r${i}`)).toBeDefined();
    expect(count('s2')).toBe(1);
  });

  it('keeps running rows past the cap', () => {
    const { ctx, insert } = setup();
    for (let i = 0; i < 205; i++) insert(`r${i}`, ago(2 * HOUR + i));
    pruneCommands(ctx);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM session_commands').get() as { n: number }).n).toBe(205);
  });
});
