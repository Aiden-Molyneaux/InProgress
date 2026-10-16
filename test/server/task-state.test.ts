import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, schemaVersion } from '../../src/server/db/connection';
import { MIGRATIONS } from '../../src/server/db/schema';
import type { Ctx } from '../../src/server/db/tx';
import { clearAsk, raiseAsk } from '../../src/server/repo/asks';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes, requireNode, updateNode } from '../../src/server/repo/nodes';
import { addBinding, createProject } from '../../src/server/repo/projects';
import { findSession } from '../../src/server/repo/sessions';
import { handleHookEvent, setFocus } from '../../src/server/session-flow';
import { STALE_SESSION_MS } from '../../src/core/types';
import { reconcileProjects } from '../../src/server/repo/taskState';
import { makeCtx } from '../helpers';

const T = '2026-10-01T00:00:00.000Z';

/** A database at schema 10 with a project and two steps, then migrated to the latest schema. */
function at10() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 10)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '10') ON CONFLICT(key) DO UPDATE SET value = '10'").run();
  db.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', '', 'active', 'claude', '', ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at, completed_at) VALUES (2, 1, 1, 1, 'task', 'Done one', '', 'done', 'claude', 'Shipped', ?, ?, ?)").run(T, T, T);
  migrate(db);
  return db;
}

/** A project with the Board reconcile switched on (main.ts sets it on the server's ctx). */
function setup(reconcile = true) {
  const ctx = makeCtx();
  if (reconcile) ctx.reconcile = reconcileProjects;
  const project = createProject(ctx, 'test', { name: 'P' });
  return { ctx, project };
}

const stored = (ctx: Ctx, id: number) =>
  ctx.db.prepare('SELECT board_state, state_since, hue, updated_at FROM nodes WHERE id = ?').get(id) as { board_state: string | null; state_since: string | null; hue: number | null; updated_at: string };

afterEach(() => vi.restoreAllMocks());

describe('migration 11', () => {
  it('upgrades a v10 database with data, keeping every row, the new columns null and min_reader_version 1', () => {
    const db = at10();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(11);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
    expect(db.prepare('SELECT id, title, status, outcome, completed_at, board_state, state_since, hue FROM nodes ORDER BY id').all()).toEqual([
      { id: 1, title: 'P', status: 'active', outcome: '', completed_at: null, board_state: null, state_since: null, hue: null },
      { id: 2, title: 'Done one', status: 'done', outcome: 'Shipped', completed_at: T, board_state: null, state_since: null, hue: null },
    ]);
    const cols = db.prepare("SELECT name FROM pragma_table_info('nodes')").pluck().all();
    expect(cols).toEqual(expect.arrayContaining(['board_state', 'state_since', 'hue']));
  });

  it('still takes an INSERT that names only the v10 nodes columns, the way a v10 build writes', () => {
    const db = at10();
    expect(() => db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (3, 1, 1, 2, 'task', 'Old build', '', 'todo', 'claude', '', ?, ?)").run(T, T)).not.toThrow();
    expect(db.prepare('SELECT board_state, state_since, hue FROM nodes WHERE id = 3').get()).toEqual({ board_state: null, state_since: null, hue: null });
  });
});

describe('the Board reconcile', () => {
  it('moves state_since only when the state changes', () => {
    const { ctx, project } = setup();
    const [s] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'S' }] });
    const first = stored(ctx, s.id);
    expect(first.board_state).toBe('backlog');
    expect(first.state_since).toBe(first.updated_at);
    updateNode(ctx, 'test', s.id, { body: 'more words' });
    expect(stored(ctx, s.id)).toMatchObject({ board_state: 'backlog', state_since: first.state_since });
    updateNode(ctx, 'test', s.id, { status: 'blocked' });
    const blocked = stored(ctx, s.id);
    expect(blocked.board_state).toBe('blocked');
    expect(blocked.state_since! > first.state_since!).toBe(true);
    expect(blocked.state_since! > blocked.updated_at).toBe(true);
    updateNode(ctx, 'test', s.id, { title: 'Renamed' });
    expect(stored(ctx, s.id).state_since).toBe(blocked.state_since);
  });

  it('on the first set takes completed_at for done, the oldest open ask for an ask state, and updated_at otherwise', () => {
    const { ctx, project } = setup(false);
    const [done, asked, blocked, plain] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'D' }, { title: 'A' }, { title: 'B', status: 'blocked' }, { title: 'P' }] });
    updateNode(ctx, 'test', done.id, { status: 'done', outcome: 'ok' });
    const ask = raiseAsk(ctx, 'test', { nodeId: asked.id, kind: 'review', text: 'Look' });
    raiseAsk(ctx, 'test', { nodeId: asked.id, kind: 'review', text: 'And this' });
    updateNode(ctx, 'test', asked.id, { body: 'touched after the ask' });
    reconcileProjects(ctx, [project.id]);
    const d = requireNode(ctx, done.id);
    expect(d).toMatchObject({ boardState: 'done', stateSince: d.completedAt, hue: null });
    expect(requireNode(ctx, asked.id)).toMatchObject({ boardState: 'review', stateSince: ask.raisedAt });
    expect(requireNode(ctx, asked.id).updatedAt).not.toBe(ask.raisedAt);
    const b = requireNode(ctx, blocked.id);
    expect(b).toMatchObject({ boardState: 'blocked', stateSince: b.updatedAt });
    const p = requireNode(ctx, plain.id);
    expect(p).toMatchObject({ boardState: 'backlog', stateSince: p.updatedAt, hue: null });
  });

  it('gives a coloured step the hue fewest steps hold, lowest index on ties', () => {
    const { ctx, project } = setup();
    const nodes = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: Array.from({ length: 8 }, (_, i) => ({ title: `S${i}`, status: 'blocked' as const })) });
    expect(nodes.map((n) => stored(ctx, n.id).hue)).toEqual([0, 1, 2, 3, 4, 5, 6, 0]);
    updateNode(ctx, 'test', nodes[3].id, { status: 'done', outcome: 'ok' });
    expect(stored(ctx, nodes[3].id)).toMatchObject({ board_state: 'done', hue: null });
    const [late] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Late', status: 'blocked' }] });
    expect(stored(ctx, late.id).hue).toBe(3);
    const [later] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Later', status: 'blocked' }] });
    expect(stored(ctx, later.id).hue).toBe(1);
  });

  it('keeps the hue between coloured states and frees it at done and at backlog', () => {
    const { ctx, project } = setup();
    const [a, b] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'A', status: 'blocked' }, { title: 'B', status: 'blocked' }] });
    expect(stored(ctx, b.id).hue).toBe(1);
    const ask = raiseAsk(ctx, 'test', { nodeId: b.id, kind: 'question', text: 'Which?' });
    expect(stored(ctx, b.id)).toMatchObject({ board_state: 'question', hue: 1 });
    clearAsk(ctx, 'window', ask.id);
    expect(stored(ctx, b.id)).toMatchObject({ board_state: 'blocked', hue: 1 });
    updateNode(ctx, 'test', b.id, { status: 'todo' });
    expect(stored(ctx, b.id)).toMatchObject({ board_state: 'backlog', hue: null });
    updateNode(ctx, 'test', a.id, { status: 'done', outcome: 'ok' });
    expect(stored(ctx, a.id)).toMatchObject({ board_state: 'done', hue: null });
    updateNode(ctx, 'test', b.id, { status: 'blocked' });
    expect(stored(ctx, b.id)).toMatchObject({ board_state: 'blocked', hue: 0 });
  });

  it('gives a hue to a coloured step stored without one, leaving its state_since', () => {
    const { ctx, project } = setup();
    const [a, b] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'A', status: 'blocked' }, { title: 'B', status: 'blocked' }] });
    const before = stored(ctx, a.id);
    ctx.db.prepare('UPDATE nodes SET hue = NULL WHERE id = ?').run(a.id);
    reconcileProjects(ctx, [project.id]);
    expect(stored(ctx, a.id)).toMatchObject({ board_state: 'blocked', state_since: before.state_since, hue: 0 });
    expect(stored(ctx, b.id).hue).toBe(1);
  });

  it('takes the state and hue off the root, a group and a dropped step that were on the board, dating when they left', () => {
    const { ctx, project } = setup();
    const [group] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'G', status: 'blocked', children: [{ title: 'Child' }] }] });
    const [gone] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Gone', status: 'blocked' }] });
    expect(stored(ctx, gone.id).hue).not.toBeNull();
    ctx.db.prepare("UPDATE nodes SET board_state = 'blocked', state_since = ?, hue = 5 WHERE id IN (?, ?)").run('2020-01-01T00:00:00.000Z', project.rootNodeId, group.id);
    updateNode(ctx, 'test', gone.id, { status: 'dropped' });
    for (const id of [project.rootNodeId, group.id, gone.id]) {
      const row = stored(ctx, id);
      expect(row).toMatchObject({ board_state: null, hue: null });
      expect(row.state_since! > '2026-09-27T12:00:00.000Z').toBe(true);
    }
  });

  it('records no events and leaves updated_at alone', () => {
    const { ctx, project } = setup(false);
    const nodes = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'A', status: 'blocked' }, { title: 'B' }, { title: 'C', assignee: 'me', status: 'active' }] });
    const before = nodes.map((n) => stored(ctx, n.id).updated_at);
    const lastEvent = maxEventId(ctx);
    reconcileProjects(ctx, [project.id]);
    expect(listEventsSince(ctx, lastEvent)).toEqual([]);
    expect(nodes.map((n) => stored(ctx, n.id).board_state)).toEqual(['blocked', 'backlog', 'unattended']);
    expect(nodes.map((n) => stored(ctx, n.id).updated_at)).toEqual(before);
  });

  it('runs inside each write for the projects its events name', () => {
    const { ctx, project } = setup(false);
    const calls: number[][] = [];
    ctx.reconcile = (_c, ids) => { calls.push(ids); };
    addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'A' }, { title: 'B' }] });
    expect(calls).toEqual([[project.id]]);
  });

  it('a reconcile that throws leaves the write committed, rolls back its own changes and logs [reconcile]', () => {
    const { ctx, project } = setup(false);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx.reconcile = (c) => {
      c.db.prepare("UPDATE nodes SET board_state = 'done' WHERE id = ?").run(project.rootNodeId);
      throw new Error('boom');
    };
    const [s] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Kept' }] });
    expect(requireNode(ctx, s.id).title).toBe('Kept');
    expect(stored(ctx, project.rootNodeId).board_state).toBeNull();
    expect(listEventsSince(ctx, 0).some((e) => e.type === 'node.created' && e.entityId === String(s.id))).toBe(true);
    expect(log).toHaveBeenCalledWith('[reconcile]', expect.objectContaining({ message: 'boom' }));
  });

  it('a reconcile that loses the whole transaction fails the write with its own error, unlogged', () => {
    const { ctx, project } = setup(false);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx.reconcile = (c) => {
      // What SQLite does on some errors (a full disk, say): it rolls the whole transaction back, not just the savepoint.
      c.db.exec('ROLLBACK');
      throw new Error('lost');
    };
    expect(() => addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Lost' }] })).toThrow('lost');
    expect(ctx.db.prepare("SELECT COUNT(*) FROM nodes WHERE title = 'Lost'").pluck().get()).toBe(0);
    expect(log).not.toHaveBeenCalledWith('[reconcile]', expect.anything());
  });

  it('dates a step that leaves the board and comes back from when it moved, not its old updated_at', () => {
    const { ctx, project } = setup();
    const [parent] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Parent' }] });
    const onBoard = stored(ctx, parent.id);
    expect(onBoard).toMatchObject({ board_state: 'backlog', state_since: onBoard.updated_at });
    const [child] = addNodes(ctx, 'test', { parentId: parent.id, nodes: [{ title: 'Child' }] });
    const asGroup = stored(ctx, parent.id);
    expect(asGroup).toMatchObject({ board_state: null, hue: null });
    expect(asGroup.state_since! > onBoard.state_since!).toBe(true);
    updateNode(ctx, 'test', child.id, { status: 'done', outcome: 'ok' });
    const back = stored(ctx, parent.id);
    expect(back.board_state).toBe('backlog');
    expect(back.state_since! > asGroup.state_since!).toBe(true);
    expect(back.updated_at).toBe(onBoard.updated_at);
  });

  it('leaves a group that was never on the board all null', () => {
    const { ctx, project } = setup();
    const [group] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'G', children: [{ title: 'Child' }] }] });
    expect(stored(ctx, group.id)).toMatchObject({ board_state: null, state_since: null, hue: null });
    addNodes(ctx, 'test', { parentId: group.id, nodes: [{ title: 'Another' }] });
    expect(stored(ctx, group.id)).toMatchObject({ board_state: null, state_since: null, hue: null });
  });

  it('follows a session through the hook path: focus gives idle, a prompt working, a stop idle', () => {
    const { ctx, project } = setup();
    addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
    const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'S' }] });
    const sid = 's-hook';
    handleHookEvent(ctx, sid, { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
    expect(findSession(ctx, sid)?.projectId).toBe(project.id);
    expect(stored(ctx, step.id).board_state).toBe('backlog');
    setFocus(ctx, 'scribe:s-hook', sid, step.id);
    expect(stored(ctx, step.id).board_state).toBe('idle');
    const hue = stored(ctx, step.id).hue;
    expect(hue).not.toBeNull();
    handleHookEvent(ctx, sid, { event: 'prompt' });
    expect(stored(ctx, step.id)).toMatchObject({ board_state: 'working', hue });
    handleHookEvent(ctx, sid, { event: 'stop' });
    expect(stored(ctx, step.id)).toMatchObject({ board_state: 'idle', hue });
  });

  it('still writes with a stale session in the project, and leaves expiring it to the reads that do', () => {
    const { ctx, project } = setup();
    addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
    const [focused, other] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'F' }, { title: 'O' }] });
    handleHookEvent(ctx, 's-old', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
    setFocus(ctx, 'scribe:s-old', 's-old', focused.id);
    expect(stored(ctx, focused.id).board_state).toBe('idle');
    const old = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS - 60_000).toISOString();
    ctx.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(old, 's-old');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    updateNode(ctx, 'test', other.id, { status: 'blocked' });
    expect(log).not.toHaveBeenCalled();
    expect(stored(ctx, other.id).board_state).toBe('blocked');
    expect(stored(ctx, focused.id).board_state).not.toBe('idle');
    expect(findSession(ctx, 's-old')?.state).not.toBe('ended');
  });
});
