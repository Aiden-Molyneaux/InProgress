import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LABEL_GLYPHS, NODE_LABELS } from '../../src/core/types';
import { homeDir } from '../../src/lib/home';
import { normalizePath } from '../../src/lib/paths';
import { updateRules } from '../../src/server/briefing';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addLog } from '../../src/server/repo/logs';
import { addNodes, listNodes, updateNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, setQueue, updateProject } from '../../src/server/repo/projects';
import { addResource } from '../../src/server/repo/resources';
import { briefingDue, findSession, listProjectSessions } from '../../src/server/repo/sessions';
import { getNodeDetail, getProjectSnapshot } from '../../src/server/repo/snapshot';
import { renderBriefing } from '../../src/server/briefing';
import { enrollSession, handleHookEvent, setFocus } from '../../src/server/session-flow';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { openDb } from '../../src/server/db/connection';
import { makeCtx } from '../helpers';

function setup(ctx: Ctx = makeCtx()) {
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
    expect(text).toContain('at most once per turn, every change batched');
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
    expect(text).toContain(`Chat-only content is first written to ${homeDir().replace(/\\/g, '/')}/resources/<slug>/<yyyy-mm-dd>-<kebab-title>.md.`);
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
    const lines = renderBriefing(getProjectSnapshot(ctx, project.slug), 's1', Date.parse(ctx.now()), { checkOld: true }).split('\n');
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

  it('carries the live-work rules: #id on subagents and tasks, the task tools, both orders, new requests', () => {
    const rules = updateRules({ home: 'C:/Users/me/.inprogress', sessionId: 's1' }).join('\n');
    expect(rules).toContain('"queue: #a, #b" is yours, "later: #c, #d" unowned');
    expect(rules).toContain('a request with a deliverable arrives (a new step with one label:');
    expect(rules).toContain("Start an Agent description with its step's #id.");
    expect(rules).toContain("TaskCreate/TaskUpdate mirror on their own; start a task's subject with #id when its step is not your focus.");
  });

  it('writes out the tasks command with this session\'s id, to run in the Bash tool where the task tools are absent', () => {
    const cli = 'C:\\personal\\InProgress\\dist\\cli\\main.js';
    const rules = updateRules({ home: 'C:/Users/me/.inprogress', sessionId: 'abc-123', cli });
    const line = rules.find((l) => l.startsWith('- Working tasks'))!;
    expect(line).toContain('Without those tools, after each change run in the Bash tool: `node C:/personal/InProgress/dist/cli/main.js tasks <step id> --session abc-123 --done "…" --doing "…" --todo "…"`');
    expect(line).toContain('(no flags clears the list; no step id uses your focus)');
    expect(line).toContain('No double quotes in subjects; single-quote one with $ or a backtick.');
    // The scribe's old fallback is gone, and nothing prints a step as "tasks #…": an unquoted # starts a comment.
    expect(rules.join('\n')).not.toContain('tasks on #');
    expect(rules.join('\n')).not.toMatch(/tasks #/);
    // The scribe line names the one exception.
    expect(rules[1]).toMatch(/^- Brief the inprogress-scribe agent .*Never edit the tree another way, except tasks below\.$/);
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
    const lines = renderBriefing(getProjectSnapshot(ctx, project.slug), 's2', Date.parse(ctx.now()), { checkOld: true }).split('\n');
    expect(lines[0]).toMatch(/Session id: s2\.$/);
    expect(lines).toContain('Other sessions here: "Launch status" (idle)');
  });
});

describe('briefing: type labels', () => {
  it('prints the glyph before the title on node lines, Next and Needs you', () => {
    const { ctx, project, a2, a3 } = setup();
    const [s3] = listNodes(ctx, project.id).filter((n) => n.title === '3 RevenueCat');
    updateNode(ctx, 'test', a2.id, { label: 'ui' });
    updateNode(ctx, 'test', a3.id, { label: 'ops' });
    updateNode(ctx, 'test', s3.id, { label: 'integration' });
    const lines = handleHookEvent(ctx, 's1', start()).context!.split('\n');
    expect(lines).toContain(`      #${a2.id} ⧉ Play app signing — active`);
    expect(lines).toContain(`      #${a3.id} ⚒ Run signing tests — NEEDS YOU`);
    expect(lines.find((l) => l.trim().startsWith('Next:'))?.trim()).toMatch(new RegExp(`^Next: #${s3.id} ⇄ 3 RevenueCat · #\\d+ 4 Build to GitHub`));
    expect(lines).toContain(`Needs you (1): #${a3.id} ⚒ Run signing tests`);
  });

  it('prints the glyph before the title on the Up next line', () => {
    const { ctx, project, a3 } = setup();
    updateNode(ctx, 'test', a3.id, { label: 'ops' });
    handleHookEvent(ctx, 's1', start());
    setQueue(ctx, 'scribe:s1', project.slug, [a3.id], { sessionId: 's1' });
    expect(handleHookEvent(ctx, 's1', start()).context!.split('\n')).toContain(`Up next (you, A): #${a3.id} ⚒ Run signing tests`);
  });

  it('names the labels as words, once, inside the checkpoint bullet, with no glyph list', () => {
    const rules = updateRules({ home: 'C:/Users/me/.inprogress', sessionId: 's1' });
    const text = rules.join('\n');
    expect(rules.find((l) => l.startsWith('- Brief when:'))).toContain(`(a new step with one label: ${NODE_LABELS.join(', ')})`);
    expect(text.split(NODE_LABELS.join(', '))).toHaveLength(2);
    for (const glyph of Object.values(LABEL_GLYPHS)) expect(text, glyph).not.toContain(glyph);
  });
});

describe('briefing: the rules block', () => {
  /** Real-length values: a Claude Code session id (a UUID), the deployed CLI and Aiden's data dir. */
  const real = { home: 'C:/Users/aiden.molyneaux/.inprogress', sessionId: '0f8c2a4e-5b7d-4c1e-9a3f-6d2b8e1c7a90', cli: 'C:/personal/InProgress/dist/cli/main.js' };

  it('fits in 1,600 characters with real-length values and the tasks command written out in full', () => {
    expect(real.sessionId).toHaveLength(36);
    const text = updateRules(real).join('\n');
    expect(text.length).toBeLessThanOrEqual(1600);
    expect(text).toContain(`\`node C:/personal/InProgress/dist/cli/main.js tasks <step id> --session ${real.sessionId} --done "…" --doing "…" --todo "…"\``);
  });

  it('keeps every clause, under a header', () => {
    const rules = updateRules(real);
    expect(rules[0]).toBe('Keeping InProgress current (Aiden watches it live):');
    expect(rules.slice(1).every((l) => l.startsWith('- '))).toBe(true);
    const text = rules.join('\n');
    const clauses = [
      // Who to brief, how, how often, and the one exception.
      'Brief the inprogress-scribe agent (Agent tool, subagent_type "inprogress-scribe", background)',
      'at most once per turn, every change batched',
      'Never edit the tree another way, except tasks below.',
      // The checkpoints, with the labels and both orders (later: is Aiden's §8 clause).
      'a request with a deliverable arrives (a new step with one label:',
      'the plan or an order changes ("queue: #a, #b" is yours, "later: #c, #d" unowned)',
      'a step starts ("focus → #id"), finishes ("#id → done; outcome …") or blocks',
      'something goes to Aiden (assignee me) or he answers',
      'Steps are plan-level with outcomes. Detours go in "log on #id: …".',
      'Something worth finding again is a resource: "resource on #id: <kind> "<title>", path <file>, snapshot_file".',
      'Chat-only content is first written to C:/Users/aiden.molyneaux/.inprogress/resources/<slug>/<yyyy-mm-dd>-<kebab-title>.md.',
      // Working tasks: the subject #id (Aiden's §8 clause), the Bash tool (ruling 32), the usage note, quoting (ruling 31).
      "TaskCreate/TaskUpdate mirror on their own; start a task's subject with #id when its step is not your focus.",
      'after each change run in the Bash tool:',
      'no step id uses your focus',
      'No double quotes in subjects',
      "Start an Agent description with its step's #id.",
      // After a brief.
      'After a brief, one line in chat ("↳ InProgress: #57 done").',
      "The scribe's notice needs no reply.",
      'Brief header: "Session: <id> · Project: <slug>". Full format: the inprogress skill.',
    ];
    for (const clause of clauses) expect(text, clause).toContain(clause);
  });

  it('leaves questions, relabelling and backtracking to the skill', () => {
    const text = updateRules(real).join('\n');
    expect(text).not.toMatch(/question|relabel|dropped|backtrack/i);
  });

  it('says on line 2 that plan edits go through the scribe, the rules below are complete, and what the skill is for', () => {
    const { ctx, project } = setup();
    const line2 = 'Plan edits go through the inprogress-scribe agent in the background (working tasks excepted, below). The rules below are complete; the inprogress skill is for opt-in, adoption and the full brief format.';
    expect(handleHookEvent(ctx, 's1', start()).context!.split('\n')[1]).toBe(line2);
    expect(enrollSession(ctx, 'scribe:e1', 'e1', project.slug).briefing.split('\n')[1]).toBe(line2);
    expect(handleHookEvent(ctx, 's1', start()).context).not.toContain('follow the inprogress skill');
  });
});

describe('briefing: needs-you ages and the check line', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const CHECK = 'Check with Aiden whether these are already done, then brief the answer (a "not yet" goes in "log on #id: …"): ';

  /** setup()'s project on a clock the test moves by hand: nothing ages unless it does. */
  function clocked() {
    let now = Date.parse('2026-10-01T09:00:00.000Z');
    const t = setup(createCtx(openDb(':memory:'), () => new Date(now).toISOString()));
    return { ...t, tick: (ms: number) => (now += ms) };
  }
  const lineOf = (text: string, head: string) => text.split('\n').find((l) => l.startsWith(head));
  const briefing = (ctx: Ctx, session = 's1') => handleHookEvent(ctx, session, start()).context!;
  const statusAnswer = (ctx: Ctx) => handleHookEvent(ctx, 's1', { event: 'prompt', asksStatus: true }).context!;

  it('gives each needs-you entry its age from its last update, in the briefing and the status answer', () => {
    const { ctx, road, a3, tick } = clocked();
    const [q] = addNodes(ctx, 'test', { parentId: road.id, nodes: [{ title: 'Pick a price', kind: 'question', assignee: 'me' }] });
    handleHookEvent(ctx, 's1', start());
    tick(DAY - HOUR);
    expect(lineOf(briefing(ctx), 'Needs you')).toBe(`Needs you (2): #${a3.id} Run signing tests · #${q.id} Pick a price (question)`);
    tick(5 * DAY);
    expect(lineOf(briefing(ctx), 'Needs you')).toBe(`Needs you (2): #${a3.id} Run signing tests (5d) · #${q.id} Pick a price (question) (5d)`);
    // A log entry leaves the age counting; a patch starts it again.
    addLog(ctx, 'scribe:s1', a3.id, 'Not yet: Aiden runs them on Monday.');
    updateNode(ctx, 'scribe:s1', q.id, { body: 'Monthly or yearly?' });
    const expected = `Needs you (2): #${a3.id} Run signing tests (5d) · #${q.id} Pick a price (question)`;
    expect(lineOf(briefing(ctx), 'Needs you')).toBe(expected);
    tick(9 * DAY);
    expect(lineOf(statusAnswer(ctx), 'Needs you')).toBe(`Needs you (2): #${a3.id} Run signing tests (2w) · #${q.id} Pick a price (question) (9d)`);
  });

  it('asks, on the line after Needs you, to check every item older than three days, in needs-you order', () => {
    const { ctx, road, a3, tick } = clocked();
    const [fresh, q] = addNodes(ctx, 'test', { parentId: road.id, nodes: [{ title: 'Sign the contract', assignee: 'me' }, { title: 'Pick a price', kind: 'question', assignee: 'me' }] });
    handleHookEvent(ctx, 's1', start());
    tick(3 * DAY);
    // Three days to the millisecond is not older than three days.
    expect(briefing(ctx)).not.toContain('Check with Aiden');
    tick(1);
    updateNode(ctx, 'test', fresh.id, { status: 'blocked' });
    const lines = briefing(ctx).split('\n');
    const at = lines.findIndex((l) => l.startsWith('Needs you (3)'));
    expect(lines[at + 1]).toBe(`${CHECK}#${a3.id}, #${q.id}.`);
    expect(lines.filter((l) => l.startsWith('Check with Aiden'))).toHaveLength(1);
  });

  it('names at most eight, then +n more, drawing from every needs-you item, not only the eight the line shows', () => {
    const { ctx, road, a3, tick } = clocked();
    const more = addNodes(ctx, 'test', { parentId: road.id, nodes: Array.from({ length: 10 }, (_, i) => ({ title: `Ask ${i + 1}`, assignee: 'me' as const })) });
    handleHookEvent(ctx, 's1', start());
    tick(4 * DAY);
    const needs = [a3, ...more];
    expect(lineOf(briefing(ctx), 'Check with Aiden')).toBe(`${CHECK}${needs.slice(0, 8).map((n) => `#${n.id}`).join(', ')}, +3 more.`);
    // The first eight change today: the line names the three the needs-you line leaves out.
    for (const n of needs.slice(0, 8)) updateNode(ctx, 'test', n.id, { outcome: 'Asked again' });
    const text = briefing(ctx);
    expect(lineOf(text, 'Needs you')).toMatch(/ · \+3 more$/);
    expect(lineOf(text, 'Check with Aiden')).toBe(`${CHECK}${needs.slice(8).map((n) => `#${n.id}`).join(', ')}.`);
  });

  it('leaves the check line out only after a compaction: startup, resume, clear, no source, another source, a missed start and enroll print it', () => {
    const { ctx, project, a3, tick } = clocked();
    handleHookEvent(ctx, 's1', start());
    tick(4 * DAY);
    const line = `${CHECK}#${a3.id}.`;
    for (const source of ['startup', 'resume', 'clear', undefined, 'mystery']) {
      expect(handleHookEvent(ctx, 's1', { event: 'start', source, cwd: 'C:/personal/InGame' }).context!.split('\n'), `source ${source}`).toContain(line);
    }
    expect(handleHookEvent(ctx, 's1', { event: 'start', source: 'compact', cwd: 'C:/personal/InGame' }).context).not.toContain('Check with Aiden');
    // A first prompt that begins tracking after a missed start, and an enroll, are fresh briefings too.
    expect(handleHookEvent(ctx, 'p1', { event: 'prompt', cwd: 'C:/personal/InGame' }).context!.split('\n')).toContain(line);
    expect(enrollSession(ctx, 'scribe:e1', 'e1', project.slug).briefing.split('\n')).toContain(line);
    // The status answer shows the ages, never the line.
    const answer = statusAnswer(ctx);
    expect(answer).toContain(`Needs you (1): #${a3.id} Run signing tests (4d)`);
    expect(answer).not.toContain('Check with Aiden');
  });
});

describe('briefing: one answer to "what\'s next"', () => {
  const brief = (ctx: Ctx, session = 's1') => handleHookEvent(ctx, session, start()).context!;
  const statusAnswer = (ctx: Ctx, session = 's1') => handleHookEvent(ctx, session, { event: 'prompt', asksStatus: true }).context!;
  const nextLines = (text: string) => text.split('\n').filter((l) => l.trim().startsWith('Next:'));
  const step = (ctx: Ctx, projectId: number, title: string) => listNodes(ctx, projectId).find((n) => n.title === title)!;

  it('no Next: line when an Up next line prints, in the briefing and the status answer', () => {
    const { ctx, project } = setup();
    handleHookEvent(ctx, 's1', start());
    expect(nextLines(brief(ctx))).toHaveLength(1);
    expect(nextLines(statusAnswer(ctx))).toHaveLength(1);
    const s4 = step(ctx, project.id, '4 Build to GitHub');
    setQueue(ctx, 'scribe:s1', project.slug, [s4.id], { sessionId: 's1' });
    for (const text of [brief(ctx), statusAnswer(ctx)]) {
      expect(text).toContain(`\nUp next (you, A): #${s4.id} 4 Build to GitHub`);
      expect(nextLines(text)).toEqual([]);
    }
  });

  it("no Next: line either when the Up next line holds only another session's steps or unowned ones", () => {
    const { ctx, project } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's2', start());
    const [s4, s5] = [step(ctx, project.id, '4 Build to GitHub'), step(ctx, project.id, '5 Store listing')];
    setQueue(ctx, 'scribe:s2', project.slug, [s4.id], { sessionId: 's2' });
    let text = brief(ctx);
    expect(text).toContain(`\nUp next: B: #${s4.id}\n`);
    expect(nextLines(text)).toEqual([]);
    setQueue(ctx, 'scribe:s2', project.slug, [], { sessionId: 's2' });
    setQueue(ctx, 'scribe:s1', project.slug, [s5.id], 'unowned');
    text = statusAnswer(ctx);
    expect(text).toContain(`\nUp next: later: #${s5.id}`);
    expect(nextLines(text)).toEqual([]);
  });

  it("keeps the Next: line when the queue's only entry is the reader's own focus, so no Up next line prints", () => {
    const { ctx, project, a2 } = setup();
    handleHookEvent(ctx, 's1', start());
    setFocus(ctx, 'scribe:s1', 's1', a2.id);
    setQueue(ctx, 'scribe:s1', project.slug, [a2.id], { sessionId: 's1' });
    expect(getProjectSnapshot(ctx, project.slug).project.queue).toHaveLength(1);
    for (const text of [brief(ctx), statusAnswer(ctx)]) {
      expect(text).not.toContain('Up next');
      expect(nextLines(text).map((l) => l.trim())).toEqual([expect.stringMatching(/^Next: #\d+ 3 RevenueCat · #\d+ 4 Build to GitHub \(\+3 more\)$/)]);
    }
  });
});

describe('briefing: recently done and left unfinished', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  /** setup()'s project on a clock the test moves by hand, so each finish gets its own time. */
  function clocked() {
    let now = Date.parse('2026-10-01T09:00:00.000Z');
    const t = setup(createCtx(openDb(':memory:'), () => new Date(now).toISOString()));
    const step = (title: string) => listNodes(t.ctx, t.project.id).find((n) => n.title === title)!;
    return { ...t, step, tick: (ms: number) => (now += ms) };
  }
  const brief = (ctx: Ctx, session = 's1') => handleHookEvent(ctx, session, start()).context!;
  const lineOf = (text: string, head: string) => text.split('\n').find((l) => l.startsWith(head));
  const statusAnswer = (ctx: Ctx) => handleHookEvent(ctx, 's1', { event: 'prompt', asksStatus: true }).context!;

  it('names the two steps finished last, each with its glyph and quoted outcome, a step with no outcome bare', () => {
    const { ctx, a1, a2, tick } = clocked();
    tick(HOUR);
    updateNode(ctx, 'test', a2.id, { status: 'done', outcome: 'Signing configured in Play Console', label: 'docs' });
    // a1 and 1 iOS certificate finished in one call, so at one time: the newer id comes first. a1 has no outcome.
    expect(lineOf(brief(ctx), 'Recently done')).toBe(`Recently done: #${a2.id} ¶ Play app signing — "Signing configured in Play Console" · #${a1.id} Upload keystore`);
    expect(statusAnswer(ctx)).not.toContain('Recently done');
  });

  it('breaks a tie in finish time by id, the newer first', () => {
    const { ctx, s1, a1 } = clocked();
    updateNode(ctx, 'test', s1.id, { outcome: 'Certificate in the keychain' });
    expect(lineOf(brief(ctx), 'Recently done')).toBe(`Recently done: #${a1.id} Upload keystore · #${s1.id} 1 iOS certificate — "Certificate in the keychain"`);
  });

  it('clips an outcome to 80 characters with the … inside them, on one line', () => {
    const { ctx, step, tick } = clocked();
    const [s3, s4] = [step('3 RevenueCat'), step('4 Build to GitHub')];
    tick(HOUR);
    updateNode(ctx, 'test', s3.id, { status: 'done', outcome: 'y'.repeat(80) });
    tick(HOUR);
    const long = `Builds on push.\n\nThe workflow ${'x'.repeat(100)}`;
    updateNode(ctx, 'test', s4.id, { status: 'done', outcome: long });
    const clipped = `${`Builds on push. The workflow ${'x'.repeat(100)}`.slice(0, 79)}…`;
    expect(clipped).toHaveLength(80);
    expect(lineOf(brief(ctx), 'Recently done')).toBe(`Recently done: #${s4.id} 4 Build to GitHub — "${clipped}" · #${s3.id} 3 RevenueCat — "${'y'.repeat(80)}"`);
  });

  it('never names a dropped step, and leaves the line out when nothing is done', () => {
    const { ctx, s1, a1, a2, tick } = clocked();
    tick(HOUR);
    updateNode(ctx, 'test', a2.id, { status: 'dropped', outcome: 'Not needed after all' });
    updateNode(ctx, 'test', s1.id, { status: 'active' });
    expect(lineOf(brief(ctx), 'Recently done')).toBe(`Recently done: #${a1.id} Upload keystore`);
    updateNode(ctx, 'test', a1.id, { status: 'todo' });
    expect(brief(ctx)).not.toContain('Recently done');
  });

  it('names the open tasks an ended session left on open steps, its subagents\' too, by step in tree order, three at most', () => {
    const { ctx, a1, a2, step } = clocked();
    const [s3, s4, s5] = [step('3 RevenueCat'), step('4 Build to GitHub'), step('5 Store listing')];
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'task-created', taskKey: '1', subject: 'Still mine' });
    handleHookEvent(ctx, 's2', start());
    setFocus(ctx, 'scribe:s2', 's2', s3.id);
    const task = (key: string, subject: string, agentId?: string) => handleHookEvent(ctx, 's2', { event: 'task-created', taskKey: key, subject, agentId });
    task('1', 'Wire the paywall');
    task('2', `#${a2.id} Check the upload key`);
    task('3', 'Finished already');
    handleHookEvent(ctx, 's2', { event: 'task-updated', taskKey: '3', status: 'completed' });
    task('4', `#${a1.id} On a finished step`);
    task('5', `#${s5.id} On a dropped step`);
    task('6', `#${s4.id} Fourth in tree order`);
    handleHookEvent(ctx, 's2', { event: 'subagent-start', agentId: 'g1', agentType: 'general-purpose' });
    task('1', 'Price the tiers', 'g1');
    handleHookEvent(ctx, 's2', { event: 'task-updated', agentId: 'g1', taskKey: '1', status: 'in_progress' });
    updateNode(ctx, 'test', s5.id, { status: 'dropped' });
    // While s2 is live, nothing is left unfinished.
    expect(brief(ctx)).not.toContain('Left unfinished');
    handleHookEvent(ctx, 's2', { event: 'end' });
    // In progress first within a step, as under the focus.
    const expected = `Left unfinished by an earlier session: on #${a2.id}: "#${a2.id} Check the upload key" · on #${s3.id}: "Price the tiers", "Wire the paywall"`;
    expect(lineOf(brief(ctx), 'Left unfinished')).toBe(expected);
    expect(statusAnswer(ctx)).not.toContain('Left unfinished');
  });

  it('leaves the line out when no ended session left work, and once the 7-day trail has passed', () => {
    const { ctx, a2, tick } = clocked();
    handleHookEvent(ctx, 's1', start());
    expect(brief(ctx)).not.toContain('Left unfinished');
    handleHookEvent(ctx, 's2', start());
    setFocus(ctx, 'scribe:s2', 's2', a2.id);
    handleHookEvent(ctx, 's2', { event: 'task-created', taskKey: '1', subject: 'Review it' });
    handleHookEvent(ctx, 's2', { event: 'end' });
    tick(7 * DAY - 1);
    expect(lineOf(brief(ctx), 'Left unfinished')).toBe(`Left unfinished by an earlier session: on #${a2.id}: "Review it"`);
    tick(2);
    expect(brief(ctx)).not.toContain('Left unfinished');
  });

  it('places both after Needs you and its check line, Recently done first, before Recent resources', () => {
    const { ctx, a2, a3, tick } = clocked();
    addResource(ctx, 'test', { nodeId: a3.id, kind: 'doc', title: 'Notes', content: 'x' });
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's2', start());
    setFocus(ctx, 'scribe:s2', 's2', a2.id);
    handleHookEvent(ctx, 's2', { event: 'task-created', taskKey: '1', subject: 'Review it' });
    handleHookEvent(ctx, 's2', { event: 'end' });
    tick(4 * DAY);
    handleHookEvent(ctx, 's3', start());
    const heads = brief(ctx).split('\n').map((l) => /^(Where things stand|Needs you|Check with Aiden|Recently done|Left unfinished|Recent resources|Other sessions here)/.exec(l)?.[1]).filter(Boolean);
    expect(heads).toEqual(['Where things stand', 'Needs you', 'Check with Aiden', 'Recently done', 'Left unfinished', 'Recent resources', 'Other sessions here']);
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

  it("makes a todo step assigned to Claude active in the focus's own write, node.updated first", () => {
    const { ctx, project } = setup();
    const [s3] = listNodes(ctx, project.id).filter((n) => n.title === '3 RevenueCat');
    handleHookEvent(ctx, 's1', start());
    const mark = maxEventId(ctx);
    // Each event reaches the bus after the commit; by then the focus is saved too, so both changes are one write.
    const seen: string[] = [];
    ctx.bus.on('event', (e: { type: string }) => seen.push(`${e.type} focus=${findSession(ctx, 's1')?.focusNodeId} status=${listNodes(ctx, project.id).find((n) => n.id === s3.id)?.status}`));
    expect(setFocus(ctx, 'scribe:s1', 's1', s3.id).focusNodeId).toBe(s3.id);
    expect(listNodes(ctx, project.id).find((n) => n.id === s3.id)).toMatchObject({ status: 'active', completedAt: null });
    // node.updated before session.updated, so the activity strip's latest line reads "<session> is on #id".
    expect(listEventsSince(ctx, mark)).toMatchObject([
      { type: 'node.updated', actor: 'scribe:s1', entityId: String(s3.id), data: { changes: { status: { from: 'todo', to: 'active' } } } },
      { type: 'session.updated', actor: 'scribe:s1', entityId: 's1', data: { changed: ['focusNodeId'], focusNodeId: s3.id } },
    ]);
    expect(seen).toEqual([`node.updated focus=${s3.id} status=active`, `session.updated focus=${s3.id} status=active`]);
  });

  it('leaves a blocked, done, dropped, active or Aiden-assigned step as it is, with no node.updated', () => {
    const { ctx, project, road, a2, a3 } = setup();
    const [blocked, done, dropped] = addNodes(ctx, 'test', { parentId: road.id, nodes: [{ title: 'Blocked', status: 'blocked' }, { title: 'Done', status: 'done' }, { title: 'Dropped', status: 'dropped' }] });
    handleHookEvent(ctx, 's1', start());
    const status = (id: number) => listNodes(ctx, project.id).find((n) => n.id === id)?.status;
    const before = [blocked, done, dropped, a2, a3].map((n) => [n.id, status(n.id)]);
    const mark = maxEventId(ctx);
    for (const n of [blocked, done, dropped, a2, a3]) setFocus(ctx, 'scribe:s1', 's1', n.id);
    setFocus(ctx, 'scribe:s1', 's1', null);
    expect([blocked, done, dropped, a2, a3].map((n) => [n.id, status(n.id)])).toEqual(before);
    expect(before.map(([, s]) => s)).toEqual(['blocked', 'done', 'dropped', 'active', 'todo']);
    expect(listEventsSince(ctx, mark).map((e) => e.type)).toEqual(Array(6).fill('session.updated'));
  });

  it('promotes the step it focuses only once: focusing it again changes nothing more', () => {
    const { ctx, project } = setup();
    const [s3] = listNodes(ctx, project.id).filter((n) => n.title === '3 RevenueCat');
    handleHookEvent(ctx, 's1', start());
    setFocus(ctx, 'scribe:s1', 's1', s3.id);
    const mark = maxEventId(ctx);
    setFocus(ctx, 'scribe:s1', 's1', s3.id);
    expect(listEventsSince(ctx, mark).map((e) => e.type)).toEqual(['session.updated']);
  });
});

describe('the full briefing on the first tracked prompt after an enroll', () => {
  const FULL = 'This session is tracked in project';
  const prompt = (extra = {}) => ({ event: 'prompt' as const, ...extra });

  /** InGame bound to C:/personal/InGame and Other to C:/personal/Other, with a clock the test moves by hand. */
  function projects() {
    let now = Date.parse('2026-10-04T09:00:00.000Z');
    const t = setup(createCtx(openDb(':memory:'), () => new Date(now).toISOString()));
    const other = createProject(t.ctx, 'test', { name: 'Other' });
    addBinding(t.ctx, 'test', other.slug, 'C:/personal/Other');
    return { ...t, other, tick: (ms: number) => (now += ms) };
  }

  it('delivers it once, on the next prompt of a session the scribe enrolled, and still returns it to the scribe', () => {
    const { ctx, project } = projects();
    expect(enrollSession(ctx, 'scribe:e1', 'e1', project.slug).briefing).toContain(`${FULL} "InGame"`);
    expect(briefingDue(ctx, 'e1')).toBe(true);
    const first = handleHookEvent(ctx, 'e1', prompt()).context!;
    expect(first.split('\n')[0]).toBe('[InProgress] This session is tracked in project "InGame" (slug ingame). Session id: e1. You are session A.');
    expect(first).toContain('Keeping InProgress current');
    expect(first).toContain('`node ');
    expect(briefingDue(ctx, 'e1')).toBe(false);
    // The next prompt is ordinary: the usual nudge, never a second briefing.
    const second = handleHookEvent(ctx, 'e1', prompt()).context!;
    expect(second).not.toContain(FULL);
    expect(second).toMatch(/^\[InProgress\] InGame · no focus set · 1 need you · last scribe update 2 prompts ago/);
  });

  it('answers a status question on that prompt with the briefing, which carries where things stand', () => {
    const { ctx, project } = projects();
    enrollSession(ctx, 'scribe:e1', 'e1', project.slug);
    const text = handleHookEvent(ctx, 'e1', prompt({ asksStatus: true })).context!;
    expect(text).toContain(FULL);
    expect(text).toContain('Where things stand:');
    expect(text).not.toContain('[InProgress] Where things stand in');
  });

  it('asks about old needs-you items in that briefing, as an enroll briefing does', () => {
    const { ctx, project, a3, tick } = projects();
    enrollSession(ctx, 'scribe:e1', 'e1', project.slug);
    tick(4 * 24 * 60 * 60 * 1000);
    expect(handleHookEvent(ctx, 'e1', prompt()).context!.split('\n')).toContain(`Check with Aiden whether these are already done, then brief the answer (a "not yet" goes in "log on #id: …"): #${a3.id}.`);
  });

  it('neither delivers nor clears it on a background-task notice: the next real prompt brings it', () => {
    const { ctx, project } = projects();
    enrollSession(ctx, 'scribe:e1', 'e1', project.slug);
    // The scribe's own enroll notice comes back as a notice.
    expect(handleHookEvent(ctx, 'e1', prompt({ notice: true })).context).toBeUndefined();
    expect(briefingDue(ctx, 'e1')).toBe(true);
    expect(handleHookEvent(ctx, 'e1', prompt()).context).toContain(FULL);
  });

  it('clears it on a start, whose own briefing is the full one, so the prompt after gets none', () => {
    const { ctx, project } = projects();
    enrollSession(ctx, 'scribe:e1', 'e1', project.slug);
    expect(handleHookEvent(ctx, 'e1', { event: 'start', source: 'compact', cwd: 'C:/elsewhere' }).context).toContain(FULL);
    expect(briefingDue(ctx, 'e1')).toBe(false);
    expect(handleHookEvent(ctx, 'e1', prompt()).context).toBeUndefined();
  });

  it('never marks a session the hook created, by a start or by a first prompt', () => {
    const { ctx } = projects();
    expect(handleHookEvent(ctx, 's1', start()).context).toContain(FULL);
    expect(handleHookEvent(ctx, 'p1', prompt({ cwd: 'C:/personal/InGame' })).context).toContain(FULL);
    expect([briefingDue(ctx, 's1'), briefingDue(ctx, 'p1')]).toEqual([false, false]);
    expect(handleHookEvent(ctx, 's1', prompt()).context).toBeUndefined();
    expect(handleHookEvent(ctx, 'p1', prompt()).context).not.toContain(FULL);
  });

  it('sets it again when an enroll repoints a session, which then gets the new project\'s briefing', () => {
    const { ctx, other } = projects();
    handleHookEvent(ctx, 'o1', start('C:/personal/Other'));
    enrollSession(ctx, 'scribe:s2', 's2', 'ingame');
    handleHookEvent(ctx, 's2', prompt());
    expect(briefingDue(ctx, 's2')).toBe(false);
    enrollSession(ctx, 'scribe:s2', 's2', other.slug);
    expect(briefingDue(ctx, 's2')).toBe(true);
    expect(handleHookEvent(ctx, 's2', prompt()).context!.split('\n')[0]).toMatch(/project "Other" \(slug other\)\. Session id: s2\. You are session B\.$/);
  });

  it('sets it when an enroll names an ended session, whose next prompt revives it with the briefing', () => {
    const { ctx, project } = projects();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'end' });
    expect(enrollSession(ctx, 'scribe:s1', 's1', project.slug).session.state).toBe('ended');
    expect(briefingDue(ctx, 's1')).toBe(true);
    const text = handleHookEvent(ctx, 's1', prompt()).context!;
    expect(text).toContain(FULL);
    expect(findSession(ctx, 's1')?.state).toBe('working');
  });

  it('leaves it as it is on a same-project re-enroll of a live session: set if still due, else unset', () => {
    const { ctx, project } = projects();
    handleHookEvent(ctx, 's1', start());
    enrollSession(ctx, 'scribe:s1', 's1', project.slug);
    expect(briefingDue(ctx, 's1')).toBe(false);
    expect(handleHookEvent(ctx, 's1', prompt()).context).toBeUndefined();
    enrollSession(ctx, 'scribe:e1', 'e1', project.slug);
    enrollSession(ctx, 'scribe:e1', 'e1', project.slug);
    expect(briefingDue(ctx, 'e1')).toBe(true);
  });

  it('sets it when a revival gives the session another letter, so the prompt brings "You are session B."', () => {
    const { ctx } = projects();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'end' });
    handleHookEvent(ctx, 's2', start());
    // Revived by a prompt into B, since s2 holds A: that prompt carries the briefing.
    const text = handleHookEvent(ctx, 's1', prompt()).context!;
    expect(text.split('\n')[0]).toMatch(/Session id: s1\. You are session B\.$/);
    expect(briefingDue(ctx, 's1')).toBe(false);
    expect(handleHookEvent(ctx, 's1', prompt()).context).not.toContain(FULL);
  });

  it('sets it on a revival into another letter by another event, for the next real prompt; keeping its letter sets nothing', () => {
    const { ctx } = projects();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'end' });
    handleHookEvent(ctx, 's2', start());
    handleHookEvent(ctx, 's1', { event: 'stop' });
    expect(briefingDue(ctx, 's1')).toBe(true);
    expect(handleHookEvent(ctx, 's1', prompt({ notice: true })).context).toBeUndefined();
    expect(handleHookEvent(ctx, 's1', prompt()).context).toMatch(/You are session B\.\n/);
    // s2 ends and comes back into its own free letter: no briefing owed.
    handleHookEvent(ctx, 's2', { event: 'end' });
    expect(handleHookEvent(ctx, 's2', prompt()).context).toBeUndefined();
    expect(findSession(ctx, 's2')?.slot).toBe(0);
    expect(briefingDue(ctx, 's2')).toBe(false);
  });

  it('leaves it unset on a revival by a start into another letter: the start carries the briefing', () => {
    const { ctx } = projects();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'end' });
    handleHookEvent(ctx, 's2', start());
    expect(handleHookEvent(ctx, 's1', { event: 'start', source: 'resume', cwd: 'C:/personal/InGame' }).context).toMatch(/You are session B\.\n/);
    expect(briefingDue(ctx, 's1')).toBe(false);
    expect(handleHookEvent(ctx, 's1', prompt()).context).toBeUndefined();
  });

  it('keeps it while the project is archived, and delivers it once the project is active again', () => {
    const { ctx, project } = projects();
    enrollSession(ctx, 'scribe:e1', 'e1', project.slug);
    updateProject(ctx, 'test', project.slug, { status: 'archived' });
    expect(handleHookEvent(ctx, 'e1', prompt())).toEqual({ tracked: false });
    expect(briefingDue(ctx, 'e1')).toBe(true);
    updateProject(ctx, 'test', project.slug, { status: 'active' });
    expect(handleHookEvent(ctx, 'e1', prompt()).context).toContain(FULL);
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
