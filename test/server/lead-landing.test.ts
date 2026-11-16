import { describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { SESSION_LANDING_LINE, landingOffLine, sessionMandateLines } from '../../src/core/lead-mandate';
import { leadBriefingLine } from '../../src/core/relay';
import { stamp } from '../../src/server/digest';
import { leadSwitches } from '../../src/server/lead';
import { leadAllow, leadDisallow } from '../../src/server/lead-commands';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { claimStep, handleHookEvent } from '../../src/server/session-flow';
import { makeCtx } from '../helpers';

const V = LEAD_INSTRUCTIONS_VERSION;
const BOUND = 'C:/personal/InGame';

/** A project led by Progresser with one step. */
function setup(lead: string | null = 'Progresser') {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, BOUND);
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Build tabs' }] });
  if (lead !== null) setProjectLead(ctx, 'window', project.slug, lead);
  const on = (sw: 'starts' | 'landing') => leadAllow(ctx, project.slug, 'Progresser', V, { switch: sw, aidenWords: 'yes' });
  const off = (sw: 'starts' | 'landing') => leadDisallow(ctx, project.slug, 'Progresser', V, { switch: sw });
  const start = (id: string) => handleHookEvent(ctx, id, { event: 'start', source: 'startup', cwd: BOUND });
  const prompt = (id: string) => String(handleHookEvent(ctx, id, { event: 'prompt' }).context ?? '');
  const newest = (text: string) => (ctx.db.prepare("SELECT at FROM lead_events WHERE text = ? ORDER BY id DESC LIMIT 1").pluck().get(text) as string);
  const events = () => ctx.db.prepare('SELECT lead, instructions, kind, text, aiden_words FROM lead_events ORDER BY id').all();
  return { ctx, project, step, on, off, start, prompt, newest, events };
}

describe('Landing turned off reaches a session that holds the Landing line', () => {
  it('adds the line to every prompt after on, then off', () => {
    const t = setup();
    t.on('landing');
    t.start('s1');
    t.off('landing');
    const line = landingOffLine(t.newest('landing'));
    expect(line).toBe(`Landing is off for this project since ${stamp(t.newest('landing'))}: land nothing without Aiden's go-ahead, whatever an earlier briefing said.`);
    expect(t.prompt('s1').split('\n')).toContain(line);
    expect(t.prompt('s1').split('\n')).toContain(line);
  });

  it('adds nothing when Landing was never on, or is on', () => {
    const never = setup();
    never.start('s1');
    expect(never.prompt('s1')).not.toContain('Landing is off');
    const on = setup();
    on.start('s1');
    on.on('landing');
    expect(on.prompt('s1')).not.toContain('Landing is off');
    // Off for Starts says nothing about Landing.
    on.on('starts');
    on.off('starts');
    expect(on.prompt('s1')).not.toContain('Landing is off');
  });

  it('adds nothing to a session that started after the disallow, and says it again once Landing has been on and off since', () => {
    const t = setup();
    t.on('landing');
    t.off('landing');
    t.start('s1');
    expect(t.prompt('s1')).not.toContain('Landing is off');
    t.on('landing');
    t.off('landing');
    expect(t.prompt('s1')).toContain(landingOffLine(t.newest('landing')));
  });
});

describe('switches do not survive a change of lead', () => {
  it('logs a disallow for each switch that is on when the lead is changed or cleared, under the outgoing lead', () => {
    for (const next of ['Rich', null]) {
      const t = setup();
      t.on('starts');
      t.on('landing');
      t.start('s1');
      const before = (t.events() as unknown[]).length;
      setProjectLead(t.ctx, 'window', t.project.slug, next);
      expect((t.events() as unknown[]).slice(before)).toEqual([
        { lead: 'Progresser', instructions: V, kind: 'disallow', text: 'starts', aiden_words: null },
        { lead: 'Progresser', instructions: V, kind: 'disallow', text: 'landing', aiden_words: null },
      ]);
      expect(leadSwitches(t.ctx, t.project.id)).toEqual({ starts: { on: false, at: null, words: null }, landing: { on: false, at: null, words: null } });
      // The session that held the Landing line is told on its next prompt.
      expect(t.prompt('s1')).toContain(landingOffLine(t.newest('landing')));
    }
  });

  it('logs only the switch that is on, and nothing for naming the same lead again or for a project with none on', () => {
    const t = setup();
    t.on('starts');
    const before = (t.events() as unknown[]).length;
    setProjectLead(t.ctx, 'window', t.project.slug, 'Progresser');
    setProjectLead(t.ctx, 'window', t.project.slug, ' Progresser ');
    expect(t.events()).toHaveLength(before);
    setProjectLead(t.ctx, 'window', t.project.slug, 'Rich');
    expect((t.events() as { kind: string; text: string }[]).slice(before).map((e) => [e.kind, e.text])).toEqual([['disallow', 'starts']]);
    // Rich now leads and has switched nothing on: a change again logs nothing.
    const after = (t.events() as unknown[]).length;
    setProjectLead(t.ctx, 'window', t.project.slug, null);
    expect(t.events()).toHaveLength(after);
  });

  it('gives the next lead no switch that the last one had', () => {
    const t = setup();
    t.on('landing');
    setProjectLead(t.ctx, 'window', t.project.slug, 'Rich');
    expect(leadSwitches(t.ctx, t.project.id).landing.on).toBe(false);
    setProjectLead(t.ctx, 'window', t.project.slug, 'Progresser');
    expect(leadSwitches(t.ctx, t.project.id).landing.on).toBe(false);
  });
});

describe('the claim carries the lead lines', () => {
  const claim = (t: ReturnType<typeof setup>, id = 's1') => {
    t.start(id);
    return claimStep(t.ctx, `session:${id}`, id, t.step.id).block;
  };

  it('adds the Lead line and the two mandate lines after the step block in a led project, and the Landing line only when Landing is on', () => {
    const t = setup();
    const block = claim(t);
    expect(block.slice(-3)).toEqual([leadBriefingLine('Progresser'), ...sessionMandateLines('Progresser')]);
    expect(block.findIndex((l) => l.startsWith('Your step:'))).toBe(0);
    expect(block).not.toContain(SESSION_LANDING_LINE);
    t.on('landing');
    const landing = claim(t, 's2');
    expect(landing.slice(-4)).toEqual([leadBriefingLine('Progresser'), ...sessionMandateLines('Progresser'), SESSION_LANDING_LINE]);
  });

  it('adds none with no lead, even with Landing on in the log', () => {
    const t = setup('Progresser');
    t.on('landing');
    ctxClear(t);
    const block = claim(t);
    expect(block.some((l) => l.startsWith('Lead:') || l.startsWith('Mandate:') || l.startsWith('Landing:'))).toBe(false);
    const none = setup(null);
    expect(claim(none).some((l) => l.startsWith('Lead:') || l.startsWith('Mandate:'))).toBe(false);
  });
});

/** Takes the lead away without the change-of-lead disallow, as an old log with Landing on and no lead would hold. */
function ctxClear(t: ReturnType<typeof setup>): void {
  t.ctx.db.prepare('UPDATE projects SET lead = NULL WHERE id = ?').run(t.project.id);
  t.ctx.db.prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind, text, aiden_words) VALUES (?, ?, 'Progresser', ?, 'allow', 'landing', 'again')").run(t.project.id, t.ctx.now(), V);
}
