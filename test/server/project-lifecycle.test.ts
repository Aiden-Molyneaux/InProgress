import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addLog } from '../../src/server/repo/logs';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, getProjectById, listBindings, listProjectSummaries, setQueue, updateProject } from '../../src/server/repo/projects';
import { addResource } from '../../src/server/repo/resources';
import { findSession } from '../../src/server/repo/sessions';
import { setTasks } from '../../src/server/repo/work';
import { handleHookEvent, setFocus } from '../../src/server/session-flow';
import {
  deleteProject, listDeletedProjects, purgeDeletedProjects, restoreProject, runMaintenance,
} from '../../src/server/project-lifecycle';

const DAY = 24 * 60 * 60 * 1000;

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A database with a clock the test moves by hand, starting 2026-10-06 09:00. */
function clocked() {
  let now = Date.parse('2026-10-06T09:00:00.000Z');
  const ctx = createCtx(openDb(':memory:'), () => new Date(now).toISOString());
  return { ctx, tick: (ms: number) => (now += ms) };
}

/** A project archived and ready to delete. */
function archived(ctx: Ctx, name: string) {
  const p = createProject(ctx, 'test', { name });
  updateProject(ctx, 'test', p.slug, { status: 'archived' });
  return p;
}

/** The error `fn` throws, so a test can read its status and hint. */
function thrown(fn: () => unknown): { status?: number; message?: string; hint?: string } {
  try {
    fn();
  } catch (err) {
    return err as { status?: number; message?: string; hint?: string };
  }
  throw new Error('it did not throw');
}

const silent = { info: () => undefined, error: () => undefined };

describe('deleteProject', () => {
  it('soft-deletes an archived project: hidden, still archived, with when it will be purged', () => {
    const { ctx } = clocked();
    const p = archived(ctx, 'Old Site');
    const mark = maxEventId(ctx);
    const at = ctx.now();
    const purgeAt = new Date(Date.parse(at) + 30 * DAY).toISOString();
    expect(deleteProject(ctx, 'window', p.id)).toEqual({ id: p.id, slug: 'old-site', deletedAt: at, purgeAt });
    expect(listProjectSummaries(ctx)).toEqual([]);
    expect(ctx.db.prepare('SELECT status, deleted_at FROM projects WHERE id = ?').get(p.id)).toEqual({ status: 'archived', deleted_at: at });
    expect(listEventsSince(ctx, mark).map((e) => ({ type: e.type, projectId: e.projectId, actor: e.actor, data: e.data }))).toEqual([
      { type: 'project.deleted', projectId: p.id, actor: 'window', data: { slug: 'old-site', name: 'Old Site', purgeAt } },
    ]);
  });

  it('needs a project that exists and is not deleted yet, archived or active', () => {
    const { ctx } = clocked();
    const kept = createProject(ctx, 'test', { name: 'Kept' });
    expect(thrown(() => deleteProject(ctx, 'window', 999))).toMatchObject({ status: 404, message: 'Project 999 not found' });
    const p = archived(ctx, 'Old');
    deleteProject(ctx, 'window', p.id);
    expect(thrown(() => deleteProject(ctx, 'window', p.id))).toMatchObject({ status: 409, message: 'Project old is already deleted' });
    const live = createProject(ctx, 'test', { name: 'Live' });
    deleteProject(ctx, 'window', live.id);
    const mark = maxEventId(ctx);
    expect(thrown(() => deleteProject(ctx, 'window', live.id))).toMatchObject({ status: 409, message: 'Project live is already deleted' });
    expect(listEventsSince(ctx, mark)).toEqual([]);
    expect(getProjectById(ctx, kept.id)?.status).toBe('active');
  });

  it('keeps its bindings, inert, for a restore', () => {
    const { ctx } = clocked();
    const p = createProject(ctx, 'test', { name: 'Old' });
    addBinding(ctx, 'test', p.slug, 'C:/work/old');
    updateProject(ctx, 'test', p.slug, { status: 'archived' });
    deleteProject(ctx, 'window', p.id);
    expect(listBindings(ctx)).toEqual([]);
    expect(ctx.db.prepare('SELECT COUNT(*) FROM bindings WHERE project_id = ?').pluck().get(p.id)).toBe(1);
    expect(handleHookEvent(ctx, 'x1', { event: 'start', source: 'startup', cwd: 'C:/work/old' })).toEqual({ tracked: false });
  });

  it('ends a session an older build left live in the archived project, before the delete is recorded', () => {
    const { ctx } = clocked();
    const p = archived(ctx, 'Old');
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at, slot) VALUES ('s1', ?, 'working', ?, ?, 0)").run(p.id, ctx.now(), ctx.now());
    const mark = maxEventId(ctx);
    deleteProject(ctx, 'window', p.id);
    expect(findSession(ctx, 's1')).toMatchObject({ state: 'ended', projectId: p.id });
    expect(listEventsSince(ctx, mark).map((e) => e.type)).toEqual(['session.updated', 'project.deleted']);
  });
});

describe('deleteProject of an active project', () => {
  /**
   * Live Site bound to C:/work/live with sessions s1 (and its subagent) and s2, Other bound to C:/work/other with s3,
   * and Up next entries owned by each session plus an unowned one in Live Site.
   */
  function live() {
    const { ctx, tick } = clocked();
    const p = createProject(ctx, 'test', { name: 'Live Site' });
    const other = createProject(ctx, 'test', { name: 'Other' });
    addBinding(ctx, 'test', p.slug, 'C:/work/live');
    addBinding(ctx, 'test', other.slug, 'C:/work/other');
    const [a, b, c] = addNodes(ctx, 'test', { parentId: p.rootNodeId, nodes: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
    handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/work/live' });
    handleHookEvent(ctx, 's2', { event: 'start', source: 'startup', cwd: 'C:/work/live' });
    handleHookEvent(ctx, 's3', { event: 'start', source: 'startup', cwd: 'C:/work/other' });
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 's1-a1', agentType: 'general-purpose' });
    setQueue(ctx, 'test', p.slug, [a.id], { sessionId: 's1' });
    setQueue(ctx, 'test', p.slug, [b.id], { sessionId: 's2' });
    setQueue(ctx, 'test', p.slug, [c.id], 'unowned');
    setQueue(ctx, 'test', other.slug, [other.rootNodeId], { sessionId: 's3' });
    return { ctx, tick, p, other, a, b, c };
  }

  it("archives and deletes it in one write: its live sessions end, their own Up next entries go, and the archive's events come before the delete's", () => {
    const { ctx, p, other, a, b, c } = live();
    const mark = maxEventId(ctx);
    const at = ctx.now();
    const purgeAt = new Date(Date.parse(at) + 30 * DAY).toISOString();
    // One write: every event is delivered after its commit, so each one finds the project deleted already.
    const seen: unknown[] = [];
    ctx.bus.on('event', () => seen.push(ctx.db.prepare('SELECT deleted_at FROM projects WHERE id = ?').pluck().get(p.id)));
    expect(deleteProject(ctx, 'window', p.id)).toEqual({ id: p.id, slug: 'live-site', deletedAt: at, purgeAt });
    expect(seen).toEqual([at, at, at, at, at]);
    expect(ctx.db.prepare('SELECT status, deleted_at FROM projects WHERE id = ?').get(p.id)).toEqual({ status: 'archived', deleted_at: at });
    expect(findSession(ctx, 's1')).toMatchObject({ projectId: p.id, state: 'ended', endedAt: at });
    expect(findSession(ctx, 's2')).toMatchObject({ projectId: p.id, state: 'ended', endedAt: at });
    expect(findSession(ctx, 's3')).toMatchObject({ projectId: other.id, state: 'idle', endedAt: null });
    expect(ctx.db.prepare("SELECT ended_at FROM session_subagents WHERE agent_id = 's1-a1'").pluck().get()).toBe(at);
    expect(getProjectById(ctx, p.id)?.queue).toEqual([{ nodeId: c.id, sessionId: null }]);
    expect(getProjectById(ctx, other.id)?.queue).toEqual([{ nodeId: other.rootNodeId, sessionId: 's3' }]);
    expect(listEventsSince(ctx, mark).map((e) => [e.type, e.entityId, e.projectId, e.actor, e.data])).toEqual([
      ['project.updated', String(p.id), p.id, 'window', { changes: { queue: {
        from: [{ nodeId: a.id, sessionId: 's1' }, { nodeId: b.id, sessionId: 's2' }, { nodeId: c.id, sessionId: null }],
        to: [{ nodeId: c.id, sessionId: null }],
      } } }],
      ['session.updated', 's1', p.id, 'window', { changed: ['state'], state: 'ended' }],
      ['session.updated', 's2', p.id, 'window', { changed: ['state'], state: 'ended' }],
      ['project.updated', String(p.id), p.id, 'window', { changes: { status: { from: 'active', to: 'archived' } } }],
      ['project.deleted', String(p.id), p.id, 'window', { slug: 'live-site', name: 'Live Site', purgeAt }],
    ]);
    // Hidden, its bindings inert, and nothing its sessions do afterwards is recorded.
    expect(listProjectSummaries(ctx).map((x) => x.slug)).toEqual(['other']);
    expect(listDeletedProjects(ctx).map((d) => d.slug)).toEqual(['live-site']);
    const after = maxEventId(ctx);
    expect(handleHookEvent(ctx, 's1', { event: 'prompt' })).toEqual({ tracked: false });
    expect(handleHookEvent(ctx, 'x1', { event: 'start', source: 'startup', cwd: 'C:/work/live' })).toEqual({ tracked: false });
    expect(listEventsSince(ctx, after)).toEqual([]);
  });

  it('records only the status change and the delete when no session is live and Up next holds nobody', () => {
    const { ctx } = clocked();
    const p = createProject(ctx, 'test', { name: 'Quiet' });
    const mark = maxEventId(ctx);
    deleteProject(ctx, 'window', p.id);
    expect(listEventsSince(ctx, mark).map((e) => e.type)).toEqual(['project.updated', 'project.deleted']);
  });

  it('comes back archived on a restore, its sessions still ended, and an unarchive puts it back in the tabs', () => {
    const { ctx, tick, p, c } = live();
    deleteProject(ctx, 'window', p.id);
    tick(DAY);
    expect(restoreProject(ctx, 'window', p.id)).toMatchObject({ id: p.id, slug: 'live-site', status: 'archived', queue: [{ nodeId: c.id, sessionId: null }] });
    expect(listProjectSummaries(ctx).find((x) => x.id === p.id)).toMatchObject({ status: 'archived', activeSessions: 0 });
    expect(findSession(ctx, 's1')?.state).toBe('ended');
    updateProject(ctx, 'test', p.slug, { status: 'active' });
    expect(listProjectSummaries(ctx).find((x) => x.id === p.id)?.status).toBe('active');
    // Tracked again on its next hook event, as after any unarchive.
    expect(handleHookEvent(ctx, 's2', { event: 'prompt' }).tracked).toBe(true);
  });

  it('leaves the project as it was when the write fails part way', () => {
    const { ctx, p } = live();
    const mark = maxEventId(ctx);
    ctx.db.exec("CREATE TRIGGER fail_delete BEFORE UPDATE OF deleted_at ON projects BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(thrown(() => deleteProject(ctx, 'window', p.id))).toMatchObject({ message: 'disk full' });
    expect(ctx.db.prepare('SELECT status, deleted_at FROM projects WHERE id = ?').get(p.id)).toEqual({ status: 'active', deleted_at: null });
    expect(findSession(ctx, 's1')?.state).not.toBe('ended');
    expect(getProjectById(ctx, p.id)?.queue).toHaveLength(3);
    expect(listEventsSince(ctx, mark)).toEqual([]);
  });
});

describe('restoreProject', () => {
  it('brings it back, archived, within its 30 days', () => {
    const { ctx, tick } = clocked();
    const p = archived(ctx, 'Old Site');
    addBinding(ctx, 'test', p.slug, 'C:/work/old');
    deleteProject(ctx, 'window', p.id);
    tick(29 * DAY);
    const mark = maxEventId(ctx);
    expect(restoreProject(ctx, 'window', p.id)).toMatchObject({ id: p.id, slug: 'old-site', status: 'archived' });
    expect(listProjectSummaries(ctx).map((x) => [x.slug, x.status])).toEqual([['old-site', 'archived']]);
    expect(listBindings(ctx).map((b) => b.path)).toEqual(['C:/work/old']);
    expect(listDeletedProjects(ctx)).toEqual([]);
    expect(listEventsSince(ctx, mark).map((e) => [e.type, e.projectId, e.data])).toEqual([['project.restored', p.id, { slug: 'old-site', name: 'Old Site' }]]);
  });

  it('keeps its slug while deleted, so a restore always gets it back', () => {
    const { ctx } = clocked();
    const p = archived(ctx, 'InGame');
    deleteProject(ctx, 'window', p.id);
    expect(createProject(ctx, 'test', { name: 'InGame' }).slug).toBe('ingame-2');
    expect(restoreProject(ctx, 'window', p.id).slug).toBe('ingame');
  });

  it('refuses a project that is not deleted, is missing, or is past its 30 days though not purged yet', () => {
    const { ctx, tick } = clocked();
    const p = archived(ctx, 'Old');
    expect(thrown(() => restoreProject(ctx, 'window', p.id))).toMatchObject({ status: 409, message: 'Project old is not deleted' });
    expect(thrown(() => restoreProject(ctx, 'window', 999))).toMatchObject({ status: 404, message: 'Project 999 not found' });
    deleteProject(ctx, 'window', p.id);
    tick(30 * DAY);
    expect(thrown(() => restoreProject(ctx, 'window', p.id))).toMatchObject({ status: 409, message: 'Project old is past its 30 days' });
    expect(ctx.db.prepare('SELECT deleted_at FROM projects WHERE id = ?').pluck().get(p.id)).not.toBeNull();
  });
});

describe('listDeletedProjects', () => {
  it('lists the projects deleted less than 30 days ago, newest first, with their purge dates', () => {
    const { ctx, tick } = clocked();
    const a = archived(ctx, 'A');
    const b = archived(ctx, 'B');
    const c = archived(ctx, 'C');
    const atA = deleteProject(ctx, 'window', a.id).deletedAt;
    tick(10 * DAY);
    const del = deleteProject(ctx, 'window', b.id);
    tick(DAY);
    deleteProject(ctx, 'window', c.id);
    expect(listDeletedProjects(ctx).map((d) => d.slug)).toEqual(['c', 'b', 'a']);
    expect(listDeletedProjects(ctx)[1]).toEqual({ id: b.id, slug: 'b', name: 'B', deletedAt: del.deletedAt, purgeAt: del.purgeAt });
    // A's 30 days are up: it leaves the list before the purge has run.
    tick(19 * DAY);
    expect(Date.parse(ctx.now()) - Date.parse(atA)).toBe(30 * DAY);
    expect(listDeletedProjects(ctx).map((d) => d.slug)).toEqual(['c', 'b']);
  });
});

describe('purgeDeletedProjects', () => {
  /**
   * Keep and Gone, each with a bound folder, a step with a log and a resource, a session with a subagent, a dispatch
   * and a working task, and Up next entries. A subagent of Keep's session points at Gone's step. Gone is deleted.
   */
  function twoProjects() {
    const { ctx, tick } = clocked();
    const make = (name: string, sessionId: string) => {
      const p = createProject(ctx, 'test', { name });
      const folder = `C:/work/${p.slug}`;
      addBinding(ctx, 'test', p.slug, folder);
      const [step] = addNodes(ctx, 'test', { parentId: p.rootNodeId, nodes: [{ title: `${name} step` }] });
      addLog(ctx, 'test', step.id, 'Started', sessionId);
      addResource(ctx, 'test', { nodeId: step.id, kind: 'doc', title: 'Notes', content: 'x' });
      handleHookEvent(ctx, sessionId, { event: 'start', source: 'startup', cwd: folder });
      setFocus(ctx, `scribe:${sessionId}`, sessionId, step.id);
      handleHookEvent(ctx, sessionId, { event: 'subagent-start', agentId: `${sessionId}-a1`, agentType: 'general-purpose' });
      handleHookEvent(ctx, sessionId, { event: 'agent-dispatch', toolUseId: `${sessionId}-t1`, agentType: 'Explore' });
      setTasks(ctx, `session:${sessionId}`, sessionId, step.id, [{ subject: 'Write it', status: 'pending' }]);
      setQueue(ctx, 'test', p.slug, [step.id], { sessionId });
      return { p, step };
    };
    const keep = make('Keep', 'k1');
    const gone = make('Gone', 'g1');
    ctx.db.prepare("UPDATE session_subagents SET node_id = ? WHERE session_id = 'k1'").run(gone.step.id);
    updateProject(ctx, 'test', gone.p.slug, { status: 'archived' });
    deleteProject(ctx, 'window', gone.p.id);
    // The archive dropped g1's dispatch; one a build from before it could have left behind.
    ctx.db.prepare("INSERT INTO subagent_dispatches (session_id, tool_use_id, agent_type, created_at) VALUES ('g1', 'g1-t2', 'Explore', ?)").run(ctx.now());
    return { ctx, tick, keep, gone };
  }

  /** How many rows each table holds for project `id` (directly or through its nodes or sessions). */
  function counts(ctx: Ctx, id: number) {
    const n = (sql: string) => ctx.db.prepare(sql).pluck().get(id) as number;
    return {
      projects: n('SELECT COUNT(*) FROM projects WHERE id = ?'),
      events: n('SELECT COUNT(*) FROM events WHERE project_id = ?'),
      bindings: n('SELECT COUNT(*) FROM bindings WHERE project_id = ?'),
      nodes: n('SELECT COUNT(*) FROM nodes WHERE project_id = ?'),
      logs: n('SELECT COUNT(*) FROM log_entries l JOIN nodes x ON x.id = l.node_id WHERE x.project_id = ?'),
      resources: n('SELECT COUNT(*) FROM resources WHERE project_id = ?'),
      sessions: n('SELECT COUNT(*) FROM sessions WHERE project_id = ?'),
      subagents: n('SELECT COUNT(*) FROM session_subagents a JOIN sessions s ON s.id = a.session_id WHERE s.project_id = ?'),
      dispatches: n('SELECT COUNT(*) FROM subagent_dispatches d JOIN sessions s ON s.id = d.session_id WHERE s.project_id = ?'),
      work: n('SELECT COUNT(*) FROM work_items WHERE project_id = ?'),
    };
  }

  it('waits out the 30 days', () => {
    const { ctx, tick, gone } = twoProjects();
    tick(30 * DAY - 60_000);
    expect(purgeDeletedProjects(ctx, tempDir('ip-purge-'), silent)).toEqual({ projects: 0, files: 0 });
    expect(counts(ctx, gone.p.id).projects).toBe(1);
  });

  it('then removes the project and everything of it, and leaves every other project as it was', () => {
    const { ctx, tick, keep, gone } = twoProjects();
    const kept = counts(ctx, keep.p.id);
    expect(Object.values(kept).every((c) => c > 0)).toBe(true);
    expect(Object.values(counts(ctx, gone.p.id)).every((c) => c > 0)).toBe(true);
    tick(30 * DAY);
    const mark = maxEventId(ctx);
    expect(purgeDeletedProjects(ctx, tempDir('ip-purge-'), silent)).toEqual({ projects: 1, files: 0 });
    expect(Object.values(counts(ctx, gone.p.id)).every((c) => c === 0)).toBe(true);
    // The session rows went with it: a later hook from that id is an unknown session again.
    expect(findSession(ctx, 'g1')).toBeUndefined();
    expect(counts(ctx, keep.p.id)).toEqual(kept);
    // Keep's subagent pointed at Gone's step: that link is cleared, the row stays.
    expect(ctx.db.prepare("SELECT agent_id, node_id FROM session_subagents WHERE session_id = 'k1'").all()).toEqual([{ agent_id: 'k1-a1', node_id: null }]);
    expect(getProjectById(ctx, keep.p.id)?.queue).toEqual([{ nodeId: keep.step.id, sessionId: 'k1' }]);
    // Filed under no project: under Gone, event pruning would keep it forever as Gone's newest event.
    expect(listEventsSince(ctx, mark).map((e) => ({ type: e.type, projectId: e.projectId, actor: e.actor, entityId: e.entityId, data: e.data }))).toEqual([
      { type: 'project.purged', projectId: null, actor: 'system', entityId: String(gone.p.id), data: { id: gone.p.id, slug: 'gone', name: 'Gone' } },
    ]);
    expect(purgeDeletedProjects(ctx, tempDir('ip-purge-'), silent)).toEqual({ projects: 0, files: 0 });
  });

  it('frees the slug once purged', () => {
    const { ctx, tick } = twoProjects();
    tick(30 * DAY);
    purgeDeletedProjects(ctx, tempDir('ip-purge-'), silent);
    expect(createProject(ctx, 'test', { name: 'Gone' }).slug).toBe('gone');
  });

  it("removes only InProgress's own copies of its files: under the home's resources folder, plain files no survivor names", () => {
    const { ctx, tick, keep, gone } = twoProjects();
    const base = tempDir('ip-purge-files-');
    const home = join(base, 'home');
    const root = join(home, 'resources');
    const repo = join(base, 'repo');
    const outside = join(base, 'outside');
    for (const dir of [join(root, 'gone'), join(root, 'keep'), repo, outside]) mkdirSync(dir, { recursive: true });
    const own = join(root, 'gone', '2026-10-06-notes.md');
    const shared = join(root, 'keep', 'shared.md');
    const readme = join(repo, 'README.md');
    const secret = join(outside, 'secret.md');
    for (const file of [own, shared, readme, secret]) writeFileSync(file, 'x');
    // A junction inside the resources folder that leads out of it.
    symlinkSync(outside, join(root, 'gone-link'), 'junction');
    const attach = (nodeId: number, path: string) => addResource(ctx, 'test', { nodeId, kind: 'doc', title: 'File', path });
    for (const path of [
      own,
      shared,
      readme,
      join(root, 'gone', 'missing.md'),
      join(root, 'gone-link', 'secret.md'),
      // Spelled out: join() would fold the .. segments away.
      `${root}/gone/../../../repo/README.md`,
      root,
      '\\\\server\\share\\notes.md',
      'notes.md',
    ]) {
      ctx.db.prepare('INSERT INTO resources (project_id, node_id, kind, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(gone.p.id, gone.step.id, 'doc', 'File', path, ctx.now(), ctx.now());
    }
    attach(keep.step.id, shared.replace(/\\/g, '/').toUpperCase());
    tick(30 * DAY);
    expect(purgeDeletedProjects(ctx, home, silent)).toEqual({ projects: 1, files: 1 });
    expect(existsSync(own)).toBe(false);
    // Its folder was left empty, so it goes too.
    expect(existsSync(join(root, 'gone'))).toBe(false);
    for (const file of [shared, readme, secret, join(root, 'gone-link')]) expect(existsSync(file), file).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('leaves a folder alone though a resource names it, and a slug folder that still holds anything', () => {
    const { ctx, tick, gone } = twoProjects();
    const home = tempDir('ip-purge-folder-');
    const folder = join(home, 'resources', 'gone', 'folder.md');
    mkdirSync(join(folder, 'inside'), { recursive: true });
    const unnamed = join(home, 'resources', 'gone', 'written-but-never-attached.md');
    writeFileSync(unnamed, 'x');
    ctx.db.prepare('INSERT INTO resources (project_id, node_id, kind, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(gone.p.id, gone.step.id, 'doc', 'Folder', folder, ctx.now(), ctx.now());
    tick(30 * DAY);
    const errors: string[] = [];
    expect(purgeDeletedProjects(ctx, home, { info: () => undefined, error: (m) => errors.push(m) })).toEqual({ projects: 1, files: 0 });
    expect(existsSync(folder)).toBe(true);
    expect(existsSync(unnamed)).toBe(true);
    expect(errors).toEqual([]);
    expect(getProjectById(ctx, gone.p.id)).toBeUndefined();
  });

  it('leaves a project restored in time alone', () => {
    const { ctx, tick, gone } = twoProjects();
    tick(29 * DAY);
    restoreProject(ctx, 'window', gone.p.id);
    tick(2 * DAY);
    expect(purgeDeletedProjects(ctx, tempDir('ip-purge-'), silent)).toEqual({ projects: 0, files: 0 });
    expect(getProjectById(ctx, gone.p.id)).toMatchObject({ status: 'archived' });
  });
});

describe('runMaintenance', () => {
  it('purges deleted projects past their 30 days and prunes old events, logging what it did', () => {
    const { ctx, tick } = clocked();
    const p = archived(ctx, 'Old');
    deleteProject(ctx, 'window', p.id);
    const keep = createProject(ctx, 'test', { name: 'Keep' });
    updateProject(ctx, 'test', keep.slug, { description: 'One' });
    tick(31 * DAY);
    updateProject(ctx, 'test', keep.slug, { description: 'Two' });
    const info: string[] = [];
    runMaintenance(ctx, tempDir('ip-maint-'), { info: (m) => info.push(m), error: (m) => info.push(`error: ${m}`) });
    expect(getProjectById(ctx, p.id)).toBeUndefined();
    expect(info).toEqual([
      'Purged 1 deleted project past its 30 days, and 0 of its files',
      'Pruned 4 events older than 30 days',
      'Pruned 0 unpaired dispatches, 0 ended subagents and 0 working tasks of sessions ended over a week ago',
    ]);
  });

  it('never throws: each job that fails is logged and the next one still runs', () => {
    const { ctx } = clocked();
    ctx.db.close();
    const errors: string[] = [];
    expect(() => runMaintenance(ctx, tempDir('ip-maint-'), { info: () => undefined, error: (m) => errors.push(m) })).not.toThrow();
    expect(errors.map((m) => m.split(':')[0])).toEqual(['Could not purge deleted projects', 'Could not prune old events', 'Could not prune live work']);
  });
});
