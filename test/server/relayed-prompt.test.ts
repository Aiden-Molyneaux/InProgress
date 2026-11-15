import { describe, expect, it } from 'vitest';
import { deriveBoard } from '../../src/core/board';
import { relayedLine } from '../../src/core/relay';
import { clearAsk, raiseAsk } from '../../src/server/repo/asks';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { briefingDue, findSession } from '../../src/server/repo/sessions';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { claimStep, enrollSession, handleHookEvent } from '../../src/server/session-flow';
import { makeCtx } from '../helpers';

const BOUND = 'C:/personal/InGame';
const REMINDER = 'If this prompt answers it';

/**
 * A project (led by Progresser unless `lead` is null) with a step that session s1 claimed, a prompt typed on it, then an
 * open question s1 raised there.
 */
function setup(lead: string | null = 'Progresser') {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, BOUND);
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Play app signing', status: 'active' }] });
  if (lead !== null) setProjectLead(ctx, 'window', project.slug, lead);
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: BOUND });
  claimStep(ctx, 'session:s1', 's1', step.id);
  handleHookEvent(ctx, 's1', { event: 'prompt', cwd: BOUND });
  const ask = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which keystore?', sessionId: 's1' });
  const session = () => findSession(ctx, 's1')!;
  const row = () => deriveBoard(getProjectSnapshot(ctx, project.id), Date.parse(ctx.now())).byId.get(step.id)!;
  const prompt = (extra: { relayed?: boolean; notice?: boolean } = {}, id = 's1') => handleHookEvent(ctx, id, { event: 'prompt', cwd: BOUND, ...extra }).context ?? '';
  return { ctx, project, step, ask, session, row, prompt };
}

describe('a relayed prompt', () => {
  it('is not Aiden typing: lastPromptAt stays, the ask stays waiting, and the Relayed line replaces the reminder', () => {
    const t = setup();
    const before = t.session();
    expect(before.lastPromptAt).not.toBeNull();
    const context = t.prompt({ relayed: true });
    const after = t.session();
    expect(after.lastPromptAt).toBe(before.lastPromptAt);
    expect(after.promptsSinceUpdate).toBe(before.promptsSinceUpdate + 1);
    expect(after.state).toBe('working');
    const lines = context.split('\n');
    expect(lines[0]).toBe(relayedLine('Progresser'));
    expect(lines.some((l) => l.includes(REMINDER))).toBe(false);
    expect(context).not.toContain('more open asks');
    const row = t.row();
    expect(row.waiting.map((a) => a.id)).toEqual([t.ask.id]);
    expect(row.marks).not.toContain('answered_in_chat');
  });

  it('differs from a typed one, which moves lastPromptAt, prints the reminder and marks the ask answered in chat', () => {
    const t = setup();
    const before = t.session();
    const context = t.prompt();
    expect(t.session().lastPromptAt).not.toBe(before.lastPromptAt);
    expect(context).not.toContain('Relayed:');
    expect(context.split('\n').some((l) => l.startsWith(`Open ask a${t.ask.id} on`) && l.includes(REMINDER))).toBe(true);
    const row = t.row();
    expect(row.waiting).toEqual([]);
    expect(row.marks).toContain('answered_in_chat');
  });

  it('still delivers an answer cleared before it, after the Relayed line, once', () => {
    const t = setup();
    clearAsk(t.ctx, 'window', t.ask.id, 'The release keystore.');
    const lines = t.prompt({ relayed: true }).split('\n');
    expect(lines[0]).toBe(relayedLine('Progresser'));
    expect(lines[1]).toBe(`Answered: a${t.ask.id} "The release keystore." (yours: act on it, or add it to your tasks)`);
    expect(t.prompt({ relayed: true })).not.toContain('Answered:');
    expect(t.prompt()).not.toContain('Answered:');
  });

  it('is a typed prompt in a project with no lead: the flag is ignored', () => {
    const t = setup(null);
    const before = t.session();
    const context = t.prompt({ relayed: true });
    expect(t.session().lastPromptAt).not.toBe(before.lastPromptAt);
    expect(context).not.toContain('Relayed:');
    expect(context).toContain(REMINDER);
  });

  it('is a notice when the notice flag is set too', () => {
    const t = setup();
    const before = t.session();
    const context = t.prompt({ relayed: true, notice: true });
    const after = t.session();
    expect(context).not.toContain('Relayed:');
    expect(after.promptsSinceUpdate).toBe(before.promptsSinceUpdate);
    expect(after.lastPromptAt).toBe(before.lastPromptAt);
  });

  it('brings a session the briefing it is owed', () => {
    const t = setup();
    enrollSession(t.ctx, 'scribe:s2', 's2', t.project.slug);
    expect(briefingDue(t.ctx, 's2')).toBe(true);
    const context = t.prompt({ relayed: true }, 's2');
    expect(briefingDue(t.ctx, 's2')).toBe(false);
    const lines = context.split('\n');
    expect(lines[0]).toBe(relayedLine('Progresser'));
    expect(context).toContain('This session is tracked in project "InGame"');
    expect(findSession(t.ctx, 's2')!.lastPromptAt).toBeNull();
  });
});
