import { describe, expect, it } from 'vitest';
import { isAidens } from '../../src/core/lead';
import { expectedPrefix } from '../../src/core/title';
import { renderStatusLine } from '../../src/server/briefing';
import { stepBlock } from '../../src/server/briefing-scoped';
import { asksToRemind, clearAsk, openAsksBy, raiseAsk, raiseAskDetailed } from '../../src/server/repo/asks';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, changeProject, createProject, listProjectSummaries } from '../../src/server/repo/projects';
import { findSession } from '../../src/server/repo/sessions';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { handleHookEvent } from '../../src/server/session-flow';
import { makeCtx } from '../helpers';

/** A scoped project with a step, and a session s1 focused on it. */
function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Build tabs', status: 'active' }] });
  changeProject(ctx, 'test', project.slug, { briefingMode: 'scoped' });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
  ctx.db.prepare('UPDATE sessions SET focus_node_id = ? WHERE id = ?').run(step.id, 's1');
  const snap = () => getProjectSnapshot(ctx, project.slug);
  const session = () => findSession(ctx, 's1')!;
  return { ctx, project, step, snap, session };
}

describe('one open ask per owner', () => {
  it('keeps a lead ask and an Aiden ask with the same kind and text as two rows, and re-raising joins its own', () => {
    const { ctx, step } = setup();
    const aiden = raiseAskDetailed(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?' });
    const lead = raiseAskDetailed(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'Which port?', owner: 'lead' });
    expect(lead.ask.id).not.toBe(aiden.ask.id);
    expect([aiden.joined, lead.joined]).toEqual([false, false]);
    expect(raiseAskDetailed(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'Which port?', owner: 'lead' })).toMatchObject({ joined: true, ask: { id: lead.ask.id, owner: 'lead' } });
    expect(raiseAskDetailed(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?' })).toMatchObject({ joined: true, ask: { id: aiden.ask.id, owner: 'aiden' } });
    expect(ctx.db.prepare('SELECT COUNT(*) FROM asks').pluck().get()).toBe(2);
  });
});

describe("a lead's ask", () => {
  it('stores no session whatever sessionId says, and is not an untracked raise', () => {
    const { ctx, step } = setup();
    const r = raiseAskDetailed(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'Send the draft', owner: 'lead', sessionId: 's1' });
    expect(r.ask.sessionId).toBeNull();
    expect(r.untracked).toBe(false);
    expect(raiseAskDetailed(ctx, 'session:s1', { nodeId: step.id, kind: 'review', text: 'Look', sessionId: 's1' }).ask.sessionId).toBe('s1');
  });

  it('refuses a due time that is not a date, and stores a good one as an ISO time', () => {
    const { ctx, step } = setup();
    expect(() => raiseAsk(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'x', owner: 'lead', dueAt: 'soon' })).toThrow(/The due time is not a date/);
    expect(raiseAsk(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'y', owner: 'lead', dueAt: '2026-12-01T10:00:00+02:00' }).dueAt).toBe('2026-12-01T08:00:00.000Z');
  });
});

describe('a lead-owned ask at every reader of open asks', () => {
  it('isAidens is true for aiden and for an owner it does not know, false for the lead', () => {
    expect(isAidens({ owner: 'aiden' })).toBe(true);
    expect(isAidens({ owner: 'lead' })).toBe(false);
    expect(isAidens({ owner: 'stranger' as never })).toBe(true);
  });

  it('is absent from the scoped step block and the scoped status line, and an Aiden ask on the same step is not', () => {
    const { ctx, step, snap, session } = setup();
    const promise = raiseAsk(ctx, 'lead', { nodeId: step.id, kind: 'review', text: 'Send Aiden the draft', owner: 'lead' });
    const block = stepBlock(snap(), step.id, session(), Date.parse(ctx.now())).join('\n');
    expect(block).not.toContain(`a${promise.id} `);
    expect(block).not.toContain('Asks on');
    expect(renderStatusLine(snap(), session())).not.toContain(`a${promise.id}`);
    const aiden = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?', sessionId: 's1' });
    expect(stepBlock(snap(), step.id, session(), Date.parse(ctx.now())).join('\n')).toContain(`a${aiden.id} ? "Which port?" (open`);
    const line = renderStatusLine(snap(), session());
    expect(line).toContain(`a${aiden.id} open`);
    expect(line).not.toContain(`a${promise.id}`);
  });

  it('leaves a cleared lead ask out of the scoped step block too', () => {
    const { ctx, step, snap, session } = setup();
    const promise = raiseAsk(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'Kept promise', owner: 'lead' });
    clearAsk(ctx, 'lead', promise.id);
    expect(stepBlock(snap(), step.id, session(), Date.parse(ctx.now())).join('\n')).not.toContain('Kept promise');
  });

  it('is not reminded by asksToRemind, and not read by the title rules', () => {
    const { ctx, step } = setup();
    const promise = raiseAsk(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'Send the draft', owner: 'lead' });
    // A stray session id on a lead row (an older build wrote one) must not make it the session's.
    ctx.db.prepare('UPDATE asks SET session_id = ? WHERE id = ?').run('s1', promise.id);
    const aiden = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?', sessionId: 's1' });
    expect(asksToRemind(ctx, 's1').map((a) => a.id)).toEqual([aiden.id]);
    expect(openAsksBy(ctx, 's1', step.id).map((a) => a.id)).toEqual([aiden.id]);
  });

  it('does not make the expected title BLOCKED or REVIEW', () => {
    const { ctx, step, snap, session } = setup();
    const q = raiseAsk(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'Send the draft', owner: 'lead' });
    const r = raiseAsk(ctx, 'lead', { nodeId: step.id, kind: 'review', text: 'Look at the draft', owner: 'lead' });
    ctx.db.prepare('UPDATE asks SET session_id = ? WHERE id IN (?, ?)').run('s1', q.id, r.id);
    const now = Date.parse(ctx.now());
    expect(expectedPrefix(session(), snap(), now)).not.toBe('BLOCKED');
    expect(expectedPrefix(session(), snap(), now)).not.toBe('REVIEW');
    raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?', sessionId: 's1' });
    expect(expectedPrefix(session(), snap(), now)).toBe('BLOCKED');
  });

  it('does not count in open_asks of the project summary, but an unknown owner does', () => {
    const { ctx, project, step } = setup();
    raiseAsk(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'Send the draft', owner: 'lead' });
    expect(listProjectSummaries(ctx).find((p) => p.id === project.id)!.openAsks).toBe(0);
    ctx.db.prepare("UPDATE asks SET owner = 'stranger'").run();
    expect(listProjectSummaries(ctx).find((p) => p.id === project.id)!.openAsks).toBe(1);
  });
});
