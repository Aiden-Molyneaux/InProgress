import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { COMMANDS_LISTED, listCommands } from '../../src/server/repo/commands';

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
