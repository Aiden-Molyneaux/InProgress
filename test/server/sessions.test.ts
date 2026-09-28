import { describe, expect, it } from 'vitest';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, updateProject } from '../../src/server/repo/projects';
import { addResource } from '../../src/server/repo/resources';
import { findSession, listProjectSessions } from '../../src/server/repo/sessions';
import { getNodeDetail, getProjectSnapshot } from '../../src/server/repo/snapshot';
import { enrollSession, handleHookEvent, setFocus } from '../../src/server/session-flow';
import { createCtx } from '../../src/server/db/tx';
import { openDb } from '../../src/server/db/connection';
import { makeCtx } from '../helpers';

function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame', playbook: 'Planning docs live in docs/planning.' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [road, s1, s2, a1, a2, a3] = addNodes(ctx, 'test', {
    parentId: project.rootNodeId,
    nodes: [{
      title: 'Road to market', kind: 'phase', status: 'active',
      children: [
        { title: '1 iOS certificate', status: 'done' },
        { title: '2 Android signing', status: 'active', children: [
          { title: 'Upload keystore', status: 'done' },
          { title: 'Play app signing', status: 'active' },
          { title: 'Run signing tests', assignee: 'me' },
        ] },
        { title: '3 RevenueCat' }, { title: '4 Build to GitHub' }, { title: '5 Store listing' }, { title: '6 Beta' }, { title: '7 Launch' },
      ],
    }],
  });
  return { ctx, project, road, s1, s2, a1, a2, a3 };
}

const start = (cwd = 'C:\\personal\\InGame\\docs', extra = {}) => ({ event: 'start' as const, source: 'startup', cwd, ...extra });

describe('handleHookEvent', () => {
  it('stores nothing for an untracked session', () => {
    const { ctx } = setup();
    expect(handleHookEvent(ctx, 'u1', start('C:/elsewhere'))).toEqual({ tracked: false });
    expect(handleHookEvent(ctx, 'u1', { event: 'prompt' })).toEqual({ tracked: false });
    expect(findSession(ctx, 'u1')).toBeUndefined();
  });

  it('hints at opt-in when an untracked prompt mentions InProgress', () => {
    const { ctx } = setup();
    const r = handleHookEvent(ctx, 'u2', { event: 'prompt', mentionsInProgress: true });
    expect(r.tracked).toBe(false);
    expect(r.context).toContain('Session id: u2');
  });

  it('briefs a bound session with rules, frontier, needs-you and resources', () => {
    const { ctx, a2, a3 } = setup();
    addResource(ctx, 'test', { nodeId: a3.id, kind: 'test-suite', title: 'Signing suite', content: 'x' });
    const r = handleHookEvent(ctx, 's1', start(undefined, { title: 'InGame launch status' }));
    expect(r.tracked).toBe(true);
    const text = r.context!;
    expect(text).toContain('tracked in project "InGame" (slug ingame). Session id: s1.');
    expect(text).toContain('Planning docs live in docs/planning.');
    expect(text).toContain('inprogress-scribe');
    expect(text).toContain(`#${a2.id} Play app signing — active`);
    expect(text).toContain(`#${a3.id} Run signing tests — NEEDS YOU`);
    expect(text).toMatch(/Next: #\d+ 3 RevenueCat · #\d+ 4 Build to GitHub \(\+3 more\)/);
    expect(text).toContain(`Needs you (1): #${a3.id} Run signing tests`);
    expect(text).toContain(`Signing suite (on #${a3.id})`);
    expect(findSession(ctx, 's1')).toMatchObject({ title: 'InGame launch status', state: 'idle', cwd: 'C:\\personal\\InGame\\docs' });
  });

  it('tracks prompt, stop and permission states and nudges when stale', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    expect(handleHookEvent(ctx, 's1', { event: 'prompt' }).context).toBeUndefined();
    expect(findSession(ctx, 's1')?.state).toBe('working');
    const nudge = handleHookEvent(ctx, 's1', { event: 'prompt' }).context!;
    expect(nudge).toMatch(/^\[InProgress\] InGame · no focus set · 1 need you · last scribe update 2 prompts ago/);
    handleHookEvent(ctx, 's1', { event: 'permission' });
    expect(findSession(ctx, 's1')?.state).toBe('permission');
    handleHookEvent(ctx, 's1', { event: 'stop' });
    expect(findSession(ctx, 's1')?.state).toBe('idle');
  });

  it('answers status questions with the current frontier', () => {
    const { ctx, a3 } = setup();
    handleHookEvent(ctx, 's1', start());
    const r = handleHookEvent(ctx, 's1', { event: 'prompt', asksStatus: true });
    expect(r.context).toContain('[InProgress] Where things stand in InGame');
    expect(r.context).toContain(`#${a3.id} Run signing tests — NEEDS YOU`);
  });

  it('leaves state alone on a compact restart but still re-briefs', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'prompt' });
    const r = handleHookEvent(ctx, 's1', { event: 'start', source: 'compact', cwd: 'C:/personal/InGame' });
    expect(r.context).toContain('Session id: s1');
    expect(findSession(ctx, 's1')?.state).toBe('working');
  });

  it('tracks subagents by agent id, ignoring the scribe and empty types', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a1', agentType: 'Explore' });
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a2', agentType: 'inprogress-scribe' });
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a3', agentType: '' });
    expect(findSession(ctx, 's1')?.subagents.map((s) => s.agentType)).toEqual(['Explore']);
    handleHookEvent(ctx, 's1', { event: 'subagent-stop', agentId: 'a1', agentType: 'Explore' });
    expect(findSession(ctx, 's1')?.subagents).toEqual([]);
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a4', agentType: 'general-purpose' });
    handleHookEvent(ctx, 's1', { event: 'end' });
    expect(findSession(ctx, 's1')).toMatchObject({ state: 'ended', subagents: [] });
  });
});

describe('enrollSession and setFocus', () => {
  it('enrolls, repoints, keeps an existing title, and refuses archived projects', () => {
    const { ctx, project } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    const r = enrollSession(ctx, 'scribe:e1', 'e1', 'ingame', 'Chosen by scribe');
    expect(r.briefing).toContain('Session id: e1');
    expect(r.session).toMatchObject({ projectId: project.id, title: 'Chosen by scribe' });
    expect(enrollSession(ctx, 'scribe:e1', 'e1', other.slug, 'Another name').session).toMatchObject({ projectId: other.id, title: 'Chosen by scribe' });
    updateProject(ctx, 'test', other.slug, { status: 'archived' });
    expect(() => enrollSession(ctx, 'scribe:e2', 'e2', other.slug)).toThrow('archived');
  });

  it('sets focus within the session project and resets the stale counter', () => {
    const { ctx, a2 } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'prompt' });
    handleHookEvent(ctx, 's1', { event: 'prompt' });
    expect(setFocus(ctx, 'scribe:s1', 's1', a2.id)).toMatchObject({ focusNodeId: a2.id, promptsSinceUpdate: 0 });
    const other = createProject(ctx, 'test', { name: 'Other' });
    expect(() => setFocus(ctx, 'scribe:s1', 's1', other.rootNodeId)).toThrow("not in this session's project");
    expect(() => setFocus(ctx, 'scribe:x', 'untracked', null)).toThrow('not tracked');
  });
});

describe('snapshots', () => {
  it('returns nodes, resources, live sessions and the last event', () => {
    const { ctx, project } = setup();
    handleHookEvent(ctx, 's1', start());
    const snap = getProjectSnapshot(ctx, project.slug);
    expect(snap.nodes).toHaveLength(12);
    expect(snap.nodes.some((n) => n.parentId === null)).toBe(true);
    expect(snap.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(snap.lastEvent?.type).toBe('session.updated');
    expect(snap.lastEventId).toBe(snap.lastEvent?.id);
  });

  it('expires sessions not seen for 12 hours', () => {
    const db = openDb(':memory:');
    let now = Date.parse('2026-09-27T00:00:00Z');
    const ctx = createCtx(db, () => new Date(now).toISOString());
    const p = createProject(ctx, 'test', { name: 'P' });
    addBinding(ctx, 'test', p.slug, 'C:/p');
    handleHookEvent(ctx, 's1', start('C:/p'));
    now += 13 * 60 * 60 * 1000;
    expect(listProjectSessions(ctx, p.id)).toEqual([]);
    expect(findSession(ctx, 's1')?.state).toBe('ended');
  });

  it('builds node details with parent, children, resources and log', () => {
    const { ctx, s2, road } = setup();
    const d = getNodeDetail(ctx, s2.id);
    expect(d.parent).toEqual({ id: road.id, title: 'Road to market' });
    expect(d.children.map((c) => c.title)).toEqual(['Upload keystore', 'Play app signing', 'Run signing tests']);
    expect(d.resources).toEqual([]);
    expect(d.log).toEqual([]);
  });
});
