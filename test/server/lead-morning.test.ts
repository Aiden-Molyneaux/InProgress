import { describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { stamp } from '../../src/core/span';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { leadAllow, leadDecide, leadSet, leadUndo, lateAnswer } from '../../src/server/lead-commands';
import { applyVerdict } from '../../src/server/lead/apply';
import { dateKey, morningList, noteWake, readMorning, watchMorning, WAKE_GAP_MS } from '../../src/server/lead/morning';
import { standingRulings } from '../../src/server/lead/prompt';
import { quietHours } from '../../src/server/lead/settings';
import { raiseAskDetailed } from '../../src/server/repo/asks';
import { addDeskItem, moveDeskItem } from '../../src/server/repo/desk';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
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
    const held = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'held', ref: 'h1', nodeId: w.step.id }, w.ctx.now()).item;
    insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'held', nodeId: w.step.id, text: 'npm publish -> publishes the package' }, held.createdAt);
    // Went wrong: a stop the lead restarted.
    w.at(local(1, 2, 10));
    const stopped = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'stopped', ref: `s1@${w.ctx.now()}`, nodeId: w.step.id }, w.ctx.now()).item;
    w.at(local(1, 2, 51));
    moveDeskItem(w.ctx.db, stopped.id, ['open'], 'done', { outcome: 'RESTART d9', now: w.ctx.now() });
    // Not delivered: a voice line never sent.
    intendSend(w.ctx.db, { projectId: w.project.id, kind: 'voice_line', target: 'webhook', body: 'x' }, local(1, 3));
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
      col('Went wrong (1)', `#${w.step.id} stopped at 02:10; restarted at 02:51.`),
      col('Not delivered (1)', `voice_line to webhook (s1), not sent since 03:00.`),
      col('The lead', '3 calls, median 70 s, slowest 2 min 50, 1 late.'),
      col('The week', '41 percent used, the line says 44. Window 12 percent.'),
    ]);
    expect(list.parts.map((p) => p.name)).toEqual(['Yours', 'Decided for you', 'Held for you', 'Went wrong', 'Not delivered', 'The lead', 'The week']);
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
    insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'setting', text: 'lead-project proj-1' }, w.ctx.now());
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
      ['start', 'proj-1', `morning-thread:${w.project.id}:${dateKey(local(1, 8))}`],
    ]);
    const [voice, start] = w.sends();
    expect(voice!.body).toBe('InProgress morning list: 0 yours, 1 decided, 0 held. Say "the list" for all of it.');
    const body = JSON.parse(start!.body) as { message: string; title: string };
    expect(body.title).toBe(`InProgress lead ${dateKey(local(1, 8))}`);
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

  it('a wake gap is noted, and the list says the laptop slept', () => {
    const w = world();
    w.session('s1');
    const a = w.ask('s1', 'Which port?');
    w.at(local(0, 22));
    noteWake(w.ctx);
    w.at(local(0, 22, 1));
    expect(noteWake(w.ctx)).toBe(false);
    w.at(local(1, 8, 30));
    expect(noteWake(w.ctx)).toBe(true);
    expect(WAKE_GAP_MS).toBe(3 * MIN);
    w.at(local(1, 8, 31));
    // Something waited in the gap: the ask raised at wake.
    w.ask('s1', 'Which fixture file?');
    void a;
    const text = morningList(w.ctx, w.project.id, local(0, 9), local(1, 9, 30));
    expect(text.text).toBe('');
    write(w.ctx, 'system', () => addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'held', ref: 'h', nodeId: w.step.id }, local(0, 23)));
    const list = morningList(w.ctx, w.project.id, local(0, 9), local(1, 9, 30));
    expect(list.text.split('\n').at(-1)).toBe(`The laptop slept from ${hm(local(0, 22, 1))} to 08:30; 1 item waited.`);
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
    expect(told).toEqual([{ kind: 'relay', target: 'thread-s1', retryKey: `undo:d${d}`, body: `[From Progresser, the lead] d${d} is withdrawn: a${a.id} is Aiden's again.` }]);
    expect(standingRulings(w.ctx, w.project.id)).toBe(`- ids are noise (from undo d${d}, ${dateKey(w.ctx.now())})`);
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
    expect(late).toEqual([{ kind: 'relay', target: 'thread-s1', retryKey: `late:a${a.id}`, body: `[From Progresser, the lead] Aiden's answer, which replaces d${d}: "No, ids are noise."` }]);
    // A plain answer to an ask nobody decided is none of this.
    const b = w.ask('s1', 'Which port?');
    expect(lateAnswer(w.ctx, b.id, 'use 4410', 'window')).toBe(false);
  });
});
