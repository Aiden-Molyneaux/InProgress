import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx, write } from '../../src/server/db/tx';
import { EVENTS_RETENTION_DAYS, lastProjectEvent, listEventsSince, maxEventId, pruneEvents, recordQuiet, toEvent } from '../../src/server/repo/events';
import { addLog } from '../../src/server/repo/logs';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject, listProjectSummaries } from '../../src/server/repo/projects';
import { addResource, deleteResource, updateResource } from '../../src/server/repo/resources';
import { makeCtx } from '../helpers';

const DAY = 24 * 60 * 60 * 1000;

describe('event contract', () => {
  it('records resource and log events with their entity, id and data', () => {
    const ctx = makeCtx();
    const project = createProject(ctx, 'test', { name: 'P' });
    const [step, other] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Step' }, { title: 'Other' }] });
    const mark = maxEventId(ctx);
    const r = addResource(ctx, 'scribe:s1', { nodeId: step.id, kind: 'runbook', title: 'Keystore runbook', content: 'x' });
    updateResource(ctx, 'scribe:s1', r.id, { nodeId: other.id });
    deleteResource(ctx, 'scribe:s1', r.id);
    const log = addLog(ctx, 'scribe:s1', step.id, 'Detour: sandbox wedge');
    const events = listEventsSince(ctx, mark).map(({ projectId, actor, type, entity, entityId, data }) => ({ projectId, actor, type, entity, entityId, data }));
    const base = { projectId: project.id, actor: 'scribe:s1' };
    expect(events).toEqual([
      { ...base, type: 'resource.created', entity: 'resource', entityId: String(r.id), data: { nodeId: step.id, title: 'Keystore runbook', kind: 'runbook' } },
      { ...base, type: 'resource.updated', entity: 'resource', entityId: String(r.id), data: { nodeId: other.id, fromNodeId: step.id } },
      { ...base, type: 'resource.deleted', entity: 'resource', entityId: String(r.id), data: { nodeId: other.id } },
      { ...base, type: 'log.created', entity: 'log', entityId: String(log.id), data: { nodeId: step.id } },
    ]);
  });

  it('parses the stored JSON data', () => {
    const row = { id: 7, ts: 't', project_id: null, actor: 'system', type: 'demo', entity: 'demo', entity_id: '3', data: '{"ids":[1,2],"nested":{"a":null}}' };
    expect(toEvent(row)).toEqual({ id: 7, ts: 't', projectId: null, actor: 'system', type: 'demo', entity: 'demo', entityId: '3', data: { ids: [1, 2], nested: { a: null } } });
  });
});

describe('event retention', () => {
  it(`prunes events older than ${EVENTS_RETENTION_DAYS} days but keeps each project's newest event`, () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const ctx = createCtx(openDb(':memory:'), () => new Date(now).toISOString());
    const quiet = createProject(ctx, 'test', { name: 'Quiet' });
    const busy = createProject(ctx, 'test', { name: 'Busy' });
    write(ctx, 'system', (record) => record({ projectId: null, type: 'demo', entity: 'demo', entityId: 1 }));
    now += 10 * DAY;
    addNodes(ctx, 'test', { parentId: busy.rootNodeId, nodes: [{ title: 'Ten days in' }] });
    now += 10 * DAY;
    addNodes(ctx, 'test', { parentId: busy.rootNodeId, nodes: [{ title: 'Twenty days in' }] });
    now += 11 * DAY;
    const quietNewest = lastProjectEvent(ctx, quiet.id)!;

    // Quiet's project.created, both of Busy's creation events and the project-less one are older than 30 days.
    expect(pruneEvents(ctx)).toBe(4);
    expect(listEventsSince(ctx, 0).map((e) => ({ projectId: e.projectId, type: e.type, ts: e.ts }))).toEqual([
      { projectId: quiet.id, type: 'node.created', ts: '2026-01-01T00:00:00.000Z' },
      { projectId: busy.id, type: 'node.created', ts: '2026-01-11T00:00:00.000Z' },
      { projectId: busy.id, type: 'node.created', ts: '2026-01-21T00:00:00.000Z' },
    ]);
    expect(lastProjectEvent(ctx, quiet.id)).toEqual(quietNewest);
    expect(pruneEvents(ctx)).toBe(0);
  });

  it('never counts a window measurement as the newest event, and prunes old ones', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const ctx = createCtx(openDb(':memory:'), () => new Date(now).toISOString());
    const p = createProject(ctx, 'test', { name: 'Quiet' });
    const real = lastProjectEvent(ctx, p.id)!;
    now += 1000;
    recordQuiet(ctx, 'window', { projectId: p.id, type: 'window.view', entity: 'window', entityId: 'view', data: { view: 'board' } });
    expect(lastProjectEvent(ctx, p.id)).toEqual(real);
    expect(listProjectSummaries(ctx).find((x) => x.id === p.id)!.lastEventAt).toBe(real.ts);
    now += 40 * DAY;
    // The window row is newer and past the cutoff: it goes, and the real event stays as the project's newest.
    expect(pruneEvents(ctx)).toBe(2); // the window row and the project's older creation event
    expect(lastProjectEvent(ctx, p.id)).toEqual(real);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM events WHERE type LIKE 'window.%'").pluck().get()).toBe(0);
  });
});
