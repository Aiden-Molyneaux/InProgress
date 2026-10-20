import { describe, expect, it } from 'vitest';
import type { TitleChannel } from '../../src/core/types';
import type { Ctx } from '../../src/server/db/tx';
import { raiseAsk } from '../../src/server/repo/asks';
import { addNodes, updateNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, updateProject } from '../../src/server/repo/projects';
import { clearBriefingDue, findSession } from '../../src/server/repo/sessions';
import { enrollSession, handleHookEvent, setFocus, type HookEventInput } from '../../src/server/session-flow';
import { titleAdvice } from '../../src/server/title-channel';
import { makeCtx } from '../helpers';

/** A project with a step, and a session `s1` enrolled with `title` (or a title built from the step's id), its focus on the step. */
function setup(o: { title?: string | ((stepId: number) => string); channel?: TitleChannel } = {}) {
  const ctx: Ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'Titles' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/Titles');
  if (o.channel) updateProject(ctx, 'test', project.slug, { titleChannel: o.channel });
  const [step, other] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Fix export' }, { title: 'Other' }] });
  enrollSession(ctx, 'scribe:s1', 's1', project.slug, typeof o.title === 'function' ? o.title(step.id) : o.title);
  clearBriefingDue(ctx, 's1');
  setFocus(ctx, 'scribe:s1', 's1', step.id);
  const hook = (input: HookEventInput, sessionId = 's1') => handleHookEvent(ctx, sessionId, input);
  const done = () => updateNode(ctx, 'test', step.id, { status: 'done' });
  const session = () => findSession(ctx, 's1')!;
  return { ctx, project, step, other, hook, done, session };
}

const stop = (extra: Partial<HookEventInput> = {}): HookEventInput => ({ event: 'stop', stopHookActive: false, desktop: true, ...extra });
const prompt = (extra: Partial<HookEventInput> = {}): HookEventInput => ({ event: 'prompt', mentionsInProgress: false, asksStatus: false, desktop: true, ...extra });

describe('titleAdvice', () => {
  it('gives nothing to a session without a title, on either event, and writes nothing', () => {
    const { ctx, done, session } = setup();
    done();
    for (const event of ['prompt', 'stop'] as const) {
      expect(titleAdvice(ctx, session(), event, { stopHookActive: false, titleChannel: 'enforce' })).toEqual({});
    }
    expect(titleAdvice(ctx, { ...session(), title: '   ' }, 'stop', { stopHookActive: false, titleChannel: 'enforce' })).toEqual({});
    expect(session().titleAsked).toBeNull();
  });

  it('never asks for an empty title when the title is only a prefix word', () => {
    const { ctx, session } = setup();
    expect(titleAdvice(ctx, { ...session(), title: 'REVIEW' }, 'stop', { stopHookActive: false, titleChannel: 'enforce' })).toEqual({});
    expect(session().titleAsked).toBeNull();
  });

  it('nudges a prompt when the focus step is done, and the line leads the context', () => {
    const { ctx, step, hook, done, session } = setup({ title: (id) => `#${id} Fix export` });
    done();
    const advice = titleAdvice(ctx, session(), 'prompt', { stopHookActive: false, titleChannel: 'nudge' });
    expect(advice.line).toContain(`"DONE #${step.id} Fix export"`);
    expect(advice.line).toContain(`#${step.id} is done`);
    expect(advice.line).toBe(`Title: set it to "DONE #${step.id} Fix export" (mcp__ccd_session_mgmt__set_session_title on "self"); InProgress sees #${step.id} is done.`);
    expect(advice.demand).toBeUndefined();
    const r = hook(prompt());
    expect(r.context?.split('\n')[0]).toBe(advice.line);
    expect(r.title).toBeUndefined();
  });

  it('gives nothing when the title is already in step', () => {
    const { ctx, step, done, session } = setup({ title: (id) => `DONE #${id} Fix export` });
    done();
    expect(session().title).toBe(`DONE #${step.id} Fix export`);
    expect(titleAdvice(ctx, session(), 'stop', { stopHookActive: false, titleChannel: 'enforce' })).toEqual({});
    expect(titleAdvice(ctx, session(), 'prompt', { stopHookActive: false, titleChannel: 'enforce' })).toEqual({});
  });

  it('never blocks in nudge mode, but still computes the line', () => {
    const { ctx, hook, done, session } = setup({ title: 'Fix export', channel: 'nudge' });
    done();
    expect(titleAdvice(ctx, session(), 'stop', { stopHookActive: false, titleChannel: 'nudge' })).toEqual({ line: expect.stringContaining('"DONE Fix export"') });
    expect(hook(stop()).title).toBeUndefined();
    expect(session().titleAsked).toBeNull();
  });
});

describe('the title channel through the hook', () => {
  it('blocks once under enforce, not again for the same title, and again once the expected title changes', () => {
    const { step, ctx, hook, done, session } = setup({ title: 'Fix export', channel: 'enforce' });
    raiseAsk(ctx, 'test', { nodeId: step.id, kind: 'review', text: 'Look at the diff', sessionId: 's1' });
    const first = hook(stop());
    expect(first.title).toEqual({ title: 'REVIEW Fix export', reason: `a review on #${step.id} waits on Aiden` });
    expect(first.context).toBeUndefined();
    expect(session().titleAsked).toBe('REVIEW Fix export');
    expect(hook(stop()).title).toBeUndefined();
    done();
    expect(hook(stop()).title).toEqual({ title: 'DONE Fix export', reason: `#${step.id} is done` });
    expect(session().titleAsked).toBe('DONE Fix export');
  });

  it('never blocks in the extra pass a block caused, and leaves titleAsked alone', () => {
    const { hook, done, session } = setup({ title: 'Fix export', channel: 'enforce' });
    done();
    expect(hook(stop({ stopHookActive: true })).title).toBeUndefined();
    expect(session().titleAsked).toBeNull();
    expect(hook(stop()).title?.title).toBe('DONE Fix export');
    expect(hook(stop({ stopHookActive: true })).title).toBeUndefined();
    expect(session().titleAsked).toBe('DONE Fix export');
  });

  it('does not loop on a declined rename: the prompt still gets the line, the next stop no demand', () => {
    const { hook, done } = setup({ title: 'Fix export', channel: 'enforce' });
    done();
    expect(hook(stop({ title: 'Fix export' })).title?.title).toBe('DONE Fix export');
    expect(hook(prompt({ title: 'Fix export' })).context?.split('\n')[0]).toContain('"DONE Fix export"');
    expect(hook(stop({ title: 'Fix export' })).title).toBeUndefined();
  });

  it('reads the title the stop carries, so an obeyed demand gives no second one and clears titleAsked', () => {
    const { hook, done, session } = setup({ title: 'Fix export', channel: 'enforce' });
    done();
    expect(hook(stop()).title?.title).toBe('DONE Fix export');
    const obeyed = hook(stop({ stopHookActive: true, title: 'DONE Fix export' }));
    expect(obeyed.title).toBeUndefined();
    expect(session()).toMatchObject({ title: 'DONE Fix export', titleAsked: null });
    expect(hook(stop({ title: 'DONE Fix export' })).title).toBeUndefined();
  });

  it('flips RUNNING with a counted command: demanded, then held, then a new demand once it ends', () => {
    const { hook, session } = setup({ title: 'Fix export', channel: 'enforce' });
    hook({ event: 'command-started', taskId: 'bshell001', kind: 'shell', commandHead: 'npm test' });
    expect(hook(stop()).title?.title).toBe('RUNNING Fix export');
    // Declined, still running: the same expected title, so no second block.
    expect(hook(stop({ title: 'Fix export' })).title).toBeUndefined();
    hook({ event: 'command-ended', taskId: 'bshell001', outcome: 'completed' });
    // The session took the RUNNING title meanwhile; now nothing runs, so the bare title is a new demand.
    expect(hook(stop({ title: 'RUNNING Fix export' })).title).toEqual({ title: 'Fix export', reason: 'nothing is running or waiting' });
    expect(session().titleAsked).toBe('Fix export');
  });

  it('keeps RUNNING expected on a prompt while the work runs, so a declined demand stays declined', () => {
    const { hook, session } = setup({ title: 'Fix export', channel: 'enforce' });
    hook({ event: 'command-started', taskId: 'bshell003', kind: 'shell', commandHead: 'npm test' });
    expect(hook(stop()).title?.title).toBe('RUNNING Fix export');
    // Declined: the next prompt still names RUNNING (the work runs) and keeps the memory of the demand.
    expect(hook(prompt({ title: 'Fix export' })).context?.split('\n')[0]).toContain('"RUNNING Fix export"');
    expect(session().titleAsked).toBe('RUNNING Fix export');
    expect(hook(stop({ title: 'Fix export' })).title).toBeUndefined();
    // Taken: a prompt while the work runs asks for nothing.
    expect(hook(prompt({ title: 'RUNNING Fix export' })).context ?? '').not.toContain('Title:');
  });

  it('gives a session outside the desktop app no advice, whatever its title', () => {
    const { hook, done, session } = setup({ title: 'Fix export', channel: 'enforce' });
    done();
    expect(hook(prompt({ desktop: undefined })).context ?? '').not.toContain('Title:');
    expect(hook(stop({ desktop: undefined })).title).toBeUndefined();
    expect(session().titleAsked).toBeNull();
  });

  it('does not count a persistent Monitor as running', () => {
    const { hook } = setup({ title: 'Fix export', channel: 'enforce' });
    hook({ event: 'command-started', taskId: 'bmonit001', kind: 'monitor', persistent: true, description: 'watch' });
    expect(hook(stop()).title).toBeUndefined();
    // The same session with a counted command beside it is running.
    hook({ event: 'command-started', taskId: 'bshell002', kind: 'shell', commandHead: 'npm test' });
    expect(hook(stop()).title?.title).toBe('RUNNING Fix export');
  });

  it('puts BLOCKED before REVIEW, and ignores an ask another session raised', () => {
    const { ctx, step, project, hook } = setup({ title: 'Fix export', channel: 'enforce' });
    enrollSession(ctx, 'scribe:s2', 's2', project.slug, 'Someone else');
    raiseAsk(ctx, 'test', { nodeId: step.id, kind: 'question', text: 'Which port?', sessionId: 's2' });
    expect(hook(stop()).title).toBeUndefined();
    raiseAsk(ctx, 'test', { nodeId: step.id, kind: 'review', text: 'Look at it', sessionId: 's1' });
    raiseAsk(ctx, 'test', { nodeId: step.id, kind: 'permission', text: 'May I deploy?', sessionId: 's1' });
    expect(hook(stop()).title).toEqual({ title: 'BLOCKED Fix export', reason: `an ask on #${step.id} waits on Aiden` });
  });

  it('gives a notice prompt no line, and other events no advice', () => {
    const { hook, done, session } = setup({ title: 'Fix export', channel: 'enforce' });
    done();
    expect(hook(prompt({ notice: true })).context ?? '').not.toContain('Title:');
    expect(hook({ event: 'permission' })).toEqual({ tracked: true });
    expect(hook({ event: 'subagent-start', agentId: 'ag1', agentType: 'Explore' })).toEqual({ tracked: true });
    expect(session().titleAsked).toBeNull();
    expect(hook(prompt()).context?.split('\n')[0]).toContain('"DONE Fix export"');
  });
});

