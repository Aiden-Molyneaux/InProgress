import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx, write } from '../../src/server/db/tx';
import { aidenOpenAsks, readLeadBrief } from '../../src/server/lead';
import { leadAllow, leadDecide, leadUndo } from '../../src/server/lead-commands';
import { renderLeadBrief } from '../../src/server/lead-text';
import { AIDEN_BROUGHT_LIMIT, LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { RELAYED } from '../../src/core/relay';
import { applyVerdict, cardAnswer, sentence } from '../../src/server/lead/apply';
import { clearAsk, raiseAskDetailed, requireAsk } from '../../src/server/repo/asks';
import { addDeskItem, getDeskItem, moveDeskItem } from '../../src/server/repo/desk';
import { bringNext, broughtOpen } from '../../src/server/repo/deskBring';
import { STUCK_COVERS_ASK_MS } from '../../src/server/repo/deskProducers';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
import { applyTurn, getTurn, leaseItem, saveAnswer } from '../../src/server/repo/leadTurns';
import { addNodes, parkNode, updateNode } from '../../src/server/repo/nodes';
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
  /** Every send but the Voice's lines (task 11 gives each bring one; lead-voice.test.ts covers them). */
  const sends = () => ctx.db.prepare("SELECT kind, target, retry_key AS retryKey, state, body, item_id AS itemId FROM lead_sends WHERE kind <> 'voice_line' ORDER BY id").all() as Record<string, unknown>[];
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
      kind: 'relay', target: 'thread-s1', retryKey: `aiden:a${ask.id}`, state: 'intended', itemId,
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
    expect(requireAsk(w.ctx, ask.id)).toMatchObject({ answer: said, answeredVia: 'lead_card' });
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

  it('a stopped item answered with none of RESTART, PARK or DONE: nothing written, it waits for Aiden as unclear (task 9)', () => {
    const w = world();
    const item = w.ctx.db.prepare("INSERT INTO desk_items (project_id, kind, ref, created_at) VALUES (?, 'stopped', 's9@x', ?)").run(w.project.id, w.ctx.now());
    const itemId = Number(item.lastInsertRowid);
    const before = footprint(w);
    expect(w.apply(w.answered(itemId, 'DECIDE', 'TECHNICAL', 'Carry on.'))).toBe(true);
    expect(footprint(w)).toEqual(before);
    expect(getDeskItem(w.ctx.db, itemId)).toMatchObject({ state: 'waiting_aiden', outcome: 'unclear' });
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


describe('the fix round after Murr', () => {
  it('F1: an undone desk decision is raised again straight to Aiden and brought: no open item, one brought, no second relay; a permission stays one', () => {
    const w = world();
    w.session('s1', true);
    for (const kind of ['question', 'permission'] as const) {
      const { ask, itemId } = w.ask('s1', `Undo me, ${kind}?`, kind);
      expect(w.apply(w.answered(itemId!, 'DECIDE', 'PRODUCT', 'Yes.', 'It reads well'))).toBe(true);
      const d = w.ctx.db.prepare("SELECT id FROM lead_events WHERE kind = 'decide' AND ask_id = ?").pluck().get(ask.id) as number;
      const sendsBefore = w.sends().length;
      const text = leadUndo(w.ctx, w.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'undo it' }).text;
      const again = Number(/as a(\d+)/.exec(text)![1]);
      expect(requireAsk(w.ctx, again)).toMatchObject({ kind, clearedAt: null });
      const items = w.ctx.db.prepare('SELECT id, state, outcome FROM desk_items WHERE ref = ?').all(String(again)) as { id: number; state: string; outcome: string }[];
      expect(items).toHaveLength(1);
      expect(items[0]!.state).toBe('waiting_aiden');
      expect(items[0]!.outcome).toMatch(/^AIDEN d\d+$/);
      const bring = w.ctx.db
        .prepare("SELECT ld.kind, ld.product_ruling, ld.would_have, ld.turn_id FROM lead_decisions ld JOIN lead_events e ON e.id = ld.event_id WHERE e.kind = 'bring' AND ld.item_id = ?")
        .all(items[0]!.id);
      // The re-raised ask carries no pick: the answer he just withdrew is not offered back to him (C1).
      expect(bring).toEqual([{ kind: kind === 'permission' ? 'permission' : 'product', product_ruling: 1, would_have: '', turn_id: null }]);
      const line = w.ctx.db.prepare("SELECT body FROM lead_sends WHERE kind = 'voice_line' AND item_id = ?").pluck().get(items[0]!.id) as string;
      expect(line).not.toContain('I would pick');
      expect(line).not.toContain('Yes.');
      expect(line).toContain(`You undid d${d}: "undo it". Give your answer.`);
      // One more send: the undo tells the session once that the decision is withdrawn (task 10); the bring adds none.
      expect(w.sends()).toHaveLength(sendsBefore + 1);
    }
    expect(w.count("desk_items WHERE state = 'open'")).toBe(0);
  });

  it('F2: a drop that clears five brought asks and a waiting sixth brings none of them', () => {
    const w = world();
    w.session('s1', false);
    const six = [1, 2, 3, 4, 5, 6].map((i) => w.ask('s1', `Dropped question ${i}?`));
    for (const x of six) expect(w.apply(w.answered(x.itemId!, 'AIDEN', 'DIRECTION', 'This.'))).toBe(true);
    expect(getDeskItem(w.ctx.db, six[5]!.itemId!)!.outcome).toBe('AIDEN waiting (limit)');
    updateNode(w.ctx, 'window', w.step.id, { status: 'dropped' });
    expect(w.count("lead_events WHERE kind = 'bring'")).toBe(AIDEN_BROUGHT_LIMIT);
    expect(getDeskItem(w.ctx.db, six[5]!.itemId!)).toMatchObject({ state: 'done', outcome: 'cleared by window' });
  });

  it('F3: brought items on a shelved step do not count, and a waiting one there is not brought', () => {
    const w = world();
    w.session('s1', false);
    const [parent, other] = addNodes(w.ctx, 'test', { parentId: w.project.rootNodeId, nodes: [{ title: 'Parent' }, { title: 'Other' }] });
    const [child] = addNodes(w.ctx, 'test', { parentId: parent!.id, nodes: [{ title: 'Child' }] });
    const itemOf = (askId: number) => w.ctx.db.prepare("SELECT id FROM desk_items WHERE kind = 'question' AND ref = ?").pluck().get(String(askId)) as number;
    const onChild = [1, 2, 3, 4, 5, 6].map((i) => {
      w.tick();
      return itemOf(raiseAskDetailed(w.ctx, 'scribe:s1', { nodeId: child!.id, kind: 'question', text: `Child question ${i}?`, sessionId: 's1' }).ask.id);
    });
    for (const itemId of onChild) expect(w.apply(w.answered(itemId, 'AIDEN', 'TASTE', 'This.'))).toBe(true);
    expect(broughtOpen(w.ctx, w.project.id)).toBe(AIDEN_BROUGHT_LIMIT);
    parkNode(w.ctx, 'window', parent!.id, { reason: 'later' }, () => undefined);
    expect(broughtOpen(w.ctx, w.project.id)).toBe(0);
    expect(w.ctx.db.transaction(() => bringNext(w.ctx, w.project.id)).immediate()).toEqual([]);
    expect(getDeskItem(w.ctx.db, onChild[5]!)!.outcome).toBe('AIDEN waiting (limit)');
    w.tick();
    const itemId = itemOf(raiseAskDetailed(w.ctx, 'scribe:s1', { nodeId: other!.id, kind: 'question', text: 'Elsewhere?', sessionId: 's1' }).ask.id);
    expect(w.apply(w.answered(itemId, 'AIDEN', 'TASTE', 'This.'))).toBe(true);
    expect(getDeskItem(w.ctx.db, itemId)!.outcome).toMatch(/^AIDEN d\d+$/);
  });

  it("F4 and F7: a WHY with no closing mark gets its period, and the message reads as the lead's relay", () => {
    expect(sentence('the board shows ids')).toBe('the board shows ids.');
    expect(sentence('Is it? ')).toBe('Is it?');
    expect(sentence('Done!')).toBe('Done!');
    const w = world();
    w.session('s1', true);
    const { itemId } = w.ask('s1', 'Should search match ids?');
    expect(w.apply(w.answered(itemId!, 'DECIDE', 'PRODUCT', 'yes', 'the board already shows ids beside titles'))).toBe(true);
    const body = w.sends()[0]!.body as string;
    expect(body).toMatch(/^\[From Progresser, the lead\] d\d+: yes\nWhy: the board already shows ids beside titles\. Aiden can undo this with "undo d\d+"\.$/);
    expect(RELAYED.test(body)).toBe(true);
  });

  it('F6: CARD clears with answered_via lead_card, and its session reads it as the rule, with no undo words', () => {
    const w = world();
    w.session('s1', false);
    const { ask, itemId } = w.ask('s1', 'May I merge?');
    expect(w.apply(w.answered(itemId!, 'CARD', 'NONE', 'A landing.'))).toBe(true);
    expect(requireAsk(w.ctx, ask.id).answeredVia).toBe('lead_card');
    const context = handleHookEvent(w.ctx, 's1', { event: 'prompt' }).context ?? '';
    expect(context).toContain(`The lead answered a${ask.id} with the landing check's rule, not a decision: "${cardAnswer(w.step.id)}"`);
    expect(context).not.toContain('undo');
  });

  it('F9: an AIDEN past the limit tells its session at once, keyed by its ask; the bring later sends nothing more', () => {
    const w = world();
    w.session('s1', true);
    const five = [1, 2, 3, 4, 5].map((i) => w.ask('s1', `Brought ${i}?`));
    for (const x of five) expect(w.apply(w.answered(x.itemId!, 'AIDEN', 'TASTE', 'This.'))).toBe(true);
    const sixth = w.ask('s1', 'Sixth?');
    expect(w.apply(w.answered(sixth.itemId!, 'AIDEN', 'DIRECTION', 'That.'))).toBe(true);
    expect(getDeskItem(w.ctx.db, sixth.itemId!)!.outcome).toBe('AIDEN waiting (limit)');
    const mine = () => w.sends().filter((x) => x.itemId === sixth.itemId);
    expect(mine()).toEqual([
      {
        kind: 'relay', target: 'thread-s1', retryKey: `aiden:a${sixth.ask.id}`, state: 'intended', itemId: sixth.itemId,
        body: `[From Progresser, the lead] a${sixth.ask.id} is Aiden's to answer (direction). Carry on with what does not depend on it, or stop.`,
      },
    ]);
    clearAsk(w.ctx, 'window', five[0]!.ask.id, 'B');
    expect(getDeskItem(w.ctx.db, sixth.itemId!)!.outcome).toMatch(/^AIDEN d\d+$/);
    expect(mine()).toHaveLength(1);
  });

  it('F10: applyTurn refuses an effect that closed its item and still says waiting_aiden', () => {
    const w = world();
    w.session('s1', false);
    const { itemId } = w.ask('s1', 'Which port?');
    const turnId = w.answered(itemId!, 'AIDEN', 'TASTE', 'x');
    expect(() =>
      applyTurn(w.ctx.db, turnId, w.ctx.now(), (_t, item) => {
        moveDeskItem(w.ctx.db, item.id, ['leased'], 'done', { outcome: 'closed', now: w.ctx.now() });
        return { itemState: 'waiting_aiden', outcome: 'AIDEN' };
      }),
    ).toThrow(/closed by its own apply/);
    expect(getTurn(w.ctx.db, turnId)!.state).toBe('answered');
  });

  it("item 3: a session's permission ask makes no desk item while it has a stuck item from the last ten minutes", () => {
    const w = world();
    w.session('s1', false);
    w.session('s2', false);
    const stuck = addDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'stuck', ref: 'abc123' }, w.ctx.now()).item;
    insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'stuck', sessionId: 's1', text: 'abc123 Bash {"command":"rm x"}' }, w.ctx.now());
    expect(w.ask('s1', 'Allow rm x?', 'permission').itemId).toBeUndefined();
    // Another session's permission, and the same session's question, still go on the desk.
    expect(w.ask('s2', 'Allow rm y?', 'permission').itemId).toBeDefined();
    expect(w.ask('s1', 'Which file?').itemId).toBeDefined();
    // Done or not, the stuck item covers ten minutes from when it was made; then a permission ask is the desk's again.
    moveDeskItem(w.ctx.db, stuck.id, ['open'], 'done', { outcome: 'ALLOW ok', now: w.ctx.now() });
    expect(w.ask('s1', 'Allow rm z?', 'permission').itemId).toBeUndefined();
    w.tick(STUCK_COVERS_ASK_MS);
    expect(w.ask('s1', 'Allow rm w?', 'permission').itemId).toBeDefined();
  });
});
