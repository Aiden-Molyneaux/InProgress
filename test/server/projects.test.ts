import { describe, expect, it } from 'vitest';
import {
  addBinding, createProject, listBindings, listProjectSummaries, removeBinding,
  resolveBinding, resolveProject, slugify, updateProject,
} from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

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

  it('summarizes needs-you counts and live sessions', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'P' });
    const ts = ctx.now();
    ctx.db.prepare("INSERT INTO nodes (project_id, parent_id, position, kind, title, status, assignee, created_at, updated_at) VALUES (?, ?, 1, 'task', 'Run tests', 'todo', 'me', ?, ?)").run(p.id, p.rootNodeId, ts, ts);
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', ?, 'working', ?, ?)").run(p.id, ts, ts);
    const [s] = listProjectSummaries(ctx);
    expect(s).toMatchObject({ slug: 'p', needsYou: 1, activeSessions: 1, workingSessions: 1 });
    expect(s.lastEventAt).not.toBeNull();
  });
});
