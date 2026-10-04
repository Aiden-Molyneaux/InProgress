import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes, updateNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, setQueue } from '../../src/server/repo/projects';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { pruneWorkItems, setTasks } from '../../src/server/repo/work';
import { handleHookEvent, setFocus, type HookEventInput } from '../../src/server/session-flow';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** A tracked session s1 in project InGame, focused on #play, with a clock the test moves by hand. */
function setup() {
  let now = Date.parse('2026-10-02T09:00:00.000Z');
  const ctx = createCtx(openDb(':memory:'), () => new Date(now).toISOString());
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [signing, play, tests, store] = addNodes(ctx, 'test', {
    parentId: project.rootNodeId,
    nodes: [
      { title: 'Android signing', status: 'active', children: [{ title: 'Play app signing', status: 'active' }, { title: 'Run signing tests' }] },
      { title: 'Store listing' },
    ],
  });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
  setFocus(ctx, 'scribe:s1', 's1', play.id);
  const hook = (input: HookEventInput, session = 's1') => handleHookEvent(ctx, session, input);
  const items = () => getProjectSnapshot(ctx, project.slug).workItems;
  return { ctx, project, signing, play, tests, store, hook, items, tick: (ms: number) => (now += ms) };
}

const created = (taskKey: string, subject: string, agentId?: string): HookEventInput => ({ event: 'task-created', taskKey, subject, ...(agentId ? { agentId } : {}) });
const updated = (taskKey: string, patch: Partial<HookEventInput> = {}): HookEventInput => ({ event: 'task-updated', taskKey, ...patch });
const subjects = (list: { subject: string }[]) => list.map((i) => i.subject);

describe('working tasks mirrored from the task tools', () => {
  it("mirrors a created task under the session's focus, pending, in creation order", () => {
    const { play, hook, items } = setup();
    expect(hook(created('1', 'Write the design note'))).toEqual({ tracked: true });
    hook(created('2', 'Read it before publishing'));
    expect(items()).toEqual([
      { id: expect.any(Number), nodeId: play.id, sessionId: 's1', agentId: '', subject: 'Write the design note', status: 'pending', blocks: [], position: 1, updatedAt: '2026-10-02T09:00:00.000Z' },
      { id: expect.any(Number), nodeId: play.id, sessionId: 's1', agentId: '', subject: 'Read it before publishing', status: 'pending', blocks: [], position: 2, updatedAt: '2026-10-02T09:00:00.000Z' },
    ]);
  });

  it('attributes a task to a leading #id in the project, else its subagent node, else the focus, else the root', () => {
    const { ctx, project, signing, play, tests, hook, items } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    hook(created('1', `#${tests.id} Run the suite on a device`));
    hook(created('2', `#${other.rootNodeId} Belongs elsewhere`));
    hook({ event: 'agent-dispatch', toolUseId: 't1', agentType: 'Explore', description: `#${signing.id} Check the keystore` });
    hook({ event: 'subagent-start', agentId: 'a1', agentType: 'Explore' });
    hook(created('1', 'Read the keystore docs', 'a1'));
    hook(created('2', `#${tests.id} A subagent task that names its node`, 'a1'));
    hook({ event: 'subagent-start', agentId: 'a2', agentType: 'Explore' });
    hook(created('1', 'A subagent with no dispatch', 'a2'));
    setFocus(ctx, 'scribe:s1', 's1', null);
    hook(created('3', 'Nothing to go on'));
    const nodeOf = Object.fromEntries(items().map((i) => [i.subject, i.nodeId]));
    expect(nodeOf).toEqual({
      [`#${tests.id} Run the suite on a device`]: tests.id,
      [`#${other.rootNodeId} Belongs elsewhere`]: play.id,
      'Read the keystore docs': signing.id,
      [`#${tests.id} A subagent task that names its node`]: tests.id,
      'A subagent with no dispatch': play.id,
      'Nothing to go on': project.rootNodeId,
    });
  });

  it('keeps each task list apart: the main session and every subagent number their own', () => {
    const { hook, items } = setup();
    hook(created('1', 'Main session task'));
    hook({ event: 'subagent-start', agentId: 'a1', agentType: 'Explore' });
    hook(created('1', 'Subagent task', 'a1'));
    hook(updated('1', { status: 'completed', agentId: 'a1' }));
    expect(items().map((i) => [i.agentId, i.subject, i.status])).toEqual([['', 'Main session task', 'pending'], ['a1', 'Subagent task', 'completed']]);
  });

  it('applies status, subject and blocks updates, and a deleted task disappears', () => {
    const { hook, items } = setup();
    hook(created('1', 'Write it'));
    hook(created('2', 'Read it'));
    hook(created('3', 'Publish it'));
    hook(updated('1', { status: 'in_progress' }));
    hook(updated('2', { subject: 'Read it twice' }));
    hook(updated('1', { addBlocks: ['2', '1', '99'] }));
    hook(updated('3', { addBlockedBy: ['2'] }));
    const [one, two, three] = items();
    expect(one).toMatchObject({ subject: 'Write it', status: 'in_progress', blocks: [two.id] });
    expect(two).toMatchObject({ subject: 'Read it twice', status: 'pending', blocks: [three.id] });
    hook(updated('2', { status: 'deleted' }));
    expect(items().map((i) => [i.subject, i.blocks])).toEqual([['Write it', []], ['Publish it', []]]);
  });

  it('keeps the node a task got at creation when its subject changes later', () => {
    const { play, tests, hook, items } = setup();
    hook(created('1', 'Write it'));
    hook(updated('1', { subject: `#${tests.id} Write it` }));
    expect(items()[0]).toMatchObject({ subject: `#${tests.id} Write it`, nodeId: play.id });
  });

  it('starts a task over when a create reuses its key', () => {
    const { tests, hook, items } = setup();
    hook(created('1', 'First list'));
    hook(updated('1', { status: 'completed' }));
    hook(created('1', `#${tests.id} After the list was reset`));
    expect(items()).toEqual([expect.objectContaining({ subject: `#${tests.id} After the list was reset`, status: 'pending', nodeId: tests.id })]);
  });

  it('picks up a task it missed from an update that names its subject, and ignores one it cannot show', () => {
    const { play, hook, items } = setup();
    hook(updated('7', { status: 'in_progress', subject: 'Created before the hooks were installed' }));
    hook(updated('8', { status: 'completed' }));
    hook(updated('9', { status: 'deleted', subject: 'Gone anyway' }));
    expect(items()).toEqual([expect.objectContaining({ subject: 'Created before the hooks were installed', status: 'in_progress', nodeId: play.id })]);
  });

  it('records one work.updated event per change, on the node', () => {
    const { ctx, play, project, hook } = setup();
    const events = (fn: () => void) => {
      const mark = maxEventId(ctx);
      fn();
      return listEventsSince(ctx, mark).map((e) => ({ type: e.type, entity: e.entity, entityId: e.entityId, actor: e.actor, projectId: e.projectId, data: e.data }));
    };
    const work = (actor: string) => ({ type: 'work.updated', entity: 'node', entityId: String(play.id), actor, projectId: project.id, data: { nodeId: play.id } });
    expect(events(() => hook(created('1', 'Write it')))).toEqual([work('hook:task-created')]);
    expect(events(() => hook(updated('1', { status: 'in_progress' })))).toEqual([work('hook:task-updated')]);
    expect(events(() => hook(updated('1', { status: 'in_progress', addBlocks: [] })))).toEqual([]);
    expect(events(() => hook(updated('42', { status: 'completed' })))).toEqual([]);
    expect(events(() => hook(updated('1', { status: 'deleted' })))).toEqual([work('hook:task-updated')]);
  });

  it('writes nothing for a session that is not tracked', () => {
    const { ctx, hook } = setup();
    expect(hook(created('1', 'Untracked work'), 'nobody')).toEqual({ tracked: false });
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM work_items').get()).toEqual({ c: 0 });
  });

  it("drops a session's tasks from view when it ends, and shows them again when it resumes", () => {
    const { hook, items } = setup();
    hook(created('1', 'Write it'));
    hook({ event: 'end' });
    expect(items()).toEqual([]);
    hook({ event: 'start', source: 'resume', cwd: 'C:/personal/InGame' });
    expect(subjects(items())).toEqual(['Write it']);
  });

  it('goes with its node when the node is deleted', () => {
    const { ctx, store, hook, items } = setup();
    hook(created('1', `#${store.id} Draft the listing`));
    ctx.db.prepare('DELETE FROM nodes WHERE id = ?').run(store.id);
    expect(items()).toEqual([]);
  });
});

describe('pruneWorkItems', () => {
  it('drops the tasks of sessions that ended more than 7 days ago', () => {
    const { ctx, hook, tick } = setup();
    hook(created('1', 'Old session work'));
    handleHookEvent(ctx, 's2', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
    hook(created('1', 'Recent session work'), 's2');
    hook({ event: 'end' });
    tick(6 * DAY);
    hook({ event: 'end' }, 's2');
    handleHookEvent(ctx, 's3', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
    hook(created('1', 'Still working'), 's3');
    tick(1 * DAY + MIN);
    expect(pruneWorkItems(ctx)).toBe(1);
    expect(ctx.db.prepare('SELECT subject FROM work_items ORDER BY id').all()).toEqual([{ subject: 'Recent session work' }, { subject: 'Still working' }]);
  });
});

describe('setTasks (the tasks command, where the task tools are absent)', () => {
  it("replaces the session's list on a node, in order, and leaves other lists alone", () => {
    const { ctx, play, tests, hook, items } = setup();
    hook(created('1', 'Mirrored elsewhere'));
    hook({ event: 'subagent-start', agentId: 'a1', agentType: 'Explore' });
    hook(created('1', `#${tests.id} A subagent's own`, 'a1'));
    const first = setTasks(ctx, 'session:s1', 's1', tests.id, [{ subject: 'Run the suite', status: 'in_progress' }, { subject: 'Report failures', status: 'pending' }]);
    expect(first.nodeId).toBe(tests.id);
    expect(first.tasks.map((i) => [i.subject, i.status, i.nodeId])).toEqual([['Run the suite', 'in_progress', tests.id], ['Report failures', 'pending', tests.id]]);
    setTasks(ctx, 'session:s1', 's1', tests.id, [{ subject: 'Run the suite', status: 'completed' }]);
    expect(items().map((i) => [i.nodeId, i.agentId, i.subject, i.status])).toEqual([
      [play.id, '', 'Mirrored elsewhere', 'pending'],
      [tests.id, 'a1', `#${tests.id} A subagent's own`, 'pending'],
      [tests.id, '', 'Run the suite', 'completed'],
    ]);
    expect(setTasks(ctx, 'session:s1', 's1', tests.id, [])).toEqual({ nodeId: tests.id, tasks: [] });
    expect(subjects(items())).toEqual(['Mirrored elsewhere', `#${tests.id} A subagent's own`]);
  });

  it("uses the session's focus when no step is named", () => {
    const { ctx, play, items } = setup();
    const res = setTasks(ctx, 'session:s1', 's1', undefined, [{ subject: 'Sign the bundle', status: 'in_progress' }]);
    expect(res.nodeId).toBe(play.id);
    expect(res.tasks.map((i) => [i.nodeId, i.subject, i.status])).toEqual([[play.id, 'Sign the bundle', 'in_progress']]);
    expect(items().map((i) => [i.nodeId, i.subject])).toEqual([[play.id, 'Sign the bundle']]);
  });

  it('refuses a session with no focus when no step is named, with a hint that names the step bare', () => {
    const { ctx } = setup();
    setFocus(ctx, 'scribe:s1', 's1', null);
    expect(() => setTasks(ctx, 'session:s1', 's1', undefined, [])).toThrow(expect.objectContaining({ status: 400, message: 'This session has no focus', hint: 'Name the step: tasks <id> …' }));
  });

  it('records work.updated for the node by its actor, and nothing when the list is unchanged', () => {
    const { ctx, tests } = setup();
    const list = [{ subject: 'Run the suite', status: 'pending' as const }];
    let mark = maxEventId(ctx);
    setTasks(ctx, 'session:s1', 's1', tests.id, list);
    expect(listEventsSince(ctx, mark)).toMatchObject([{ type: 'work.updated', entity: 'node', entityId: String(tests.id), actor: 'session:s1', data: { nodeId: tests.id } }]);
    mark = maxEventId(ctx);
    setTasks(ctx, 'session:s1', 's1', tests.id, list);
    expect(listEventsSince(ctx, mark)).toEqual([]);
  });

  it('refuses a session that is not tracked, an unknown node and a node outside its project, with hints a main session can act on', () => {
    const { ctx, project, tests } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    const refusal = (fn: () => unknown): { message: string; hint?: string } => {
      try {
        fn();
      } catch (err) {
        return err as { message: string; hint?: string };
      }
      throw new Error('expected a refusal');
    };
    const untracked = refusal(() => setTasks(ctx, 'session:nobody', 'nobody', tests.id, []));
    const outside = refusal(() => setTasks(ctx, 'session:s1', 's1', other.rootNodeId, []));
    const unknown = refusal(() => setTasks(ctx, 'session:s1', 's1', 99999, []));
    expect(untracked.message).toBe('Session nobody is not tracked');
    expect(outside.message).toBe(`#${other.rootNodeId} is not in this session's project`);
    expect(unknown.message).toBe('Node #99999 not found');
    expect(untracked.hint).toMatch(/--session/);
    expect(outside.hint).toBe(`Find the right step id with the CLI command: outline ${project.slug}`);
    expect(unknown.hint).toBe(outside.hint);
    // The main session has none of the scribe's tools, and a "#" would start a comment in its shell.
    for (const hint of [untracked.hint, outside.hint, unknown.hint]) {
      expect(hint).not.toMatch(/enroll_session|get_outline|#/);
    }
  });
});

describe('the queue', () => {
  it('keeps the planned order and leaves out done and dropped nodes as it is read', () => {
    const { ctx, project, play, tests, store } = setup();
    expect(setQueue(ctx, 'scribe:s1', project.slug, [tests.id, store.id, play.id, tests.id]).queue).toEqual([tests.id, store.id, play.id]);
    updateNode(ctx, 'test', play.id, { status: 'done' });
    updateNode(ctx, 'test', store.id, { status: 'dropped' });
    expect(getProjectSnapshot(ctx, project.slug).project.queue).toEqual([tests.id]);
    // A node that is reopened takes its old place again.
    updateNode(ctx, 'test', play.id, { status: 'active' });
    expect(getProjectSnapshot(ctx, project.slug).project.queue).toEqual([tests.id, play.id]);
    expect(setQueue(ctx, 'scribe:s1', project.slug, []).queue).toEqual([]);
  });

  it('refuses a node outside the project, naming it', () => {
    const { ctx, project, tests } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    expect(() => setQueue(ctx, 'scribe:s1', project.slug, [tests.id, other.rootNodeId])).toThrow(`#${other.rootNodeId} is not in project ingame`);
    expect(() => setQueue(ctx, 'scribe:s1', project.slug, [99999])).toThrow('#99999 is not in project ingame');
    expect(getProjectSnapshot(ctx, project.slug).project.queue).toEqual([]);
  });

  it('records project.updated with the change, and nothing when the order is the same', () => {
    const { ctx, project, tests, store } = setup();
    let mark = maxEventId(ctx);
    setQueue(ctx, 'scribe:s1', project.slug, [tests.id, store.id]);
    expect(listEventsSince(ctx, mark)).toMatchObject([
      { type: 'project.updated', entity: 'project', entityId: String(project.id), actor: 'scribe:s1', data: { changes: { queue: { from: [], to: [tests.id, store.id] } } } },
    ]);
    mark = maxEventId(ctx);
    setQueue(ctx, 'scribe:s1', project.slug, [tests.id, store.id]);
    expect(listEventsSince(ctx, mark)).toEqual([]);
  });
});
