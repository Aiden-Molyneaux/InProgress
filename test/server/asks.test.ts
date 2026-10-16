import { describe, expect, it } from 'vitest';
import { clearAsk, listProjectAsks, markAnswersDelivered, owedAnswers, raiseAsk, raiseAskDetailed, requireAsk, undeliveredAnswers } from '../../src/server/repo/asks';
import { lastProjectEvent, listEventsSince } from '../../src/server/repo/events';
import { addNodes, requireNode, updateNode } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { STALE_SESSION_MS } from '../../src/core/types';
import { makeCtx } from '../helpers';

function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'P' });
  const [step] = addNodes(ctx, 'scribe:s1', { parentId: project.rootNodeId, nodes: [{ title: 'Step' }] });
  return { ctx, project, step };
}

describe('asks', () => {
  it('raise is idempotent on node, kind and text, and records one ask.raised', () => {
    const { ctx, step } = setup();
    const a = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?' });
    const b = raiseAsk(ctx, 'session:s2', { nodeId: step.id, kind: 'question', text: 'Which port?' });
    expect(b.id).toBe(a.id);
    expect(listEventsSince(ctx, 0).filter((e) => e.type === 'ask.raised')).toHaveLength(1);
    const c = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'review', text: 'Which port?' });
    expect(c.id).not.toBe(a.id);
  });

  it('refuses an unknown kind, an empty text and a root node', () => {
    const { ctx, project, step } = setup();
    expect(() => raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'release' as never, text: 'x' })).toThrow(/Unknown ask kind/);
    expect(() => raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text: '  ' })).toThrow(/empty/);
    expect(() => raiseAsk(ctx, 'w', { nodeId: project.rootNodeId, kind: 'question', text: 'x' })).toThrow(/root/);
  });

  it('clear keeps the first clearedAt and clearedBy, takes the first non-empty answer, and records one ask.cleared', () => {
    const { ctx, step } = setup();
    const a = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Q' });
    const first = clearAsk(ctx, 'window', a.id);
    const second = clearAsk(ctx, 'scribe:s9', a.id, 'Use 4410');
    expect(second).toMatchObject({ clearedAt: first.clearedAt, clearedBy: 'window', answer: 'Use 4410' });
    const third = clearAsk(ctx, 'scribe:s9', a.id, 'Another');
    expect(third.answer).toBe('Use 4410');
    expect(listEventsSince(ctx, 0).filter((e) => e.type === 'ask.cleared')).toHaveLength(1);
  });

  it('clearing the ask on a question node marks the node done with the answer, or "Answered"', () => {
    const { ctx, project } = setup();
    const [q1, q2] = addNodes(ctx, 'scribe:s1', { parentId: project.rootNodeId, nodes: [{ title: 'Pick?', kind: 'question', assignee: 'me' }, { title: 'Other?', kind: 'question', assignee: 'me' }] });
    clearAsk(ctx, 'window', raiseAsk(ctx, 'w', { nodeId: q1.id, kind: 'question', text: 'Pick?' }).id, 'Blue');
    clearAsk(ctx, 'window', raiseAsk(ctx, 'w', { nodeId: q2.id, kind: 'question', text: 'Other?' }).id);
    expect(requireNode(ctx, q1.id)).toMatchObject({ status: 'done', outcome: 'Blue' });
    expect(requireNode(ctx, q2.id)).toMatchObject({ status: 'done', outcome: 'Answered' });
  });

  it('dropping a step clears its open asks in the same write; finishing it does not', () => {
    const { ctx, project } = setup();
    const [d, f] = addNodes(ctx, 'scribe:s1', { parentId: project.rootNodeId, nodes: [{ title: 'D' }, { title: 'F' }] });
    raiseAsk(ctx, 'w', { nodeId: d.id, kind: 'question', text: 'Q' });
    raiseAsk(ctx, 'w', { nodeId: f.id, kind: 'review', text: 'Look' });
    updateNode(ctx, 'scribe:s1', d.id, { status: 'dropped' });
    updateNode(ctx, 'scribe:s1', f.id, { status: 'done' });
    const asks = listProjectAsks(ctx, project.id);
    expect(asks.find((a) => a.nodeId === d.id)).toMatchObject({ clearedBy: 'scribe:s1' });
    expect(asks.find((a) => a.nodeId === f.id)?.clearedAt).toBeNull();
  });

  it('lists open asks and those cleared in the last 7 days, in the snapshot too', () => {
    const { ctx, project, step } = setup();
    const old = raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text: 'old' });
    clearAsk(ctx, 'window', old.id);
    ctx.db.prepare('UPDATE asks SET cleared_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', old.id);
    raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text: 'open' });
    expect(getProjectSnapshot(ctx, project.id).asks.map((a) => a.text)).toEqual(['open']);
  });

  it('gives each cleared answer to its raising session once', () => {
    const { ctx, project, step } = setup();
    const a = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Q', sessionId: null });
    clearAsk(ctx, 'window', a.id, 'Yes');
    expect(undeliveredAnswers(ctx, 's1')).toEqual([]); // no session id on the ask
    // A tracked session: its row exists, so the ask keeps the session id.
    const ts = ctx.now();
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', ?, 'working', ?, ?)").run(project.id, ts, ts);
    const b = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Q2', sessionId: 's1' });
    expect(b.sessionId).toBe('s1');
    expect(undeliveredAnswers(ctx, 's1')).toEqual([]); // not cleared yet
    clearAsk(ctx, 'window', b.id, 'Yes');
    expect(undeliveredAnswers(ctx, 's1').map((x) => x.id)).toEqual([b.id]);
    markAnswersDelivered(ctx, [b.id]);
    expect(undeliveredAnswers(ctx, 's1')).toEqual([]);
  });

  it('routes an answered ask to the step driver only when no live session raised it, and owedAnswers lists the same', () => {
    const { ctx, project, step } = setup();
    const ts = ctx.now();
    const add = (id: string, state: string, seen = ts) =>
      ctx.db.prepare('INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, project.id, state, ts, seen);
    add('drv', 'working');
    add('live', 'working');
    add('gone', 'ended');
    // Not ended, but silent one millisecond past the stale limit: not live.
    add('quiet', 'working', new Date(Date.parse(ts) - STALE_SESSION_MS - 1).toISOString());
    ctx.db.prepare("UPDATE nodes SET driver_session_id = 'drv' WHERE id = ?").run(step.id);
    ctx.db.prepare("UPDATE sessions SET focus_node_id = ? WHERE id = 'drv'").run(step.id);
    const raise = (text: string, sessionId: string | null, answer: string) => {
      const a = raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text, sessionId });
      return clearAsk(ctx, 'window', a.id, answer).id;
    };
    const fromGone = raise('gone', 'gone', 'yes');
    const fromNobody = raise('nobody', null, 'yes');
    const fromQuiet = raise('quiet', 'quiet', 'yes');
    raise('live', 'live', 'yes');
    raise('blank', 'gone', '');
    expect(undeliveredAnswers(ctx, 'drv').map((a) => a.id)).toEqual([fromGone, fromNobody, fromQuiet]);
    expect(owedAnswers(ctx, step.id).map((a) => a.id)).toEqual([fromGone, fromNobody, fromQuiet]);
    markAnswersDelivered(ctx, [fromGone]);
    expect(owedAnswers(ctx, step.id).map((a) => a.id)).toEqual([fromNobody, fromQuiet]);
    // A driver column left behind on a step that is no longer the session's focus routes nothing.
    ctx.db.prepare("UPDATE sessions SET focus_node_id = NULL WHERE id = 'drv'").run();
    expect(undeliveredAnswers(ctx, 'drv')).toEqual([]);
  });

  it('refuses an ask on a dropped step', () => {
    const { ctx, step } = setup();
    updateNode(ctx, 't', step.id, { status: 'dropped' });
    expect(() => raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text: 'Q' })).toThrow(/is dropped/);
  });

  it('dropping a step with an open ask leaves node.updated as the newest event', () => {
    const { ctx, project, step } = setup();
    raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text: 'Q' });
    updateNode(ctx, 't', step.id, { status: 'dropped' });
    expect(lastProjectEvent(ctx, project.id)?.type).toBe('node.updated');
    expect(listProjectAsks(ctx, project.id)[0].clearedAt).not.toBeNull();
  });

  it('finishing a question node with updateNode clears its ask with the outcome as the answer', () => {
    const { ctx, project } = setup();
    const [q] = addNodes(ctx, 't', { parentId: project.rootNodeId, nodes: [{ title: 'Pick?', kind: 'question', assignee: 'me' }] });
    raiseAsk(ctx, 'w', { nodeId: q.id, kind: 'question', text: 'Pick?' });
    updateNode(ctx, 't', q.id, { status: 'done', outcome: 'Blue' });
    expect(listProjectAsks(ctx, project.id)[0]).toMatchObject({ answer: 'Blue', clearedBy: 't' });
    expect(requireNode(ctx, q.id)).toMatchObject({ status: 'done', outcome: 'Blue' });
  });

  it('dropping a question node clears its ask and leaves the node dropped', () => {
    const { ctx, project } = setup();
    const [q] = addNodes(ctx, 't', { parentId: project.rootNodeId, nodes: [{ title: 'Pick?', kind: 'question', assignee: 'me' }] });
    raiseAsk(ctx, 'w', { nodeId: q.id, kind: 'question', text: 'Pick?' });
    updateNode(ctx, 't', q.id, { status: 'dropped' });
    expect(listProjectAsks(ctx, project.id)[0].clearedAt).not.toBeNull();
    expect(requireNode(ctx, q.id).status).toBe('dropped');
  });

  it('does not find the asks of a deleted project', () => {
    const { ctx, project, step } = setup();
    const a = raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text: 'Q', sessionId: null });
    ctx.db.prepare("UPDATE projects SET status = 'archived', deleted_at = ? WHERE id = ?").run(ctx.now(), project.id);
    expect(() => requireAsk(ctx, a.id)).toThrow(/not found/);
  });

  it('stores an untracked session id as no session instead of failing the foreign key', () => {
    const { ctx, step } = setup();
    expect(raiseAsk(ctx, 'session:ghost', { nodeId: step.id, kind: 'question', text: 'Q', sessionId: 'ghost' }).sessionId).toBeNull();
  });
});

describe('raiseAskDetailed: what a raise tells its caller', () => {
  it('says when the session is not tracked (stored as no session) and when it joined an open ask', () => {
    const { ctx, step } = setup();
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', 1, 'idle', ?, ?)").run(ctx.now(), ctx.now());
    const fresh = raiseAskDetailed(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?', sessionId: 's1' });
    expect(fresh).toMatchObject({ joined: false, untracked: false, ask: { sessionId: 's1' } });
    const joined = raiseAskDetailed(ctx, 'session:s2', { nodeId: step.id, kind: 'question', text: 'Which port?', sessionId: 's2' });
    // Joined: the row is the first raiser's, and s2 is not tracked either.
    expect(joined).toMatchObject({ joined: true, untracked: true, ask: { id: fresh.ask.id, sessionId: 's1' } });
    const stray = raiseAskDetailed(ctx, 'session:ghost', { nodeId: step.id, kind: 'review', text: 'Look', sessionId: 'ghost' });
    expect(stray).toMatchObject({ joined: false, untracked: true, ask: { sessionId: null } });
    // No session given at all (the window, the scribe): not "untracked", it never claimed to be a session.
    expect(raiseAskDetailed(ctx, 'window', { nodeId: step.id, kind: 'permission', text: 'Allow' })).toMatchObject({ joined: false, untracked: false });
    // The plain raise keeps returning the ask alone.
    expect(raiseAsk(ctx, 'window', { nodeId: step.id, kind: 'permission', text: 'Allow' })).not.toHaveProperty('joined');
  });
});
