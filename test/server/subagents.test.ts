import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes } from '../../src/server/repo/nodes';
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
const descriptions = (ctx: Ctx) => Object.fromEntries(subagents(ctx).map((s) => [s.agentId, s.description]));

describe('subagent dispatches', () => {
  it('pairs a dispatch with the next SubagentStart of its type, with its description, model and the focus node', () => {
    const { ctx, play, hook } = setup();
    expect(hook(dispatch('toolu_1', 'Map the hook payloads', 'Explore', 'sonnet'))).toEqual({ tracked: true });
    hook(start('a1'));
    expect(subagents(ctx)).toEqual([
      { agentId: 'a1', agentType: 'Explore', startedAt: expect.any(String), description: 'Map the hook payloads', model: 'sonnet', nodeId: play.id, endedAt: null },
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

  it('shows a subagent without a dispatch by its type alone', () => {
    const { ctx, hook } = setup();
    hook(start('a1'));
    expect(subagents(ctx)[0]).toMatchObject({ agentId: 'a1', description: null, model: null, nodeId: null });
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

  it('clears subagents and dispatches when the session ends', () => {
    const { ctx, hook } = setup();
    hook(dispatch('t1', 'never started'));
    hook(dispatch('t2', 'running'));
    hook(start('a1'));
    hook({ event: 'end' });
    expect(findSession(ctx, 's1')!.subagents).toEqual([]);
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM session_subagents').get()).toEqual({ c: 0 });
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM subagent_dispatches').get()).toEqual({ c: 0 });
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

  it('removes subagents an hour after they ended, and their dispatches with them', () => {
    const { ctx, hook, tick } = setup();
    hook(dispatch('t1', 'old'));
    hook(start('a1'));
    hook(start('a2'));
    hook({ event: 'subagent-stop', agentId: 'a1' });
    tick(61 * MIN);
    expect(pruneSubagents(ctx)).toEqual({ dispatches: 1, subagents: 1 });
    expect(ctx.db.prepare('SELECT agent_id FROM session_subagents').all()).toEqual([{ agent_id: 'a2' }]);
  });
});
