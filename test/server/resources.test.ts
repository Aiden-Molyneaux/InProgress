import { describe, expect, it } from 'vitest';
import { listEventsSince, lastProjectEvent, maxEventId } from '../../src/server/repo/events';
import { addLog, listLogs } from '../../src/server/repo/logs';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { addResource, deleteResource, listNodeResources, listResourceMeta, requireResource, updateResource } from '../../src/server/repo/resources';
import { search } from '../../src/server/repo/search';
import { makeCtx } from '../helpers';

function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'P' });
  const [step, other] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Run signing tests' }, { title: 'Other step' }] });
  return { ctx, project, step, other };
}

describe('resources', () => {
  it('requires content, a path, or a url', () => {
    const { ctx, step } = setup();
    expect(() => addResource(ctx, 't', { nodeId: step.id, kind: 'doc', title: 'Empty' })).toThrow('needs content, a path, or a url');
  });

  it('adds, lists metadata without content, updates, moves within the project, and deletes', () => {
    const { ctx, project, step, other } = setup();
    const r = addResource(ctx, 'scribe:s1', { nodeId: step.id, kind: 'test-suite', title: 'Signing suite', content: '# Tests\n- a', sessionId: 's1' });
    expect(r).toMatchObject({ nodeId: step.id, projectId: project.id, content: '# Tests\n- a', contentLength: 11, sessionId: 's1' });
    const meta = listResourceMeta(ctx, project.id);
    expect(meta).toHaveLength(1);
    expect(meta[0]).not.toHaveProperty('content');
    expect(meta[0].contentLength).toBe(11);
    const moved = updateResource(ctx, 't', r.id, { nodeId: other.id, title: 'Suite v2' });
    expect(moved).toMatchObject({ nodeId: other.id, title: 'Suite v2' });
    expect(listNodeResources(ctx, other.id).map((x) => x.id)).toEqual([r.id]);
    expect(() => updateResource(ctx, 't', r.id, { content: null })).toThrow('needs content, a path, or a url');
    deleteResource(ctx, 't', r.id);
    expect(() => requireResource(ctx, r.id)).toThrow(`Resource r${r.id} not found`);
  });

  it('refuses to move a resource to another project', () => {
    const { ctx, step } = setup();
    const p2 = createProject(ctx, 't', { name: 'P2' });
    const r = addResource(ctx, 't', { nodeId: step.id, kind: 'link', title: 'Docs', url: 'https://example.com' });
    expect(() => updateResource(ctx, 't', r.id, { nodeId: p2.rootNodeId })).toThrow('different project');
  });
});

describe('logs', () => {
  it('returns the newest entries, oldest first, with session titles', () => {
    const { ctx, step } = setup();
    ctx.db.prepare("INSERT INTO sessions (id, title, state, started_at, last_seen_at) VALUES ('s1', 'InGame launch status', 'idle', 'x', 'x')").run();
    for (let i = 1; i <= 3; i++) addLog(ctx, 't', step.id, `note ${i}`, 's1');
    const log = listLogs(ctx, step.id, 2);
    expect(log.map((l) => l.text)).toEqual(['note 2', 'note 3']);
    expect(log[0].sessionTitle).toBe('InGame launch status');
    expect(() => addLog(ctx, 't', step.id, '   ')).toThrow('Log text is empty');
  });
});

describe('search', () => {
  it('finds nodes and resources case-insensitively, treating % and _ literally', () => {
    const { ctx, project, step } = setup();
    addResource(ctx, 't', { nodeId: step.id, kind: 'runbook', title: 'Keystore runbook', content: 'Use 100% of the SIGNING key' });
    const res = search(ctx, project.id, 'signing');
    expect(res.nodes.map((n) => n.title)).toEqual(['Run signing tests']);
    expect(res.resources.map((r) => r.title)).toEqual(['Keystore runbook']);
    expect(search(ctx, project.id, '100%').resources).toHaveLength(1);
    expect(search(ctx, project.id, '_').nodes).toHaveLength(0);
  });
});

describe('events', () => {
  it('lists events after an id and finds the newest per project', () => {
    const { ctx, project } = setup();
    const max = maxEventId(ctx);
    expect(max).toBeGreaterThan(0);
    expect(listEventsSince(ctx, max - 1)).toHaveLength(1);
    expect(lastProjectEvent(ctx, project.id)?.id).toBe(max);
    expect(lastProjectEvent(ctx, 999)).toBeNull();
  });
});
