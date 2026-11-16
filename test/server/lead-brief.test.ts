import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app';
import { openDb } from '../../src/server/db/connection';
import { createCtx, write } from '../../src/server/db/tx';
import { deleteProject, purgeDeletedProjects } from '../../src/server/project-lifecycle';
import { LEAD_INSTRUCTIONS_VERSION, LEAD_NAME_RULE } from '../../src/core/lead';
import { renderLeadBrief } from '../../src/server/lead-text';
import { leadFolders, logLeadEvent, markLeadSeen, noLeadNamed, outOfDate, readLeadBrief, readLeadIntent, readLeadRules, requireLead, staleReasons } from '../../src/server/lead';
import { raiseAsk } from '../../src/server/repo/asks';
import { maxEventId } from '../../src/server/repo/events';
import { addNodes, parkNode, updateNode } from '../../src/server/repo/nodes';
import { addBinding, changeProject, createProject, listProjectSummaries, setProjectIntentInWrite, setProjectLead, setQueue } from '../../src/server/repo/projects';
import { claimStep, handleHookEvent } from '../../src/server/session-flow';
import type { BoardRow } from '../../src/core/board';
import type { Ask, Session, TreeNode } from '../../src/core/types';
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
    expect(requireLead(ctx, project.slug, 'Progresser ', LEAD_INSTRUCTIONS_VERSION, true).lead).toBe('Progresser');
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
    expect(() => requireLead(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION - 1, true)).toThrow(outOfDate(LEAD_INSTRUCTIONS_VERSION - 1, project.slug, 'Progresser'));
    expect(outOfDate(1, 'ingame', 'Progresser')).toBe('Your rules are version 1; version 3 is current. Run "lead rules ingame --as Progresser" again and follow what it prints.');
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

  it("takes one plain word as a name and refuses any other with the rule's sentence", () => {
    const { setLead } = setup();
    for (const bad of ['Lead Bot', 'a"b', '$x', 'a`b', '-x', 'Zoë', 'x'.repeat(41)]) {
      expect(() => setLead(bad), bad).toThrow(LEAD_NAME_RULE);
    }
    for (const good of ['Progresser', 'lead-2', 'A.b_c']) expect(setLead(good).lead).toBe(good);
  });
});

function resolveLead(ctx: ReturnType<typeof makeCtx>, slug: string): string | null {
  return ctx.db.prepare('SELECT lead FROM projects WHERE slug = ?').pluck().get(slug) as string | null;
}

describe('readLeadBrief: the T3 link', () => {
  it("reads the newest of this project's relay events: none, a relay, then a later failure; another project's are not counted", () => {
    const { ctx, project, brief, a } = setup();
    expect(brief().links).toMatchObject({ t3: 'not checked', t3At: null });
    const other = createProject(ctx, 'test', { name: 'Elsewhere' });
    const log = (projectId: number, kind: 'relay' | 'relay_failed' | 'relay_unknown' | 'park') =>
      logLeadEvent(ctx, { projectId, lead: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, kind, nodeId: a.id, text: 'hi' });
    log(other.id, 'relay_failed');
    log(project.id, 'park');
    expect(brief().links).toMatchObject({ t3: 'not checked', t3At: null });
    log(project.id, 'relay');
    const relayAt = ctx.db.prepare("SELECT at FROM lead_events WHERE kind = 'relay'").pluck().get() as string;
    expect(brief().links).toMatchObject({ t3: 'ok', t3At: relayAt });
    log(project.id, 'relay_failed');
    const failedAt = ctx.db.prepare("SELECT at FROM lead_events WHERE kind = 'relay_failed' AND project_id = ?").pluck().get(project.id) as string;
    expect(failedAt > relayAt).toBe(true);
    expect(brief().links).toMatchObject({ t3: 'unavailable', t3At: failedAt });
    log(other.id, 'relay');
    expect(brief().links).toMatchObject({ t3: 'unavailable', t3At: failedAt });
    log(project.id, 'relay_unknown');
    expect(brief().links.t3).toBe('unavailable');
    // Two events at the same instant: the one logged later is the newest.
    const at = '2099-01-01T00:00:00.000Z';
    const insert = ctx.db.prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind, text) VALUES (?, ?, 'Progresser', 1, ?, 'hi')");
    insert.run(project.id, at, 'relay_failed');
    insert.run(project.id, at, 'relay');
    expect(brief().links).toMatchObject({ t3: 'ok', t3At: at });
  });
});

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
    const mask = (text: string) => text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, '<time>').replace(/(seen |· |look |changed |waited |ended |idle )(<1m|\d+[mhdw])/g, '$1<age>');
    expect(mask(second)).toBe(mask(first));
  });

  it('puts only the Board\'s next rows in Next up, in its order, and only stale marks in Stale', () => {
    const { ctx, project, a, b, c, aidenAsk, brief } = setup();
    setQueue(ctx, 'test', project.slug, [c.id, b.id], 'unowned');
    expect(brief().nextUp.map((n) => n.stepId)).toEqual([c.id, b.id]);
    // A done step with no outcome carries no_outcome, which is housekeeping: it is not Stale.
    updateNode(ctx, 'scribe:s1', a.id, { status: 'done' });
    expect(brief().stale).toEqual([]);
    // An ask of Aiden's left over a week is stale_ask, and is listed with only that mark and its reason in words.
    const later = new Date(Date.parse(ctx.now()) + 10 * 24 * 60 * 60 * 1000);
    expect(readLeadBrief(ctx, project.slug, 1, later).stale).toEqual([
      { stepId: a.id, title: 'Play app signing', marks: ['stale_ask'], reasons: [`a${aidenAsk.id} has waited 10d`] },
    ]);
  });

  it('has every open step that is a row in it: in flight, Aiden\'s own, next up, stale or counted in the backlog', () => {
    const { ctx, project, a, b, c, brief } = setup();
    const [blocked, own, parked, phase, pressKit, done, flying] = addNodes(ctx, 'test', {
      parentId: project.rootNodeId,
      nodes: [
        { title: 'Wait for the store', status: 'blocked' },
        { title: 'Buy the domain', status: 'active', assignee: 'me' },
        { title: 'Dark mode' },
        { title: 'Launch', children: [{ title: 'Press kit' }] },
        { title: 'Upload the key', status: 'done', outcome: 'Uploaded.' },
        { title: 'Signing fix', status: 'active' },
      ],
    });
    parkNode(ctx, 'test', parked.id, { reason: 'later' }, () => {});
    claimStep(ctx, 'test', 's1', flying.id);
    const r = brief();
    expect(r.inFlight.map((s) => s.stepId)).toEqual([flying.id]);
    expect(r.aidensOwn.map((s) => [s.stepId, s.title])).toEqual([[own.id, 'Buy the domain']]);
    expect(r.nextUp.map((n) => n.stepId)).toEqual([b.id]);
    // Started or blocked, with no session on it and no place in the queue: each says so in words.
    // The test clock moves with every read, so the age is masked.
    expect(r.stale.map((s) => ({ ...s, reasons: s.reasons.map((x) => x.replace(/(<1m|\d+m) ago$/, '<age> ago')) }))).toEqual([
      { stepId: a.id, title: 'Play app signing', marks: ['no_session'], reasons: ['active with no session on it, last changed <age> ago'] },
      { stepId: blocked.id, title: 'Wait for the store', marks: ['blocked'], reasons: ['blocked, last changed <age> ago'] },
    ]);
    // The rest of the backlog is counted: Old spike and Press kit. Launch only groups its step, and Dark mode is parked.
    expect(r.backlog).toBe(2);
    const open = ctx.db.prepare("SELECT COUNT(*) FROM nodes WHERE project_id = ? AND parent_id IS NOT NULL AND status IN ('todo', 'active', 'blocked')").pluck().get(project.id) as number;
    expect(r.inFlight.length + r.aidensOwn.length + r.nextUp.length + r.stale.length + r.backlog).toBe(open - 1);
    expect([c.id, phase.id, pressKit.id, done.id].every((id) => !r.stale.some((s) => s.stepId === id))).toBe(true);
  });

  it('leaves an ask on a shelved step out of Waiting on Aiden', () => {
    const { ctx, a, aidenAsk, brief } = setup();
    expect(brief().waitingOnAiden.map((x) => x.askId)).toEqual([aidenAsk.id]);
    parkNode(ctx, 'test', a.id, { reason: 'later' }, () => {});
    expect(brief().waitingOnAiden).toEqual([]);
  });

  it('cites what the lead said in Aiden\'s name since the last look, newest first, by ask or by step', () => {
    const { ctx, project, aidenAsk, a, brief } = setup();
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'answer', askId: aidenAsk.id, aidenWords: 'Use the release keystore.' });
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'park', nodeId: a.id, text: 'parked', aidenWords: 'Park it.' });
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'relay', nodeId: a.id, text: 'no words of his' });
    expect(brief().saidInAidensName.map((e) => [e.kind, e.ref, e.words])).toEqual([
      ['park', `#${a.id}`, 'Park it.'],
      ['answer', `a${aidenAsk.id}`, 'Use the release keystore.'],
    ]);
  });
});

describe('staleReasons', () => {
  const NOW = Date.parse('2026-11-15T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const ask = (id: number, raisedAt: string) => ({ id, raisedAt }) as Ask;
  const row = (o: Partial<Pick<BoardRow, 'column' | 'sessions' | 'driver' | 'asks' | 'waiting' | 'marks'>> & { status?: string; updatedAt?: string }) => ({
    node: { status: o.status ?? 'active', updatedAt: o.updatedAt ?? ago(3 * DAY) } as TreeNode,
    column: o.column ?? 'backlog',
    sessions: o.sessions ?? [],
    driver: o.driver ?? null,
    asks: o.asks ?? [],
    waiting: o.waiting ?? o.asks ?? [],
    marks: o.marks ?? [],
  });

  it('says in words why each mark is there, naming the asks and the ages', () => {
    const old = ask(107, ago(27 * DAY));
    const fresh = [ask(323, ago(4 * HOUR)), ask(324, ago(4 * HOUR))];
    const idle = { id: 's1', lastSeenAt: ago(2 * HOUR) } as Session;
    const text = (r: ReturnType<typeof row>, ended: string | null = null) => staleReasons(r, NOW, ended).map((w) => w.text);
    expect(text(row({ column: 'now', sessions: [idle], asks: [old], marks: ['stale_ask'] }))).toEqual(['a107 has waited 27d']);
    expect(text(row({ column: 'now', sessions: [idle], asks: [old, ...fresh], waiting: [old], marks: ['answered_in_chat'] }))).toEqual([
      'a323 and a324 may be answered already: Aiden has typed in its session since',
    ]);
    expect(text(row({ column: 'now', sessions: [idle], driver: idle, marks: ['stalled'] }))).toEqual(['its session has been idle 2h with nothing waiting on Aiden']);
    expect(text(row({ column: 'now', sessions: [idle], marks: ['stalled'] }))).toEqual(['sessions are on it but none drives it']);
    expect(text(row({ column: 'done', status: 'done', sessions: [idle], marks: ['done_focus'] }))).toEqual(['done, but a session still has it claimed']);
    expect(text(row({ column: 'next', status: 'todo', marks: ['answer_waiting'] }))).toEqual(['an answer has not reached a session yet']);
    // A housekeeping mark is no reason: it stays out, as before.
    expect(text(row({ column: 'next', status: 'todo', marks: ['deep', 'no_why'] }))).toEqual([]);
  });

  it('lists a started or blocked step with no session and no queue place, and lets ended_open speak for an active one', () => {
    const marks = (r: ReturnType<typeof row>, ended: string | null = null) => staleReasons(r, NOW, ended).map((w) => [w.mark, w.text]);
    expect(marks(row({}))).toEqual([['no_session', 'active with no session on it, last changed 3d ago']]);
    expect(marks(row({ status: 'blocked' }))).toEqual([['blocked', 'blocked, last changed 3d ago']]);
    expect(marks(row({ marks: ['ended_open'] }), ago(5 * HOUR))).toEqual([['ended_open', 'its session ended 5h ago and left it open']]);
    expect(marks(row({ status: 'blocked', marks: ['ended_open'] }), ago(5 * HOUR))).toEqual([
      ['blocked', 'blocked, last changed 3d ago'],
      ['ended_open', 'its session ended 5h ago and left it open'],
    ]);
    // In the queue it is in Next up with its status, and a todo step in the backlog is only counted.
    expect(marks(row({ column: 'next' }))).toEqual([]);
    expect(marks(row({ status: 'todo' }))).toEqual([]);
  });
});

describe('the brief route', () => {
  it('answers a project with no lead 409 when `as` is given, and writes nothing', async () => {
    const { ctx, app, project, leadEvents, seenAt } = setup();
    const before = maxEventId(ctx);
    const res = await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=${LEAD_INSTRUCTIONS_VERSION}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(noLeadNamed('Progresser'));
    expect(maxEventId(ctx)).toBe(before);
    expect(leadEvents()).toBe(0);
    expect(seenAt()).toBeNull();
  });

  it('answers another lead\'s name 409, and the named lead with { brief, text }', async () => {
    const { app, project, setLead } = setup();
    setLead('Progresser');
    expect((await app.inject({ url: `/api/lead/${project.slug}/brief?as=Rich&instructions=${LEAD_INSTRUCTIONS_VERSION}` })).statusCode).toBe(409);
    const ok = await app.inject({ url: `/api/lead/${project.slug}/brief?as=progresser&instructions=${LEAD_INSTRUCTIONS_VERSION}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().brief.project).toEqual({ slug: 'ingame', name: 'InGame', lead: 'Progresser' });
    expect(ok.json().text.split('\n')[0]).toMatch(/^Lead brief · InGame · .* · instructions v3 \(yours: v3\)$/);
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
    expect((await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=${LEAD_INSTRUCTIONS_VERSION}&mark=1` })).statusCode).toBe(400);
  });

  it('a GET never marks the look', async () => {
    const { app, project, setLead, seenAt } = setup();
    setLead('Progresser');
    await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=${LEAD_INSTRUCTIONS_VERSION}` });
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
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'answer', askId: aidenAsk.id, aidenWords: 'Yes.' });
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'park', text: 'later' });
    const { events } = (await app.inject({ url: `/api/lead/${project.slug}/events` })).json();
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(['park', 'answer']);
    expect(events[1]).toMatchObject({ lead: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, askId: aidenAsk.id, aidenWords: 'Yes.', nodeId: null, sessionId: null, text: '' });
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
    const first = await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=${LEAD_INSTRUCTIONS_VERSION}` });
    expect(first.json().brief.landedSince.map((n: { stepId: number }) => n.stepId)).toEqual([a.id]);
    expect(seenAt()).toBeNull();
    const res = await seen(app, project.slug, { as: 'progresser', instructions: LEAD_INSTRUCTIONS_VERSION });
    expect(res.statusCode).toBe(200);
    expect(res.json().seenAt).toBe(seenAt());
    const second = await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=${LEAD_INSTRUCTIONS_VERSION}` });
    expect(second.json().brief.landedSince).toEqual([]);
    expect(second.json().brief.links.lastSeenAt).toBe(seenAt());
  });

  it('refuses a request with no bearer token, a project with no lead or another lead, and writes nothing', async () => {
    const { ctx, app, project, setLead, seenAt } = setup();
    expect((await seen(app, project.slug, { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION }, {})).statusCode).toBe(401);
    const before = maxEventId(ctx);
    const none = await seen(app, project.slug, { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe(noLeadNamed('Progresser'));
    setLead('Progresser');
    expect((await seen(app, project.slug, { as: 'Rich', instructions: LEAD_INSTRUCTIONS_VERSION })).statusCode).toBe(409);
    expect(seenAt()).toBeNull();
    expect(maxEventId(ctx)).toBe(before + 1);
  });

  it('takes the time of the brief the lead read, so a step that landed after that brief is in the next one', async () => {
    const { ctx, app, project, a, setLead, seenAt } = setup();
    setLead('Progresser');
    const first = (await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=${LEAD_INSTRUCTIONS_VERSION}` })).json().brief;
    updateNode(ctx, 'scribe:s1', a.id, { status: 'done', outcome: 'Signed.' });
    const res = await seen(app, project.slug, { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, at: first.at });
    expect(res.json().seenAt).toBe(first.at);
    expect(seenAt()).toBe(first.at);
    const second = (await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=${LEAD_INSTRUCTIONS_VERSION}` })).json().brief;
    expect(second.landedSince.map((n: { stepId: number }) => n.stepId)).toEqual([a.id]);
  });

  it('counts a time ahead of the clock as now, and refuses one that is no time', async () => {
    const { ctx, app, project, setLead, seenAt } = setup();
    setLead('Progresser');
    const ahead = new Date(Date.parse(ctx.now()) + 3_600_000).toISOString();
    const res = await seen(app, project.slug, { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, at: ahead });
    expect(res.statusCode).toBe(200);
    expect(seenAt()! < ahead).toBe(true);
    expect((await seen(app, project.slug, { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, at: 'yesterday' })).statusCode).toBe(400);
  });

  it('takes a strict body: as, instructions and the time only', async () => {
    const { app, project, setLead } = setup();
    setLead('Progresser');
    expect((await seen(app, project.slug, { as: 'Progresser' })).statusCode).toBe(400);
    expect((await seen(app, project.slug, { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, extra: true })).statusCode).toBe(400);
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
    logLeadEvent(ctx, { projectId: project.id, lead: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'answer', aidenWords: 'Yes.' });
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

describe('the rules route', () => {
  const CLI = 'node C:/x/dist/cli/main.js';

  it('answers version 3 and the text for the stored lead name, whatever case `as` is given in', async () => {
    const { app, project, setLead } = setup();
    setLead('Progresser');
    for (const as of ['Progresser', 'progresser', 'PROGRESSER']) {
      const res = await app.inject({ url: `/api/lead/${project.slug}/rules?as=${as}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { version: number; text: string; bootstrap: string };
      expect(body.version).toBe(3);
      expect(body.text.split('\n')[0]).toBe('Rules for Progresser, the lead for InGame. Version 3.');
      expect(body.text).toContain('lead brief ingame --as Progresser --instructions 3');
      expect(body.bootstrap.split('\n')).toHaveLength(3);
      expect(body.bootstrap).toContain('lead rules ingame --as Progresser');
    }
  });

  it('refuses no lead, another name and an archived project with their sentences, and writes nothing', async () => {
    const { ctx, app, project, setLead, leadEvents } = setup();
    const none = await app.inject({ url: `/api/lead/${project.slug}/rules?as=Progresser` });
    expect([none.statusCode, none.json().error]).toEqual([409, noLeadNamed('Progresser')]);
    setLead('Progresser');
    const other = await app.inject({ url: `/api/lead/${project.slug}/rules?as=Rich` });
    expect([other.statusCode, other.json().error]).toEqual([409, noLeadNamed('Rich')]);
    changeProject(ctx, 'test', project.slug, { status: 'archived' });
    const archived = await app.inject({ url: `/api/lead/${project.slug}/rules?as=Progresser` });
    expect([archived.statusCode, archived.json().error]).toEqual([409, 'This project is archived, so it has no lead.']);
    expect(leadEvents()).toBe(0);
  });

  it('takes `as` and nothing else', async () => {
    const { app, project } = setup();
    expect((await app.inject({ url: `/api/lead/${project.slug}/rules` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/lead/${project.slug}/rules?as=Progresser&instructions=2` })).statusCode).toBe(400);
  });

  it('readLeadRules prints the command prefix it is given and the stored name', () => {
    const { ctx, project, setLead } = setup();
    setLead('Progresser');
    const r = readLeadRules(ctx, project.slug, ' progresser ', CLI);
    expect(r.version).toBe(LEAD_INSTRUCTIONS_VERSION);
    expect(r.text).toContain(`\n  ${CLI}\n`);
    expect(r.bootstrap).toBe(`You are Progresser, the lead for InGame.\nBefore anything else in every conversation, run this on Aiden's laptop and follow exactly what it prints:\n${CLI} lead rules ingame --as Progresser`);
  });
});

describe('a lead on older rules', () => {
  it('is refused a change with the sentence that names the rules command, and still reads, with the second line', async () => {
    const { app, project, setLead, brief } = setup();
    setLead('Progresser');
    const res = await app.inject({
      method: 'POST',
      url: `/api/lead/${project.slug}/kept`,
      headers: { authorization: 'Bearer t' },
      payload: { as: 'Progresser', instructions: 1, askId: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Your rules are version 1; version 3 is current. Run "lead rules ingame --as Progresser" again and follow what it prints.');
    const read = await app.inject({ url: `/api/lead/${project.slug}/brief?as=Progresser&instructions=1` });
    expect(read.statusCode).toBe(200);
    expect(read.json().text.split('\n')[1]).toBe('Your rules are out of date: you can read, you cannot change anything. Run the rules command again.');
    expect(brief().instructions.yours).toBe(1);
  });
});

describe('the intent record on the brief', () => {
  const RECORD = '## Goal\nShip it.\n\n## Phase\nFinish #1 and #2.\n\n## Out of scope\nNothing.\n\n## What Aiden cares about\nSpeed.\n\n## Standing rulings\nNone.\n';
  const store = (ctx: ReturnType<typeof setup>['ctx'], projectId: number, text: string) => write(ctx, 'lead', (record) => setProjectIntentInWrite(ctx, record, projectId, text));

  it('carries the whole record as text, and nothing with no record', () => {
    const { ctx, project, brief } = setup();
    expect(brief().intent).toMatchObject({ text: '', landedSince: 0, phaseFinished: false, updatedAt: null });
    store(ctx, project.id, RECORD);
    expect(brief().intent.text).toBe(RECORD);
    expect(brief().intent.updatedAt).not.toBeNull();
  });

  it('counts only the steps done at or after the record was written, never the root', () => {
    const { ctx, project, a, b, brief } = setup();
    updateNode(ctx, 'scribe:s1', a.id, { status: 'done', outcome: 'Signed.' });
    store(ctx, project.id, RECORD);
    expect(brief().intent.landedSince).toBe(0);
    updateNode(ctx, 'scribe:s1', b.id, { status: 'done', outcome: 'Published.' });
    expect(brief().intent.landedSince).toBe(1);
    updateNode(ctx, 'scribe:s1', project.rootNodeId, { status: 'done' });
    expect(brief().intent.landedSince).toBe(1);
  });

  it('phaseFinished is false when the Phase names no step, false while a named step is open, and true when all are done or dropped', () => {
    const { ctx, project, a, b, c, brief } = setup();
    store(ctx, project.id, `## Goal\nShip it.\n\n## Phase\nPolish.\n`);
    expect(brief().intent.phaseFinished).toBe(false);
    store(ctx, project.id, `## Goal\nShip it.\n\n## Phase\nFinish #${a.id} and #${b.id}.\n`);
    expect(brief().intent.phaseFinished).toBe(false);
    updateNode(ctx, 'scribe:s1', a.id, { status: 'done', outcome: 'Signed.' });
    expect(brief().intent.phaseFinished).toBe(false);
    updateNode(ctx, 'scribe:s1', b.id, { status: 'dropped' });
    expect(brief().intent.phaseFinished).toBe(true);
    // Only ids written out count: a range names its two ends.
    store(ctx, project.id, `## Goal\nShip it.\n\n## Phase\n#${a.id} to #${c.id}.\n`);
    expect(brief().intent.phaseFinished).toBe(false);
  });

  it('phaseFinished ignores an id that is not a step of this project, and is false when only those are named', () => {
    const { ctx, project, a, brief } = setup();
    const other = createProject(ctx, 'test', { name: 'Elsewhere' });
    const [foreign] = addNodes(ctx, 'test', { parentId: other.rootNodeId, nodes: [{ title: 'Unfinished elsewhere' }] });
    updateNode(ctx, 'scribe:s1', a.id, { status: 'done', outcome: 'Signed.' });
    store(ctx, project.id, `## Goal\nShip it.\n\n## Phase\nFinish #${a.id} with #${foreign.id}.\n`);
    expect(brief().intent.phaseFinished).toBe(true);
    store(ctx, project.id, `## Goal\nShip it.\n\n## Phase\nOnly #${foreign.id} and #999999.\n`);
    expect(brief().intent.phaseFinished).toBe(false);
  });

  it('reads the Phase in full, whatever its length, for the finished check', () => {
    const { ctx, project, a, b, brief } = setup();
    updateNode(ctx, 'scribe:s1', a.id, { status: 'done', outcome: 'Signed.' });
    // The step that is still open is named past the 300 characters the brief's headline keeps.
    store(ctx, project.id, `## Goal\nShip it.\n\n## Phase\nFinish #${a.id}, ${'and keep going '.repeat(30)}then #${b.id}.\n`);
    expect(brief().intent.phase.length).toBeLessThan(310);
    expect(brief().intent.phaseFinished).toBe(false);
  });
});

describe('the intent route', () => {
  it('reads the stored record back for the named lead, any instructions version, and says so when there is none', async () => {
    const { ctx, app, project, setLead } = setup();
    setLead('Progresser');
    const none = await app.inject({ url: `/api/lead/${project.slug}/intent?as=Progresser&instructions=1` });
    expect(none.json()).toEqual({ text: 'No intent record yet.', updatedAt: null });
    const text = '## Goal\nShip it.\n\n## Phase\nBeta.\n';
    write(ctx, 'lead', (record) => setProjectIntentInWrite(ctx, record, project.id, text));
    const res = await app.inject({ url: `/api/lead/${project.slug}/intent?as=progresser&instructions=1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe(text);
    expect(readLeadIntent(ctx, project.slug, 'Progresser', 1).updatedAt).toBe(res.json().updatedAt);
  });

  it('refuses another name, a missing name and a missing version', async () => {
    const { app, project, setLead } = setup();
    setLead('Progresser');
    const other = await app.inject({ url: `/api/lead/${project.slug}/intent?as=Rich&instructions=3` });
    expect([other.statusCode, other.json().error]).toEqual([409, noLeadNamed('Rich')]);
    expect((await app.inject({ url: `/api/lead/${project.slug}/intent?as=Progresser` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/lead/${project.slug}/intent` })).statusCode).toBe(400);
  });
});

describe('leadFolders', () => {
  it('gives forward slashes, no trailing slash, each folder once ignoring case, sorted, and none under C:/work or of another project', () => {
    const { ctx, project } = setup();
    const other = createProject(ctx, 'test', { name: 'Elsewhere' });
    for (const path of ['D:\\Zed\\Repo\\', 'c:/personal/ingame', 'C:/Personal/InGame/', 'C:\\work\\x', 'c:/work']) addBinding(ctx, 'test', project.slug, path);
    addBinding(ctx, 'test', other.slug, 'C:/personal/other');
    const folders = leadFolders(ctx, project.id);
    expect(folders).toEqual(['C:/personal/InGame', 'D:/Zed/Repo']);
    expect(folders.filter((f) => f.toLowerCase() === 'c:/personal/ingame')).toHaveLength(1);
    expect(folders).toContain('D:/Zed/Repo');
    expect(folders.some((f) => f.toLowerCase().startsWith('c:/work'))).toBe(false);
    expect(folders.some((f) => f.includes('\\') || f.endsWith('/'))).toBe(false);
    expect(folders).toEqual([...folders].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0)));
  });

  it('leaves out a folder that holds C:/work and a network path, and keeps an ordinary one', () => {
    const { ctx, project } = setup();
    const insert = ctx.db.prepare("INSERT INTO bindings (project_id, path, branch_pattern, created_at) VALUES (?, ?, '', ?)");
    // Inserted directly: addBinding may normalise or refuse some of these.
    for (const path of ['C:/', '//localhost/c$/work', 'C:/personal/x']) insert.run(project.id, path, ctx.now());
    expect(leadFolders(ctx, project.id)).toEqual(['C:/personal/InGame', 'C:/personal/x']);
  });

  it('is empty for a project with no folder, and the rules route prints those folders', async () => {
    const { ctx, project, setLead } = setup();
    setLead('Progresser');
    expect(readLeadRules(ctx, project.slug, 'Progresser', 'node x').text).toContain('You may read, and never change, anything inside:\n  C:/personal/InGame\n');
    const bare = createProject(ctx, 'test', { name: 'Bare' });
    setProjectLead(ctx, 'window', bare.slug, 'Progresser');
    expect(leadFolders(ctx, bare.id)).toEqual([]);
    expect(readLeadRules(ctx, bare.slug, 'Progresser', 'node x').text).toContain('This project has no folder on record.');
  });
});
