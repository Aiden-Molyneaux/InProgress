import { describe, expect, it } from 'vitest';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { clearAsk, raiseAsk } from '../../src/server/repo/asks';
import { addNodes, findNode, updateNode } from '../../src/server/repo/nodes';
import { addBinding, changeProject, createProject, setQueue } from '../../src/server/repo/projects';
import { briefingDue, clearBriefingDue, findSession } from '../../src/server/repo/sessions';
import { claimStep, enrollSession, handleHookEvent, orchestrate, setFocus } from '../../src/server/session-flow';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { openDb } from '../../src/server/db/connection';
import { STALE_SESSION_MS } from '../../src/core/types';
import { makeCtx } from '../helpers';

function setup(ctx: Ctx = makeCtx()) {
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [group] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Group', status: 'active' }] });
  const [step, other, third] = addNodes(ctx, 'test', { parentId: group.id, nodes: [{ title: 'Build tabs' }, { title: 'Write guide' }, { title: 'Third' }] });
  const join = (id: string) => {
    enrollSession(ctx, `scribe:${id}`, id, project.slug);
    clearBriefingDue(ctx, id);
  };
  return { ctx, project, group, step, other, third, join };
}

describe('claimStep', () => {
  it('makes a todo step active, sets the role to worker, returns the block, and marks no briefing due', () => {
    const { ctx, project, step, join } = setup();
    join('s1');
    ctx.db.prepare("UPDATE sessions SET role = 'orchestrator' WHERE id = 's1'").run();
    setQueue(ctx, 'scribe:s1', project.slug, [step.id], 'unowned');
    const mark = maxEventId(ctx);
    const r = claimStep(ctx, 'session:s1', 's1', step.id);
    expect(r.notes).toEqual([`You drive #${step.id}.`]);
    expect(r.session).toMatchObject({ focusNodeId: step.id, role: 'worker' });
    expect(r.block[0]).toMatch(/^Your step: #\d+ InGame › #\d+ Group$/);
    expect(r.block[1]).toBe(`  #${step.id} Build tabs · active`);
    expect(ctx.db.prepare('SELECT status FROM nodes WHERE id = ?').get(step.id)).toEqual({ status: 'active' });
    expect(briefingDue(ctx, 's1')).toBe(false);
    const changed = listEventsSince(ctx, mark).filter((e) => e.type === 'session.updated').map((e) => (e.data as { changed: string[] }).changed);
    expect(changed).toEqual([['role'], ['focusNodeId']]);
  });

  it('records no role change for a worker that stays a worker', () => {
    const { ctx, step, join } = setup();
    join('s1');
    const mark = maxEventId(ctx);
    claimStep(ctx, 'session:s1', 's1', step.id);
    expect(listEventsSince(ctx, mark).filter((e) => e.type === 'session.updated').map((e) => (e.data as { changed: string[] }).changed)).toEqual([['focusNodeId']]);
  });

  it('notes a step outside Next, an open ask, and another live session on it, and claims anyway', () => {
    const { ctx, project, step, other, join } = setup();
    join('s1');
    join('s2');
    setFocus(ctx, 'scribe:s2', 's2', other.id);
    raiseAsk(ctx, 'test', { nodeId: other.id, kind: 'question', text: 'Which tool?' });
    ctx.db.prepare("UPDATE sessions SET title = 'Guide writer' WHERE id = 's2'").run();
    const r = claimStep(ctx, 'session:s1', 's1', other.id);
    // s2's set_focus made it the driver, so the driver note names it and the "also claimed" note for it is skipped.
    expect(r.notes).toEqual([`Note: #${other.id} has open ask a1.`, `B drives #${other.id}; you are helping. Pass --take-over to drive.`]);
    expect(findSession(ctx, 's1')?.focusNodeId).toBe(other.id);
    // A step that is not in Next at all, and not on any session.
    expect(claimStep(ctx, 'session:s1', 's1', step.id).notes).toEqual([`Note: #${step.id} is not in Next.`, `You drive #${step.id}.`]);
    // A third session on a step with a driver and a helper hears of the helper, and of the driver once.
    join('s3');
    claimStep(ctx, 'session:s2', 's2', step.id);
    expect(claimStep(ctx, 'session:s3', 's3', step.id).notes).toEqual([
      `Note: #${step.id} is also claimed by B "Guide writer" (working).`,
      `A drives #${step.id}; you are helping. Pass --take-over to drive.`,
    ]);
    // Once it is queued, the note goes.
    setQueue(ctx, 'scribe:s1', project.slug, [other.id], 'unowned');
    expect(claimStep(ctx, 'session:s1', 's1', other.id).notes.some((n) => n.includes('not in Next'))).toBe(false);
  });

  it("refuses another project's step with the hint, and an untracked session", () => {
    const { ctx, join } = setup();
    join('s1');
    const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
    const [foreign] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Foreign' }] });
    expect(() => claimStep(ctx, 'session:s1', 's1', foreign.id)).toThrow(/is not in this session's project/);
    expect(() => claimStep(ctx, 'session:ghost', 'ghost', foreign.id)).toThrow(/is not tracked/);
    expect(findSession(ctx, 's1')?.focusNodeId).toBeNull();
  });
});

describe('the driver', () => {
  const driver = (ctx: Ctx, id: number) => findNode(ctx, id)!.driverSessionId;
  /** setup() on a clock the test moves by hand. */
  function clocked() {
    let now = Date.parse('2026-10-01T09:00:00.000Z');
    const t = setup(createCtx(openDb(':memory:'), () => new Date(now).toISOString()));
    return { ...t, tick: (ms: number) => (now += ms) };
  }

  it('claims a step with no driver and drives it', () => {
    const { ctx, step, join } = setup();
    join('s1');
    const r = claimStep(ctx, 'session:s1', 's1', step.id);
    expect(driver(ctx, step.id)).toBe('s1');
    expect(r.notes).toContain(`You drive #${step.id}.`);
  });

  it('a second claim joins as a helper', () => {
    const { ctx, step, join } = setup();
    join('s1');
    join('s2');
    claimStep(ctx, 'session:s1', 's1', step.id);
    const r = claimStep(ctx, 'session:s2', 's2', step.id);
    expect(driver(ctx, step.id)).toBe('s1');
    expect(findSession(ctx, 's2')?.focusNodeId).toBe(step.id);
    expect(r.notes).toContain(`A drives #${step.id}; you are helping. Pass --take-over to drive.`);
    expect(r.notes.some((n) => n.includes('also claimed by A'))).toBe(false);
  });

  it("--take-over moves the driver and clears the old driver's focus", () => {
    const { ctx, step, join, tick } = clocked();
    join('s1');
    join('s2');
    claimStep(ctx, 'session:s1', 's1', step.id);
    const seen = findSession(ctx, 's1')!.lastSeenAt;
    tick(60_000);
    const mark = maxEventId(ctx);
    const r = claimStep(ctx, 'session:s2', 's2', step.id, { takeOver: true });
    expect(driver(ctx, step.id)).toBe('s2');
    expect(findSession(ctx, 's1')).toMatchObject({ focusNodeId: null, lastSeenAt: seen });
    expect(briefingDue(ctx, 's1')).toBe(true);
    expect(briefingDue(ctx, 's2')).toBe(false);
    expect(r.notes).toContain(`You drive #${step.id}; took over from A.`);
    expect(r.notes.some((n) => n.includes('also claimed by'))).toBe(false);
    const events = listEventsSince(ctx, mark);
    expect(events.find((e) => e.type === 'session.updated' && e.entityId === 's1')?.data).toMatchObject({ changed: ['focusNodeId'], focusNodeId: null });
    expect(events.find((e) => e.type === 'node.updated' && e.entityId === String(step.id))?.data).toEqual({ changes: { driverSessionId: { from: 's1', to: 's2' } } });
  });

  it('a stale driver is replaced without the flag', () => {
    const { ctx, step, join, tick } = clocked();
    join('s1');
    claimStep(ctx, 'session:s1', 's1', step.id);
    tick(STALE_SESSION_MS + 60_000);
    join('s2');
    const r = claimStep(ctx, 'session:s2', 's2', step.id);
    expect(driver(ctx, step.id)).toBe('s2');
    expect(r.notes).toContain(`You drive #${step.id}.`);
    // Not a take-over: the stale session owes no briefing.
    expect(briefingDue(ctx, 's1')).toBe(false);
  });

  it('a driver id that names no session counts as no driver', () => {
    const { ctx, step, join } = setup();
    join('s1');
    ctx.db.prepare("UPDATE nodes SET driver_session_id = 'gone' WHERE id = ?").run(step.id);
    expect(claimStep(ctx, 'session:s1', 's1', step.id).notes).toContain(`You drive #${step.id}.`);
    expect(driver(ctx, step.id)).toBe('s1');
  });

  it('claiming your own step again changes nothing', () => {
    const { ctx, step, join } = setup();
    join('s1');
    claimStep(ctx, 'session:s1', 's1', step.id);
    const mark = maxEventId(ctx);
    const r = claimStep(ctx, 'session:s1', 's1', step.id, { takeOver: true });
    expect(r.notes.some((n) => n.includes('drive'))).toBe(false);
    expect(driver(ctx, step.id)).toBe('s1');
    expect(listEventsSince(ctx, mark).some((e) => e.type === 'node.updated')).toBe(false);
  });

  it('a refused claim leaves the driver as it was', () => {
    const { ctx, project, step, join } = setup();
    join('s1');
    claimStep(ctx, 'session:s1', 's1', step.id);
    expect(() => claimStep(ctx, 'session:s1', 's1', project.rootNodeId)).toThrow(/is the project root/);
    expect(driver(ctx, step.id)).toBe('s1');
    expect(driver(ctx, project.rootNodeId)).toBeNull();
  });

  it('set_focus drives only a driverless step', () => {
    const { ctx, step, other, join } = setup();
    join('s1');
    join('s2');
    claimStep(ctx, 'session:s1', 's1', step.id);
    setFocus(ctx, 'scribe:s2', 's2', step.id);
    expect(driver(ctx, step.id)).toBe('s1');
    expect(findSession(ctx, 's2')?.focusNodeId).toBe(step.id);
    setFocus(ctx, 'scribe:s2', 's2', other.id);
    expect(driver(ctx, other.id)).toBe('s2');
    // A helper moving on leaves the step it helped on with its driver.
    expect(driver(ctx, step.id)).toBe('s1');
  });

  it('focus elsewhere, focus null and orchestrate all stop the driving', () => {
    const { ctx, step, other, join } = setup();
    join('s1');
    claimStep(ctx, 'session:s1', 's1', step.id);
    claimStep(ctx, 'session:s1', 's1', other.id);
    expect(driver(ctx, step.id)).toBeNull();
    expect(driver(ctx, other.id)).toBe('s1');
    setFocus(ctx, 'scribe:s1', 's1', null);
    expect(driver(ctx, other.id)).toBeNull();
    claimStep(ctx, 'session:s1', 's1', step.id);
    expect(driver(ctx, step.id)).toBe('s1');
    orchestrate(ctx, 'session:s1', 's1', { status: false });
    expect(driver(ctx, step.id)).toBeNull();
  });

  it('set_focus and claim give no driver to a done step', () => {
    const { ctx, step, other, join } = setup();
    join('s1');
    join('s2');
    updateNode(ctx, 'test', step.id, { status: 'done' });
    setFocus(ctx, 'scribe:s1', 's1', step.id);
    expect(driver(ctx, step.id)).toBeNull();
    const r = claimStep(ctx, 'session:s2', 's2', step.id);
    expect(driver(ctx, step.id)).toBeNull();
    expect(r.notes.some((n) => n.includes('drive'))).toBe(false);
    // An open step still gets one.
    setFocus(ctx, 'scribe:s1', 's1', other.id);
    expect(driver(ctx, other.id)).toBe('s1');
  });

  it('a driver whose focus moved elsewhere without clearing the column is not live', () => {
    const { ctx, step, other, join } = setup();
    join('s1');
    join('s2');
    claimStep(ctx, 'session:s1', 's1', step.id);
    ctx.db.prepare('UPDATE sessions SET focus_node_id = ? WHERE id = ?').run(other.id, 's1');
    const r = claimStep(ctx, 'session:s2', 's2', step.id);
    expect(driver(ctx, step.id)).toBe('s2');
    expect(r.notes).toContain(`You drive #${step.id}.`);
    expect(findSession(ctx, 's1')?.focusNodeId).toBe(other.id);
    expect(briefingDue(ctx, 's1')).toBe(false);
  });

  it('orchestrate leaves alone a step the session only helps on', () => {
    const { ctx, step, join } = setup();
    join('s1');
    join('s2');
    claimStep(ctx, 'session:s1', 's1', step.id);
    claimStep(ctx, 'session:s2', 's2', step.id);
    orchestrate(ctx, 'session:s2', 's2', { status: false });
    expect(driver(ctx, step.id)).toBe('s1');
  });
});

describe('orchestrate', () => {
  it('sets the role, clears the focus, records session.orchestrate with the status flag, and opens with the counts', () => {
    const { ctx, step, join } = setup();
    join('s1');
    setFocus(ctx, 'scribe:s1', 's1', step.id);
    updateNode(ctx, 'test', step.id, { status: 'done' });
    const mark = maxEventId(ctx);
    const r = orchestrate(ctx, 'session:s1', 's1', { status: false });
    expect(r.session).toMatchObject({ role: 'orchestrator', focusNodeId: null });
    expect(r.opening).toContain('Role: orchestrator. You never implement');
    expect(r.opening).toMatch(/Since your last look \(\d+[mhd]\): /);
    expect(r.opening).not.toContain('Digest for');
    const events = listEventsSince(ctx, mark);
    expect(events.find((e) => e.type === 'session.orchestrate')).toMatchObject({ actor: 'session:s1', data: { status: false, marks: 1 } });
    expect(events.find((e) => e.type === 'session.updated')?.data).toMatchObject({ changed: ['role', 'focusNodeId'] });
    const full = orchestrate(ctx, 'session:s1', 's1', { status: true });
    expect(full.opening).toContain('Digest for InGame since');
    expect(full.opening).toContain(`Reconcile:\n  #${step.id} no_outcome`);
    expect(listEventsSince(ctx, mark).filter((e) => e.type === 'session.orchestrate').map((e) => (e.data as { status: boolean }).status)).toEqual([false, true]);
  });

  it('lists the top three of Next with ready or not ready', () => {
    const { ctx, project, step, other, third, join } = setup();
    join('s1');
    setQueue(ctx, 'scribe:s1', project.slug, [step.id, other.id, third.id], 'unowned');
    raiseAsk(ctx, 'test', { nodeId: other.id, kind: 'permission', text: 'Allow it' });
    const lines = orchestrate(ctx, 'session:s1', 's1', { status: true }).opening.split('\n');
    const at = lines.indexOf('Next:');
    expect(lines.slice(at, at + 4)).toEqual(['Next:', `  #${step.id} Build tabs: ready`, `  #${other.id} Write guide: not ready`, `  #${third.id} Third: ready`]);
  });

  it('refuses a session that is not tracked', () => {
    const { ctx } = setup();
    expect(() => orchestrate(ctx, 'session:ghost', 'ghost', { status: false })).toThrow(/is not tracked/);
  });
});

describe('scribe focus in a scoped project', () => {
  it('marks a briefing due when the focus changes, and does not in a full project or for a claim', () => {
    const { ctx, project, step, other, join } = setup();
    join('s1');
    setFocus(ctx, 'scribe:s1', 's1', step.id);
    expect(briefingDue(ctx, 's1')).toBe(false);
    changeProject(ctx, 'test', project.slug, { briefingMode: 'scoped' });
    setFocus(ctx, 'scribe:s1', 's1', step.id);
    expect(briefingDue(ctx, 's1')).toBe(false);
    setFocus(ctx, 'scribe:s1', 's1', other.id);
    expect(briefingDue(ctx, 's1')).toBe(true);
    clearBriefingDue(ctx, 's1');
    claimStep(ctx, 'session:s1', 's1', step.id);
    expect(briefingDue(ctx, 's1')).toBe(false);
    setFocus(ctx, 'session:s1', 's1', other.id);
    expect(briefingDue(ctx, 's1')).toBe(false);
  });
});

describe('role across SessionStart sources', () => {
  it('a clear start resets an orchestrator to worker; compaction and resume keep it', () => {
    const { ctx, join } = setup();
    join('s1');
    const start = (source: string) => handleHookEvent(ctx, 's1', { event: 'start', source, cwd: 'C:/personal/InGame' });
    ctx.db.prepare("UPDATE sessions SET role = 'orchestrator' WHERE id = 's1'").run();
    start('compact');
    expect(findSession(ctx, 's1')?.role).toBe('orchestrator');
    start('resume');
    expect(findSession(ctx, 's1')?.role).toBe('orchestrator');
    start('clear');
    expect(findSession(ctx, 's1')?.role).toBe('worker');
  });

  it('briefs an orchestrator with its own briefing, with the counts line, in a full project', () => {
    const { ctx, join } = setup();
    join('s1');
    ctx.db.prepare("UPDATE sessions SET role = 'orchestrator' WHERE id = 's1'").run();
    const text = handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' }).context!;
    expect(text).toContain('Role: orchestrator. You never implement');
    expect(text).toMatch(/\nSince your last look \(/);
    expect(text).not.toContain('"queue: #a, #b"');
  });
});

describe('the answers line', () => {
  const prompt = (extra = {}) => ({ event: 'prompt' as const, cwd: 'C:/personal/InGame', ...extra });

  it('arrives once, on the next real prompt after the ask is cleared, and not on a notice', () => {
    const { ctx, step, join } = setup();
    join('s1');
    const ask = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?', sessionId: 's1' });
    expect(handleHookEvent(ctx, 's1', prompt()).context).toBeUndefined();
    clearAsk(ctx, 'window', ask.id, '8080');
    expect(handleHookEvent(ctx, 's1', prompt({ notice: true })).context).toBeUndefined();
    expect(handleHookEvent(ctx, 's1', prompt()).context).toMatch(new RegExp(`^Answered: a${ask.id} "8080"(\n|$)`));
    expect(handleHookEvent(ctx, 's1', prompt()).context).toMatch(/^\[InProgress\] InGame/);
  });

  it('says Cleared with no answer, and comes before the status answer or line the prompt returns', () => {
    const { ctx, step, join } = setup();
    join('s1');
    const ask = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'permission', text: 'Allow it', sessionId: 's1' });
    clearAsk(ctx, 'window', ask.id);
    const lines = handleHookEvent(ctx, 's1', prompt({ asksStatus: true })).context!.split('\n');
    expect(lines[0]).toBe(`Cleared: a${ask.id}, no answer`);
    expect(lines[1]).toContain('Where things stand in InGame');
  });

  it('goes only to the session that raised the ask', () => {
    const { ctx, step, join } = setup();
    join('s1');
    join('s2');
    const ask = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Q', sessionId: 's1' });
    clearAsk(ctx, 'window', ask.id, 'yes');
    expect(handleHookEvent(ctx, 's2', prompt()).context).toBeUndefined();
    expect(handleHookEvent(ctx, 's1', prompt()).context).toBe(`Answered: a${ask.id} "yes"`);
  });
});

describe('review fixes', () => {
  it('claim refuses the project root and a dropped step, with a hint, and changes nothing', () => {
    const { ctx, project, step, join } = setup();
    join('s1');
    ctx.db.prepare("UPDATE sessions SET role = 'orchestrator' WHERE id = 's1'").run();
    expect(() => claimStep(ctx, 'session:s1', 's1', project.rootNodeId)).toThrow(/is the project root/);
    updateNode(ctx, 'test', step.id, { status: 'dropped' });
    expect(() => claimStep(ctx, 'session:s1', 's1', step.id)).toThrow(/is dropped/);
    expect(findSession(ctx, 's1')).toMatchObject({ role: 'orchestrator', focusNodeId: null });
  });

  it('the activity strip ends on the session line: orchestrate records its event first, claim its role first', () => {
    const { ctx, step, join } = setup();
    join('s1');
    const mark = maxEventId(ctx);
    orchestrate(ctx, 'session:s1', 's1', { status: false });
    expect(listEventsSince(ctx, mark).map((e) => e.type)).toEqual(['session.orchestrate', 'session.updated']);
    const mark2 = maxEventId(ctx);
    claimStep(ctx, 'session:s1', 's1', step.id);
    const events = listEventsSince(ctx, mark2).filter((e) => e.type === 'session.updated');
    expect(events.map((e) => (e.data as { changed: string[] }).changed)).toEqual([['role'], ['focusNodeId']]);
  });

  it('the answers line is one line of at most 300 characters', () => {
    const { ctx, step, join } = setup();
    join('s1');
    const ask = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Q', sessionId: 's1' });
    clearAsk(ctx, 'window', ask.id, `Yes.\n\n  Then   ${'x'.repeat(400)}`);
    const line = handleHookEvent(ctx, 's1', { event: 'prompt', cwd: 'C:/personal/InGame' }).context!.split('\n')[0];
    expect(line.startsWith(`Answered: a${ask.id} "Yes. Then xxx`)).toBe(true);
    const answer = /"(.*)"$/.exec(line)![1];
    expect(answer).toHaveLength(300);
    expect(answer.endsWith('…')).toBe(true);
  });
});
