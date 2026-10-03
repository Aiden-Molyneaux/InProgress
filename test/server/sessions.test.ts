import { describe, expect, it } from 'vitest';
import { homeDir } from '../../src/lib/home';
import { updateRules } from '../../src/server/briefing';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes, listNodes, updateNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, setQueue, updateProject } from '../../src/server/repo/projects';
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
    expect(text).toContain('At most one brief per turn');
    expect(text).toContain(`#${a2.id} Play app signing — active`);
    expect(text).toContain(`#${a3.id} Run signing tests — NEEDS YOU`);
    expect(text).toMatch(/Next: #\d+ 3 RevenueCat · #\d+ 4 Build to GitHub \(\+3 more\)/);
    expect(text).toContain(`Needs you (1): #${a3.id} Run signing tests`);
    expect(text).toContain(`Signing suite (on #${a3.id})`);
    expect(findSession(ctx, 's1')).toMatchObject({ title: 'InGame launch status', state: 'idle', cwd: 'C:\\personal\\InGame\\docs' });
  });

  it('names the resources folder by its absolute path, which the Write tool needs', () => {
    const { ctx } = setup();
    const text = handleHookEvent(ctx, 's1', start()).context!;
    expect(text).toContain(`Content that only exists in chat is first written to ${homeDir().replace(/\\/g, '/')}/resources/<slug>/<yyyy-mm-dd>-<kebab-title>.md.`);
    expect(text).not.toContain('~/');
    expect(updateRules('C:\\Users\\me\\.inprogress').join('\n')).toContain(' C:/Users/me/.inprogress/resources/<slug>/<yyyy-mm-dd>-<kebab-title>.md.');
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

  it('does not count a background-task notice as a prompt, nor nudge on one', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'prompt' });
    handleHookEvent(ctx, 's1', { event: 'stop' });
    // The scribe finishing comes back as a notice: the session works on it, but no prompt was typed.
    expect(handleHookEvent(ctx, 's1', { event: 'prompt', notice: true }).context).toBeUndefined();
    expect(findSession(ctx, 's1')).toMatchObject({ state: 'working', promptsSinceUpdate: 1 });
    expect(handleHookEvent(ctx, 's1', { event: 'prompt' }).context).toMatch(/last scribe update 2 prompts ago/);
    expect(handleHookEvent(ctx, 's1', { event: 'prompt', notice: true }).context).toBeUndefined();
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

  it('resets to idle only on a startup, resume or clear start; a missing source counts as startup', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    const cases = [['startup', 'idle'], ['resume', 'idle'], ['clear', 'idle'], [undefined, 'idle'], ['compact', 'working'], ['mystery', 'working']] as const;
    for (const [source, state] of cases) {
      handleHookEvent(ctx, 's1', { event: 'prompt' });
      handleHookEvent(ctx, 's1', { event: 'start', source, cwd: 'C:/personal/InGame' });
      expect(findSession(ctx, 's1')?.state, `source ${source}`).toBe(state);
    }
  });

  it('tracks subagents by agent id, ignoring the scribe and empty types', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a1', agentType: 'Explore' });
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a2', agentType: 'inprogress-scribe' });
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a3', agentType: '' });
    expect(findSession(ctx, 's1')?.subagents.map((s) => s.agentType)).toEqual(['Explore']);
    handleHookEvent(ctx, 's1', { event: 'subagent-stop', agentId: 'a1', agentType: 'Explore' });
    // Stopped, not forgotten: it shows as ended for a few minutes.
    expect(findSession(ctx, 's1')?.subagents).toEqual([expect.objectContaining({ agentId: 'a1', endedAt: expect.any(String) })]);
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a4', agentType: 'general-purpose' });
    handleHookEvent(ctx, 's1', { event: 'end' });
    expect(findSession(ctx, 's1')).toMatchObject({ state: 'ended', subagents: [] });
  });
});

describe('briefing: live work', () => {
  it('names the planned order in an Up next line after where things stand, leaving out finished steps', () => {
    const { ctx, project, a2, a3 } = setup();
    setQueue(ctx, 'scribe:s1', project.slug, [a3.id, a2.id]);
    const text = handleHookEvent(ctx, 's1', start()).context!;
    expect(text).toContain(`\nUp next: #${a3.id} Run signing tests → #${a2.id} Play app signing\n`);
    expect(text.indexOf('Where things stand:')).toBeLessThan(text.indexOf('Up next:'));
    expect(text.indexOf('Up next:')).toBeLessThan(text.indexOf('Needs you (1)'));
    updateNode(ctx, 'test', a3.id, { status: 'done' });
    expect(handleHookEvent(ctx, 's1', { event: 'prompt', asksStatus: true }).context).toMatch(new RegExp(`\\nUp next: #${a2.id} Play app signing$`));
  });

  it('caps the Up next line at five steps', () => {
    const { ctx, project, road } = setup();
    const steps = addNodes(ctx, 'test', { parentId: road.id, nodes: Array.from({ length: 7 }, (_, i) => ({ title: `Step ${i + 1}` })) });
    setQueue(ctx, 'scribe:s1', project.slug, steps.map((n) => n.id));
    const line = handleHookEvent(ctx, 's1', start()).context!.split('\n').find((l) => l.startsWith('Up next:'));
    expect(line).toBe(`Up next: ${steps.slice(0, 5).map((n) => `#${n.id} ${n.title}`).join(' → ')} (+2 more)`);
  });

  it("lists the focused step's working tasks under it: in progress first, then pending, at most 5", () => {
    const { ctx, a2, a3 } = setup();
    handleHookEvent(ctx, 's1', start());
    setFocus(ctx, 'scribe:s1', 's1', a2.id);
    for (let i = 1; i <= 7; i++) handleHookEvent(ctx, 's1', { event: 'task-created', taskKey: String(i), subject: `Task ${i}` });
    handleHookEvent(ctx, 's1', { event: 'task-updated', taskKey: '6', status: 'in_progress' });
    handleHookEvent(ctx, 's1', { event: 'task-updated', taskKey: '3', status: 'in_progress' });
    handleHookEvent(ctx, 's1', { event: 'task-updated', taskKey: '2', status: 'completed' });
    const lines = handleHookEvent(ctx, 's1', { event: 'prompt', asksStatus: true }).context!.split('\n');
    const at = lines.findIndex((l) => l.includes(`#${a2.id} Play app signing — active  ◆ this session`));
    expect(lines.slice(at + 1, at + 7)).toEqual([
      '        ◐ Task 3',
      '        ◐ Task 6',
      '        ○ Task 1',
      '        ○ Task 4',
      '        ○ Task 5',
      `      #${a3.id} Run signing tests — NEEDS YOU`,
    ]);
  });

  it('shows no task lines without a focus, and no Up next line without a queue', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'task-created', taskKey: '1', subject: 'Unfocused work' });
    const text = handleHookEvent(ctx, 's1', start()).context!;
    expect(text).not.toContain('Unfocused work');
    expect(text).not.toContain('Up next');
  });

  it('carries the live-work rules: #id on subagents and tasks, the task tools, the queue, new requests', () => {
    const rules = updateRules('C:/Users/me/.inprogress').join('\n');
    expect(rules).toContain('"queue: #a, #b, #c"');
    expect(rules).toContain('a new request with a deliverable arrives (it becomes a step right away)');
    expect(rules).toContain('"#44 Build project tabs"');
    expect(rules).toContain('TaskCreate');
    expect(rules).toContain('tasks on #57:');
  });
});

describe('briefing: type labels', () => {
  it('prints the glyph before the title on node lines, Next, Up next and Needs you', () => {
    const { ctx, project, a2, a3 } = setup();
    const [s3] = listNodes(ctx, project.id).filter((n) => n.title === '3 RevenueCat');
    updateNode(ctx, 'test', a2.id, { label: 'ui' });
    updateNode(ctx, 'test', a3.id, { label: 'ops' });
    updateNode(ctx, 'test', s3.id, { label: 'integration' });
    setQueue(ctx, 'scribe:s1', project.slug, [a3.id]);
    const lines = handleHookEvent(ctx, 's1', start()).context!.split('\n');
    expect(lines).toContain(`      #${a2.id} ⧉ Play app signing — active`);
    expect(lines).toContain(`      #${a3.id} ⚒ Run signing tests — NEEDS YOU`);
    expect(lines.find((l) => l.trim().startsWith('Next:'))?.trim()).toMatch(new RegExp(`^Next: #${s3.id} ⇄ 3 RevenueCat · #\\d+ 4 Build to GitHub`));
    expect(lines).toContain(`Up next: #${a3.id} ⚒ Run signing tests`);
    expect(lines).toContain(`Needs you (1): #${a3.id} ⚒ Run signing tests`);
  });

  it('lists the label set and the picking rule once in the update rules', () => {
    const rules = updateRules('C:/Users/me/.inprogress').join('\n');
    expect(rules).toContain('⧉ ui, ⚙ server, ⛁ data, ⇄ integration, ⚒ ops, ¶ docs, ⚑ fix, ↻ refactor, ⌕ research');
    expect(rules.match(/⧉ ui/g)).toHaveLength(1);
    expect(rules).toMatch(/purpose first \(fix, refactor, research\), else by where the work lands/);
    expect(rules).toContain('(task, server)');
  });
});

describe('first prompt of a session the server has not seen (a missed start)', () => {
  const prompt = (cwd: string, extra = {}) => ({ event: 'prompt' as const, cwd, ...extra });

  it('tracks it when its folder is bound, and briefs it in that prompt', () => {
    const { ctx, project, a3 } = setup();
    const r = handleHookEvent(ctx, 'p1', prompt('C:\\personal\\InGame\\src', { branch: 'main', title: 'Missed start', mentionsInProgress: false, asksStatus: false }));
    expect(r.tracked).toBe(true);
    expect(r.context).toContain('[InProgress] This session is tracked in project "InGame" (slug ingame). Session id: p1.');
    expect(r.context).toContain('Where things stand:');
    expect(r.context).toContain(`Needs you (1): #${a3.id} Run signing tests`);
    expect(findSession(ctx, 'p1')).toMatchObject({ projectId: project.id, state: 'working', promptsSinceUpdate: 1, cwd: 'C:\\personal\\InGame\\src', branch: 'main', title: 'Missed start' });
    // From then on it is an ordinary tracked session: no second briefing, the usual nudge.
    expect(handleHookEvent(ctx, 'p1', prompt('C:\\personal\\InGame\\src')).context).toMatch(/^\[InProgress\] InGame · no focus set · 1 need you · last scribe update 2 prompts ago/);
  });

  it('briefs it even when that prompt asks for status (the briefing has the frontier)', () => {
    const { ctx } = setup();
    const r = handleHookEvent(ctx, 'p2', prompt('C:/personal/InGame', { asksStatus: true }));
    expect(r.context).toContain('This session is tracked in project "InGame"');
    expect(r.context).toContain('Where things stand:');
  });

  it('resolves the binding exactly like a start, branch patterns included', () => {
    const { ctx } = setup();
    const ticket = createProject(ctx, 'test', { name: 'Ticket' });
    addBinding(ctx, 'test', ticket.slug, 'C:/personal/InGame', '*VCAD-978*');
    expect(handleHookEvent(ctx, 'p3', prompt('C:/personal/InGame', { branch: 'feature/VCAD-978-x' })).context).toContain('(slug ticket)');
    expect(handleHookEvent(ctx, 'p4', prompt('C:/personal/InGame', { branch: null })).context).toContain('(slug ingame)');
  });

  it('records the new session for the UI', () => {
    const { ctx } = setup();
    const mark = maxEventId(ctx);
    handleHookEvent(ctx, 'p5', prompt('C:/personal/InGame'));
    expect(listEventsSince(ctx, mark)).toMatchObject([{ type: 'session.updated', actor: 'hook:prompt', entityId: 'p5', data: { changed: ['created', 'state'], state: 'working' } }]);
  });

  it('stays untracked outside bound folders, as before', () => {
    const { ctx } = setup();
    expect(handleHookEvent(ctx, 'u1', prompt('C:/elsewhere', { branch: null }))).toEqual({ tracked: false });
    expect(handleHookEvent(ctx, 'u1', prompt('C:/elsewhere', { mentionsInProgress: true })).context).toContain('This session is not tracked yet. Session id: u1.');
    expect(findSession(ctx, 'u1')).toBeUndefined();
  });

  it('still needs a start or a prompt: other events never begin tracking', () => {
    const { ctx } = setup();
    for (const event of ['stop', 'permission', 'subagent-start', 'subagent-stop', 'end'] as const) {
      expect(handleHookEvent(ctx, 'o1', { event, cwd: 'C:/personal/InGame' }), event).toEqual({ tracked: false });
    }
    expect(findSession(ctx, 'o1')).toBeUndefined();
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

  it('clears focus and tells the old project when enroll repoints a session', () => {
    const { ctx, project, a2 } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    handleHookEvent(ctx, 's1', start());
    setFocus(ctx, 'scribe:s1', 's1', a2.id);
    expect(enrollSession(ctx, 'scribe:s1', 's1', project.slug).session.focusNodeId).toBe(a2.id);
    const mark = maxEventId(ctx);
    expect(enrollSession(ctx, 'scribe:s1', 's1', other.slug).session).toMatchObject({ projectId: other.id, focusNodeId: null });
    expect(listEventsSince(ctx, mark).filter((e) => e.projectId === project.id))
      .toMatchObject([{ type: 'session.updated', entityId: 's1', data: { changed: ['projectId'], state: 'idle' } }]);
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
    expect(() => setFocus(ctx, 'scribe:x', 'untracked', a2.id)).toThrow('not tracked');
    expect(findSession(ctx, 'untracked')).toBeUndefined();
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

  it('revives an expired session on its next prompt without a stale end time', () => {
    const db = openDb(':memory:');
    let now = Date.parse('2026-09-27T00:00:00Z');
    const ctx = createCtx(db, () => new Date(now).toISOString());
    const p = createProject(ctx, 'test', { name: 'P' });
    addBinding(ctx, 'test', p.slug, 'C:/p');
    handleHookEvent(ctx, 's1', start('C:/p'));
    now += 13 * 60 * 60 * 1000;
    listProjectSessions(ctx, p.id);
    expect(findSession(ctx, 's1')?.endedAt).not.toBeNull();
    handleHookEvent(ctx, 's1', { event: 'prompt' });
    expect(findSession(ctx, 's1')).toMatchObject({ state: 'working', endedAt: null });
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
