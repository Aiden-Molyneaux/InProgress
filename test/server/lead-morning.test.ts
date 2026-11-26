import { join } from 'node:path';
import { RELAYED, relayText } from '../../src/core/relay';
import { describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { stamp } from '../../src/core/span';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { leadAllow, leadDecide, leadSet, leadUndo, lateAnswer } from '../../src/server/lead-commands';
import { applyVerdict } from '../../src/server/lead/apply';
import { heldRef } from '../../src/server/lead/hold';
import { dateKey, dayWords, morningList, noteWake, readMorning, watchMorning, WAKE_GAP_MS } from '../../src/server/lead/morning';
import { standingRulings } from '../../src/server/lead/prompt';
import { quietHours } from '../../src/server/lead/settings';
import { raiseAskDetailed, undeliveredAnswers } from '../../src/server/repo/asks';
import { addDeskItem, moveDeskItem } from '../../src/server/repo/desk';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
import { addDecision } from '../../src/server/repo/leadDecisions';
import { clipLine } from '../../src/core/step-ref';
import { intendSend } from '../../src/server/repo/leadSends';
import { applyTurn, leaseItem, moveTurn, saveAnswer } from '../../src/server/repo/leadTurns';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { addReading } from '../../src/server/repo/usageReadings';
import { write } from '../../src/server/db/tx';
import { handleHookEvent } from '../../src/server/session-flow';

const V = LEAD_INSTRUCTIONS_VERSION;
const BOUND = 'C:/personal/InProgress';
const MIN = 60_000;
/** A local time on 25 November 2026 plus `day` days, as an ISO string: the tests read local hours, as the list does. */
const local = (day: number, h: number, m = 0): string => new Date(2026, 10, 25 + day, h, m).toISOString();
const hm = (iso: string): string => stamp(iso).slice(11);

/** InProgress led by Progresser with the round on since Wednesday 20:00, on a clock the test sets. */
function world() {
  let t = Date.parse(local(0, 20));
  const ctx = createCtx(openDb(':memory:'), () => new Date(t).toISOString());
  ctx.home = HOME;
  const at = (iso: string) => void (t = Date.parse(iso));
  const project = createProject(ctx, 'test', { name: 'InProgress' });
  addBinding(ctx, 'test', project.slug, BOUND);
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Board search' }] });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
  const session = (id: string) => handleHookEvent(ctx, id, { event: 'start', source: 'startup', cwd: BOUND, app: 't3' as const, t3ThreadId: `thread-${id}` });
  const ask = (sessionId: string, text: string) => raiseAskDetailed(ctx, `scribe:${sessionId}`, { nodeId: step!.id, kind: 'question', text, sessionId }).ask;
  const count = (sql: string, ...args: unknown[]) => ctx.db.prepare(`SELECT COUNT(*) FROM ${sql}`).pluck().get(...args) as number;
  const sends = () => ctx.db.prepare('SELECT kind, target, retry_key AS retryKey, body FROM lead_sends ORDER BY id').all() as { kind: string; target: string; retryKey: string; body: string }[];
  return { ctx, project, step: step!, at, session, ask, count, sends };
}

const HOME = 'C:/test-home/inprogress';

describe('the morning list', () => {
  it('lays out a night: product rulings first with every undo word, the parts that have something, the rest left out', () => {
    const w = world();
    w.session('s1');
    w.at(local(0, 23));
    const a1 = w.ask('s1', 'Should the button say Find or Search?');
    const a2 = w.ask('s1', 'Which port?');
    const a3 = w.ask('s1', 'Which fixture file?');
    w.at(local(0, 23, 10));
    const technical = leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: a2.id, answer: 'use 4410', reason: 'it is free', kind: 'technical' }).decision;
    w.at(local(0, 23, 20));
    const product = leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: a3.id, answer: 'ids are matched too', reason: 'the board shows ids', kind: 'product' }).decision;
    // Yours: brought and waiting.
    insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'bring', askId: a1.id, nodeId: w.step.id, text: 'Search.' }, w.ctx.now());
    // Held for you.
    w.at(local(1, 1, 0));
    const held = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'held', ref: heldRef('s1', 'npm publish'), nodeId: w.step.id }, w.ctx.now()).item;
    insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'held', nodeId: w.step.id, sessionId: 's1', text: 'npm publish -> publishes the package' }, held.createdAt);
    // Went wrong: a stop the lead restarted.
    w.at(local(1, 2, 10));
    const stopped = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'stopped', ref: `s1@${w.ctx.now()}`, nodeId: w.step.id }, w.ctx.now()).item;
    w.at(local(1, 2, 51));
    moveDeskItem(w.ctx.db, stopped.id, ['open'], 'done', { outcome: 'RESTART d9', now: w.ctx.now() });
    // Its restart's decision is not listed again under Decided for you: Went wrong names it (C6).
    const restart = insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'decide', nodeId: w.step.id, text: 'restart' }, w.ctx.now());
    addDecision(w.ctx.db, { eventId: restart, itemId: stopped.id, kind: 'technical', line: 'Restarted the step', saidWhere: 'desk', saidAt: w.ctx.now() });
    // Not delivered: a voice line never sent, a carried answer and a message under the lead's header (C5).
    intendSend(w.ctx.db, { projectId: w.project.id, kind: 'voice_line', target: 'webhook', body: 'x' }, local(1, 3));
    intendSend(w.ctx.db, { projectId: w.project.id, kind: 'carry', target: 'thread-s1', body: `Aiden's answer to a1, carried by Progresser:   "Search"\nsecond line` }, local(1, 3, 1));
    intendSend(w.ctx.db, { projectId: w.project.id, kind: 'relay', target: 'thread-s1', body: `[From Progresser, the lead] d1 is withdrawn: ${'a very long line '.repeat(8)}` }, local(1, 3, 2));
    // The lead: three applied calls, one late.
    const calls = [[70_000, null], [170_000, local(1, 4)], [30_000, local(1, 5, 30)]] as const;
    calls.forEach(([ms, due], i) => {
      w.at(local(1, 4, 10 * i));
      const item = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'promise_due', ref: `p${i}`, dueAt: due }, w.ctx.now()).item;
      const turn = leaseItem(w.ctx.db, item.id, { way: 'headless', model: 'm', leaseMs: 6 * MIN }, w.ctx.now())!;
      moveTurn(w.ctx.db, turn.id, ['leased'], 'applied', { finishedAt: w.ctx.now(), durationMs: ms });
    });
    // The week.
    const now = local(1, 9, 30);
    addReading(w.ctx.db, { at: local(1, 9, 25), source: 'turn', windowUsed: 0.12, windowResets: local(1, 14), weekUsed: 0.41, weekResets: new Date(Date.parse(now) + 0.56 * 7 * 24 * 60 * MIN).toISOString() });

    const list = morningList(w.ctx, w.project.id, local(0, 9), now);
    expect(list.yours).toBe(1);
    expect(list.decided).toBe(2);
    expect(list.held).toBe(1);
    const width = 'Decided for you (2)'.length + 2;
    const col = (label: string, line: string, first = true) => (first ? label.padEnd(width) : ' '.repeat(width)) + line;
    const step = `#${w.step.id} Board search`;
    expect(list.text.split('\n')).toEqual([
      `InProgress · Thursday 26 November · since Wednesday 09:00`,
      col('Yours (1)', `${step}: Should the button say Find or Search?. I would: Search.`),
      col('Decided for you (2)', 'Product rulings first:'),
      col('', `d${product} ${step}: Which fixture file? -> ids are matched too. "undo d${product}"`, false),
      col('', `d${technical} ${step}: Which port? -> use 4410. "undo d${technical}"`, false),
      col('Held for you (1)', `#${w.step.id} wants to npm publish. Say "go ahead" or "not yet".`),
      col('Went wrong (1)', `#${w.step.id} stopped at 02:10; restarted at 02:51, 41 minutes lost.`),
      col('Not delivered (3)', `A Voice line "x" (s1), not sent since 03:00.`),
      col('', `A carried answer "Aiden's answer to a1, carried by Progresser: "Search"" (s2), not sent since 03:01.`, false),
      col('', `A message to a session "${clipLine(`d1 is withdrawn: ${'a very long line '.repeat(8)}`, 80)}" (s3), not sent since 03:02.`, false),
      col('The lead', '3 calls, median 70 s, slowest 2 min 50, 1 late.'),
      col('The week', '41 percent used, the line says 44. Window 12 percent.'),
    ]);
    expect(list.parts.map((p) => p.name)).toEqual(['Yours', 'Decided for you', 'Held for you', 'Went wrong', 'Not delivered', 'The lead', 'The week']);
  });

  it('M1, O1, O2, m4: a stop from before the last list is decided for you; a park says its undo word; a send that could not go; a relay header line', () => {
    const w = world();
    // A stop made before `since` and decided after it: Went wrong does not list it, so Decided for you does (M1).
    w.at(local(0, 8));
    const early = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'stopped', ref: `s1@${w.ctx.now()}`, nodeId: w.step.id }, w.ctx.now()).item;
    w.at(local(0, 23));
    const restart = insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'decide', nodeId: w.step.id, text: 'restart' }, w.ctx.now());
    addDecision(w.ctx.db, { eventId: restart, itemId: early.id, kind: 'technical', line: 'Restarted the export', saidWhere: 'desk', saidAt: w.ctx.now() });
    moveDeskItem(w.ctx.db, early.id, ['open'], 'done', { outcome: `RESTART d${restart}`, now: w.ctx.now() });
    // A stop in the night the lead parked: its line carries the park's undo word (O1).
    w.at(local(1, 2, 10));
    const parked = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'stopped', ref: `s2@${w.ctx.now()}`, nodeId: w.step.id }, w.ctx.now()).item;
    w.at(local(1, 2, 51));
    const park = insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'park', nodeId: w.step.id, text: 'no way on' }, w.ctx.now());
    addDecision(w.ctx.db, { eventId: park, itemId: parked.id, kind: 'technical', line: 'Parked the step', saidWhere: 'desk', saidAt: w.ctx.now() });
    moveDeskItem(w.ctx.db, parked.id, ['open'], 'done', { outcome: `PARK d${park}`, now: w.ctx.now() });
    // A carry whose thread is gone, and one T3 Code refused (O2).
    w.at(local(1, 3));
    insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'send_refused', nodeId: w.step.id, text: 's7 (carry): its thread th_1 is not in T3 Code' }, w.ctx.now());
    insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'send_refused', nodeId: w.step.id, text: 's8 for item #3: a bad title' }, w.ctx.now());
    // A relay whose header stands alone on its first line (m4).
    const relayed = intendSend(w.ctx.db, { projectId: w.project.id, kind: 'relay', target: 'thread-s1', body: relayText('Progresser', 'InProgress', 'Where does the work stand?') }, local(1, 3, 5));
    const list = morningList(w.ctx, w.project.id, local(0, 9), local(1, 9, 30));
    const part = (name: string) => list.parts.find((p) => p.name === name)?.lines ?? [];
    expect(part('Decided for you')).toEqual([`d${restart} #${w.step.id} Board search: Restarted the export. "undo d${restart}"`]);
    expect(part('Went wrong')).toEqual([
      `#${w.step.id} stopped at 02:10; parked at 02:51. "undo d${park}"`,
      `#${w.step.id}: a send could not go at 03:00 and was cleared (s7 (carry): its thread th_1 is not in T3 Code).`,
      `#${w.step.id}: a send was refused at 03:00 and cleared (s8 for item #3: a bad title).`,
    ]);
    expect(part('Not delivered')).toEqual([`A message to a session "Where does the work stand?" (s${relayed.id}), not sent since 03:05.`]);
  });

  it('leaves out a part with nothing, and a day with nothing has no list', () => {
    const w = world();
    w.session('s1');
    const a = w.ask('s1', 'Which port?');
    w.at(local(0, 23));
    const d = leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: a.id, answer: 'use 4410', reason: 'free' }).decision;
    const only = morningList(w.ctx, w.project.id, local(0, 9), local(1, 9, 30));
    expect(only.parts.map((p) => p.name)).toEqual(['Decided for you']);
    expect(only.text).not.toContain('Product rulings first');
    expect(only.text).toContain(`"undo d${d}"`);
    // Undone, it is no longer listed: nothing is left.
    leadUndo(w.ctx, w.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'undo it' });
    expect(morningList(w.ctx, w.project.id, local(0, 9), local(1, 9, 30)).parts.map((p) => p.name)).not.toContain('Decided for you');
    const quiet = world();
    expect(morningList(quiet.ctx, quiet.project.id, local(0, 9), local(1, 9, 30))).toMatchObject({ text: '', parts: [] });
    expect(readMorning(quiet.ctx, quiet.project.id)).toMatch(/^Nothing since /);
  });

  it('the watch writes the morning row and its sends once however many ticks, a missed night as one list, an empty day as an empty row', () => {
    const w = world();
    w.session('s1');
    const a = w.ask('s1', 'Which port?');
    leadSet(w.ctx, w.project.slug, 'Progresser', V, { key: 'quiet', value: '23:00-08:00' });
    expect(quietHours(w.ctx.db, w.project.id)).toEqual({ from: 23 * 60, to: 8 * 60 });
    w.at(local(0, 23));
    leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: a.id, answer: 'use 4410', reason: 'free' });
    // The lead's thread is set up: a setting row.
    insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'setting', text: 'lead-thread on' }, w.ctx.now());
    w.at(local(1, 7, 59));
    expect(watchMorning(w.ctx)).toBe(0);
    // Ticks all morning, and the minutes after: one list, however many.
    for (const [day, h, m] of [[1, 8, 0], [1, 8, 1], [1, 12, 0]] as const) {
      w.at(local(day, h, m));
      watchMorning(w.ctx);
    }
    expect(w.count("lead_events WHERE kind = 'morning'")).toBe(1);
    expect(w.sends().map((s) => [s.kind, s.target, s.retryKey])).toEqual([
      ['voice_line', 'webhook', `morning:${w.project.id}:${dateKey(local(1, 8))}`],
      ['start', join(HOME, 'lead', w.project.slug), `morning-thread:${w.project.id}:${dateKey(local(1, 8))}`],
    ]);
    const [voice, start] = w.sends();
    expect(voice!.body).toBe('InProgress morning list: 0 yours, 1 decided, 0 held. Say "the list" for all of it.');
    const body = JSON.parse(start!.body) as { message: string; title: string; provider: string; model: string };
    expect(body.title).toBe(`InProgress lead ${dayWords(local(1, 8))}`);
    expect([body.provider, body.model]).toEqual(['claudeAgent', 'claude-opus-5-5']);
    expect(body.message.startsWith(`You are Progresser, the lead for InProgress. Run: inprogress lead rules ${w.project.slug} --as Progresser and follow them. Then read this morning's list:`)).toBe(true);
    expect(body.message).toContain('Decided for you (1)');
    // The sender carried both out; the next day had nothing: an empty morning row, and nothing more is sent.
    w.ctx.db.prepare("UPDATE lead_sends SET state = 'done'").run();
    w.at(local(2, 8, 5));
    expect(watchMorning(w.ctx)).toBe(0);
    watchMorning(w.ctx);
    expect(w.count("lead_events WHERE kind = 'morning'")).toBe(2);
    expect(w.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'morning' ORDER BY id DESC").pluck().get()).toBe('');
    expect(w.sends()).toHaveLength(2);
  });

  it('a wake gap in the night is noted, and the list says how many items waited across the lid', () => {
    const w = world();
    w.session('s1');
    // Three items open before the lid shuts: the question and two held commands.
    w.ask('s1', 'Which port?');
    w.at(local(0, 21));
    for (const ref of ['h1', 'h2']) addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'held', ref, nodeId: w.step.id }, w.ctx.now());
    w.at(local(0, 22));
    noteWake(w.ctx);
    w.at(local(0, 22, 1));
    expect(noteWake(w.ctx)).toBe(false);
    w.at(local(1, 8, 30));
    expect(noteWake(w.ctx)).toBe(true);
    expect(WAKE_GAP_MS).toBe(3 * MIN);
    // Something raised after the wake did not wait across the lid.
    w.at(local(1, 8, 31));
    w.ask('s1', 'Which fixture file?');
    const list = morningList(w.ctx, w.project.id, local(0, 9), local(1, 9, 30));
    expect(list.text.split('\n').at(-1)).toBe(`The laptop slept from ${hm(local(0, 22, 1))} to 08:30. 3 items waited; none was lost.`);
    // One that waited and fell behind is said (C7).
    w.ctx.db.prepare("UPDATE desk_items SET state = 'behind' WHERE ref = 'h1'").run();
    expect(morningList(w.ctx, w.project.id, local(0, 9), local(1, 9, 30)).text.split('\n').at(-1)).toBe(`The laptop slept from ${hm(local(0, 22, 1))} to 08:30. 3 items waited; 1 fell behind.`);
  });

  it('a gap outside the quiet hours is not noted as the night', () => {
    const w = world();
    w.at(local(1, 12));
    noteWake(w.ctx);
    w.at(local(1, 13));
    expect(noteWake(w.ctx)).toBe(true);
    expect(w.count("lead_events WHERE kind = 'slept'")).toBe(0);
    // A gap that runs into the quiet hours is.
    w.at(local(1, 23));
    noteWake(w.ctx);
    w.at(local(2, 1));
    expect(noteWake(w.ctx)).toBe(true);
    expect(w.count("lead_events WHERE kind = 'slept'")).toBe(1);
  });
});

describe('the morning list, once a day', () => {
  /** A second project with the round on, one decision of its own to list. */
  const second = (w: ReturnType<typeof world>) => {
    const p = createProject(w.ctx, 'test', { name: 'Glimpse' });
    addBinding(w.ctx, 'test', p.slug, 'C:/personal/Glimpse');
    const [node] = addNodes(w.ctx, 'test', { parentId: p.rootNodeId, nodes: [{ title: 'Login' }] });
    setProjectLead(w.ctx, 'window', p.slug, 'Grok');
    leadAllow(w.ctx, p.slug, 'Grok', V, { switch: 'round', aidenWords: 'go' });
    return { p, node: node! };
  };

  it('changing quiet hours after the morning ran writes no second list and throws nothing, and the next project still gets its list', () => {
    const w = world();
    const { p, node } = second(w);
    leadSet(w.ctx, p.slug, 'Grok', V, { key: 'quiet', value: '00:00-12:00' });
    w.session('s1');
    const a = w.ask('s1', 'Which port?');
    w.at(local(0, 23));
    leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: a.id, answer: 'use 4410', reason: 'free' });
    const b = raiseAskDetailed(w.ctx, 'scribe:x', { nodeId: node.id, kind: 'question', text: 'Which provider?' }).ask;
    leadDecide(w.ctx, p.slug, 'Grok', V, { askId: b.id, answer: 'google', reason: 'already set up' });
    w.at(local(1, 9, 5));
    expect(watchMorning(w.ctx)).toBe(1);
    // Aiden moves the first project's morning to 10:00-11:00 after it ran.
    leadSet(w.ctx, w.project.slug, 'Progresser', V, { key: 'quiet', value: '10:00-11:00' });
    w.at(local(1, 12, 5));
    const errors: string[] = [];
    expect(watchMorning(w.ctx, { error: (m) => void errors.push(m) })).toBe(1);
    expect(errors).toEqual([]);
    expect(w.count("lead_events WHERE kind = 'morning' AND project_id = ?", w.project.id)).toBe(1);
    expect(w.count("lead_events WHERE kind = 'morning' AND project_id = ?", p.id)).toBe(1);
    expect(w.count("lead_sends WHERE kind = 'voice_line'")).toBe(2);
  });

  it("one project's failure is logged and never stops the others", () => {
    const w = world();
    const { p, node } = second(w);
    w.session('s1');
    const a = w.ask('s1', 'Which port?');
    const b = raiseAskDetailed(w.ctx, 'scribe:x', { nodeId: node.id, kind: 'question', text: 'Which provider?' }).ask;
    w.at(local(0, 23));
    leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: a.id, answer: 'use 4410', reason: 'free' });
    leadDecide(w.ctx, p.slug, 'Grok', V, { askId: b.id, answer: 'google', reason: 'set up' });
    // The first project's retry key is taken already, as a leftover of an older build would leave it.
    w.at(local(1, 9, 5));
    intendSend(w.ctx.db, { projectId: w.project.id, kind: 'voice_line', target: 'webhook', retryKey: `morning:${w.project.id}:${dateKey(w.ctx.now())}`, body: 'old' }, w.ctx.now());
    const errors: string[] = [];
    expect(watchMorning(w.ctx, { error: (m) => void errors.push(m) })).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`project ${w.project.id}`);
    expect(w.count("lead_events WHERE kind = 'morning' AND project_id = ?", p.id)).toBe(1);
  });

  it("a morning's own Voice line, still intended, is not next day's Not delivered; rows written in the morning's own tick are not counted twice", () => {
    const w = world();
    w.session('s1');
    const a = w.ask('s1', 'Which port?');
    w.at(local(0, 23));
    leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: a.id, answer: 'use 4410', reason: 'free' });
    w.at(local(1, 9, 0));
    expect(watchMorning(w.ctx)).toBe(1);
    const row = w.ctx.db.prepare("SELECT at FROM lead_events WHERE kind = 'morning'").pluck().get() as string;
    // The voice line stays intended: the sender has no Voice yet. A day later the next list is empty.
    w.at(local(2, 9, 0));
    expect(morningList(w.ctx, w.project.id, row, w.ctx.now()).parts.map((x) => x.name)).toEqual([]);
    // A decision written at exactly the since time belongs to the list before it.
    expect(morningList(w.ctx, w.project.id, local(0, 23), w.ctx.now()).parts.map((x) => x.name)).toEqual([]);
  });

  it('a held item reads its own command, joined by session and ref', () => {
    const w = world();
    w.session('s1');
    w.at(local(1, 1));
    for (const [session, command] of [['s1', 'npm publish'], ['s2', 'git push -> origin']] as const) {
      const { item } = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'held', ref: heldRef(session, command), nodeId: w.step.id }, w.ctx.now());
      insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'held', nodeId: w.step.id, sessionId: session, text: `${command} -> held for Aiden` }, item.createdAt);
    }
    const lines = morningList(w.ctx, w.project.id, local(0, 9), local(1, 9)).parts.find((x) => x.name === 'Held for you')!.lines;
    expect(lines).toEqual([
      `#${w.step.id} wants to npm publish. Say "go ahead" or "not yet".`,
      `#${w.step.id} wants to git push -> origin. Say "go ahead" or "not yet".`,
    ]);
  });

  it('lead morning prints today written list, then what is new since it', () => {
    const w = world();
    w.session('s1');
    const a = w.ask('s1', 'Which port?');
    w.at(local(0, 23));
    leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: a.id, answer: 'use 4410', reason: 'free' });
    w.at(local(1, 9, 0));
    watchMorning(w.ctx);
    const written = w.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'morning'").pluck().get() as string;
    w.at(local(1, 9, 30));
    expect(readMorning(w.ctx, w.project.id)).toBe(written);
    const b = w.ask('s1', 'Which fixture file?');
    w.at(local(1, 9, 40));
    leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: b.id, answer: 'fixtures.json', reason: 'the only one' });
    const printed = readMorning(w.ctx, w.project.id);
    expect(printed.startsWith(`${written}\n\nSince then:\n`)).toBe(true);
    expect(printed).toContain('Which fixture file? -> fixtures.json');
    // Another day, before its list: the list built now, not yesterday's.
    w.at(local(2, 8));
    expect(readMorning(w.ctx, w.project.id)).not.toContain('Since then');
  });
});

describe('undo of a desk decision, and Aiden late answer', () => {
  const decided = () => {
    const w = world();
    w.session('s1');
    const a = w.ask('s1', 'Should search match step ids?');
    const itemId = w.ctx.db.prepare("SELECT id FROM desk_items WHERE kind = 'question'").pluck().get() as number;
    const turn = leaseItem(w.ctx.db, itemId, { way: 'headless', model: 'm', leaseMs: 6 * MIN }, w.ctx.now())!;
    saveAnswer(w.ctx.db, turn.id, { verdict: 'DECIDE', kind: 'PRODUCT', answer: 'yes', why: 'the board shows ids' }, w.ctx.now());
    write(w.ctx, 'lead:Progresser', (record) => applyTurn(w.ctx.db, turn.id, w.ctx.now(), (t, item) => applyVerdict(w.ctx, t, item, record)), { immediate: true });
    const d = w.ctx.db.prepare("SELECT id FROM lead_events WHERE kind = 'decide'").pluck().get() as number;
    return { w, a, d };
  };

  it('tells the session once, and keeps his reason as a standing ruling the desk turn reads', () => {
    const { w, a, d } = decided();
    expect(standingRulings(w.ctx, w.project.id)).toBe('');
    leadUndo(w.ctx, w.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'undo d' + d + ', ids are noise', reason: 'ids are noise' });
    const told = w.sends().filter((s) => s.retryKey === `undo:d${d}`);
    expect(told).toEqual([{ kind: 'relay', target: 'thread-s1', retryKey: `undo:d${d}`, body: `[From Progresser, the lead] d${d} is withdrawn: a${a.id} is Aiden's again. His words: "undo d${d}, ids are noise".` }]);
    expect(standingRulings(w.ctx, w.project.id)).toBe(`- ids are noise (from undo d${d}, ${dateKey(w.ctx.now())})`);
    // The tag is stored on the ruling itself, not found by a join.
    expect(w.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'ruling'").pluck().get()).toBe(`d${d}: ids are noise`);
    // Undone once: a second undo is refused and tells nothing more.
    expect(() => leadUndo(w.ctx, w.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'again' })).toThrow(/already undone/);
    expect(w.sends().filter((s) => s.retryKey === `undo:d${d}`)).toHaveLength(1);
  });

  it('an undo with no reason stores no ruling', () => {
    const { w, d } = decided();
    leadUndo(w.ctx, w.project.slug, 'Progresser', V, { eventId: d, aidenWords: `undo d${d}` });
    expect(standingRulings(w.ctx, w.project.id)).toBe('');
  });

  it('a decision said by the lead on the CLI path (said_where thread) is told too, but a brought one is not decided so nothing is told', () => {
    const w = world();
    w.session('s1');
    const a = w.ask('s1', 'Which port?');
    const d = leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: a.id, answer: 'use 4410', reason: 'free' }).decision;
    leadUndo(w.ctx, w.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'no' });
    expect(w.sends().filter((s) => s.retryKey === `undo:d${d}`)).toHaveLength(1);
  });

  it('T9: a late answer for a session not in T3 Code becomes the ask answer, undelivered, so its next prompt reads it; a T3 session keeps the relay', () => {
    const plain = decided();
    plain.w.ctx.db.prepare("UPDATE sessions SET t3_thread_id = NULL, app = 'claude' WHERE id = 's1'").run();
    plain.w.ctx.db.prepare('UPDATE asks SET answer_delivered_at = ? WHERE id = ?').run(plain.w.ctx.now(), plain.a.id);
    expect(lateAnswer(plain.w.ctx, plain.a.id, 'No, ids are noise.', 'window')).toBe(true);
    expect(plain.w.ctx.db.prepare('SELECT answer, answer_delivered_at AS delivered FROM asks WHERE id = ?').get(plain.a.id)).toEqual({ answer: 'No, ids are noise.', delivered: null });
    expect(plain.w.sends().filter((s) => s.retryKey === `late:a${plain.a.id}`)).toHaveLength(0);
    // Y1: the answer is Aiden's own: the session's prompt reads it as his, never as the lead's.
    expect(undeliveredAnswers(plain.w.ctx, 's1').map((x) => [x.id, x.answer, x.answeredVia])).toEqual([[plain.a.id, 'No, ids are noise.', null]]);
    const context = handleHookEvent(plain.w.ctx, 's1', { event: 'prompt' }).context ?? '';
    expect(context).toContain(`Answered: a${plain.a.id} "No, ids are noise."`);
    expect(context).not.toContain('not Aiden');
    const t3 = decided();
    const events: string[] = [];
    t3.w.ctx.bus.on('event', (e: { type: string }) => void events.push(e.type));
    t3.w.ctx.db.prepare('UPDATE asks SET answer_delivered_at = ? WHERE id = ?').run(t3.w.ctx.now(), t3.a.id);
    expect(lateAnswer(t3.w.ctx, t3.a.id, 'No, ids are noise.', 'window')).toBe(true);
    // The window shows his answer (an event, and the row), and the T3 session has its carry. As with any carried answer, it
    // is undelivered until the carry is tried (which stamps it), so a cleared carry leaves it for the next prompt.
    expect(t3.w.ctx.db.prepare('SELECT answer, answered_via AS via FROM asks WHERE id = ?').get(t3.a.id)).toEqual({ answer: 'No, ids are noise.', via: null });
    expect(undeliveredAnswers(t3.w.ctx, 's1').map((x) => x.id)).toEqual([t3.a.id]);
    expect(events).toContain('ask.cleared');
    expect(t3.w.sends().filter((s) => s.retryKey === `late:a${t3.a.id}`)).toHaveLength(1);
  });

  it('Y2: Went wrong gives a restart that waits and a park skipped words of their own, never restarted or parked', () => {
    const w = world();
    const made = (ref: string, outcome: string, state: 'open' | 'done') => {
      const { item } = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'stopped', ref, nodeId: w.step.id }, w.ctx.now());
      moveDeskItem(w.ctx.db, item.id, ['open'], state, { outcome, now: w.ctx.now() });
    };
    made(`s1@${w.ctx.now()}`, 'waits: a restart waits for a fresh usage reading (there is no usage reading yet)', 'open');
    made(`s2@${w.ctx.now()}`, `PARK skipped: #${w.step.id} is already done (the cause)`, 'done');
    const list = morningList(w.ctx, w.project.id, '2026-01-01T00:00:00.000Z', w.ctx.now());
    const wrong = list.parts.find((p) => p.name === 'Went wrong')!.lines;
    expect(wrong.some((l) => l.includes('a restart waits for a usage reading'))).toBe(true);
    expect(wrong.some((l) => l.includes('not parked at') && l.includes('the step was already done'))).toBe(true);
    expect(wrong.some((l) => / restarted at |; parked at /.test(l))).toBe(false);
  });

  it('Aiden late answer in the window becomes an undo plus his answer, and reaches the session once', () => {
    const { w, a, d } = decided();
    expect(lateAnswer(w.ctx, a.id, 'No, ids are noise.', 'window')).toBe(true);
    expect(lateAnswer(w.ctx, a.id, 'No, ids are noise.', 'window')).toBe(false);
    const kinds = w.ctx.db.prepare("SELECT kind, text, aiden_words FROM lead_events WHERE ask_id = ? AND kind IN ('undo', 'answer') ORDER BY id").all(a.id);
    expect(kinds).toEqual([
      { kind: 'undo', text: `d${d}`, aiden_words: 'No, ids are noise.' },
      { kind: 'answer', text: '', aiden_words: 'No, ids are noise.' },
    ]);
    const late = w.sends().filter((s) => s.retryKey === `late:a${a.id}`);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ kind: 'carry', target: 'thread-s1', retryKey: `late:a${a.id}` });
    // His own words, never under the lead's [From ...] header, which the hook reads as not Aiden.
    expect(late[0]!.body).toMatch(new RegExp(`^Aiden's answer to a${a.id}, which replaces d${d}, carried by Progresser from the window at \\d\\d:\\d\\d: "No, ids are noise\\."$`));
    expect(RELAYED.test(late[0]!.body)).toBe(false);
    // A plain answer to an ask nobody decided is none of this.
    const b = w.ask('s1', 'Which port?');
    expect(lateAnswer(w.ctx, b.id, 'use 4410', 'window')).toBe(false);
  });
});
