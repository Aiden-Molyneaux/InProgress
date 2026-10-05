import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx, type Ctx } from '../../src/server/db/tx';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { addNodes, deleteNode, updateNode } from '../../src/server/repo/nodes';
import { STALE_SESSION_MS, type QueueEntry } from '../../src/core/types';
import { addBinding, createProject, getProjectById, setQueue } from '../../src/server/repo/projects';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { pruneWorkItems, setTasks } from '../../src/server/repo/work';
import { enrollSession, handleHookEvent, setFocus, type HookEventInput } from '../../src/server/session-flow';

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
      { id: expect.any(Number), nodeId: play.id, sessionId: 's1', agentId: '', subject: 'Write the design note', status: 'pending', blocks: [], position: 1, updatedAt: '2026-10-02T09:00:00.000Z', endedAt: null },
      { id: expect.any(Number), nodeId: play.id, sessionId: 's1', agentId: '', subject: 'Read it before publishing', status: 'pending', blocks: [], position: 2, updatedAt: '2026-10-02T09:00:00.000Z', endedAt: null },
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

  it("keeps a session's tasks in view when it ends, with when it ended, and reads them as live again when it resumes", () => {
    const { hook, items, tick } = setup();
    hook(created('1', 'Write it'));
    tick(5 * MIN);
    hook({ event: 'end' });
    expect(items()).toEqual([expect.objectContaining({ subject: 'Write it', endedAt: '2026-10-02T09:05:00.000Z' })]);
    hook({ event: 'start', source: 'resume', cwd: 'C:/personal/InGame' });
    expect(items()).toEqual([expect.objectContaining({ subject: 'Write it', endedAt: null })]);
  });

  it('goes with its node when the node is deleted', () => {
    const { ctx, store, hook, items } = setup();
    hook(created('1', `#${store.id} Draft the listing`));
    ctx.db.prepare('DELETE FROM nodes WHERE id = ?').run(store.id);
    expect(items()).toEqual([]);
  });
});

describe('the trail of ended work in the snapshot', () => {
  it("shows an ended session's tasks for 7 days after it ended, then leaves them out even before a prune", () => {
    const { hook, items, tick } = setup();
    hook(created('1', 'Write it'));
    hook(updated('1', { status: 'in_progress' }));
    hook({ event: 'end' });
    tick(7 * DAY - MIN);
    expect(items()).toEqual([expect.objectContaining({ subject: 'Write it', status: 'in_progress', endedAt: '2026-10-02T09:00:00.000Z' })]);
    tick(2 * MIN);
    expect(items()).toEqual([]);
  });

  it("dates an expired session's end by when it was last seen, not when the expiry ran", () => {
    const { ctx, project, play, hook, tick } = setup();
    hook(created('1', 'Write it'));
    tick(30 * MIN);
    hook({ event: 'stop' });
    tick(16 * 60 * MIN);
    expect(getProjectSnapshot(ctx, project.slug).pastSessions).toEqual([{ id: 's1', title: null, focusNodeId: play.id, endedAt: '2026-10-02T09:30:00.000Z' }]);
    // The trail itself still lasts 7 days from the expiry, as the prune counts it.
    tick(7 * DAY - MIN);
    expect(getProjectSnapshot(ctx, project.slug).pastSessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('leaves out the tasks of a session that moved to another project, whether it is live or ended', () => {
    const { ctx, hook, items } = setup();
    hook(created('1', 'Write it'));
    const other = createProject(ctx, 'test', { name: 'Other' });
    enrollSession(ctx, 'scribe:s1', 's1', other.slug);
    expect(items()).toEqual([]);
    hook({ event: 'end' });
    expect(items()).toEqual([]);
    expect(getProjectSnapshot(ctx, other.slug).workItems).toEqual([]);
  });

  it('names the ended sessions the trail needs: ones that left tasks or stopped subagents in the last 7 days', () => {
    const { ctx, project, play, hook, tick } = setup();
    const startIn = (id: string) => handleHookEvent(ctx, id, { event: 'start', source: 'startup', cwd: 'C:/personal/InGame', title: `Session ${id}` });
    hook(created('1', 'Left by s1'));
    startIn('s2');
    hook({ event: 'subagent-start', agentId: 'b1', agentType: 'general-purpose' }, 's2');
    startIn('s3');
    startIn('s4');
    hook(created('1', 'Still going'), 's4');
    hook({ event: 'end' });
    tick(MIN);
    hook({ event: 'end' }, 's2');
    hook({ event: 'end' }, 's3');
    const past = () => getProjectSnapshot(ctx, project.slug).pastSessions;
    // Newest first. s3 left nothing behind, and s4 is still live.
    expect(past()).toEqual([
      { id: 's2', title: 'Session s2', focusNodeId: null, endedAt: '2026-10-02T09:01:00.000Z' },
      { id: 's1', title: null, focusNodeId: play.id, endedAt: '2026-10-02T09:00:00.000Z' },
    ]);
    // s4 keeps working meanwhile, so it never goes stale.
    tick(7 * DAY - MIN + 1000);
    hook({ event: 'prompt' }, 's4');
    expect(past().map((s) => s.id)).toEqual(['s2']);
    tick(MIN);
    hook({ event: 'prompt' }, 's4');
    expect(past()).toEqual([]);
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
    expect(res.tasks.map((i) => [i.nodeId, i.subject, i.status, i.endedAt])).toEqual([[play.id, 'Sign the bundle', 'in_progress', null]]);
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
  const S1 = { sessionId: 's1' };
  const S2 = { sessionId: 's2' };
  /** Queue entries owned by `sessionId` (null: unowned), as the API reads them. */
  const owned = (sessionId: string | null, ...ids: number[]): QueueEntry[] => ids.map((nodeId) => ({ nodeId, sessionId }));
  const stored = (ctx: Ctx, projectId: number): unknown => JSON.parse(ctx.db.prepare('SELECT queue FROM projects WHERE id = ?').pluck().get(projectId) as string);
  const store = (ctx: Ctx, projectId: number, value: unknown) => ctx.db.prepare('UPDATE projects SET queue = ? WHERE id = ?').run(JSON.stringify(value), projectId);
  /** setup() plus a second live session s2 in the project and five more open steps. */
  function twoSessions() {
    const t = setup();
    t.hook({ event: 'start', source: 'startup', cwd: 'C:/personal/InGame' }, 's2');
    const [a, b, c, d, e] = addNodes(t.ctx, 'test', { parentId: t.project.rootNodeId, nodes: ['A', 'B', 'C', 'D', 'E'].map((title) => ({ title })) });
    const queue = () => getProjectById(t.ctx, t.project.id)!.queue;
    return { ...t, a, b, c, d, e, queue };
  }

  it('keeps the planned order and leaves out done and dropped nodes as it is read', () => {
    const { ctx, project, play, tests, store: listing } = setup();
    expect(setQueue(ctx, 'scribe:s1', project.slug, [tests.id, listing.id, play.id, tests.id], 'unowned').queue).toEqual(owned(null, tests.id, listing.id, play.id));
    updateNode(ctx, 'test', play.id, { status: 'done' });
    updateNode(ctx, 'test', listing.id, { status: 'dropped' });
    expect(getProjectSnapshot(ctx, project.slug).project.queue).toEqual(owned(null, tests.id));
    // A node that is reopened takes its old place again.
    updateNode(ctx, 'test', play.id, { status: 'active' });
    expect(getProjectSnapshot(ctx, project.slug).project.queue).toEqual(owned(null, tests.id, play.id));
    expect(setQueue(ctx, 'scribe:s1', project.slug, [], 'unowned').queue).toEqual([]);
  });

  it('reads both stored shapes, a bare number as an unowned entry, and skips anything else', () => {
    const { ctx, project, signing, play, tests, store: listing } = setup();
    store(ctx, project.id, [tests.id, listing.id]);
    expect(getProjectById(ctx, project.id)!.queue).toEqual(owned(null, tests.id, listing.id));
    store(ctx, project.id, [{ node: tests.id, session: 's1' }, { node: listing.id, session: null }, play.id, { node: 'x', session: null }, -2, { node: signing.id, session: 7 }, 'junk', tests.id]);
    expect(getProjectById(ctx, project.id)!.queue).toEqual([{ nodeId: tests.id, sessionId: 's1' }, { nodeId: listing.id, sessionId: null }, { nodeId: play.id, sessionId: null }]);
  });

  it('stores every entry as an object on every write', () => {
    const { ctx, project, tests, store: listing } = setup();
    store(ctx, project.id, [listing.id]);
    setQueue(ctx, 'scribe:s1', project.slug, [tests.id], S1);
    expect(stored(ctx, project.id)).toEqual([{ node: tests.id, session: 's1' }, { node: listing.id, session: null }]);
  });

  it("replaces only the writing session's entries, in place of its first old one, or after the last owned entry", () => {
    const { ctx, project, a, b, c, d, e, queue } = twoSessions();
    setQueue(ctx, 'scribe:s1', project.slug, [a.id, b.id], S1);
    setQueue(ctx, 'scribe:s2', project.slug, [c.id], S2);
    setQueue(ctx, 'scribe:s1', project.slug, [d.id], 'unowned');
    expect(queue()).toEqual([...owned('s1', a.id, b.id), ...owned('s2', c.id), ...owned(null, d.id)]);
    setQueue(ctx, 'scribe:s1', project.slug, [e.id, a.id], S1);
    expect(queue()).toEqual([...owned('s1', e.id, a.id), ...owned('s2', c.id), ...owned(null, d.id)]);
    // An empty list clears only that session's entries.
    setQueue(ctx, 'scribe:s1', project.slug, [], S1);
    expect(queue()).toEqual([...owned('s2', c.id), ...owned(null, d.id)]);
    // With none of its own, a session's entries go after the last owned entry, ahead of the unowned ones.
    setQueue(ctx, 'scribe:s1', project.slug, [a.id], S1);
    expect(queue()).toEqual([...owned('s2', c.id), ...owned('s1', a.id), ...owned(null, d.id)]);
    setQueue(ctx, 'scribe:s2', project.slug, [b.id, c.id], S2);
    expect(queue()).toEqual([...owned('s2', b.id, c.id), ...owned('s1', a.id), ...owned(null, d.id)]);
  });

  it('rewrites a session\'s entries where its first one stood, not at the head', () => {
    const { ctx, project, a, c, d, e, queue } = twoSessions();
    setQueue(ctx, 'scribe:s2', project.slug, [c.id], S2);
    setQueue(ctx, 'scribe:s1', project.slug, [a.id], S1);
    setQueue(ctx, 'scribe:s1', project.slug, [d.id], 'unowned');
    expect(queue()).toEqual([...owned('s2', c.id), ...owned('s1', a.id), ...owned(null, d.id)]);
    setQueue(ctx, 'scribe:s1', project.slug, [e.id, a.id], S1);
    expect(queue()).toEqual([...owned('s2', c.id), ...owned('s1', e.id, a.id), ...owned(null, d.id)]);
  });

  it("keeps other owners' finished entries in store, so a step that is reopened takes its old place again", () => {
    const { ctx, project, a, b, c, d, queue } = twoSessions();
    setQueue(ctx, 'scribe:s2', project.slug, [a.id, b.id], S2);
    updateNode(ctx, 'test', b.id, { status: 'done' });
    setQueue(ctx, 'scribe:s1', project.slug, [c.id], S1);
    setQueue(ctx, 'scribe:s1', project.slug, [d.id], 'unowned');
    expect(stored(ctx, project.id)).toContainEqual({ node: b.id, session: 's2' });
    expect(queue()).toEqual([...owned('s2', a.id), ...owned('s1', c.id), ...owned(null, d.id)]);
    updateNode(ctx, 'test', b.id, { status: 'active' });
    expect(queue()).toEqual([...owned('s2', a.id, b.id), ...owned('s1', c.id), ...owned(null, d.id)]);
  });

  it("replaces only the unowned entries for 'unowned', after every owned one", () => {
    const { ctx, project, a, b, c, d, queue } = twoSessions();
    setQueue(ctx, 'scribe:s1', project.slug, [c.id, d.id], 'unowned');
    setQueue(ctx, 'scribe:s1', project.slug, [a.id], S1);
    setQueue(ctx, 'scribe:s1', project.slug, [d.id, b.id], 'unowned');
    expect(queue()).toEqual([...owned('s1', a.id), ...owned(null, d.id, b.id)]);
  });

  it('keeps a node in the queue once: claiming it takes it from wherever it was', () => {
    const { ctx, project, a, b, c, queue } = twoSessions();
    setQueue(ctx, 'scribe:s1', project.slug, [a.id, b.id], S1);
    setQueue(ctx, 'scribe:s1', project.slug, [c.id], 'unowned');
    setQueue(ctx, 'scribe:s2', project.slug, [b.id, c.id, b.id], S2);
    expect(queue()).toEqual([...owned('s1', a.id), ...owned('s2', b.id, c.id)]);
    setQueue(ctx, 'scribe:s1', project.slug, [a.id], 'unowned');
    expect(queue()).toEqual([...owned('s2', b.id, c.id), ...owned(null, a.id)]);
  });

  it('keeps owned entries ahead of unowned ones, whatever order was stored', () => {
    const { ctx, project, a, b, d, queue } = twoSessions();
    store(ctx, project.id, [{ node: d.id, session: null }, { node: a.id, session: 's2' }]);
    setQueue(ctx, 'scribe:s1', project.slug, [b.id], S1);
    expect(queue()).toEqual([...owned('s2', a.id), ...owned('s1', b.id), ...owned(null, d.id)]);
  });

  it('stores a queue: from an ended session as unowned, at the head of the unowned part', () => {
    const { ctx, project, hook, a, b, c, d, e, queue } = twoSessions();
    setQueue(ctx, 'scribe:s1', project.slug, [a.id], S1);
    setQueue(ctx, 'scribe:s1', project.slug, [d.id, e.id], 'unowned');
    hook({ event: 'end' }, 's2');
    setQueue(ctx, 'scribe:s2', project.slug, [b.id, c.id, e.id], S2);
    expect(queue()).toEqual([...owned('s1', a.id), ...owned(null, b.id, c.id, e.id, d.id)]);
  });

  it('stores a queue: from a session gone stale, not yet expired, as unowned, with its old entries released after it', () => {
    const { ctx, project, hook, tick, a, b, c, d, queue } = twoSessions();
    setQueue(ctx, 'scribe:s2', project.slug, [c.id], S2);
    setQueue(ctx, 'scribe:s1', project.slug, [d.id], 'unowned');
    tick(STALE_SESSION_MS + MIN);
    // s1 is heard from again; s2 is past the stale limit but still reads idle (expiry runs only on a snapshot read).
    hook({ event: 'prompt' });
    setQueue(ctx, 'scribe:s1', project.slug, [a.id], S1);
    setQueue(ctx, 'scribe:s2', project.slug, [b.id], S2);
    // What releaseQueue would leave: none of it owned, all of it ahead of the older unowned entries.
    expect(queue()).toEqual([...owned('s1', a.id), ...owned(null, b.id, c.id, d.id)]);
  });

  it('drops released entries whose step is no longer open: no owner is left to reopen them into place', () => {
    const { ctx, project, hook, a, b, c, d, e, queue } = twoSessions();
    setQueue(ctx, 'scribe:s1', project.slug, [a.id, b.id, c.id, e.id], S1);
    setQueue(ctx, 'scribe:s1', project.slug, [d.id], 'unowned');
    updateNode(ctx, 'test', b.id, { status: 'done' });
    updateNode(ctx, 'test', c.id, { status: 'dropped' });
    deleteNode(ctx, 'test', e.id, false);
    hook({ event: 'end' });
    expect(stored(ctx, project.id)).toEqual([{ node: a.id, session: null }, { node: d.id, session: null }]);
    updateNode(ctx, 'test', b.id, { status: 'active' });
    expect(queue()).toEqual(owned(null, a.id, d.id));
  });

  it("turns an ended session's entries unowned, at the head of the unowned part, in order", () => {
    const { ctx, project, hook, a, b, c, d, queue } = twoSessions();
    setQueue(ctx, 'scribe:s1', project.slug, [a.id, b.id], S1);
    setQueue(ctx, 'scribe:s2', project.slug, [c.id], S2);
    setQueue(ctx, 'scribe:s1', project.slug, [d.id], 'unowned');
    const mark = maxEventId(ctx);
    hook({ event: 'end' });
    expect(queue()).toEqual([...owned('s2', c.id), ...owned(null, a.id, b.id, d.id)]);
    // Recorded in the end's own write, before the session's event, so the activity strip still says the session ended.
    expect(listEventsSince(ctx, mark)).toMatchObject([
      { type: 'project.updated', actor: 'hook:end', projectId: project.id, data: { changes: { queue: { from: [...owned('s1', a.id, b.id), ...owned('s2', c.id), ...owned(null, d.id)] } } } },
      { type: 'session.updated', entityId: 's1', data: { state: 'ended' } },
    ]);
  });

  it('records nothing for the queue when the ended session owned no entries', () => {
    const { ctx, project, hook, a, queue } = twoSessions();
    setQueue(ctx, 'scribe:s1', project.slug, [a.id], S1);
    const mark = maxEventId(ctx);
    hook({ event: 'end' }, 's2');
    expect(listEventsSince(ctx, mark).map((e) => e.type)).toEqual(['session.updated']);
    expect(queue()).toEqual(owned('s1', a.id));
  });

  it("turns a stale session's entries unowned when it expires", () => {
    const { ctx, project, hook, tick, a, b, c, queue } = twoSessions();
    setQueue(ctx, 'scribe:s2', project.slug, [b.id, c.id], S2);
    setQueue(ctx, 'scribe:s1', project.slug, [a.id], 'unowned');
    tick(STALE_SESSION_MS + MIN);
    hook({ event: 'prompt' });
    const mark = maxEventId(ctx);
    getProjectSnapshot(ctx, project.slug);
    expect(queue()).toEqual(owned(null, b.id, c.id, a.id));
    expect(listEventsSince(ctx, mark)).toMatchObject([
      { type: 'project.updated', actor: 'system', projectId: project.id },
      { type: 'session.updated', entityId: 's2', data: { state: 'ended' } },
    ]);
  });

  it('keeps the stored order of sessions that expire together, as Up next showed them before', () => {
    const { ctx, project, hook, tick, a, b, c, d, queue } = twoSessions();
    hook({ event: 'start', source: 'startup', cwd: 'C:/personal/InGame' }, 's3');
    setQueue(ctx, 'scribe:s2', project.slug, [a.id, b.id], S2);
    setQueue(ctx, 'scribe:s3', project.slug, [c.id], { sessionId: 's3' });
    setQueue(ctx, 'scribe:s1', project.slug, [d.id], 'unowned');
    tick(STALE_SESSION_MS + MIN);
    hook({ event: 'prompt' });
    getProjectSnapshot(ctx, project.slug);
    expect(queue()).toEqual(owned(null, a.id, b.id, c.id, d.id));
  });

  it('shows the released queue in the very snapshot that expires the session', () => {
    const { ctx, project, hook, tick, a, b, c } = twoSessions();
    setQueue(ctx, 'scribe:s2', project.slug, [b.id], S2);
    setQueue(ctx, 'scribe:s1', project.slug, [a.id], S1);
    setQueue(ctx, 'scribe:s1', project.slug, [c.id], 'unowned');
    tick(STALE_SESSION_MS + MIN);
    hook({ event: 'prompt' });
    const snap = getProjectSnapshot(ctx, project.slug);
    expect(snap.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(snap.project.queue).toEqual([...owned('s1', a.id), ...owned(null, b.id, c.id)]);
  });

  it("turns a session's entries unowned in its old project when it moves to another", () => {
    const { ctx, project, a, b, d, queue } = twoSessions();
    const other = createProject(ctx, 'test', { name: 'Other' });
    setQueue(ctx, 'scribe:s2', project.slug, [a.id, b.id], S2);
    setQueue(ctx, 'scribe:s1', project.slug, [d.id], 'unowned');
    const mark = maxEventId(ctx);
    enrollSession(ctx, 'scribe:s2', 's2', other.slug);
    expect(queue()).toEqual(owned(null, a.id, b.id, d.id));
    expect(listEventsSince(ctx, mark).filter((e) => e.type === 'project.updated')).toMatchObject([{ projectId: project.id, entityId: String(project.id) }]);
    // Enrolling again where it already is moves nothing.
    setQueue(ctx, 'scribe:s1', project.slug, [b.id], S1);
    enrollSession(ctx, 'scribe:s1', 's1', project.slug);
    expect(queue()).toEqual([...owned('s1', b.id), ...owned(null, a.id, d.id)]);
  });

  it('refuses a node outside the project, naming it', () => {
    const { ctx, project, tests } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    expect(() => setQueue(ctx, 'scribe:s1', project.slug, [tests.id, other.rootNodeId], S1)).toThrow(`#${other.rootNodeId} is not in project ingame`);
    expect(() => setQueue(ctx, 'scribe:s1', project.slug, [99999], 'unowned')).toThrow('#99999 is not in project ingame');
    expect(getProjectSnapshot(ctx, project.slug).project.queue).toEqual([]);
  });

  it('refuses a session not tracked in the project, with a hint', () => {
    const { ctx, project, tests } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    enrollSession(ctx, 'scribe:s3', 's3', other.slug);
    for (const sessionId of ['nobody', 's3']) {
      let err: unknown;
      try {
        setQueue(ctx, `scribe:${sessionId}`, project.slug, [tests.id], { sessionId });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ status: 400, message: `Session ${sessionId} is not tracked in project ingame`, hint: expect.stringContaining('enroll_session') });
    }
    expect(stored(ctx, project.id)).toEqual([]);
  });

  it('records project.updated with the change, and nothing when the stored queue is the same', () => {
    const { ctx, project, tests, store: listing } = setup();
    let mark = maxEventId(ctx);
    setQueue(ctx, 'scribe:s1', project.slug, [tests.id, listing.id], S1);
    expect(listEventsSince(ctx, mark)).toMatchObject([
      { type: 'project.updated', entity: 'project', entityId: String(project.id), actor: 'scribe:s1', data: { changes: { queue: { from: [], to: owned('s1', tests.id, listing.id) } } } },
    ]);
    mark = maxEventId(ctx);
    setQueue(ctx, 'scribe:s1', project.slug, [tests.id, listing.id], S1);
    expect(listEventsSince(ctx, mark)).toEqual([]);
  });
});
