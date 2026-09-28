import { describe, expect, it } from 'vitest';
import type { EventRow, ProjectSnapshot } from '../../src/core/types';
import { actorLabel, describeEvent } from '../../web/src/describe';
import { relativeTime } from '../../web/src/time';

const snapshot = {
  project: { id: 1, slug: 'p', name: 'P' },
  nodes: [{ id: 58, title: 'Run signing tests' }, { id: 55, title: '2 Android signing' }],
  resources: [],
  sessions: [{ id: 's1', title: 'InGame launch status' }],
} as unknown as ProjectSnapshot;

const ev = (type: string, entityId: string, data: unknown, actor = 'scribe:s1'): EventRow => ({ id: 1, ts: '2026-09-27T12:00:00Z', projectId: 1, actor, type, entity: 'x', entityId, data });

describe('describeEvent', () => {
  it('describes changes in plain words', () => {
    expect(describeEvent(ev('node.created', '58', { ids: [58], parentId: 55 }), snapshot)).toBe('added #58 Run signing tests');
    expect(describeEvent(ev('node.created', '58', { ids: [58, 59], parentId: 55 }), snapshot)).toBe('added 2 steps under #55 2 Android signing');
    expect(describeEvent(ev('node.updated', '58', { changes: { status: { from: 'todo', to: 'done' } } }), snapshot)).toBe('#58 Run signing tests → done');
    expect(describeEvent(ev('resource.created', '12', { nodeId: 58, title: 'Signing suite' }), snapshot)).toBe('"Signing suite" attached to #58 Run signing tests');
    expect(describeEvent(ev('log.created', '3', { nodeId: 55 }), snapshot)).toBe('note on #55 2 Android signing');
    expect(describeEvent(ev('session.updated', 's1', { changed: ['state'], state: 'permission' }), snapshot)).toBe('InGame launch status is waiting for a permission');
    expect(describeEvent(ev('session.updated', 's1', { changed: ['focusNodeId'], focusNodeId: 58 }), snapshot)).toBe('InGame launch status is on #58 Run signing tests');
  });

  it('labels actors', () => {
    expect(actorLabel(ev('node.created', '1', {}), snapshot)).toBe('scribe (InGame launch status)');
    expect(actorLabel(ev('node.created', '1', {}, 'hook:prompt'), snapshot)).toBe('Claude');
    expect(actorLabel(ev('node.created', '1', {}, 'system'), snapshot)).toBe('system');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  it('rounds to friendly units', () => {
    expect(relativeTime('2026-09-27T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-09-27T11:58:00Z', now)).toBe('2 min ago');
    expect(relativeTime('2026-09-27T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-09-25T12:00:00Z', now)).toBe('2 d ago');
  });
});
