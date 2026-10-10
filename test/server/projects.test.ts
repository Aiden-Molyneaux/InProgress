import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../src/server/db/tx';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addLog } from '../../src/server/repo/logs';
import { addNodes, findNode, requireNode, updateNode } from '../../src/server/repo/nodes';
import {
  addBinding, createProject, getProjectById, listBindings, listProjectSummaries, removeBinding,
  resolveBinding, resolveProject, slugify, updateProject,
} from '../../src/server/repo/projects';
import { addResource, requireResource } from '../../src/server/repo/resources';
import { search } from '../../src/server/repo/search';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { makeCtx } from '../helpers';

/** As a delete leaves it: archived, with deleted_at set to `at` (default: now). */
function markDeleted(ctx: Ctx, id: number, at = ctx.now()): void {
  ctx.db.prepare("UPDATE projects SET status = 'archived', deleted_at = ? WHERE id = ?").run(at, id);
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

describe('deleted projects are hidden', () => {
  /** Live and Gone, both bound to a folder; Gone has a step with a resource and is deleted at 2026-10-01. */
  function deleted() {
    const ctx = makeCtx();
    const live = createProject(ctx, 'test', { name: 'Live' });
    const gone = createProject(ctx, 'test', { name: 'Gone Site' });
    addBinding(ctx, 'test', live.slug, 'C:/work/live');
    addBinding(ctx, 'test', gone.slug, 'C:/work/gone');
    const [step] = addNodes(ctx, 'test', { parentId: gone.rootNodeId, nodes: [{ title: 'Ship it' }] });
    const resource = addResource(ctx, 'test', { nodeId: step.id, kind: 'doc', title: 'Notes', content: 'x' });
    markDeleted(ctx, gone.id, '2026-10-01T09:00:00.000Z');
    return { ctx, live, gone, step, resource };
  }

  it('leaves the project list, which the window, status, list_projects and doctor read', () => {
    const { ctx, live } = deleted();
    expect(listProjectSummaries(ctx).map((p) => p.id)).toEqual([live.id]);
  });

  it('is not found by id, slug or name, and the miss says how to restore it and until when', () => {
    const { ctx, gone } = deleted();
    for (const ref of [gone.id, String(gone.id), 'gone-site', 'GONE-SITE', 'Gone Site']) {
      const err = thrown(() => resolveProject(ctx, ref));
      expect(err, String(ref)).toMatchObject({ status: 404, message: `Project "${String(ref)}" not found` });
      expect(err.hint, String(ref)).toBe('It was deleted; restore it from Recently deleted in the window before 2026-10-31.');
    }
    // The snapshot route (a stale #/p/ link), the outline and search all resolve through it.
    expect(() => getProjectSnapshot(ctx, 'gone-site')).toThrow('Project "gone-site" not found');
    expect(() => search(ctx, resolveProject(ctx, 'gone-site').id, 'Ship')).toThrow('not found');
    // Writes by reference refuse too: an update (an unarchive by an old reference) and a binding.
    expect(() => updateProject(ctx, 'test', 'gone-site', { status: 'active' })).toThrow('not found');
    expect(() => addBinding(ctx, 'test', 'gone-site', 'C:/work/other')).toThrow('not found');
  });

  it('keeps a deleted slug for its project when a new one takes the name, so an old reference never lands on the new one', () => {
    const ctx = makeCtx();
    const old = createProject(ctx, 'test', { name: 'InGame' });
    markDeleted(ctx, old.id, '2026-10-01T09:00:00.000Z');
    const fresh = createProject(ctx, 'test', { name: 'InGame' });
    expect(fresh.slug).toBe('ingame-2');
    // The old slug and id, and the name typed as the old slug, all mean the deleted project: the restore hint, not the new one.
    for (const ref of ['ingame', 'INGAME', 'InGame', old.id, String(old.id)]) {
      const err = thrown(() => resolveProject(ctx, ref));
      expect(err, String(ref)).toMatchObject({ status: 404, message: `Project "${String(ref)}" not found` });
      expect(err.hint, String(ref)).toBe('It was deleted; restore it from Recently deleted in the window before 2026-10-31.');
    }
    // So a scribe call that still carries the old slug cannot archive the new project.
    expect(() => updateProject(ctx, 'test', 'ingame', { status: 'archived' })).toThrow('not found');
    expect(getProjectById(ctx, fresh.id)?.status).toBe('active');
    expect(resolveProject(ctx, 'ingame-2').id).toBe(fresh.id);
    expect(resolveProject(ctx, fresh.id).id).toBe(fresh.id);
  });

  it('finds the live project by a name it shares with a deleted one when the name is no slug', () => {
    const ctx = makeCtx();
    const old = createProject(ctx, 'test', { name: 'Shared', slug: 'shared-old' });
    markDeleted(ctx, old.id);
    const live = createProject(ctx, 'test', { name: 'Shared', slug: 'shared-new' });
    expect(resolveProject(ctx, 'shared').id).toBe(live.id);
  });

  it('gives the restore hint for a deleted id even when a live project has that number as its slug', () => {
    const ctx = makeCtx();
    const old = createProject(ctx, 'test', { name: 'Old' });
    const numbered = createProject(ctx, 'test', { name: String(old.id) });
    expect(numbered.slug).toBe(String(old.id));
    // Before the delete the id wins over the slug; the delete must not hand the reference to the other project.
    expect(resolveProject(ctx, String(old.id)).id).toBe(old.id);
    markDeleted(ctx, old.id, '2026-10-01T09:00:00.000Z');
    expect(thrown(() => resolveProject(ctx, String(old.id))).hint).toBe('It was deleted; restore it from Recently deleted in the window before 2026-10-31.');
    expect(resolveProject(ctx, numbered.id).id).toBe(numbered.id);
  });

  it('names only the projects still there when a reference misses', () => {
    const { ctx } = deleted();
    expect(thrown(() => resolveProject(ctx, 'nope')).hint).toBe('Known projects: live');
  });

  it('says it is past its 30 days once the restore window has closed, before the purge has run', () => {
    const { ctx, gone } = deleted();
    markDeleted(ctx, gone.id, '2026-08-01T09:00:00.000Z');
    expect(thrown(() => resolveProject(ctx, 'gone-site')).hint).toBe('It was deleted over 30 days ago and is about to be removed for good.');
  });

  it('leaves the binding list, and its folder no longer tracks sessions even if an old build unarchived it', () => {
    const { ctx, live, gone } = deleted();
    expect(listBindings(ctx).map((b) => b.projectId)).toEqual([live.id]);
    expect(resolveBinding(ctx, 'C:/work/gone/src', 'main')).toBeUndefined();
    ctx.db.prepare("UPDATE projects SET status = 'active' WHERE id = ?").run(gone.id);
    expect(resolveBinding(ctx, 'C:/work/gone/src', 'main')).toBeUndefined();
    expect(resolveBinding(ctx, 'C:/work/live', 'main')?.id).toBe(live.id);
  });

  it("treats its steps and resources as not found, for reads and writes by id", () => {
    const { ctx, step, resource } = deleted();
    expect(findNode(ctx, step.id)).toBeUndefined();
    expect(thrown(() => requireNode(ctx, step.id))).toMatchObject({ status: 404, message: `Node #${step.id} not found` });
    expect(() => updateNode(ctx, 'test', step.id, { status: 'done' })).toThrow(`Node #${step.id} not found`);
    expect(() => addLog(ctx, 'test', step.id, 'Done')).toThrow(`Node #${step.id} not found`);
    expect(() => addResource(ctx, 'test', { nodeId: step.id, kind: 'doc', title: 'More', content: 'y' })).toThrow(`Node #${step.id} not found`);
    expect(thrown(() => requireResource(ctx, resource.id))).toMatchObject({ status: 404, message: `Resource r${resource.id} not found` });
    // Nothing was written.
    expect(ctx.db.prepare("SELECT status FROM nodes WHERE id = ?").pluck().get(step.id)).toBe('todo');
  });

  it('gives up a folder it was bound to: binding it to another project takes it over', () => {
    const { ctx, live, gone } = deleted();
    const old = listBindings(ctx);
    const mark = maxEventId(ctx);
    const binding = addBinding(ctx, 'test', live.slug, 'C:\\work\\gone');
    expect(binding).toMatchObject({ projectId: live.id, path: 'C:/work/gone' });
    expect(listBindings(ctx).map((b) => b.path)).toEqual(['C:/work/live', 'C:/work/gone']);
    expect(ctx.db.prepare('SELECT COUNT(*) FROM bindings WHERE project_id = ?').pluck().get(gone.id)).toBe(0);
    expect(listEventsSince(ctx, mark).map((e) => [e.type, e.projectId])).toEqual([['binding.deleted', gone.id], ['binding.created', live.id]]);
    expect(old).toHaveLength(1);
  });

  it('still reads by id inside the server', () => {
    const { ctx, gone } = deleted();
    expect(getProjectById(ctx, gone.id)).toMatchObject({ slug: 'gone-site', status: 'archived' });
  });
});

describe('updateProject', () => {
  it('records nothing when nothing changes, so a second archive logs no second event', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'P' });
    const mark = maxEventId(ctx);
    updateProject(ctx, 'test', p.slug, { status: 'archived' });
    updateProject(ctx, 'test', p.slug, { status: 'archived' });
    updateProject(ctx, 'test', p.slug, { name: 'P', description: '' });
    expect(listEventsSince(ctx, mark).map((e) => e.type)).toEqual(['project.updated']);
    expect(getProjectById(ctx, p.id)?.status).toBe('archived');
  });
});

describe('projects', () => {
  it('slugifies names', () => {
    expect(slugify('InGame: Road to Market!')).toBe('ingame-road-to-market');
    expect(slugify('***')).toBe('project');
  });

  it('creates a project with an active goal root and unique slugs', () => {
    const ctx = makeCtx();
    const a = createProject(ctx, 'test', { name: 'InGame', description: 'Game collection app' });
    const b = createProject(ctx, 'test', { name: 'InGame' });
    expect(a.slug).toBe('ingame');
    expect(b.slug).toBe('ingame-2');
    const root = ctx.db.prepare('SELECT * FROM nodes WHERE id = ?').get(a.rootNodeId) as { kind: string; title: string; body: string; status: string; parent_id: number | null };
    expect(root).toMatchObject({ kind: 'goal', title: 'InGame', body: 'Game collection app', status: 'active', parent_id: null });
    const types = (ctx.db.prepare('SELECT type FROM events ORDER BY id').all() as { type: string }[]).map((r) => r.type);
    expect(types).toEqual(['project.created', 'node.created', 'project.created', 'node.created']);
  });

  it('falls back to the name when the given slug is blank', () => {
    const ctx = makeCtx();
    expect(createProject(ctx, 'test', { name: 'InGame', slug: '' }).slug).toBe('ingame');
    expect(createProject(ctx, 'test', { name: 'InGame', slug: '  ' }).slug).toBe('ingame-2');
  });

  it('resolves by id, slug, or name and explains misses', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'InGame' });
    expect(resolveProject(ctx, p.id).slug).toBe('ingame');
    expect(resolveProject(ctx, String(p.id)).slug).toBe('ingame');
    expect(resolveProject(ctx, 'INGAME').id).toBe(p.id);
    expect(resolveProject(ctx, 'ingame').id).toBe(p.id);
    expect(() => resolveProject(ctx, 'nope')).toThrow('Project "nope" not found');
    try { resolveProject(ctx, 'nope'); } catch (e) { expect((e as { hint?: string }).hint).toContain('ingame'); }
  });

  it('keeps the root in sync with the name and description, and archives', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'Old' });
    const u = updateProject(ctx, 'test', p.slug, { name: 'New', description: 'Purpose', status: 'archived' });
    expect(u).toMatchObject({ name: 'New', description: 'Purpose', status: 'archived' });
    const root = ctx.db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(p.rootNodeId);
    expect(root).toEqual({ title: 'New', body: 'Purpose' });
  });

  it('adds bindings idempotently and refuses to steal another project\'s folder', () => {
    const ctx = makeCtx();
    const a = createProject(ctx, 'test', { name: 'A' });
    const b = createProject(ctx, 'test', { name: 'B' });
    const first = addBinding(ctx, 'test', a.slug, 'C:\\personal\\InGame\\');
    expect(first).toMatchObject({ path: 'C:/personal/InGame', branchPattern: null });
    expect(addBinding(ctx, 'test', a.slug, '/c/personal/ingame').id).toBe(first.id);
    expect(() => addBinding(ctx, 'test', b.slug, 'C:/personal/InGame')).toThrow('already bound to project a');
    const withBranch = addBinding(ctx, 'test', b.slug, 'C:/personal/InGame', '*VCAD-978*');
    expect(withBranch.branchPattern).toBe('*VCAD-978*');
    removeBinding(ctx, 'test', first.id);
    expect(listBindings(ctx).map((x) => x.id)).toEqual([withBranch.id]);
    expect(() => removeBinding(ctx, 'test', 9999)).toThrow('Binding 9999 not found');
  });

  it('refuses relative binding paths and dot segments', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'P' });
    expect(() => addBinding(ctx, 'test', p.slug, 'repo')).toThrow('Binding path must be absolute: repo');
    expect(() => addBinding(ctx, 'test', p.slug, './x')).toThrow('Binding path must be absolute: ./x');
    expect(() => addBinding(ctx, 'test', p.slug, 'C:/a/../b')).toThrow('Binding path must not contain . or .. segments: C:/a/../b');
    try { addBinding(ctx, 'test', p.slug, 'repo'); } catch (e) { expect(e).toMatchObject({ status: 400, hint: 'Use the full folder path, e.g. C:/personal/InGame.' }); }
    expect(listBindings(ctx)).toEqual([]);
    expect(addBinding(ctx, 'test', p.slug, 'C:/personal/InGame').path).toBe('C:/personal/InGame');
    expect(addBinding(ctx, 'test', p.slug, '\\\\server\\share\\repo').path).toBe('//server/share/repo');
    expect(addBinding(ctx, 'test', p.slug, '/home/me/repo').path).toBe('/home/me/repo');
    expect(addBinding(ctx, 'test', p.slug, 'C:/work/.config').path).toBe('C:/work/.config');
  });

  it('treats branch patterns that differ only in case as the same binding', () => {
    const ctx = makeCtx();
    const a = createProject(ctx, 'test', { name: 'A' });
    const b = createProject(ctx, 'test', { name: 'B' });
    const first = addBinding(ctx, 'test', a.slug, 'C:/work/repo', '*VCAD-978*');
    expect(addBinding(ctx, 'test', a.slug, 'C:/work/repo', '*vcad-978*').id).toBe(first.id);
    expect(() => addBinding(ctx, 'test', b.slug, 'C:/work/repo', '*vcad-978*')).toThrow('already bound to project a');
    expect(listBindings(ctx)).toHaveLength(1);
  });

  it('resolves the longest matching binding, preferring a branch match, skipping archived projects', () => {
    const ctx = makeCtx();
    const repo = createProject(ctx, 'test', { name: 'Repo' });
    const docs = createProject(ctx, 'test', { name: 'Docs' });
    const ticket = createProject(ctx, 'test', { name: 'Ticket' });
    addBinding(ctx, 'test', repo.slug, 'C:/work/repo');
    addBinding(ctx, 'test', docs.slug, 'C:/work/repo/docs');
    addBinding(ctx, 'test', ticket.slug, 'C:/work/repo', '*VCAD-978*');
    expect(resolveBinding(ctx, 'C:\\work\\repo\\src', 'main')?.slug).toBe('repo');
    expect(resolveBinding(ctx, 'C:/work/repo/src', 'feature/VCAD-978-x')?.slug).toBe('ticket');
    expect(resolveBinding(ctx, 'C:/work/repo/docs/a', 'feature/VCAD-978-x')?.slug).toBe('docs');
    expect(resolveBinding(ctx, 'C:/elsewhere', 'main')).toBeUndefined();
    updateProject(ctx, 'test', 'ticket', { status: 'archived' });
    expect(resolveBinding(ctx, 'C:/work/repo/src', 'feature/VCAD-978-x')?.slug).toBe('repo');
  });

  it('breaks a tie between matching branch patterns on one path by binding order', () => {
    const ctx = makeCtx();
    const other = createProject(ctx, 'test', { name: 'Other' });
    const first = createProject(ctx, 'test', { name: 'First' });
    addBinding(ctx, 'test', first.slug, 'C:/work/repo', '*VCAD*');
    addBinding(ctx, 'test', other.slug, 'C:/work/repo', '*VCAD-978*');
    // With statistics SQLite scans projects first, so rows arrive in project order unless the query orders them.
    ctx.db.exec('ANALYZE');
    expect(resolveBinding(ctx, 'C:/work/repo/src', 'feature/VCAD-978-x')?.slug).toBe('first');
  });

  it('summarizes needs-you counts and live sessions', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'P' });
    const ts = ctx.now();
    ctx.db.prepare("INSERT INTO nodes (project_id, parent_id, position, kind, title, status, assignee, created_at, updated_at) VALUES (?, ?, 1, 'task', 'Run tests', 'todo', 'me', ?, ?)").run(p.id, p.rootNodeId, ts, ts);
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', ?, 'working', ?, ?)").run(p.id, ts, ts);
    const [s] = listProjectSummaries(ctx);
    expect(s).toMatchObject({ slug: 'p', needsYou: 1, activeSessions: 1, workingSessions: 1, busySessions: 1 });
    expect(s.lastEventAt).not.toBeNull();
  });

  it('counts a live idle session with a running worker as busy, but not as working, and leaves readers out', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'P' });
    const ts = ctx.now();
    const session = ctx.db.prepare('INSERT INTO sessions (id, project_id, state, started_at, last_seen_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)');
    const agent = ctx.db.prepare('INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at, ended_at) VALUES (?, ?, ?, ?, ?)');
    const summary = () => listProjectSummaries(ctx).find((x) => x.id === p.id)!;
    session.run('idle', p.id, 'idle', ts, ts, null);
    expect(summary()).toMatchObject({ activeSessions: 1, workingSessions: 0, busySessions: 0 });
    // A reader alone (Explore, Plan, claude-code-guide) does not make it busy.
    agent.run('idle', 'r1', 'Explore', ts, null);
    agent.run('idle', 'r2', 'Plan', ts, null);
    agent.run('idle', 'r3', 'claude-code-guide', ts, null);
    expect(summary()).toMatchObject({ workingSessions: 0, busySessions: 0 });
    // Nor does a worker that has ended.
    agent.run('idle', 'w0', 'general-purpose', ts, ts);
    expect(summary().busySessions).toBe(0);
    // A running worker does, once per session however many it has.
    agent.run('idle', 'w1', 'general-purpose', ts, null);
    agent.run('idle', 'w2', 'general-purpose', ts, null);
    expect(summary()).toMatchObject({ activeSessions: 1, workingSessions: 0, busySessions: 1 });
    // A working session counts once, with or without workers.
    session.run('busy', p.id, 'working', ts, ts, null);
    agent.run('busy', 'w3', 'general-purpose', ts, null);
    expect(summary()).toMatchObject({ activeSessions: 2, workingSessions: 1, busySessions: 2 });
    // An ended session, or one past the stale limit, is not busy, whatever its rows say.
    const old = new Date(Date.parse(ts) - 13 * 60 * 60 * 1000).toISOString();
    session.run('ended', p.id, 'ended', ts, ts, ts);
    agent.run('ended', 'w4', 'general-purpose', ts, null);
    session.run('stale', p.id, 'idle', old, old, null);
    agent.run('stale', 'w5', 'general-purpose', old, null);
    expect(summary()).toMatchObject({ activeSessions: 2, workingSessions: 1, busySessions: 2 });
  });

  it('counts a live idle session with only a counting command as busy, once, and leaves out one that is old, a server, persistent or ended', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'P' });
    const ts = ctx.now();
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', ?, 'idle', ?, ?)").run(p.id, ts, ts);
    const command = ctx.db.prepare('INSERT INTO session_commands (session_id, task_id, kind, persistent, command_head, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const summary = () => listProjectSummaries(ctx).find((x) => x.id === p.id)!;
    const old = new Date(Date.parse(ts) - 30 * 60_000).toISOString();
    command.run('s1', 'old', 'shell', 0, 'npm run build', old, null);
    command.run('s1', 'dev', 'shell', 0, 'npm run dev', ts, null);
    command.run('s1', 'mon', 'monitor', 1, 'tail -f', ts, null);
    command.run('s1', 'done', 'shell', 0, 'npm run build', ts, ts);
    expect(summary()).toMatchObject({ activeSessions: 1, workingSessions: 0, busySessions: 0 });
    command.run('s1', 'b1', 'shell', 0, 'npm run build', ts, null);
    command.run('s1', 'b2', 'shell', 0, 'npm test', ts, null);
    expect(summary()).toMatchObject({ workingSessions: 0, busySessions: 1 });
    // Busy by a worker too, it still counts once.
    ctx.db.prepare("INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at) VALUES ('s1', 'w1', 'general-purpose', ?)").run(ts);
    expect(summary().busySessions).toBe(1);
  });

  it('lists a project whose idle session has a running worker before a quiet one', () => {
    const ctx = makeCtx();
    const busy = createProject(ctx, 'test', { name: 'Busy' });
    const quiet = createProject(ctx, 'test', { name: 'Quiet' });
    const ts = ctx.now();
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', ?, 'idle', ?, ?)").run(busy.id, ts, ts);
    ctx.db.prepare("INSERT INTO session_subagents (session_id, agent_id, agent_type, started_at) VALUES ('s1', 'w1', 'general-purpose', ?)").run(ts);
    // Quiet has the newer event, so only the worker puts Busy first.
    updateProject(ctx, 'test', quiet.slug, { description: 'newer' });
    expect(listProjectSummaries(ctx).map((x) => x.slug)).toEqual(['busy', 'quiet']);
  });
});
