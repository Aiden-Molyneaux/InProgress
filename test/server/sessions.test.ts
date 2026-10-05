import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { homeDir } from '../../src/lib/home';
import { normalizePath } from '../../src/lib/paths';
import { updateRules } from '../../src/server/briefing';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes, listNodes, updateNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, setQueue, updateProject } from '../../src/server/repo/projects';
import { addResource } from '../../src/server/repo/resources';
import { findSession, listProjectSessions } from '../../src/server/repo/sessions';
import { getNodeDetail, getProjectSnapshot } from '../../src/server/repo/snapshot';
import { renderBriefing } from '../../src/server/briefing';
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
    expect(updateRules({ home: 'C:\\Users\\me\\.inprogress', sessionId: 's1' }).join('\n')).toContain(' C:/Users/me/.inprogress/resources/<slug>/<yyyy-mm-dd>-<kebab-title>.md.');
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
    // Ending keeps the rows for the trail, and ends the one still running.
    expect(findSession(ctx, 's1')).toMatchObject({
      state: 'ended',
      subagents: [{ agentId: 'a1', endedAt: expect.any(String) }, { agentId: 'a4', endedAt: findSession(ctx, 's1')!.endedAt }],
    });
  });
});

describe('briefing: live work', () => {
  it('names the planned order in an Up next line after where things stand, leaving out finished steps', () => {
    const { ctx, project, a2, a3 } = setup();
    handleHookEvent(ctx, 's1', start());
    setQueue(ctx, 'scribe:s1', project.slug, [a3.id, a2.id], { sessionId: 's1' });
    const text = handleHookEvent(ctx, 's1', start()).context!;
    expect(text).toContain(`\nUp next (you, A): #${a3.id} Run signing tests → #${a2.id} Play app signing\n`);
    expect(text.indexOf('Where things stand:')).toBeLessThan(text.indexOf('Up next'));
    expect(text.indexOf('Up next')).toBeLessThan(text.indexOf('Needs you (1)'));
    updateNode(ctx, 'test', a3.id, { status: 'done' });
    expect(handleHookEvent(ctx, 's1', { event: 'prompt', asksStatus: true }).context).toMatch(new RegExp(`\\nUp next \\(you, A\\): #${a2.id} Play app signing$`));
  });

  it("puts this session's own steps first, then other sessions' by letter and the unowned ones, in the briefing and the status answer", () => {
    const { ctx, project, a1, a2, a3, road } = setup();
    const [s3, s4] = addNodes(ctx, 'test', { parentId: road.id, nodes: [{ title: 'Later one' }, { title: 'Later two' }] });
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's2', start());
    setQueue(ctx, 'scribe:s2', project.slug, [a2.id], { sessionId: 's2' });
    setQueue(ctx, 'scribe:s1', project.slug, [a3.id, a1.id], { sessionId: 's1' });
    setQueue(ctx, 'scribe:s1', project.slug, [s3.id, s4.id], 'unowned');
    const line = (text: string) => text.split('\n').find((l) => l.startsWith('Up next'));
    const expected = `Up next (you, A): #${a3.id} Run signing tests · B: #${a2.id} · later: #${s3.id} → #${s4.id}`;
    // a1 is done, so it is left out.
    expect(line(handleHookEvent(ctx, 's1', start()).context!)).toBe(expected);
    expect(line(handleHookEvent(ctx, 's1', { event: 'prompt', asksStatus: true }).context!)).toBe(expected);
    expect(line(handleHookEvent(ctx, 's2', start()).context!)).toBe(`Up next (you, B): #${a2.id} Play app signing · A: #${a3.id} · later: #${s3.id} → #${s4.id}`);
    // A session with nothing of its own queued reads the others' parts only; one that ended leaves its steps under later.
    setQueue(ctx, 'scribe:s2', project.slug, [], { sessionId: 's2' });
    handleHookEvent(ctx, 's1', { event: 'end' });
    expect(line(handleHookEvent(ctx, 's2', start()).context!)).toBe(`Up next: later: #${a3.id} → #${s3.id} → #${s4.id}`);
  });

  it('leaves the letter out of its own part while the session has no slot, and prints ? for another owner without one', () => {
    const { ctx, project, a2, a3 } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's2', start());
    setQueue(ctx, 'scribe:s1', project.slug, [a3.id], { sessionId: 's1' });
    setQueue(ctx, 'scribe:s2', project.slug, [a2.id], { sessionId: 's2' });
    // As from before migration 4: the next hook event gives each a slot.
    ctx.db.prepare('UPDATE sessions SET slot = NULL').run();
    const lines = renderBriefing(getProjectSnapshot(ctx, project.slug), 's1').split('\n');
    expect(lines).toContain(`Up next (you): #${a3.id} Run signing tests · ?: #${a2.id}`);
  });

  it('caps the Up next line at five steps', () => {
    const { ctx, project, road } = setup();
    const steps = addNodes(ctx, 'test', { parentId: road.id, nodes: Array.from({ length: 7 }, (_, i) => ({ title: `Step ${i + 1}` })) });
    handleHookEvent(ctx, 's1', start());
    setQueue(ctx, 'scribe:s1', project.slug, steps.map((n) => n.id), { sessionId: 's1' });
    const line = handleHookEvent(ctx, 's1', start()).context!.split('\n').find((l) => l.startsWith('Up next'));
    expect(line).toBe(`Up next (you, A): ${steps.slice(0, 5).map((n) => `#${n.id} ${n.title}`).join(' → ')} (+2 more)`);
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

  it("leaves an ended session's open tasks out of the focused step's task lines", () => {
    const { ctx, a2 } = setup();
    handleHookEvent(ctx, 's1', start());
    setFocus(ctx, 'scribe:s1', 's1', a2.id);
    handleHookEvent(ctx, 's2', start());
    setFocus(ctx, 'scribe:s2', 's2', a2.id);
    handleHookEvent(ctx, 's2', { event: 'task-created', taskKey: '1', subject: 'Left in progress' });
    handleHookEvent(ctx, 's2', { event: 'task-updated', taskKey: '1', status: 'in_progress' });
    handleHookEvent(ctx, 's2', { event: 'task-created', taskKey: '2', subject: 'Left pending' });
    handleHookEvent(ctx, 's1', { event: 'task-created', taskKey: '1', subject: 'Still mine' });
    handleHookEvent(ctx, 's2', { event: 'end' });
    // Not as live task lines (P8 names them in a line of their own).
    for (const text of [handleHookEvent(ctx, 's1', { event: 'prompt', asksStatus: true }).context!, handleHookEvent(ctx, 's1', start()).context!]) {
      expect(text).toContain('○ Still mine');
      expect(text).not.toContain('◐ Left in progress');
      expect(text).not.toContain('○ Left pending');
    }
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
    const rules = updateRules({ home: 'C:/Users/me/.inprogress', sessionId: 's1' }).join('\n');
    expect(rules).toContain('"queue: #a, #b, #c"');
    expect(rules).toContain('a new request with a deliverable arrives (it becomes a step right away)');
    expect(rules).toContain('"#44 Build project tabs"');
    expect(rules).toContain('TaskCreate');
  });

  it('writes out the tasks command with this session\'s id, as the one write the session makes itself', () => {
    const cli = 'C:\\personal\\InProgress\\dist\\cli\\main.js';
    const rules = updateRules({ home: 'C:/Users/me/.inprogress', sessionId: 'abc-123', cli });
    const line = rules.find((l) => l.startsWith('- Working tasks'))!;
    expect(line).toContain('Without the task tools, run this after each change; it is the one InProgress write you make yourself:');
    expect(line).toContain('`node C:/personal/InProgress/dist/cli/main.js tasks <step id> --session abc-123 --done "…" --doing "…" --todo "…"`');
    expect(line).toContain('leave out <step id> to use your focus');
    // The scribe's old fallback is gone, and nothing prints a step as "tasks #…": an unquoted # starts a comment.
    expect(rules.join('\n')).not.toContain('tasks on #');
    expect(rules.join('\n')).not.toMatch(/tasks #/);
    // Only that line changed: the scribe line stays for P8 to rewrite.
    expect(rules[1]).toMatch(/^- Never edit it yourself\. Brief the inprogress-scribe agent/);
  });

  it("prints the CLI beside the server module, with the briefed session's id", () => {
    const { ctx } = setup();
    const text = handleHookEvent(ctx, 's1', start()).context!;
    // Under vitest the module is src/lib/task-command.ts, so "beside" is src/cli/main.js; bundled, it is dist/cli/main.js
    // (the smoke test checks that one against the installed rules).
    const printed = /`node (\S+) tasks <step id> --session s1 --done "…" --doing "…" --todo "…"`/.exec(text);
    expect(printed?.[1]).toBe(normalizePath(resolve('src/cli/main.js')));
  });
});

describe('briefing: session identity', () => {
  it('ends the first line with the session\'s letter, in one sentence', () => {
    const { ctx } = setup();
    const first = handleHookEvent(ctx, 's1', start()).context!.split('\n')[0];
    expect(first).toBe('[InProgress] This session is tracked in project "InGame" (slug ingame). Session id: s1. You are session A.');
    expect(handleHookEvent(ctx, 's2', start()).context!.split('\n')[0]).toMatch(/Session id: s2\. You are session B\.$/);
  });

  it('leads each of the other sessions with its letter', () => {
    const { ctx, a2 } = setup();
    handleHookEvent(ctx, 's1', start(undefined, { title: 'Launch status' }));
    setFocus(ctx, 'scribe:s1', 's1', a2.id);
    handleHookEvent(ctx, 's2', start(undefined, { title: 'Store listing' }));
    handleHookEvent(ctx, 's2', { event: 'prompt' });
    const lines = handleHookEvent(ctx, 's3', start()).context!.split('\n');
    expect(lines).toContain(`Other sessions here: B "Store listing" (working) · A "Launch status" (idle, on #${a2.id})`);
  });

  it('prints no letter for a session whose slot is still empty (it predates migration 4)', () => {
    const { ctx, project } = setup();
    handleHookEvent(ctx, 's1', start(undefined, { title: 'Launch status' }));
    handleHookEvent(ctx, 's2', start());
    ctx.db.prepare('UPDATE sessions SET slot = NULL').run();
    const lines = renderBriefing(getProjectSnapshot(ctx, project.slug), 's2').split('\n');
    expect(lines[0]).toMatch(/Session id: s2\.$/);
    expect(lines).toContain('Other sessions here: "Launch status" (idle)');
  });
});

describe('briefing: type labels', () => {
  it('prints the glyph before the title on node lines, Next, Up next and Needs you', () => {
    const { ctx, project, a2, a3 } = setup();
    const [s3] = listNodes(ctx, project.id).filter((n) => n.title === '3 RevenueCat');
    updateNode(ctx, 'test', a2.id, { label: 'ui' });
    updateNode(ctx, 'test', a3.id, { label: 'ops' });
    updateNode(ctx, 'test', s3.id, { label: 'integration' });
    handleHookEvent(ctx, 's1', start());
    setQueue(ctx, 'scribe:s1', project.slug, [a3.id], { sessionId: 's1' });
    const lines = handleHookEvent(ctx, 's1', start()).context!.split('\n');
    expect(lines).toContain(`      #${a2.id} ⧉ Play app signing — active`);
    expect(lines).toContain(`      #${a3.id} ⚒ Run signing tests — NEEDS YOU`);
    expect(lines.find((l) => l.trim().startsWith('Next:'))?.trim()).toMatch(new RegExp(`^Next: #${s3.id} ⇄ 3 RevenueCat · #\\d+ 4 Build to GitHub`));
    expect(lines).toContain(`Up next (you, A): #${a3.id} ⚒ Run signing tests`);
    expect(lines).toContain(`Needs you (1): #${a3.id} ⚒ Run signing tests`);
  });

  it('lists the label set and the picking rule once in the update rules', () => {
    const rules = updateRules({ home: 'C:/Users/me/.inprogress', sessionId: 's1' }).join('\n');
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

describe('session slots', () => {
  const HOUR = 60 * 60 * 1000;

  /** InGame bound to C:/personal/InGame and Other to C:/personal/Other, with a clock the test moves by hand. */
  function slots() {
    let now = Date.parse('2026-10-04T09:00:00.000Z');
    const ctx = createCtx(openDb(':memory:'), () => new Date(now).toISOString());
    const project = createProject(ctx, 'test', { name: 'InGame' });
    addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
    const other = createProject(ctx, 'test', { name: 'Other' });
    addBinding(ctx, 'test', other.slug, 'C:/personal/Other');
    const slot = (id: string) => findSession(ctx, id)?.slot;
    return { ctx, project, other, slot, tick: (ms: number) => (now += ms) };
  }
  const here = () => start('C:/personal/InGame');

  it('gives a new session the lowest slot no other live session of its project holds', () => {
    const { ctx, slot } = slots();
    handleHookEvent(ctx, 's1', here());
    // A missed start: the first prompt begins tracking, and takes a slot the same way.
    handleHookEvent(ctx, 's2', { event: 'prompt', cwd: 'C:/personal/InGame' });
    handleHookEvent(ctx, 'o1', start('C:/personal/Other'));
    expect([slot('s1'), slot('s2'), slot('o1')]).toEqual([0, 1, 0]);
  });

  it('gives a session that enrollSession creates the lowest free slot too', () => {
    const { ctx, project, slot } = slots();
    handleHookEvent(ctx, 's1', here());
    expect(enrollSession(ctx, 'scribe:e1', 'e1', project.slug).session.slot).toBe(1);
    expect(slot('e1')).toBe(1);
  });

  it("never gives two live sessions one slot, and frees an ended session's slot", () => {
    const { ctx, project, slot } = slots();
    for (const id of ['s1', 's2', 's3']) handleHookEvent(ctx, id, here());
    expect([slot('s1'), slot('s2'), slot('s3')]).toEqual([0, 1, 2]);
    handleHookEvent(ctx, 's2', { event: 'end' });
    handleHookEvent(ctx, 's4', here());
    handleHookEvent(ctx, 's5', here());
    expect([slot('s1'), slot('s3'), slot('s4'), slot('s5')]).toEqual([0, 2, 1, 3]);
    const live = getProjectSnapshot(ctx, project.slug).sessions.map((s) => s.slot);
    expect(new Set(live).size).toBe(live.length);
  });

  it('frees the slot of a session idle past the stale limit, before expiry has marked it ended', () => {
    const { ctx, slot, tick } = slots();
    handleHookEvent(ctx, 's1', here());
    tick(12 * HOUR + 60_000);
    // Still idle when s2 arrives: only a snapshot read (here, s2's briefing, after its write) marks it ended.
    expect(findSession(ctx, 's1')?.state).toBe('idle');
    handleHookEvent(ctx, 's2', here());
    expect(slot('s2')).toBe(0);
    // Back, s1 finds its slot taken and takes the lowest free one.
    handleHookEvent(ctx, 's1', { event: 'prompt' });
    expect([slot('s1'), slot('s2')]).toEqual([1, 0]);
  });

  it("keeps a revived session's slot while it is free, and reassigns it when another live session holds it", () => {
    const { ctx, slot } = slots();
    handleHookEvent(ctx, 's1', here());
    handleHookEvent(ctx, 's2', here());
    handleHookEvent(ctx, 's1', { event: 'end' });
    handleHookEvent(ctx, 's2', { event: 'end' });
    // Slot 0 is free too, but s2 keeps its own.
    handleHookEvent(ctx, 's2', { event: 'prompt' });
    expect(slot('s2')).toBe(1);
    handleHookEvent(ctx, 's3', here());
    expect(slot('s3')).toBe(0);
    handleHookEvent(ctx, 's1', { event: 'start', source: 'resume', cwd: 'C:/personal/InGame' });
    expect([slot('s1'), slot('s2'), slot('s3')]).toEqual([2, 1, 0]);
  });

  it('gives a session enrollSession repoints the lowest free slot in its new project', () => {
    const { ctx, other, slot } = slots();
    handleHookEvent(ctx, 's1', here());
    handleHookEvent(ctx, 's2', here());
    handleHookEvent(ctx, 'o1', start('C:/personal/Other'));
    expect(enrollSession(ctx, 'scribe:s2', 's2', other.slug).session.slot).toBe(1);
    expect(enrollSession(ctx, 'scribe:s1', 's1', other.slug).session.slot).toBe(2);
    handleHookEvent(ctx, 's3', here());
    expect([slot('o1'), slot('s3')]).toEqual([0, 0]);
  });

  it('fills a null slot (a session from before migration 4) on its next hook event or enroll, and tells the UI', () => {
    const { ctx, project, slot } = slots();
    handleHookEvent(ctx, 's1', here());
    handleHookEvent(ctx, 's2', here());
    ctx.db.prepare('UPDATE sessions SET slot = NULL').run();
    const mark = maxEventId(ctx);
    // A stop on an idle session changes nothing else: the event is the slot's alone.
    handleHookEvent(ctx, 's1', { event: 'stop' });
    expect(slot('s1')).toBe(0);
    expect(listEventsSince(ctx, mark)).toMatchObject([{ type: 'session.updated', entityId: 's1', data: { changed: ['slot'] } }]);
    expect(enrollSession(ctx, 'scribe:s2', 's2', project.slug).session.slot).toBe(1);
  });

  it('leaves an ended session out: enrolling it neither revives it nor takes a slot from a live one', () => {
    const { ctx, project, slot } = slots();
    handleHookEvent(ctx, 's1', here());
    handleHookEvent(ctx, 's1', { event: 'end' });
    handleHookEvent(ctx, 's2', here());
    expect(enrollSession(ctx, 'scribe:s1', 's1', project.slug).session).toMatchObject({ state: 'ended', slot: 0 });
    expect(slot('s2')).toBe(0);
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
