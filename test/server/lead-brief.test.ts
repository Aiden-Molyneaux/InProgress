import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { deleteProject, purgeDeletedProjects } from '../../src/server/project-lifecycle';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { renderLeadBrief } from '../../src/server/lead-text';
import { logLeadEvent, markLeadSeen, noLeadNamed, outOfDate, readLeadBrief, requireLead } from '../../src/server/lead';
import { raiseAsk } from '../../src/server/repo/asks';
import { maxEventId } from '../../src/server/repo/events';
import { addNodes, parkNode, updateNode } from '../../src/server/repo/nodes';
import { addBinding, changeProject, createProject, listProjectSummaries, setProjectLead, setQueue } from '../../src/server/repo/projects';
import { handleHookEvent } from '../../src/server/session-flow';
import { makeCtx } from '../helpers';

const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui-token' };

/** A project with three steps, a tracked session on the first, an ask of Aiden's and a promise of the lead's. */
function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [a, b, c] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Play app signing', status: 'active' }, { title: 'Privacy page' }, { title: 'Old spike' }] });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
  const aidenAsk = raiseAsk(ctx, 'session:s1', { nodeId: a.id, kind: 'question', text: 'Which keystore?' });
  const leadAsk = raiseAsk(ctx, 'lead', { nodeId: b.id, kind: 'question', text: 'Send Aiden the draft', owner: 'lead', dueAt: '2026-09-27T11:00:00.000Z' });
  setQueue(ctx, 'test', project.slug, [b.id], 'unowned');
  const app = buildApp({ ctx, token: 't', uiToken: 'ui-token', version: 'test' });
  const brief = (ref = project.slug) => readLeadBrief(ctx, ref, 1, new Date(ctx.now()));
  const leadEvents = () => ctx.db.prepare('SELECT COUNT(*) FROM lead_events').pluck().get() as number;
  const seenAt = () => ctx.db.prepare('SELECT lead_seen_at FROM projects WHERE id = ?').pluck().get(project.id) as string | null;
  const setLead = (name: string | null) => setProjectLead(ctx, 'window', project.slug, name);
  return { ctx, app, project, a, b, c, aidenAsk, leadAsk, brief, leadEvents, seenAt, setLead };
}

describe('requireLead', () => {
  it('passes for the named lead, ignoring case and spaces, and throws for another name', () => {
    const { ctx, project, setLead } = setup();
    setLead('Progresser');
    expect(requireLead(ctx, project.slug, 'progresser', 1, false).slug).toBe(project.slug);
    expect(requireLead(ctx, project.slug, 'Progresser ', 1, true).lead).toBe('Progresser');
    expect(() => requireLead(ctx, project.slug, 'Rich', 1, false)).toThrow(noLeadNamed('Rich'));
  });

  it('refuses a project with no lead with the plan\'s sentence, as a 409, and writes nothing', () => {
    const { ctx, project, leadEvents } = setup();
    const before = maxEventId(ctx);
    let caught: unknown;
    try {
      requireLead(ctx, project.slug, 'Progresser', 1, false);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 409, message: 'This project has no lead named Progresser. Only Aiden can give a project a lead, from its actions in the window.' });
    expect(maxEventId(ctx)).toBe(before);
    expect(leadEvents()).toBe(0);
  });

  it('refuses a write from older instructions but lets a read through', () => {
    const { ctx, project, setLead } = setup();
    setLead('Progresser');
    expect(requireLead(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION - 1, false).lead).toBe('Progresser');
    expect(() => requireLead(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION - 1, true)).toThrow(outOfDate(LEAD_INSTRUCTIONS_VERSION - 1));
    expect(outOfDate(0)).toBe('Your instructions are version 0; version 1 is needed to change anything. Ask Aiden to paste the new ones.');
  });
});

describe('setProjectLead', () => {
  it('trims the name, clears it with null, records only a real change, and refuses an empty or long name', () => {
    const { ctx, project, setLead } = setup();
    expect(setLead('  Progresser  ').lead).toBe('Progresser');
    const mark = maxEventId(ctx);
    setLead('Progresser');
    expect(maxEventId(ctx)).toBe(mark);
    expect(setLead(null).lead).toBeNull();
    expect(maxEventId(ctx)).toBeGreaterThan(mark);
    expect(() => setLead('   ')).toThrow(/1 to 40/);
    expect(() => setLead('x'.repeat(41))).toThrow(/1 to 40/);
    expect(resolveLead(ctx, project.slug)).toBeNull();
  });
});

function resolveLead(ctx: ReturnType<typeof makeCtx>, slug: string): string | null {
  return ctx.db.prepare('SELECT lead FROM projects WHERE slug = ?').pluck().get(slug) as string | null;
}

describe('readLeadBrief', () => {
  it('lists a lead-owned ask under For the lead, not Waiting on Aiden, and keeps it out of open_asks', () => {
    const { ctx, project, brief, aidenAsk, leadAsk, a, b } = setup();
    const r = brief();
    expect(r.waitingOnAiden.map((x) => x.askId)).toEqual([aidenAsk.id]);
    expect(r.waitingOnAiden[0]).toMatchObject({ stepId: a.id, stepTitle: 'Play app signing', kind: 'question' });
    expect(r.forTheLead.map((x) => x.askId)).toEqual([leadAsk.id]);
    expect(r.forTheLead[0]).toMatchObject({ stepId: b.id, stepTitle: 'Privacy page', overdue: true });
    expect(listProjectSummaries(ctx).find((p) => p.id === project.id)!.openAsks).toBe(1);
    expect(r.aidenOpenAcrossProjects).toBe(1);
  });

  it('reads in flight, next up and the project from what is there', () => {
    const { brief, b } = setup();
    const r = brief();
    expect(r.project).toEqual({ slug: 'ingame', name: 'InGame', lead: null });
    expect(r.instructions).toEqual({ current: LEAD_INSTRUCTIONS_VERSION, yours: 1 });
    expect(r.inFlight).toHaveLength(1);
    expect(r.inFlight[0]).toMatchObject({ sessionId: 's1', stepId: null, title: 'no step claimed', app: 'cli' });
    expect(r.nextUp).toEqual([{ stepId: b.id, title: 'Privacy page', status: 'todo' }]);
    expect(r.links).toEqual({ t3: 'not checked', t3At: null, lastSeenAt: null });
  });

  it('puts a promise with no due time after one with a due time, and a later due time after an earlier one', () => {
    const { ctx, brief, a } = setup();
    raiseAsk(ctx, 'lead', { nodeId: a.id, kind: 'question', text: 'No time given', owner: 'lead' });
    raiseAsk(ctx, 'lead', { nodeId: a.id, kind: 'question', text: 'Much later', owner: 'lead', dueAt: '2027-01-01T00:00:00.000Z' });
    expect(brief().forTheLead.map((x) => x.text)).toEqual(['Send Aiden the draft', 'Much later', 'No time given']);
  });

  it('is the same twice running, apart from its times', () => {
    const { ctx, project, setLead } = setup();
    setLead('Progresser');
    const render = (now: string) => renderLeadBrief(readLeadBrief(ctx, project.slug, 1, new Date(now)));
    const first = render('2026-11-14T12:00:00.000Z');
    const second = render('2026-11-15T15:07:30.000Z');
    // The times are what differs: stamps and ages.
    expect(second).not.toBe(first);
    const mask = (text: string) => text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, '<time>').replace(/(seen |· |look )(<1m|\d+[mhdw])/g, '$1<age>');
    expect(mask(second)).toBe(mask(first));
  });

  it('puts only the Board\'s next rows in Next up, in its order, and only stale marks in Stale', () => {
    const { ctx, project, a, b, c, brief } = setup();
    setQueue(ctx, 'test', project.slug, [c.id, b.id], 'unowned');
    expect(brief().nextUp.map((n) => n.stepId)).toEqual([c.id, b.id]);
    // A done step with no outcome carries no_outcome, which is housekeeping: it is not Stale.
    updateNode(ctx, 'scribe:s1', a.id, { status: 'done' });
    expect(brief().stale).toEqual([]);
    // An ask of Aiden's left over a week is stale_ask, and is listed with only that mark.
    const later = new Date(Date.parse(ctx.now()) + 10 * 24 * 60 * 60 * 1000);
    expect(readLeadBrief(ctx, project.slug, 1, later).stale).toEqual([{ stepId: a.id, title: 'Play app signing', marks: ['stale_ask'] }]);
  });

  it('leaves an ask on a shelved step out of Waiting on Aiden', () => {
    const { ctx, a, aidenAsk, brief } = setup();
    expect(brief().waitingOnAiden.map((x) => x.askId)).toEqual([aidenAsk.id]);
    parkNode(ctx, 'test', a.id, { reason: 'later' }, () => {});
    expect(brief().waitingOnAiden).toEqual([]);
  });

  it('cites what the lead said in Aiden\'s name since the last look, newest first, by ask or by step', () => {
    const { ctx, project, aidenAsk, a, brief } = setup();
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: 1, kind: 'answer', askId: aidenAsk.id, aidenWords: 'Use the release keystore.' });
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: 1, kind: 'park', nodeId: a.id, text: 'parked', aidenWords: 'Park it.' });
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: 1, kind: 'relay', nodeId: a.id, text: 'no words of his' });
    expect(brief().saidInAidensName.map((e) => [e.kind, e.ref, e.words])).toEqual([
      ['park', `#${a.id}`, 'Park it.'],
      ['answer', `a${aidenAsk.id}`, 'Use the release keystore.'],
    ]);
  });
});

describe('the brief route', () => {
  it('answers a project with no lead 409 when `as` is given, and writes nothing', async () => {
    const { ctx, app, project, leadEvents, seenAt } = setup();
    const before = maxEventId(ctx);
    const res = await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=1` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(noLeadNamed('Progresser'));
    expect(maxEventId(ctx)).toBe(before);
    expect(leadEvents()).toBe(0);
    expect(seenAt()).toBeNull();
  });

  it('answers another lead\'s name 409, and the named lead with { brief, text }', async () => {
    const { app, project, setLead } = setup();
    setLead('Progresser');
    expect((await app.inject({ url: `/api/lead/${project.slug}/brief?as=Rich&instructions=1` })).statusCode).toBe(409);
    const ok = await app.inject({ url: `/api/lead/${project.slug}/brief?as=progresser&instructions=1` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().brief.project).toEqual({ slug: 'ingame', name: 'InGame', lead: 'Progresser' });
    expect(ok.json().text.split('\n')[0]).toMatch(/^Lead brief · InGame · .* · instructions v1 \(yours: v1\)$/);
  });

  it('answers the window without `as`: no lead check, yours null, and never marks, whatever the query says', async () => {
    const { app, project, seenAt } = setup();
    const res = await app.inject({ url: `/api/lead/${project.slug}/brief` });
    expect(res.statusCode).toBe(200);
    expect(res.json().brief.instructions.yours).toBeNull();
    expect(res.json().text).toContain('(yours: none)');
    expect(seenAt()).toBeNull();
  });

  it('refuses an `as` with no instructions, and an unknown query key', async () => {
    const { app, project } = setup();
    expect((await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/lead/${project.slug}/brief?bogus=1` })).statusCode).toBe(400);
    // Marking is a write of its own: the GET takes no mark.
    expect((await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=1&mark=1` })).statusCode).toBe(400);
  });

  it('a GET never marks the look', async () => {
    const { app, project, setLead, seenAt } = setup();
    setLead('Progresser');
    await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=1` });
    expect(seenAt()).toBeNull();
  });

  it('markLeadSeen sets lead_seen_at to the time given, answers the look on record, and never moves it back', () => {
    const { ctx, project, seenAt } = setup();
    expect(markLeadSeen(ctx, project.slug, new Date('2026-11-14T10:00:00.000Z'))).toBe('2026-11-14T10:00:00.000Z');
    expect(markLeadSeen(ctx, project.slug, new Date('2026-11-14T09:00:00.000Z'))).toBe('2026-11-14T10:00:00.000Z');
    expect(seenAt()).toBe('2026-11-14T10:00:00.000Z');
    expect(markLeadSeen(ctx, project.slug, new Date('2026-11-14T11:00:00.000Z'))).toBe('2026-11-14T11:00:00.000Z');
  });

  it('answers the log, newest first', async () => {
    const { ctx, app, project, aidenAsk } = setup();
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: 1, kind: 'answer', askId: aidenAsk.id, aidenWords: 'Yes.' });
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: 1, kind: 'park', text: 'later' });
    const { events } = (await app.inject({ url: `/api/lead/${project.slug}/events` })).json();
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(['park', 'answer']);
    expect(events[1]).toMatchObject({ lead: 'Progresser', instructions: 1, askId: aidenAsk.id, aidenWords: 'Yes.', nodeId: null, sessionId: null, text: '' });
  });
});

describe('the seen route', () => {
  const BEARER = { authorization: 'Bearer t' };
  const seen = (app: ReturnType<typeof setup>['app'], slug: string, payload: unknown, headers: Record<string, string> = BEARER) =>
    app.inject({ method: 'POST', url: `/api/lead/${slug}/seen`, headers, payload: payload as object });

  it('marks the look behind the bearer guard, answers { seenAt }, and the next brief counts from it', async () => {
    const { ctx, app, project, a, setLead, seenAt } = setup();
    setLead('Progresser');
    updateNode(ctx, 'scribe:s1', a.id, { status: 'done', outcome: 'Signed.' });
    const first = await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=1` });
    expect(first.json().brief.landedSince.map((n: { stepId: number }) => n.stepId)).toEqual([a.id]);
    expect(seenAt()).toBeNull();
    const res = await seen(app, project.slug, { as: 'progresser', instructions: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().seenAt).toBe(seenAt());
    const second = await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=1` });
    expect(second.json().brief.landedSince).toEqual([]);
    expect(second.json().brief.links.lastSeenAt).toBe(seenAt());
  });

  it('refuses a request with no bearer token, a project with no lead or another lead, and writes nothing', async () => {
    const { ctx, app, project, setLead, seenAt } = setup();
    expect((await seen(app, project.slug, { as: 'Progresser', instructions: 1 }, {})).statusCode).toBe(401);
    const before = maxEventId(ctx);
    const none = await seen(app, project.slug, { as: 'Progresser', instructions: 1 });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe(noLeadNamed('Progresser'));
    setLead('Progresser');
    expect((await seen(app, project.slug, { as: 'Rich', instructions: 1 })).statusCode).toBe(409);
    expect(seenAt()).toBeNull();
    expect(maxEventId(ctx)).toBe(before + 1);
  });

  it('takes the time of the brief the lead read, so a step that landed after that brief is in the next one', async () => {
    const { ctx, app, project, a, setLead, seenAt } = setup();
    setLead('Progresser');
    const first = (await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=1` })).json().brief;
    updateNode(ctx, 'scribe:s1', a.id, { status: 'done', outcome: 'Signed.' });
    const res = await seen(app, project.slug, { as: 'Progresser', instructions: 1, at: first.at });
    expect(res.json().seenAt).toBe(first.at);
    expect(seenAt()).toBe(first.at);
    const second = (await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=1` })).json().brief;
    expect(second.landedSince.map((n: { stepId: number }) => n.stepId)).toEqual([a.id]);
  });

  it('counts a time ahead of the clock as now, and refuses one that is no time', async () => {
    const { ctx, app, project, setLead, seenAt } = setup();
    setLead('Progresser');
    const ahead = new Date(Date.parse(ctx.now()) + 3_600_000).toISOString();
    const res = await seen(app, project.slug, { as: 'Progresser', instructions: 1, at: ahead });
    expect(res.statusCode).toBe(200);
    expect(seenAt()! < ahead).toBe(true);
    expect((await seen(app, project.slug, { as: 'Progresser', instructions: 1, at: 'yesterday' })).statusCode).toBe(400);
  });

  it('takes a strict body: as, instructions and the time only', async () => {
    const { app, project, setLead } = setup();
    setLead('Progresser');
    expect((await seen(app, project.slug, { as: 'Progresser' })).statusCode).toBe(400);
    expect((await seen(app, project.slug, { as: 'Progresser', instructions: 1, extra: true })).statusCode).toBe(400);
    expect((await seen(app, project.slug, { as: 'Progresser', instructions: 'one' })).statusCode).toBe(400);
  });
});

describe('an archived project', () => {
  it('has no lead: requireLead refuses it with its own sentence, as a 409', () => {
    const { ctx, project, setLead } = setup();
    setLead('Progresser');
    changeProject(ctx, 'test', project.slug, { status: 'archived' });
    let caught: unknown;
    try {
      requireLead(ctx, project.slug, 'Progresser', 1, false);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 409, message: 'This project is archived, so it has no lead.' });
  });
});

describe('purging a project that has lead events', () => {
  it('succeeds and the lead_events rows go with the project', () => {
    let now = Date.parse('2026-10-06T09:00:00.000Z');
    const ctx = createCtx(openDb(':memory:'), () => new Date(now).toISOString());
    const project = createProject(ctx, 'test', { name: 'Old Site' });
    setProjectLead(ctx, 'window', project.slug, 'Progresser');
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: 1, kind: 'answer', aidenWords: 'Yes.' });
    changeProject(ctx, 'window', project.slug, { status: 'archived' });
    deleteProject(ctx, 'window', project.id);
    now += 31 * 24 * 60 * 60 * 1000;
    const logged: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'ip-purge-'));
    try {
      expect(purgeDeletedProjects(ctx, home, { info: (m) => logged.push(m), error: (m) => logged.push(m) })).toEqual({ projects: 1, files: 0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(ctx.db.prepare('SELECT COUNT(*) FROM lead_events').pluck().get()).toBe(0);
    expect(ctx.db.prepare('SELECT COUNT(*) FROM projects').pluck().get()).toBe(0);
  });
});

describe('the window route that sets a lead', () => {
  it('sets and clears the lead behind the window guard, and refuses a request without it', async () => {
    const { app, project } = setup();
    const url = `/api/ui/projects/${project.id}/lead`;
    const slug = project.slug;
    expect((await app.inject({ method: 'POST', url, headers: UI, payload: { slug, name: ' Progresser ' } })).json().project.lead).toBe('Progresser');
    const cleared = await app.inject({ method: 'POST', url, headers: UI, payload: { slug, name: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().project.lead).toBeNull();
    expect((await app.inject({ method: 'POST', url, headers: { origin: 'http://localhost:80' }, payload: { slug, name: 'Progresser' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { 'x-ip-ui-token': 'ui-token' }, payload: { slug, name: 'Progresser' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: UI, payload: { slug, name: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: UI, payload: { slug, name: 'x'.repeat(41) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: UI, payload: { slug: 'other', name: 'Progresser' } })).statusCode).toBe(409);
  });

  it('is not reachable with the bearer token the CLI and MCP hold', async () => {
    const { app, project } = setup();
    const res = await app.inject({ method: 'POST', url: `/api/ui/projects/${project.id}/lead`, headers: { authorization: 'Bearer t' }, payload: { slug: project.slug, name: 'Progresser' } });
    expect(res.statusCode).toBe(403);
  });
});
