import { describe, expect, it } from 'vitest';
import { clearAsk, listProjectAsks, markAnswersDelivered, raiseAsk, undeliveredAnswers } from '../../src/server/repo/asks';
import { listEventsSince } from '../../src/server/repo/events';
import { addNodes, requireNode, updateNode } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
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

  it('stores an untracked session id as no session instead of failing the foreign key', () => {
    const { ctx, step } = setup();
    expect(raiseAsk(ctx, 'session:ghost', { nodeId: step.id, kind: 'question', text: 'Q', sessionId: 'ghost' }).sessionId).toBeNull();
  });
});
