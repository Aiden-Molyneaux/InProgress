import { describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { buildApp } from '../../src/server/app';
import { leadSwitches, noLeadNamed, outOfDate, readLeadBrief } from '../../src/server/lead';
import { stamp } from '../../src/server/digest';
import { renderLeadBrief } from '../../src/server/lead-text';
import { addNodes } from '../../src/server/repo/nodes';
import { handleHookEvent } from '../../src/server/session-flow';
import { leadAllow, leadDisallow } from '../../src/server/lead-commands';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

const BEARER = { authorization: 'Bearer t' };
const V = LEAD_INSTRUCTIONS_VERSION;

/** Two projects, each with a lead named Progresser. */
function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  setProjectLead(ctx, 'window', elsewhere.slug, 'Progresser');
  const app = buildApp({ ctx, token: 't', uiToken: 'ui-token', version: 'test' });
  const events = () => ctx.db.prepare('SELECT project_id, kind, text, aiden_words, instructions, lead FROM lead_events ORDER BY id').all() as Record<string, unknown>[];
  const refused = (fn: () => unknown): { status: number; message: string } => {
    const count = events().length;
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught, 'it should have been refused').toBeDefined();
    expect(events()).toHaveLength(count);
    return caught as { status: number; message: string };
  };
  return { ctx, project, elsewhere, app, events, refused };
}

describe('leadSwitches', () => {
  it('reads both off with no events, on after an allow, off after a disallow, on again after another allow', () => {
    const s = setup();
    expect(leadSwitches(s.ctx, s.project.id)).toEqual({ starts: { on: false, at: null, words: null }, landing: { on: false, at: null, words: null } });
    leadAllow(s.ctx, s.project.slug, 'progresser', V, { switch: 'starts', aidenWords: 'yes, start them' });
    const on = leadSwitches(s.ctx, s.project.id);
    expect(on.starts).toMatchObject({ on: true, words: 'yes, start them' });
    expect(typeof on.starts.at).toBe('string');
    expect(on.landing.on).toBe(false);
    leadDisallow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts' });
    expect(leadSwitches(s.ctx, s.project.id).starts).toEqual({ on: false, at: null, words: null });
    leadAllow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts', aidenWords: 'again' });
    expect(leadSwitches(s.ctx, s.project.id).starts).toMatchObject({ on: true, words: 'again' });
  });

  it("does not count another project's events, and keeps the two switches apart", () => {
    const s = setup();
    leadAllow(s.ctx, s.elsewhere.slug, 'Progresser', V, { switch: 'landing', aidenWords: 'land it' });
    expect(leadSwitches(s.ctx, s.project.id).landing.on).toBe(false);
    expect(leadSwitches(s.ctx, s.elsewhere.id).landing.on).toBe(true);
    expect(leadSwitches(s.ctx, s.elsewhere.id).starts.on).toBe(false);
  });
});

describe('leadAllow and leadDisallow', () => {
  it('log one allow line and one disallow line with the switch as text, and answer their sentences', () => {
    const s = setup();
    expect(leadAllow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'landing', aidenWords: 'land routine work' }).text).toBe('Landing is on for InGame.');
    expect(leadDisallow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'landing', aidenWords: 'stop' }).text).toBe('Landing is off for InGame.');
    expect(leadAllow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts', aidenWords: 'go' }).text).toBe('Starts is on for InGame.');
    expect(s.events()).toEqual([
      { project_id: s.project.id, kind: 'allow', text: 'landing', aiden_words: 'land routine work', instructions: V, lead: 'Progresser' },
      { project_id: s.project.id, kind: 'disallow', text: 'landing', aiden_words: 'stop', instructions: V, lead: 'Progresser' },
      { project_id: s.project.id, kind: 'allow', text: 'starts', aiden_words: 'go', instructions: V, lead: 'Progresser' },
    ]);
  });

  it('refuses allow twice, disallow twice and a disallow of a switch never on, logging nothing', () => {
    const s = setup();
    expect(s.refused(() => leadDisallow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts' }))).toMatchObject({ status: 409, message: 'Starts is already off.' });
    leadAllow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts', aidenWords: 'go' });
    expect(s.refused(() => leadAllow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts', aidenWords: 'go again' }))).toMatchObject({ status: 409, message: 'Starts is already on.' });
    leadDisallow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts' });
    expect(s.refused(() => leadDisallow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts' }))).toMatchObject({ status: 409, message: 'Starts is already off.' });
    expect(s.refused(() => leadDisallow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'landing' }))).toMatchObject({ status: 409, message: 'Landing is already off.' });
  });

  it('refuses another lead, old instructions and a project with no lead', () => {
    const s = setup();
    expect(s.refused(() => leadAllow(s.ctx, s.project.slug, 'Rich', V, { switch: 'starts', aidenWords: 'go' }))).toMatchObject({ status: 409, message: noLeadNamed('Rich') });
    expect(s.refused(() => leadAllow(s.ctx, s.project.slug, 'Progresser', V - 1, { switch: 'starts', aidenWords: 'go' }))).toMatchObject({
      status: 409,
      message: outOfDate(V - 1, s.project.slug, 'Progresser'),
    });
    setProjectLead(s.ctx, 'window', s.project.slug, null);
    expect(s.refused(() => leadAllow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts', aidenWords: 'go' }))).toMatchObject({ status: 409 });
  });
});

describe('the brief: switches and started', () => {
  it('carries each switch, and the start events of the last 7 days newest first, claimed when a session carries the thread', () => {
    const s = setup();
    const [step] = addNodes(s.ctx, 'test', { parentId: s.project.rootNodeId, nodes: [{ title: 'Dark mode' }] });
    leadAllow(s.ctx, s.project.slug, 'Progresser', V, { switch: 'starts', aidenWords: 'go' });
    const log = s.ctx.db.prepare('INSERT INTO lead_events (project_id, at, lead, instructions, kind, node_id, text, aiden_words) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const now = Date.parse(s.ctx.now());
    log.run(s.project.id, new Date(now - 60_000).toISOString(), 'Progresser', V, 'start', step.id, 'mcp:new', null);
    log.run(s.project.id, new Date(now - 3_600_000).toISOString(), 'Progresser', V, 'start', step.id, 'mcp:carried', 'go on');
    log.run(s.project.id, new Date(now - 8 * 86_400_000).toISOString(), 'Progresser', V, 'start', step.id, 'mcp:old', null);
    log.run(s.project.id, new Date(now - 120_000).toISOString(), 'Progresser', V, 'start_failed', step.id, 'boom', null);
    handleHookEvent(s.ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame', app: 't3', t3ThreadId: 'mcp:carried' });
    const brief = readLeadBrief(s.ctx, s.project.slug, V, new Date(s.ctx.now()));
    expect(brief.switches.starts).toMatchObject({ on: true, words: 'go' });
    expect(brief.switches.landing.on).toBe(false);
    expect(brief.started.map((e) => [e.threadId, e.stepId, e.stepTitle, e.onAidensWord, e.claimed])).toEqual([
      ['mcp:new', step.id, 'Dark mode', false, false],
      ['mcp:carried', step.id, 'Dark mode', true, true],
    ]);
    expect(renderLeadBrief(brief)).toContain(`Switches: starts on since ${stamp(brief.switches.starts.at as string)} ("go") · landing off`);
  });
});

describe('the allow and disallow routes', () => {
  const post = (s: ReturnType<typeof setup>, path: string, payload: Record<string, unknown>, headers: Record<string, string> = BEARER) =>
    s.app.inject({ method: 'POST', url: `/api/lead/${s.project.slug}/${path}`, headers, payload });

  it('turn a switch on and off, and need the token', async () => {
    const s = setup();
    const who = { as: 'Progresser', instructions: V };
    expect((await post(s, 'allow', { ...who, switch: 'starts', aidenWords: 'go' }, {})).statusCode).toBe(401);
    const on = await post(s, 'allow', { ...who, switch: 'starts', aidenWords: 'go' });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ text: 'Starts is on for InGame.' });
    expect((await post(s, 'allow', { ...who, switch: 'starts', aidenWords: 'go' })).statusCode).toBe(409);
    const off = await post(s, 'disallow', { ...who, switch: 'starts' });
    expect(off.json()).toEqual({ text: 'Starts is off for InGame.' });
    expect(s.events().map((e) => e.kind)).toEqual(['allow', 'disallow']);
  });

  it('refuse a switch that is not one of the two, an allow with no words, and words over 2,000 characters, logging nothing', async () => {
    const s = setup();
    const who = { as: 'Progresser', instructions: V };
    expect((await post(s, 'allow', { ...who, switch: 'deploys', aidenWords: 'go' })).statusCode).toBe(400);
    expect((await post(s, 'disallow', { ...who, switch: 'deploys' })).statusCode).toBe(400);
    expect((await post(s, 'allow', { ...who, switch: 'starts' })).statusCode).toBe(400);
    expect((await post(s, 'allow', { ...who, switch: 'starts', aidenWords: '  ' })).statusCode).toBe(400);
    expect((await post(s, 'allow', { ...who, switch: 'starts', aidenWords: 'x'.repeat(2_001) })).statusCode).toBe(400);
    expect(s.events()).toEqual([]);
  });
});
