import { describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { openDb } from '../../src/server/db/connection';
import { createCtx, write } from '../../src/server/db/tx';
import { aidenOpenAsks, readLeadBrief } from '../../src/server/lead';
import { leadAllow, leadDecide, leadUndo } from '../../src/server/lead-commands';
import { renderLeadBrief } from '../../src/server/lead-text';
import { AIDEN_BROUGHT_LIMIT, applyVerdict, cardAnswer } from '../../src/server/lead/apply';
import { clearAsk, raiseAskDetailed, requireAsk } from '../../src/server/repo/asks';
import { getDeskItem } from '../../src/server/repo/desk';
import { applyTurn, getTurn, leaseItem, saveAnswer } from '../../src/server/repo/leadTurns';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { handleHookEvent } from '../../src/server/session-flow';

const V = LEAD_INSTRUCTIONS_VERSION;
const BOUND = 'C:/personal/InProgress';
const MIN = 60_000;

/** InProgress led by Progresser, a step, and on a clock the test moves. The round is switched on unless `roundOn` is false. */
function world(opts: { roundOn?: boolean } = {}) {
  let t = Date.parse('2026-11-25T09:00:00.000Z');
  const ctx = createCtx(openDb(':memory:'), () => new Date(t).toISOString());
  const tick = (ms = 1000) => void (t += ms);
  const project = createProject(ctx, 'test', { name: 'InProgress' });
  addBinding(ctx, 'test', project.slug, BOUND);
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Board search' }] });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const roundOn = () => leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
  if (opts.roundOn !== false) roundOn();
  const session = (id: string, t3: boolean) =>
    handleHookEvent(ctx, id, { event: 'start', source: 'startup', cwd: BOUND, ...(t3 ? { app: 't3' as const, t3ThreadId: `thread-${id}` } : {}) });
  /** A session's ask, raised a second later; answers the ask and its desk item's id. */
  const ask = (sessionId: string, text: string, kind: 'question' | 'permission' = 'question') => {
    tick();
    const { ask: a } = raiseAskDetailed(ctx, `scribe:${sessionId}`, { nodeId: step!.id, kind, text, sessionId });
    const itemId = ctx.db.prepare('SELECT id FROM desk_items WHERE kind = ? AND ref = ?').pluck().get(kind, String(a.id)) as number | undefined;
    return { ask: a, itemId };
  };
  /** A turn leased on the item with this answer saved, as the runner leaves it before the apply. */
  const answered = (itemId: number, verdict: string, kind: string, answer: string, why = 'The record says so.') => {
    const turn = leaseItem(ctx.db, itemId, { way: 'headless', model: 'claude-opus-5-5', leaseMs: 6 * MIN }, ctx.now())!;
    expect(saveAnswer(ctx.db, turn.id, { verdict, kind, answer, why }, ctx.now())).toBe(true);
    return turn.id;
  };
  /** The runner's apply: one immediate write as the lead, applyTurn's compare-and-set, applyVerdict with the write's record. */
  const apply = (turnId: number) =>
    write(ctx, 'lead:Progresser', (record) => applyTurn(ctx.db, turnId, ctx.now(), (turn, item) => applyVerdict(ctx, turn, item, record)), { immediate: true });
  const count = (sql: string, ...args: unknown[]) => ctx.db.prepare(`SELECT COUNT(*) FROM ${sql}`).pluck().get(...args) as number;
  const sends = () => ctx.db.prepare('SELECT kind, target, retry_key AS retryKey, state, body, item_id AS itemId FROM lead_sends ORDER BY id').all() as Record<string, unknown>[];
  return { ctx, project, step: step!, tick, roundOn, session, ask, answered, apply, count, sends };
}

/** Everything the desk might write, counted: to show an apply wrote nothing. */
const footprint = (w: ReturnType<typeof world>) => ({
  events: w.count('lead_events'),
  decisions: w.count('lead_decisions'),
  sends: w.count('lead_sends'),
  cleared: w.count('asks WHERE cleared_at IS NOT NULL'),
});

describe('DECIDE', () => {
  it("on a T3 session's question: the decision, its row, the ask answered, scene 1's message, the item done, once; undo finds it", () => {
    const w = world();
    w.session('s1', true);
    const { ask, itemId } = w.ask('s1', 'Should search match step ids as well as titles?');
    const turnId = w.answered(itemId!, 'DECIDE', 'PRODUCT', 'yes, match ids too, so typing 745 finds #745.', 'the board already shows ids beside titles.');
    const heard: string[] = [];
    w.ctx.bus.on('event', (e: { type: string }) => heard.push(e.type));
    expect(w.apply(turnId)).toBe(true);
    // The window hears the clear after the commit.
    expect(heard).toContain('ask.cleared');
    const decide = w.ctx.db.prepare("SELECT id, ask_id, text, lead FROM lead_events WHERE kind = 'decide'").all() as { id: number; ask_id: number; text: string; lead: string }[];
    expect(decide).toEqual([{ id: expect.any(Number), ask_id: ask.id, text: 'the board already shows ids beside titles.', lead: 'Progresser' }]);
    const d = decide[0]!.id;
    expect(w.ctx.db.prepare('SELECT kind, product_ruling, line, item_id, turn_id, said_where FROM lead_decisions WHERE event_id = ?').get(d)).toEqual({
      kind: 'product', product_ruling: 1, line: 'Should search match step ids as well as titles? -> yes, match ids too, so typing 745 finds #745.',
      item_id: itemId, turn_id: turnId, said_where: 'desk',
    });
    expect(requireAsk(w.ctx, ask.id)).toMatchObject({ answer: 'yes, match ids too, so typing 745 finds #745.', answeredVia: 'lead_decided', clearedBy: 'lead:Progresser' });
    expect(w.sends()).toEqual([{
      kind: 'relay', target: 'thread-s1', retryKey: `relay:d${d}`, state: 'intended', itemId,
      body: `[From Progresser, the lead] d${d}: yes, match ids too, so typing 745 finds #745.\nWhy: the board already shows ids beside titles. Aiden can undo this with "undo d${d}".`,
    }]);
    expect(getDeskItem(w.ctx.db, itemId!)).toMatchObject({ state: 'done', outcome: `DECIDE d${d}` });
    expect(getTurn(w.ctx.db, turnId)!.state).toBe('applied');
    // Applied again: the compare-and-set refuses, nothing changes.
    const before = footprint(w);
    expect(w.apply(turnId)).toBe(false);
    expect(footprint(w)).toEqual(before);
    // The brief shows it with its undo word, and undo finds it.
    expect(renderLeadBrief(readLeadBrief(w.ctx, w.project.slug, V, new Date(w.ctx.now())))).toContain(`· undo: undo d${d}`);
    expect(leadUndo(w.ctx, w.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'undo it' }).text).toContain(`Undid d${d}`);
  });

  it("on a CLI session's question: no send; a TECHNICAL ruling is kind technical", () => {
    const w = world();
    w.session('s1', false);
    const { itemId } = w.ask('s1', 'Which port?');
    expect(w.apply(w.answered(itemId!, 'DECIDE', 'TECHNICAL', 'Use 4410.'))).toBe(true);
    expect(w.sends()).toEqual([]);
    expect(w.ctx.db.prepare('SELECT kind, product_ruling FROM lead_decisions').get()).toEqual({ kind: 'technical', product_ruling: 0 });
  });

  it('on a permission ask: accepted on the desk path, kind permission; lead decide still refuses one', () => {
    const w = world();
    w.session('s1', true);
    const { ask, itemId } = w.ask('s1', 'May I run the migration check?', 'permission');
    expect(w.apply(w.answered(itemId!, 'DECIDE', 'TECHNICAL', 'Yes, on the copy.'))).toBe(true);
    expect(requireAsk(w.ctx, ask.id)).toMatchObject({ answeredVia: 'lead_decided', answer: 'Yes, on the copy.' });
    expect(w.ctx.db.prepare('SELECT kind FROM lead_decisions').pluck().get()).toBe('permission');
    const { ask: other } = w.ask('s1', 'May I delete the scratch folder?', 'permission');
    expect(() => leadDecide(w.ctx, w.project.slug, 'Progresser', V, { askId: other.id, answer: 'yes', reason: 'scratch' })).toThrow(/decides a question only/);
  });
});

describe('AIDEN', () => {
  it('records the would-have first, tells the session, and leaves the item waiting on Aiden', () => {
    const w = world();
    w.session('s1', true);
    const { ask, itemId } = w.ask('s1', 'The button says "Find" or "Search"?');
    const turnId = w.answered(itemId!, 'AIDEN', 'TASTE', 'Search: the window says it everywhere else.');
    expect(w.apply(turnId)).toBe(true);
    const bring = w.ctx.db.prepare("SELECT id, ask_id, text FROM lead_events WHERE kind = 'bring'").all() as { id: number; ask_id: number; text: string }[];
    expect(bring).toEqual([{ id: expect.any(Number), ask_id: ask.id, text: 'Search: the window says it everywhere else.' }]);
    const d = bring[0]!.id;
    expect(w.ctx.db.prepare('SELECT kind, product_ruling, line, would_have, said_where, item_id, turn_id FROM lead_decisions WHERE event_id = ?').get(d)).toEqual({
      kind: 'product', product_ruling: 1, line: 'The button says "Find" or "Search"?', would_have: 'Search: the window says it everywhere else.', said_where: null, item_id: itemId, turn_id: turnId,
    });
    expect(w.sends()).toEqual([{
      kind: 'relay', target: 'thread-s1', retryKey: `aiden:d${d}`, state: 'intended', itemId,
      body: `[From Progresser, the lead] a${ask.id} is Aiden's to answer (taste). Carry on with what does not depend on it, or stop.`,
    }]);
    expect(requireAsk(w.ctx, ask.id).clearedAt).toBeNull();
    expect(getDeskItem(w.ctx.db, itemId!)).toMatchObject({ state: 'waiting_aiden', outcome: `AIDEN d${d}` });
    // The brief shows it with its d-number and would-have.
    expect(renderLeadBrief(readLeadBrief(w.ctx, w.project.slug, V, new Date(w.ctx.now())))).toContain(`d${d} `);
    expect(readLeadBrief(w.ctx, w.project.slug, V, new Date(w.ctx.now())).brought).toEqual([
      expect.objectContaining({ tag: `d${d}`, askId: ask.id, line: 'The button says "Find" or "Search"?', wouldHave: 'Search: the window says it everywhere else.' }),
    ]);
  });

  it('brings at most five; a sixth waits with no bring; a clear brings the next, permissions first, then idle sessions, once each', () => {
    const w = world();
    w.session('s1', false);
    w.session('busy', false);
    w.session('idle', false);
    const brought = [1, 2, 3, 4, 5].map((i) => w.ask('s1', `Question ${i}?`));
    for (const b of brought) expect(w.apply(w.answered(b.itemId!, 'AIDEN', 'DIRECTION', `Pick ${b.ask.id}`))).toBe(true);
    expect(w.count("lead_events WHERE kind = 'bring'")).toBe(AIDEN_BROUGHT_LIMIT);
    // Waiting, in the order raised: a question from a working session, a question from an idle one, a permission.
    const busy = w.ask('busy', 'Busy question?');
    handleHookEvent(w.ctx, 'busy', { event: 'prompt' });
    const idle = w.ask('idle', 'Idle question?');
    const perm = w.ask('s1', 'May I push the branch?', 'permission');
    for (const x of [busy, idle, perm]) {
      expect(w.apply(w.answered(x.itemId!, 'AIDEN', 'CANNOT-BE-TAKEN-BACK', 'I would wait.'))).toBe(true);
      expect(getDeskItem(w.ctx.db, x.itemId!)).toMatchObject({ state: 'waiting_aiden', outcome: 'AIDEN waiting (limit)' });
    }
    expect(w.count("lead_events WHERE kind = 'bring'")).toBe(AIDEN_BROUGHT_LIMIT);
    const bringsOf = (itemId: number) => w.count("lead_decisions ld JOIN lead_events e ON e.id = ld.event_id WHERE e.kind = 'bring' AND ld.item_id = ?", itemId);
    // Aiden answers one: the permission is brought next, in the same write.
    clearAsk(w.ctx, 'window', brought[0]!.ask.id, 'B');
    expect([busy, idle, perm].map((x) => bringsOf(x.itemId!))).toEqual([0, 0, 1]);
    expect(getDeskItem(w.ctx.db, perm.itemId!)!.outcome).toMatch(/^AIDEN d\d+$/);
    clearAsk(w.ctx, 'window', brought[1]!.ask.id, 'B');
    expect([busy, idle, perm].map((x) => bringsOf(x.itemId!))).toEqual([0, 1, 1]);
    clearAsk(w.ctx, 'window', brought[2]!.ask.id, 'B');
    expect([busy, idle, perm].map((x) => bringsOf(x.itemId!))).toEqual([1, 1, 1]);
    // A clear with nothing left waiting brings nothing more.
    clearAsk(w.ctx, 'window', brought[3]!.ask.id, 'B');
    expect(w.count("lead_events WHERE kind = 'bring'")).toBe(AIDEN_BROUGHT_LIMIT + 3);
  });

  it("is still brought with six old asks of Aiden's open: the five counts what the lead brought", () => {
    const w = world({ roundOn: false });
    w.session('s1', false);
    for (let i = 0; i < 6; i++) w.ask('s1', `Old ask ${i}?`);
    w.tick(MIN);
    w.roundOn();
    const { itemId } = w.ask('s1', 'New question?');
    expect(aidenOpenAsks(w.ctx, w.project.id).project).toBe(7);
    expect(w.apply(w.answered(itemId!, 'AIDEN', 'TASTE', 'This one.'))).toBe(true);
    expect(getDeskItem(w.ctx.db, itemId!)!.outcome).toMatch(/^AIDEN d\d+$/);
  });
});

describe('CARD', () => {
  it("clears a question with the landing check's line, logs the card, and tells the session", () => {
    const w = world();
    w.session('s1', true);
    const { ask, itemId } = w.ask('s1', 'May I merge #745 into main?');
    expect(w.apply(w.answered(itemId!, 'CARD', 'NONE', 'Checks green, reviewed by Murr, touches web/ only.'))).toBe(true);
    const said = cardAnswer(w.step.id);
    expect(said).toBe(`A landing is decided by the landing check, not by the lead. Run: inprogress landing ${w.step.id} --action <merge|deploy|push|publish|push-public>, and follow its answer.`);
    expect(requireAsk(w.ctx, ask.id)).toMatchObject({ answer: said, answeredVia: 'lead_decided' });
    expect(w.ctx.db.prepare("SELECT ask_id, text FROM lead_events WHERE kind = 'card'").all()).toEqual([{ ask_id: ask.id, text: 'Checks green, reviewed by Murr, touches web/ only.' }]);
    expect(w.sends()).toEqual([{ kind: 'relay', target: 'thread-s1', retryKey: `card:a${ask.id}`, state: 'intended', itemId, body: `[From Progresser, the lead] a${ask.id}: ${said}` }]);
    expect(getDeskItem(w.ctx.db, itemId!)).toMatchObject({ state: 'done', outcome: 'CARD' });
  });
});

describe('refusals', () => {
  it('an ask already cleared when applied: outcome ask cleared, nothing else written', () => {
    const w = world();
    w.session('s1', true);
    const { ask, itemId } = w.ask('s1', 'Which port?');
    const turnId = w.answered(itemId!, 'DECIDE', 'TECHNICAL', 'Use 4410.');
    // Cleared under the item, with no clear path closing it: as a write that raced the apply would leave it.
    w.ctx.db.prepare("UPDATE asks SET cleared_at = ?, answer = 'mine' WHERE id = ?").run(w.ctx.now(), ask.id);
    const before = footprint(w);
    expect(w.apply(turnId)).toBe(true);
    expect(footprint(w)).toEqual(before);
    expect(getDeskItem(w.ctx.db, itemId!)).toMatchObject({ state: 'done', outcome: 'ask cleared' });
  });

  it('a stopped item: no action in this task, item done', () => {
    const w = world();
    const item = w.ctx.db.prepare("INSERT INTO desk_items (project_id, kind, ref, created_at) VALUES (?, 'stopped', 's9@x', ?)").run(w.project.id, w.ctx.now());
    const itemId = Number(item.lastInsertRowid);
    const before = footprint(w);
    expect(w.apply(w.answered(itemId, 'DECIDE', 'TECHNICAL', 'Carry on.'))).toBe(true);
    expect(footprint(w)).toEqual(before);
    expect(getDeskItem(w.ctx.db, itemId)).toMatchObject({ state: 'done', outcome: 'DECIDE (no action in this task)' });
  });

  it('a project with no lead: outcome no lead', () => {
    const w = world();
    w.session('s1', true);
    const { itemId } = w.ask('s1', 'Which port?');
    const turnId = w.answered(itemId!, 'DECIDE', 'TECHNICAL', 'Use 4410.');
    w.ctx.db.prepare('UPDATE projects SET lead = NULL WHERE id = ?').run(w.project.id);
    const before = footprint(w);
    expect(w.apply(turnId)).toBe(true);
    expect(footprint(w)).toEqual(before);
    expect(getDeskItem(w.ctx.db, itemId!)).toMatchObject({ state: 'done', outcome: 'no lead' });
  });
});

