import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes, deleteNode } from '../../src/server/repo/nodes';
import { addBinding, createProject } from '../../src/server/repo/projects';
import { findSession } from '../../src/server/repo/sessions';
import { pruneSubagents } from '../../src/server/repo/subagents';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { handleHookEvent, setFocus, type HookEventInput } from '../../src/server/session-flow';

const MIN = 60 * 1000;

/** A tracked session s1 in project InGame, focused on #play, with a clock the test moves by hand. */
function setup() {
  let now = Date.parse('2026-10-02T09:00:00.000Z');
  const ctx = createCtx(openDb(':memory:'), () => new Date(now).toISOString());
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [signing, play, tests] = addNodes(ctx, 'test', {
    parentId: project.rootNodeId,
    nodes: [{ title: 'Android signing', status: 'active', children: [{ title: 'Play app signing', status: 'active' }, { title: 'Run signing tests' }] }],
  });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
  setFocus(ctx, 'scribe:s1', 's1', play.id);
  const hook = (input: HookEventInput, session = 's1') => handleHookEvent(ctx, session, input);
  return { ctx, project, signing, play, tests, hook, tick: (ms: number) => (now += ms) };
}

const dispatch = (toolUseId: string, description: string, agentType = 'Explore', model?: string): HookEventInput => ({ event: 'agent-dispatch', toolUseId, description, agentType, ...(model ? { model } : {}) });
const start = (agentId: string, agentType = 'Explore'): HookEventInput => ({ event: 'subagent-start', agentId, agentType });
const launched = (toolUseId: string, agentId: string, model?: string): HookEventInput => ({ event: 'agent-launched', toolUseId, agentId, ...(model ? { model } : {}) });
const subagents = (ctx: Ctx) => findSession(ctx, 's1')!.subagents;
/** The input with the prompt's first sentence, as the pre-tool hook sends it. */
const purposed = (input: HookEventInput, purpose: string): HookEventInput => ({ ...input, purpose });
const purposes = (ctx: Ctx) => Object.fromEntries(subagents(ctx).map((s) => [s.agentId, s.purpose]));
const descriptions = (ctx: Ctx) => Object.fromEntries(subagents(ctx).map((s) => [s.agentId, s.description]));

describe('subagent dispatches', () => {
  it('pairs a dispatch with the next SubagentStart of its type, with its description, model and the focus node', () => {
    const { ctx, play, hook } = setup();
    expect(hook(dispatch('toolu_1', 'Map the hook payloads', 'Explore', 'sonnet'))).toEqual({ tracked: true });
    hook(start('a1'));
    expect(subagents(ctx)).toEqual([
      { agentId: 'a1', agentType: 'Explore', startedAt: expect.any(String), description: 'Map the hook payloads', model: 'sonnet', nodeId: play.id, endedAt: null, ordinal: 1, purpose: null },
    ]);
  });

  it("takes the node from a leading #id in the description when that node is in the session's project", () => {
    const { ctx, play, tests, hook } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    hook(dispatch('t1', `#${tests.id} Run the signing suite`));
    hook(dispatch('t2', `#${other.rootNodeId} Not this project`));
    hook(dispatch('t3', '#99999 No such node'));
    hook(dispatch('t4', `Mentions #${tests.id} later on`));
    for (const id of ['a1', 'a2', 'a3', 'a4']) hook(start(id));
    expect(subagents(ctx).map((s) => s.nodeId)).toEqual([tests.id, play.id, play.id, play.id]);
  });

  it('leaves the node empty when there is no #id and no focus', () => {
    const { ctx, hook } = setup();
    setFocus(ctx, 'scribe:s1', 's1', null);
    hook(dispatch('t1', 'Look around'));
    hook(start('a1'));
    expect(subagents(ctx)[0]).toMatchObject({ description: 'Look around', nodeId: null });
  });

  it('pairs first in, first out within each agent type', () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'first explore'));
    hook(dispatch('t2', 'a general one', 'general-purpose'));
    hook(dispatch('t3', 'second explore'));
    hook(start('a1'));
    hook(start('a2'));
    hook(start('a3', 'general-purpose'));
    expect(descriptions(ctx)).toEqual({ a1: 'first explore', a2: 'second explore', a3: 'a general one' });
  });

  it('shows a subagent without a dispatch by its type alone, on the focus its session had when it started', () => {
    const { ctx, play, hook } = setup();
    hook(start('a1'));
    expect(subagents(ctx)[0]).toMatchObject({ agentId: 'a1', description: null, model: null, nodeId: play.id });
  });

  it('corrects a crossed pairing when a launch names the agent (foreground agents, at completion)', () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'first'));
    hook(dispatch('t2', 'second'));
    hook(start('x2'));
    hook(start('x1'));
    expect(descriptions(ctx)).toEqual({ x2: 'first', x1: 'second' });
    hook(launched('t1', 'x1'));
    expect(descriptions(ctx)).toEqual({ x2: 'second', x1: 'first' });
    hook(launched('t2', 'x2'));
    expect(descriptions(ctx)).toEqual({ x2: 'second', x1: 'first' });
  });

  it('pairs exactly when the launch arrives before the start (background agents)', () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'first'));
    hook(dispatch('t2', 'second'));
    hook(launched('t2', 'x2'));
    hook(start('x2'));
    hook(start('x1'));
    expect(descriptions(ctx)).toEqual({ x2: 'second', x1: 'first' });
  });

  it('gives a wrongly taken dispatch back when the launch of its real agent comes first', () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'first'));
    hook(dispatch('t2', 'second'));
    hook(start('x2'));
    hook(launched('t1', 'x1'));
    expect(descriptions(ctx)).toEqual({ x2: 'second' });
    hook(start('x1'));
    expect(descriptions(ctx)).toEqual({ x2: 'second', x1: 'first' });
  });

  it('puts back a dispatch an agent held wrongly when its launch claims an unpaired one', () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'first'));
    hook(dispatch('t2', 'second'));
    hook(start('x2'));
    hook(launched('t2', 'x2'));
    hook(start('x1'));
    expect(descriptions(ctx)).toEqual({ x2: 'second', x1: 'first' });
  });

  it('fills a missing model from the launch, and keeps the one the dispatch named', () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'inherits'));
    hook(dispatch('t2', 'named', 'general-purpose', 'sonnet'));
    hook(start('a1'));
    hook(start('a2', 'general-purpose'));
    hook(launched('t1', 'a1', 'opus-5'));
    hook(launched('t2', 'a2', 'sonnet-5'));
    expect(Object.fromEntries(subagents(ctx).map((s) => [s.agentId, s.model]))).toEqual({ a1: 'opus-5', a2: 'sonnet' });
  });

  it("never records the scribe's own dispatches", () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'InProgress update', 'inprogress-scribe'));
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM subagent_dispatches').get()).toEqual({ c: 0 });
  });

  it('writes nothing for a session that is not tracked', () => {
    const { ctx, hook } = setup();
    expect(hook(dispatch('t1', 'Look around'), 'nobody')).toEqual({ tracked: false });
    expect(hook(launched('t1', 'a1'), 'nobody')).toEqual({ tracked: false });
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM subagent_dispatches').get()).toEqual({ c: 0 });
    expect(findSession(ctx, 'nobody')).toBeUndefined();
  });
});

describe('the start focus of a subagent with no step', () => {
  const nodeOf = (ctx: Ctx, agentId: string) => subagents(ctx).find((a) => a.agentId === agentId)?.nodeId;
  const trailNode = (ctx: Ctx, slug: string, agentId: string) => getProjectSnapshot(ctx, slug).trailAgents.find((a) => a.agentId === agentId)?.nodeId;

  it('stays on the focus at its start while it runs, after it stops, and after its session ends on another focus', () => {
    const { ctx, project, play, tests, hook } = setup();
    // A workflow agent: no dispatch, so no step of its own.
    hook(start('w1', 'general-purpose'));
    setFocus(ctx, 'scribe:s1', 's1', tests.id);
    expect(nodeOf(ctx, 'w1')).toBe(play.id);
    hook({ event: 'subagent-stop', agentId: 'w1' });
    expect(nodeOf(ctx, 'w1')).toBe(play.id);
    expect(trailNode(ctx, project.slug, 'w1')).toBe(play.id);
    hook({ event: 'end' });
    expect(getProjectSnapshot(ctx, project.slug).pastSessions).toEqual([expect.objectContaining({ id: 's1', focusNodeId: tests.id })]);
    expect(trailNode(ctx, project.slug, 'w1')).toBe(play.id);
  });

  it("gives way to a step its dispatch named, and to the focus at its dispatch", () => {
    const { ctx, signing, tests, hook } = setup();
    hook(dispatch('t1', `#${signing.id} Check the keystore`, 'general-purpose'));
    setFocus(ctx, 'scribe:s1', 's1', null);
    hook(start('a1', 'general-purpose'));
    expect(nodeOf(ctx, 'a1')).toBe(signing.id);
    hook(dispatch('t2', 'Look around', 'general-purpose'));
    setFocus(ctx, 'scribe:s1', 's1', tests.id);
    hook(start('a2', 'general-purpose'));
    // The focus at dispatch was cleared (null), so the focus at its start stands in.
    expect(nodeOf(ctx, 'a2')).toBe(tests.id);
  });

  it('takes the first focus its session sets when it started with none, and stays there when the focus moves again', () => {
    const { ctx, signing, play, tests, hook } = setup();
    setFocus(ctx, 'scribe:s1', 's1', null);
    hook(start('w1', 'general-purpose'));
    hook(start('w2', 'general-purpose'));
    hook({ event: 'subagent-stop', agentId: 'w2' });
    hook(dispatch('t1', `#${signing.id} Check the keystore`, 'general-purpose'));
    hook(start('a1', 'general-purpose'));
    expect(nodeOf(ctx, 'w1')).toBeNull();
    setFocus(ctx, 'scribe:s1', 's1', play.id);
    setFocus(ctx, 'scribe:s1', 's1', tests.id);
    expect(nodeOf(ctx, 'w1')).toBe(play.id);
    // Only a running subagent with no step takes it: a stopped one, and one whose dispatch named a step, keep none.
    const columns = ctx.db.prepare('SELECT agent_id, node_id, start_focus_id FROM session_subagents ORDER BY agent_id').all();
    expect(columns).toEqual([
      { agent_id: 'a1', node_id: signing.id, start_focus_id: null },
      { agent_id: 'w1', node_id: null, start_focus_id: play.id },
      { agent_id: 'w2', node_id: null, start_focus_id: null },
    ]);
  });

  it('keeps the start focus of its first start when it is resumed after a focus change', () => {
    const { ctx, play, tests, hook } = setup();
    hook(start('w1', 'general-purpose'));
    hook({ event: 'subagent-stop', agentId: 'w1' });
    setFocus(ctx, 'scribe:s1', 's1', tests.id);
    hook(start('w1', 'general-purpose'));
    expect(subagents(ctx)).toEqual([expect.objectContaining({ agentId: 'w1', endedAt: null, nodeId: play.id })]);
  });

  it("reads null once its start step is deleted, so it falls back to its session's focus as before", () => {
    const { ctx, tests, hook } = setup();
    const [extra] = addNodes(ctx, 'test', { parentId: tests.id, nodes: [{ title: 'Scratch step' }] });
    setFocus(ctx, 'scribe:s1', 's1', extra.id);
    hook(start('w1', 'general-purpose'));
    expect(nodeOf(ctx, 'w1')).toBe(extra.id);
    setFocus(ctx, 'scribe:s1', 's1', tests.id);
    deleteNode(ctx, 'test', extra.id);
    expect(nodeOf(ctx, 'w1')).toBeNull();
  });

  it('keeps it for the loser of a launch swap, whose dispatch goes back to its real agent', () => {
    const { ctx, signing, play, tests, hook } = setup();
    hook(dispatch('t1', `#${signing.id} Check the keystore`));
    hook(start('y2'));
    expect(nodeOf(ctx, 'y2')).toBe(signing.id);
    hook(launched('t1', 'y1'));
    expect(subagents(ctx)[0]).toMatchObject({ agentId: 'y2', description: null, nodeId: play.id });
    setFocus(ctx, 'scribe:s1', 's1', tests.id);
    expect(nodeOf(ctx, 'y2')).toBe(play.id);
  });
});

describe('subagent purpose', () => {
  it('stores the purpose with the dispatch and shows it on the subagent first in, first out', () => {
    const { ctx, hook } = setup();
    hook(purposed(dispatch('t1', 'Review P6', 'general-purpose'), 'Review the diff for P6.'));
    expect(ctx.db.prepare('SELECT tool_use_id, purpose FROM subagent_dispatches').all()).toEqual([{ tool_use_id: 't1', purpose: 'Review the diff for P6.' }]);
    hook(start('a1', 'general-purpose'));
    expect(subagents(ctx)).toEqual([expect.objectContaining({ agentId: 'a1', description: 'Review P6', purpose: 'Review the diff for P6.' })]);
  });

  it('shows it through the named pairing, when the launch arrives before the start', () => {
    const { ctx, hook } = setup();
    hook(purposed(dispatch('t1', 'first'), 'Read the hooks.'));
    hook(purposed(dispatch('t2', 'second'), 'Read the tests.'));
    hook(launched('t2', 'x2'));
    hook(start('x2'));
    hook(start('x1'));
    expect(purposes(ctx)).toEqual({ x2: 'Read the tests.', x1: 'Read the hooks.' });
  });

  it('moves it with the description when a launch swaps a crossed pairing, and clears it when none is left', () => {
    const { ctx, hook } = setup();
    hook(purposed(dispatch('t1', 'first'), 'First purpose.'));
    hook(purposed(dispatch('t2', 'second'), 'Second purpose.'));
    hook(start('x2'));
    hook(start('x1'));
    expect(purposes(ctx)).toEqual({ x2: 'First purpose.', x1: 'Second purpose.' });
    hook(launched('t1', 'x1'));
    expect(purposes(ctx)).toEqual({ x2: 'Second purpose.', x1: 'First purpose.' });
    // One dispatch, taken by the wrong agent: its real agent's launch takes it back, and the other is left with none.
    hook(purposed(dispatch('t3', 'third'), 'Third purpose.'));
    hook(start('y2'));
    expect(purposes(ctx).y2).toBe('Third purpose.');
    hook(launched('t3', 'y1'));
    expect(purposes(ctx).y2).toBeNull();
  });

  it('is null for a dispatch without one, and for a subagent with no dispatch', () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'Look around'));
    hook(start('a1'));
    hook(start('a2'));
    expect(purposes(ctx)).toEqual({ a1: null, a2: null });
  });

  it('carries it into the trail', () => {
    const { ctx, project, hook } = setup();
    hook(purposed(dispatch('t1', 'Write the tests', 'general-purpose'), 'Write the layout tests.'));
    hook(start('a1', 'general-purpose'));
    hook({ event: 'subagent-stop', agentId: 'a1' });
    expect(getProjectSnapshot(ctx, project.slug).trailAgents).toEqual([expect.objectContaining({ agentId: 'a1', purpose: 'Write the layout tests.' })]);
  });
});

describe('subagent lifetimes', () => {
  it('marks a stopped subagent ended and keeps showing it for 5 minutes', () => {
    const { ctx, project, hook, tick } = setup();
    hook(dispatch('t1', 'Map the hooks'));
    hook(start('a1'));
    tick(2 * MIN);
    hook({ event: 'subagent-stop', agentId: 'a1', agentType: 'Explore' });
    const [ended] = subagents(ctx);
    expect(ended).toMatchObject({ agentId: 'a1', description: 'Map the hooks', endedAt: '2026-10-02T09:02:00.000Z' });
    tick(4 * MIN);
    expect(getProjectSnapshot(ctx, project.slug).sessions[0].subagents.map((s) => s.agentId)).toEqual(['a1']);
    tick(2 * MIN);
    expect(getProjectSnapshot(ctx, project.slug).sessions[0].subagents).toEqual([]);
  });

  it('revives a subagent that starts again (resumed), keeping what it was doing', () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'Map the hooks'));
    hook(start('a1'));
    hook({ event: 'subagent-stop', agentId: 'a1' });
    hook(dispatch('t2', 'Another explore'));
    hook(start('a1'));
    expect(subagents(ctx)).toMatchObject([{ agentId: 'a1', description: 'Map the hooks', endedAt: null }]);
    // The new dispatch stays for the agent it belongs to.
    hook(start('a2'));
    expect(descriptions(ctx)).toEqual({ a1: 'Map the hooks', a2: 'Another explore' });
  });

  it('tells the UI when what it shows of a subagent changes, and only then', () => {
    const { ctx, hook } = setup();
    const changes = (fn: () => void) => {
      const mark = maxEventId(ctx);
      fn();
      return listEventsSince(ctx, mark).map((e) => (e.data as { changed: string[] }).changed);
    };
    expect(changes(() => hook(dispatch('t1', 'first')))).toEqual([]);
    expect(changes(() => hook(dispatch('t2', 'second')))).toEqual([]);
    expect(changes(() => hook(start('x2')))).toEqual([['subagents']]);
    expect(changes(() => hook(start('x1')))).toEqual([['subagents']]);
    // The crossed pair is swapped; the second launch only confirms.
    expect(changes(() => hook(launched('t2', 'x2')))).toEqual([['subagents']]);
    expect(changes(() => hook(launched('t1', 'x1')))).toEqual([]);
    expect(changes(() => hook({ event: 'subagent-stop', agentId: 'x2' }))).toEqual([['subagents']]);
  });

  it('keeps the subagent rows when the session ends, ends the running ones then, and drops the dispatches', () => {
    const { ctx, hook, tick } = setup();
    hook(dispatch('t1', 'Map the hooks', 'general-purpose'));
    hook(dispatch('t2', 'Write the tests', 'general-purpose'));
    hook(dispatch('t3', 'Never started', 'general-purpose'));
    hook(start('a1', 'general-purpose'));
    hook(start('a2', 'general-purpose'));
    tick(MIN);
    hook({ event: 'subagent-stop', agentId: 'a1' });
    tick(MIN);
    hook({ event: 'end' });
    // A row that had already stopped keeps its own time.
    expect(ctx.db.prepare('SELECT agent_id, description, ended_at FROM session_subagents ORDER BY agent_id').all()).toEqual([
      { agent_id: 'a1', description: 'Map the hooks', ended_at: '2026-10-02T09:01:00.000Z' },
      { agent_id: 'a2', description: 'Write the tests', ended_at: '2026-10-02T09:02:00.000Z' },
    ]);
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM subagent_dispatches').get()).toEqual({ c: 0 });
  });

  it("ends a stale session's running subagents when it was last seen, not when it expired", () => {
    const { ctx, project, hook, tick } = setup();
    hook(dispatch('t1', 'Long job', 'general-purpose'));
    hook(start('a1', 'general-purpose'));
    tick(30 * MIN);
    hook({ event: 'stop' });
    tick(13 * 60 * MIN);
    const snap = getProjectSnapshot(ctx, project.slug);
    expect(findSession(ctx, 's1')).toMatchObject({ state: 'ended', endedAt: '2026-10-02T22:30:00.000Z' });
    expect(snap.trailAgents).toEqual([expect.objectContaining({ sessionId: 's1', agentId: 'a1', startedAt: '2026-10-02T09:00:00.000Z', endedAt: '2026-10-02T09:30:00.000Z' })]);
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM subagent_dispatches').get()).toEqual({ c: 0 });
  });
});

describe('subagent numbers', () => {
  const numbers = (ctx: Ctx, session = 's1') =>
    Object.fromEntries((ctx.db.prepare('SELECT agent_id, ordinal FROM session_subagents WHERE session_id = ?').all(session) as { agent_id: string; ordinal: number | null }[]).map((r) => [r.agent_id, r.ordinal]));

  it("numbers a session's subagents from 1 as they start, each session on its own, and never the scribe", () => {
    const { ctx, hook } = setup();
    hook({ event: 'start', source: 'startup', cwd: 'C:/personal/InGame' }, 's2');
    hook(start('a1', 'general-purpose'));
    hook(start('scribe', 'inprogress-scribe'));
    hook(start('a2', 'general-purpose'));
    hook(start('b1', 'general-purpose'), 's2');
    expect(numbers(ctx)).toEqual({ a1: 1, a2: 2 });
    expect(numbers(ctx, 's2')).toEqual({ b1: 1 });
    expect(subagents(ctx).map((a) => a.ordinal)).toEqual([1, 2]);
  });

  it("keeps a resumed subagent's number, and gives the next one a new number even after the highest stopped", () => {
    const { ctx, hook } = setup();
    hook(start('a1', 'general-purpose'));
    hook(start('a2', 'general-purpose'));
    hook({ event: 'subagent-stop', agentId: 'a1' });
    hook({ event: 'subagent-stop', agentId: 'a2' });
    hook(start('a1', 'general-purpose'));
    hook(start('a3', 'general-purpose'));
    expect(numbers(ctx)).toEqual({ a1: 1, a2: 2, a3: 3 });
  });

  it('counts past a subagent from before migration 4, which has no number', () => {
    const { ctx, hook } = setup();
    hook(start('old', 'general-purpose'));
    ctx.db.prepare('UPDATE session_subagents SET ordinal = NULL').run();
    hook(start('a1', 'general-purpose'));
    expect(numbers(ctx)).toEqual({ old: null, a1: 1 });
  });

  it('carries the number into the trail', () => {
    const { ctx, project, hook } = setup();
    hook(start('a1', 'general-purpose'));
    hook(start('a2', 'general-purpose'));
    hook({ event: 'subagent-stop', agentId: 'a2' });
    expect(getProjectSnapshot(ctx, project.slug).trailAgents).toEqual([expect.objectContaining({ agentId: 'a2', ordinal: 2 })]);
  });
});

describe('the trail of ended subagents in the snapshot', () => {
  it("lists a stopped subagent at once, with its session, and leaves out running ones and other projects' agents", () => {
    const { ctx, project, play, hook, tick } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    addBinding(ctx, 'test', other.slug, 'C:/personal/Other');
    handleHookEvent(ctx, 'o1', { event: 'start', source: 'startup', cwd: 'C:/personal/Other' });
    hook(start('c1', 'general-purpose'), 'o1');
    hook({ event: 'subagent-stop', agentId: 'c1' }, 'o1');
    hook(dispatch('t1', 'Map the hooks', 'general-purpose', 'sonnet'));
    hook(start('a1', 'general-purpose'));
    hook(start('a2', 'general-purpose'));
    tick(MIN);
    hook({ event: 'subagent-stop', agentId: 'a1' });
    // The layout, not the server, decides when a live session's stopped subagent leaves its greyed badge for the trail.
    expect(getProjectSnapshot(ctx, project.slug).trailAgents).toEqual([
      { sessionId: 's1', agentId: 'a1', agentType: 'general-purpose', startedAt: '2026-10-02T09:00:00.000Z', description: 'Map the hooks', model: 'sonnet', nodeId: play.id, endedAt: '2026-10-02T09:01:00.000Z', ordinal: 1, purpose: null },
    ]);
    expect(getProjectSnapshot(ctx, other.slug).trailAgents.map((a) => a.agentId)).toEqual(['c1']);
  });

  it('leaves readers out of the trail, and an ended session whose only trail was readers out of the past sessions', () => {
    const { ctx, project, hook } = setup();
    for (const [id, type] of [['r1', 'Explore'], ['r2', 'Plan'], ['r3', 'claude-code-guide'], ['w1', 'general-purpose']]) {
      hook(start(id, type));
      hook({ event: 'subagent-stop', agentId: id });
    }
    handleHookEvent(ctx, 's2', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
    hook(start('r4', 'Explore'), 's2');
    hook({ event: 'end' }, 's2');
    const snap = getProjectSnapshot(ctx, project.slug);
    expect(snap.trailAgents.map((a) => a.agentId)).toEqual(['w1']);
    expect(snap.pastSessions).toEqual([]);
    // The session's own list still has its readers: the window shows the running ones.
    hook(start('r5', 'Explore'));
    expect(subagents(ctx).map((a) => a.agentId)).toEqual(['r1', 'r2', 'r3', 'r5', 'w1']);
  });

  it('keeps a trail agent for 7 days after it stopped, then leaves it out even before a prune', () => {
    const { ctx, project, hook, tick } = setup();
    hook(start('a1', 'general-purpose'));
    hook({ event: 'subagent-stop', agentId: 'a1' });
    hook({ event: 'end' });
    const trail = () => getProjectSnapshot(ctx, project.slug).trailAgents.map((a) => a.agentId);
    tick(7 * 24 * 60 * MIN - MIN);
    expect(trail()).toEqual(['a1']);
    tick(2 * MIN);
    expect(trail()).toEqual([]);
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM session_subagents').get()).toEqual({ c: 1 });
  });
});

describe('pruneSubagents', () => {
  it('drops dispatches no agent took within 10 minutes', () => {
    const { ctx, hook, tick } = setup();
    hook(dispatch('t1', 'denied before it ran'));
    hook(dispatch('t2', 'recent'));
    tick(9 * MIN);
    expect(pruneSubagents(ctx)).toEqual({ dispatches: 0, subagents: 0 });
    tick(2 * MIN);
    hook(dispatch('t3', 'just now'));
    expect(pruneSubagents(ctx)).toEqual({ dispatches: 2, subagents: 0 });
    expect(ctx.db.prepare('SELECT tool_use_id FROM subagent_dispatches').all()).toEqual([{ tool_use_id: 't3' }]);
  });

  it('never pairs a dispatch older than 10 minutes', () => {
    const { ctx, hook, tick } = setup();
    hook(dispatch('t1', 'denied before it ran'));
    tick(11 * MIN);
    hook(start('a1'));
    expect(subagents(ctx)[0]).toMatchObject({ agentId: 'a1', description: null });
  });

  it('keeps the dispatch of an agent it knows, even past 10 minutes, so a late launch can still correct it', () => {
    const { ctx, hook, tick } = setup();
    hook(dispatch('t1', 'first'));
    hook(dispatch('t2', 'second'));
    hook(start('x2'));
    hook(start('x1'));
    tick(30 * MIN);
    hook({ event: 'subagent-stop', agentId: 'x1' });
    expect(pruneSubagents(ctx)).toEqual({ dispatches: 0, subagents: 0 });
    hook(launched('t1', 'x1'));
    expect(descriptions(ctx)).toEqual({ x2: 'second', x1: 'first' });
  });

  it('removes subagents 7 days after they stopped, and their dispatches with them', () => {
    const { ctx, hook, tick } = setup();
    hook(dispatch('t1', 'old', 'general-purpose'));
    hook(start('a1', 'general-purpose'));
    hook(start('a2', 'general-purpose'));
    hook({ event: 'subagent-stop', agentId: 'a1' });
    tick(7 * 24 * 60 * MIN - MIN);
    expect(pruneSubagents(ctx)).toEqual({ dispatches: 0, subagents: 0 });
    tick(2 * MIN);
    expect(pruneSubagents(ctx)).toEqual({ dispatches: 1, subagents: 1 });
    expect(ctx.db.prepare('SELECT agent_id FROM session_subagents').all()).toEqual([{ agent_id: 'a2' }]);
  });
});
