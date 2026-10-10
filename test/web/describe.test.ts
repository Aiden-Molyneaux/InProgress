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

  it("names the subagents the transcript watcher ended after their session's title, by tag, and why", () => {
    const withAgents = {
      ...snapshot,
      sessions: [{ id: 's1', title: 'InGame launch status', slot: 0, subagents: [{ agentId: 'x3', ordinal: 3 }] }],
      trailAgents: [{ sessionId: 's1', agentId: 'x4', ordinal: 4 }],
    } as unknown as ProjectSnapshot;
    const ended = (...list: [string, string][]) => ev('session.updated', 's1', { changed: ['subagents'], state: 'working', ended: list.map(([agentId, reason]) => ({ agentId, reason })) }, 'system');
    expect(describeEvent(ended(['x3', 'limit']), withAgents)).toBe('InGame launch status · a3 hit the usage limit');
    expect(describeEvent(ended(['x3', 'killed'], ['x4', 'silent']), withAgents)).toBe('InGame launch status · a3 was stopped, a4 stopped responding');
    // One it cannot find, or a session with no letter, reads as "a subagent".
    expect(describeEvent(ended(['zz', 'error']), withAgents)).toBe('InGame launch status · a subagent hit an API error');
    expect(describeEvent(ended(['x3', 'error']), snapshot)).toBe('InGame launch status · a subagent hit an API error');
  });

  it('says a session is busy when it went idle with work still running', () => {
    expect(describeEvent(ev('session.updated', 's1', { changed: ['state'], state: 'idle', activity: 'busy' }), snapshot)).toBe('InGame launch status is busy');
    expect(describeEvent(ev('session.updated', 's1', { changed: ['state'], state: 'idle', activity: 'idle' }), snapshot)).toBe('InGame launch status is idle');
    expect(describeEvent(ev('session.updated', 's1', { changed: ['state'], state: 'idle' }), snapshot)).toBe('InGame launch status is idle');
    expect(describeEvent(ev('session.updated', 's1', { changed: ['state'], state: 'working', activity: 'working' }), snapshot)).toBe('InGame launch status is working');
  });

  it('says which background command a session started, and how one ended', () => {
    const command = (data: object) => ev('session.updated', 's1', { changed: ['commands'], state: 'idle', activity: 'busy', ...data }, 'hook:command');
    expect(describeEvent(command({ command: { label: 'npm run test:e2e' } }), snapshot)).toBe('InGame launch status started npm run test:e2e');
    expect(describeEvent(command({ command: { label: 'npm run test:e2e', outcome: 'completed' } }), snapshot)).toBe('InGame launch status: npm run test:e2e completed');
    expect(describeEvent(command({ command: { label: 'tsc', outcome: 'failed' } }), snapshot)).toBe('InGame launch status: tsc failed');
    expect(describeEvent(command({ command: { label: 'tsc', outcome: 'killed' } }), snapshot)).toBe('InGame launch status: tsc was stopped');
    expect(describeEvent(command({ command: { label: 'tsc', outcome: 'session' } }), snapshot)).toBe('InGame launch status: tsc ended with its session');
    expect(describeEvent(command({ command: { label: 'tsc', outcome: 'unknown' } }), snapshot)).toBe('InGame launch status: tsc ended');
  });

  it('keeps a session end as the end when it also ended a command, and puts a command after a state change', () => {
    const upd = (data: object) => ev('session.updated', 's1', data, 'hook:end');
    expect(describeEvent(upd({ changed: ['state', 'commands'], state: 'ended', activity: 'ended', command: { label: 'npm run dev', outcome: 'session' } }), snapshot)).toBe('InGame launch status ended');
    expect(describeEvent(upd({ changed: ['state', 'commands'], state: 'idle', activity: 'busy', command: { label: 'tsc', outcome: 'completed' } }), snapshot)).toBe('InGame launch status is busy · tsc completed');
    expect(describeEvent(upd({ changed: ['state', 'commands'], state: 'idle', activity: 'idle', command: { label: 'tsc', outcome: 'killed' } }), snapshot)).toBe('InGame launch status is idle · tsc was stopped');
    expect(describeEvent(upd({ changed: ['state', 'commands'], state: 'working', activity: 'working', command: { label: 'tsc' } }), snapshot)).toBe('InGame launch status is working · started tsc');
  });

  it('says a background command ended when the watcher changed only the commands', () => {
    const watcher = ev('session.updated', 's1', { changed: ['commands'], state: 'idle', activity: 'idle' }, 'system');
    expect(describeEvent(watcher, snapshot)).toBe('InGame launch status: a background command ended');
    expect(describeEvent(watcher, null)).toBe('a session: a background command ended');
  });

  it('labels actors', () => {
    expect(actorLabel(ev('node.created', '1', {}), snapshot)).toBe('scribe (InGame launch status)');
    expect(actorLabel(ev('node.created', '1', {}, 'hook:prompt'), snapshot)).toBe('Claude');
    expect(actorLabel(ev('node.created', '1', {}, 'system'), snapshot)).toBe('system');
  });

  it('falls back to ids and the event type when the snapshot has no match', () => {
    expect(describeEvent(ev('widget.spun', '7', {}), snapshot)).toBe('widget.spun');
    expect(describeEvent(ev('node.updated', '99', { changes: { status: { from: 'todo', to: 'done' } } }), snapshot)).toBe('#99 → done');
    expect(describeEvent(ev('node.created', '58', { ids: [58], parentId: 55 }), null)).toBe('added #58');
    expect(describeEvent(ev('session.updated', 's1', { changed: ['state'], state: 'idle' }), null)).toBe('a session is idle');
  });

  it("reads a task write by session:<id>, the tasks command's actor, as that session's title", () => {
    const event = ev('work.updated', '58', { nodeId: 58 }, 'session:s1');
    expect(actorLabel(event, snapshot)).toBe('InGame launch status');
    expect(describeEvent(event, snapshot)).toBe('tasks updated on #58 Run signing tests');
    // An ended session is not in the snapshot: it falls back to the short id, as an untitled session reads.
    expect(actorLabel(ev('work.updated', '58', { nodeId: 58 }, 'session:abcdef123456'), snapshot)).toBe('Session abcdef');
    expect(actorLabel(event, null)).toBe('Session s1');
  });

  it('labels a scribe without a known session as plain scribe', () => {
    expect(actorLabel(ev('node.created', '1', {}, 'scribe'), snapshot)).toBe('scribe');
    expect(actorLabel(ev('node.created', '1', {}), null)).toBe('scribe');
  });

  it('says where working tasks changed, and when Up next changed', () => {
    expect(describeEvent(ev('work.updated', '58', { nodeId: 58 }, 'hook:task-updated'), snapshot)).toBe('tasks updated on #58 Run signing tests');
    expect(describeEvent(ev('work.updated', '99', { nodeId: 99 }, 'hook:task-created'), snapshot)).toBe('tasks updated on #99');
    expect(describeEvent(ev('project.updated', '1', { changes: { queue: { from: [58], to: [55, 58] } } }), snapshot)).toBe('Up next changed');
    expect(describeEvent(ev('project.updated', '1', { changes: { description: { from: 'P', to: 'Q' } } }), snapshot)).toBe('project updated');
  });

  it('says when a session ended', () => {
    expect(describeEvent(ev('session.updated', 's1', { changed: ['state'], state: 'ended' }), snapshot)).toBe('InGame launch status ended');
    expect(describeEvent(ev('session.updated', 'gone', { changed: ['state'], state: 'ended' }), snapshot)).toBe('a session ended');
  });

  it('says when the project was archived, unarchived, deleted or restored', () => {
    const status = (from: string, to: string) => ({ changes: { status: { from, to } } });
    expect(describeEvent(ev('project.updated', '1', status('active', 'archived'), 'window'), snapshot)).toBe('archived the project');
    expect(describeEvent(ev('project.updated', '1', status('archived', 'active'), 'window'), snapshot)).toBe('unarchived the project');
    // The scribe's update_project reads the same.
    expect(describeEvent(ev('project.updated', '1', status('active', 'archived')), snapshot)).toBe('archived the project');
    expect(describeEvent(ev('project.deleted', '1', { slug: 'p', name: 'P', purgeAt: '2026-11-05T12:00:00Z' }, 'window'), snapshot)).toBe('deleted the project');
    expect(describeEvent(ev('project.restored', '1', { slug: 'p', name: 'P' }, 'window'), snapshot)).toBe('restored the project');
  });

  it('says when the project was renamed, from the window or by the scribe', () => {
    const renamed = { changes: { name: { from: 'P', to: 'Q' } } };
    expect(describeEvent(ev('project.updated', '1', renamed, 'window'), snapshot)).toBe('renamed the project');
    expect(describeEvent(ev('project.updated', '1', renamed), snapshot)).toBe('renamed the project');
    expect(describeEvent(ev('project.updated', '1', { changes: { ...renamed.changes, description: { from: '', to: 'x' } } }), snapshot)).toBe('renamed the project');
  });

  it("labels the window's own writes as you", () => {
    expect(actorLabel(ev('project.updated', '1', {}, 'window'), snapshot)).toBe('you');
    expect(actorLabel(ev('project.updated', '1', {}, 'window'), null)).toBe('you');
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
