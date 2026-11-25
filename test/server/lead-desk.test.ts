import { afterEach, describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { stamp } from '../../src/core/span';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { DESK_ASK_DUE_MS, DESK_STOPPED_MS, DESK_WATCH_DUE_MS, onDeskItem, readDesk, watchDesk } from '../../src/server/lead/desk';
import { leadAllow, leadAnswer, leadDisallow, leadKept, leadPromise } from '../../src/server/lead-commands';
import { clearAsk, raiseAskDetailed } from '../../src/server/repo/asks';
import { getDeskItem, moveDeskItem, type DeskItem } from '../../src/server/repo/desk';
import { addNodes, deleteNode, updateNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead, updateProject } from '../../src/server/repo/projects';
import { roundFirstOn, roundSince, switchLine } from '../../src/server/repo/switches';
import { claimStep, handleHookEvent } from '../../src/server/session-flow';

const V = LEAD_INSTRUCTIONS_VERSION;
const BOUND = 'C:/personal/InGame';
const MIN = 60_000;

/** A project led by Progresser with two steps, on a clock the test moves (`tick`), and the desk's rows. */
function setup() {
  let t = Date.parse('2026-11-25T09:00:00.000Z');
  const ctx = createCtx(openDb(':memory:'), () => new Date(t).toISOString());
  const tick = (ms: number) => {
    t += ms;
  };
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, BOUND);
  const [step, other] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Build tabs' }, { title: 'Sound' }] });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const roundOn = () => leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
  const roundOff = () => leadDisallow(ctx, project.slug, 'Progresser', V, { switch: 'round' });
  const hook = (id: string, input: Parameters<typeof handleHookEvent>[2]) => handleHookEvent(ctx, id, input);
  /** A worker session on `nodeId` that has just stopped. */
  const stopOn = (id: string, nodeId: number) => {
    hook(id, { event: 'start', source: 'startup', cwd: BOUND });
    claimStep(ctx, `session:${id}`, id, nodeId);
    hook(id, { event: 'stop', background: [] });
  };
  const ask = (sessionId: string | null, kind: 'question' | 'permission' | 'review' = 'question', text = 'Which port?', nodeId = step.id) =>
    raiseAskDetailed(ctx, sessionId === null ? 'window' : `scribe:${sessionId}`, { nodeId, kind, text, sessionId });
  const items = () => ctx.db.prepare('SELECT id FROM desk_items ORDER BY id').pluck().all().map((id) => getDeskItem(ctx.db, id as number)!) as DeskItem[];
  return { ctx, project, step, other, tick, roundOn, roundOff, hook, stopOn, ask, items, now: () => ctx.now() };
}

const unsubscribers: (() => void)[] = [];
afterEach(() => {
  while (unsubscribers.length) unsubscribers.pop()!();
});
/** Every project id the desk wakes for, from now on. */
function wakes(): number[] {
  const seen: number[] = [];
  unsubscribers.push(onDeskItem((id) => seen.push(id)));
  return seen;
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the round switch', () => {
  it('is accepted by lead allow, and roundSince reads it: the allow time while on, null when off or never on', () => {
    const s = setup();
    expect(roundSince(s.ctx.db, s.project.id)).toBeNull();
    s.roundOn();
    expect(roundSince(s.ctx.db, s.project.id)).toBe(s.now());
    s.tick(MIN);
    s.roundOff();
    expect(roundSince(s.ctx.db, s.project.id)).toBeNull();
    s.tick(MIN);
    s.roundOn();
    expect(roundSince(s.ctx.db, s.project.id)).toBe(s.now());
  });

  it('roundFirstOn reads the first switch-on ever, whatever came after', () => {
    const s = setup();
    expect(roundFirstOn(s.ctx.db, s.project.id)).toBeNull();
    s.roundOn();
    const first = s.now();
    s.tick(MIN);
    s.roundOff();
    expect(roundFirstOn(s.ctx.db, s.project.id)).toBe(first);
    s.tick(MIN);
    s.roundOn();
    expect(roundFirstOn(s.ctx.db, s.project.id)).toBe(first);
  });

  it('reads a switch through lead_events_switch, and an item ever made through desk_items_kind_ref', () => {
    const s = setup();
    const plan = (sql: string, ...args: unknown[]) => String(s.ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => (r as { detail: string }).detail));
    expect(plan("SELECT kind, at, aiden_words FROM lead_events WHERE project_id = ? AND kind IN ('allow', 'disallow') AND text = ? ORDER BY at DESC, id DESC LIMIT 1", 1, 'round')).toContain('lead_events_switch');
    expect(plan("SELECT at FROM lead_events WHERE project_id = ? AND kind IN ('allow', 'disallow') AND text = 'round' AND kind = 'allow' ORDER BY at, id LIMIT 1", 1)).toContain('lead_events_switch');
    expect(plan('SELECT 1 FROM desk_items WHERE kind = ? AND ref = ?', 'stopped', 's1@x')).toContain('desk_items_kind_ref');
    // The plans above are of the queries switchLine and roundFirstOn run: they still answer.
    s.roundOn();
    expect(switchLine(s.ctx.db, s.project.id, 'round')).toEqual({ kind: 'allow', at: s.now(), aidenWords: 'run the round' });
  });
});

describe('a session raises a question or a permission', () => {
  it('makes one item due in 3 minutes and wakes the listener once, after the write; raised again (joined), nothing more', async () => {
    const s = setup();
    s.roundOn();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    const seen = wakes();
    const { ask } = s.ask('s1');
    // The wake waits for the write to finish.
    expect(seen).toEqual([]);
    await settle();
    expect(seen).toEqual([s.project.id]);
    expect(s.items()).toEqual([
      expect.objectContaining({ kind: 'question', ref: String(ask.id), nodeId: s.step.id, state: 'open', createdAt: s.now(), dueAt: new Date(Date.parse(ask.raisedAt) + DESK_ASK_DUE_MS).toISOString() }),
    ]);
    expect(DESK_ASK_DUE_MS).toBe(3 * MIN);
    s.tick(MIN);
    expect(s.ask('s1').joined).toBe(true);
    await settle();
    expect(s.items()).toHaveLength(1);
    expect(seen).toEqual([s.project.id]);
    // A permission is an item of its own kind.
    expect(s.ask('s1', 'permission', 'May I push?').ask.kind).toBe('permission');
    expect(s.items().map((i) => i.kind)).toEqual(['question', 'permission']);
  });

  it('makes none with the round off, with no session, for a review, or for a lead promise', () => {
    const s = setup();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    s.ask('s1');
    expect(s.items()).toEqual([]);
    s.roundOn();
    s.ask(null, 'question', 'From the window');
    s.ask('s1', 'review', 'Look at the tabs');
    leadPromise(s.ctx, s.project.slug, 'Progresser', V, { text: 'Check the tabs', dueAt: new Date(Date.parse(s.now()) + 10 * MIN).toISOString(), stepId: s.step.id });
    expect(s.items()).toEqual([]);
  });

  it('makes none for an ask raised before the round was first switched on and joined after it', () => {
    const s = setup();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    s.ask('s1');
    s.tick(MIN);
    s.roundOn();
    s.tick(MIN);
    expect(s.ask('s1').joined).toBe(true);
    expect(s.items()).toEqual([]);
    // Nor does the sweep take it: it is one of the old asks of task 17.
    expect(watchDesk(s.ctx).swept).toBe(0);
  });

  it('takes an ask raised while the round was off, once it is back on', () => {
    const s = setup();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    s.roundOn();
    s.tick(MIN);
    s.roundOff();
    s.tick(MIN);
    const { ask } = s.ask('s1');
    expect(s.items()).toEqual([]);
    expect(watchDesk(s.ctx).swept).toBe(0);
    s.tick(MIN);
    s.roundOn();
    expect(watchDesk(s.ctx).swept).toBe(1);
    expect(s.items()).toEqual([expect.objectContaining({ kind: 'question', ref: String(ask.id) })]);
  });

  it('makes no new item for a join after its item is done, and a new one when the ask is asked anew (bumped)', () => {
    const s = setup();
    s.roundOn();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    const { ask } = s.ask('s1');
    moveDeskItem(s.ctx.db, s.items()[0].id, ['open'], 'done', { outcome: 'relayed', now: s.now() });
    s.tick(MIN);
    expect(s.ask('s1').joined).toBe(true);
    expect(s.items()).toHaveLength(1);
    // A prompt to the session since the raise, then the same ask again: it is asked anew (#522).
    s.tick(MIN);
    s.hook('s1', { event: 'prompt' });
    s.tick(MIN);
    const again = s.ask('s1');
    expect(again.joined).toBe(true);
    expect(again.ask.raisedAt).toBe(s.now());
    expect(s.items().map((i) => [i.ref, i.state])).toEqual([
      [String(ask.id), 'done'],
      [String(ask.id), 'open'],
    ]);
  });

  it('a listener that throws is logged and never reaches the write', async () => {
    const s = setup();
    s.roundOn();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    unsubscribers.push(onDeskItem(() => {
      throw new Error('listener down');
    }));
    const seen = wakes();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      expect(() => s.ask('s1')).not.toThrow();
      await settle();
    } finally {
      console.error = original;
    }
    expect(s.items()).toHaveLength(1);
    expect(seen).toEqual([s.project.id]);
    expect(String(errors.flat())).toContain('listener down');
  });
});

describe('clearing the ask closes its item in the same write', () => {
  it('from the window', () => {
    const s = setup();
    s.roundOn();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    const { ask } = s.ask('s1');
    s.tick(MIN);
    clearAsk(s.ctx, 'window', ask.id, '4317');
    expect(s.items()).toEqual([expect.objectContaining({ state: 'done', doneAt: s.now(), outcome: 'cleared by window' })]);
  });

  it("by the lead carrying Aiden's answer, a leased item included", () => {
    const s = setup();
    s.roundOn();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    const { ask } = s.ask('s1');
    expect(moveDeskItem(s.ctx.db, s.items()[0].id, ['open'], 'leased', { now: s.now() })).toBe(true);
    leadAnswer(s.ctx, s.project.slug, 'Progresser', V, { askId: ask.id, aidenWords: 'Use 4317.' });
    expect(s.items()).toEqual([expect.objectContaining({ state: 'done', outcome: 'cleared by lead:Progresser' })]);
  });

  // A finished task step keeps its asks (repo/nodes.ts): a drop, or a question step finished, is what clears them.
  it('by the step being dropped, and leaves the items of other asks alone', () => {
    const s = setup();
    s.roundOn();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    s.ask('s1');
    s.ask('s1', 'question', 'Which sound?', s.other.id);
    updateNode(s.ctx, 'window', s.step.id, { status: 'dropped' });
    expect(s.items().map((i) => [i.ref, i.state, i.outcome])).toEqual([
      [s.items()[0].ref, 'done', 'cleared by window'],
      [s.items()[1].ref, 'open', null],
    ]);
  });
});

describe('deleting a step closes the items of its asks, which go by cascade', () => {
  it('for the step and the steps under it, outcome step deleted, and leaves other steps alone', () => {
    const s = setup();
    s.roundOn();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    const [child] = addNodes(s.ctx, 'test', { parentId: s.step.id, nodes: [{ title: 'Tab bar' }] });
    const onStep = s.ask('s1').ask;
    const onChild = s.ask('s1', 'permission', 'May I push?', child.id).ask;
    const elsewhere = s.ask('s1', 'question', 'Which sound?', s.other.id).ask;
    expect(moveDeskItem(s.ctx.db, s.items()[1].id, ['open'], 'leased', { now: s.now() })).toBe(true);
    s.tick(MIN);
    deleteNode(s.ctx, 'window', s.step.id, true);
    expect(s.ctx.db.prepare('SELECT COUNT(*) FROM asks WHERE id IN (?, ?)').pluck().get(onStep.id, onChild.id)).toBe(0);
    expect(s.items().map((i) => [i.ref, i.state, i.outcome, i.doneAt])).toEqual([
      [String(onStep.id), 'done', 'step deleted', s.now()],
      [String(onChild.id), 'done', 'step deleted', s.now()],
      [String(elsewhere.id), 'open', null, null],
    ]);
  });
});

describe('the minute watch: stopped', () => {
  it('closes an open stopped item once its session moves on, and leaves a done one as it is', () => {
    const s = setup();
    s.roundOn();
    s.tick(MIN);
    s.stopOn('s1', s.step.id);
    s.stopOn('s2', s.other.id);
    s.tick(DESK_STOPPED_MS);
    expect(watchDesk(s.ctx).stopped).toBe(2);
    const [one, two] = s.items();
    moveDeskItem(s.ctx.db, two.id, ['open'], 'done', { outcome: 'relayed', now: s.now() });
    s.tick(MIN);
    s.hook('s1', { event: 'prompt' });
    s.hook('s2', { event: 'prompt' });
    s.tick(MIN);
    watchDesk(s.ctx);
    expect(getDeskItem(s.ctx.db, one.id)).toMatchObject({ state: 'done', outcome: 'session moved on', doneAt: s.now() });
    expect(getDeskItem(s.ctx.db, two.id)).toMatchObject({ state: 'done', outcome: 'relayed' });
  });

  it('leaves an archived project alone', () => {
    const s = setup();
    s.roundOn();
    leadPromise(s.ctx, s.project.slug, 'Progresser', V, { text: 'Check the tabs', dueAt: new Date(Date.parse(s.now()) + MIN).toISOString(), stepId: s.step.id });
    updateProject(s.ctx, 'window', s.project.slug, { status: 'archived' });
    s.tick(2 * MIN);
    expect(watchDesk(s.ctx)).toEqual({ stopped: 0, promiseDue: 0, swept: 0 });
    expect(s.items()).toEqual([]);
  });

  it('makes one item 10 minutes after the stop, none at 9, none on repeated ticks, none for the same stop once done, and a new one for a later stop', () => {
    const s = setup();
    s.roundOn();
    s.tick(MIN);
    s.stopOn('s1', s.step.id);
    const stoppedAt = s.now();
    expect(DESK_STOPPED_MS).toBe(10 * MIN);
    s.tick(9 * MIN);
    expect(watchDesk(s.ctx).stopped).toBe(0);
    s.tick(MIN);
    expect(watchDesk(s.ctx).stopped).toBe(1);
    expect(s.items()).toEqual([
      expect.objectContaining({ kind: 'stopped', ref: `s1@${stoppedAt}`, nodeId: s.step.id, dueAt: new Date(Date.parse(s.now()) + DESK_WATCH_DUE_MS).toISOString() }),
    ]);
    s.tick(MIN);
    expect(watchDesk(s.ctx)).toEqual({ stopped: 0, promiseDue: 0, swept: 0 });
    moveDeskItem(s.ctx.db, s.items()[0].id, ['open'], 'done', { outcome: 'relayed', now: s.now() });
    s.tick(MIN);
    expect(watchDesk(s.ctx).stopped).toBe(0);
    expect(s.items()).toHaveLength(1);
    // A later stop is another cause.
    s.hook('s1', { event: 'prompt' });
    s.hook('s1', { event: 'stop', background: [] });
    const later = s.now();
    s.tick(DESK_STOPPED_MS);
    expect(watchDesk(s.ctx).stopped).toBe(1);
    expect(s.items().map((i) => i.ref)).toEqual([`s1@${stoppedAt}`, `s1@${later}`]);
  });

  it('makes none with an open ask on the step, while a non-reader subagent runs, for an orchestrator, or for a stop before the round', () => {
    const s = setup();
    s.stopOn('early', s.step.id);
    s.tick(MIN);
    s.roundOn();
    s.tick(MIN);
    s.stopOn('asking', s.step.id);
    s.ask('asking');
    s.stopOn('busy', s.other.id);
    s.hook('busy', { event: 'subagent-start', agentId: 'g1', agentType: 'general-purpose' });
    s.stopOn('orch', s.other.id);
    s.ctx.db.prepare("UPDATE sessions SET role = 'orchestrator' WHERE id = 'orch'").run();
    s.tick(DESK_STOPPED_MS + MIN);
    watchDesk(s.ctx);
    expect(s.items().filter((i) => i.kind === 'stopped')).toEqual([]);
  });

  it('makes none for a stop before the round was switched on', () => {
    const s = setup();
    s.stopOn('early', s.step.id);
    s.tick(MIN);
    s.roundOn();
    s.tick(DESK_STOPPED_MS + MIN);
    expect(watchDesk(s.ctx).stopped).toBe(0);
    // The same session stopping again after the switch is a stop the round covers.
    s.hook('early', { event: 'prompt' });
    s.hook('early', { event: 'stop', background: [] });
    s.tick(DESK_STOPPED_MS);
    expect(watchDesk(s.ctx).stopped).toBe(1);
  });

  it('makes none with the round off', () => {
    const s = setup();
    s.stopOn('s1', s.step.id);
    s.tick(DESK_STOPPED_MS + MIN);
    expect(watchDesk(s.ctx)).toEqual({ stopped: 0, promiseDue: 0, swept: 0 });
    expect(s.items()).toEqual([]);
  });
});

describe('the minute watch: promise_due and the sweep', () => {
  it('makes one promise_due item for a promise past its time, and none on repeated ticks, even once it is done', () => {
    const s = setup();
    s.roundOn();
    const { ask } = leadPromise(s.ctx, s.project.slug, 'Progresser', V, { text: 'Check the tabs', dueAt: new Date(Date.parse(s.now()) + 10 * MIN).toISOString(), stepId: s.step.id });
    s.tick(9 * MIN);
    expect(watchDesk(s.ctx).promiseDue).toBe(0);
    s.tick(2 * MIN);
    expect(watchDesk(s.ctx).promiseDue).toBe(1);
    expect(s.items()).toEqual([expect.objectContaining({ kind: 'promise_due', ref: String(ask.id), nodeId: s.step.id, dueAt: new Date(Date.parse(s.now()) + DESK_WATCH_DUE_MS).toISOString() })]);
    s.tick(MIN);
    expect(watchDesk(s.ctx).promiseDue).toBe(0);
    moveDeskItem(s.ctx.db, s.items()[0].id, ['open'], 'done', { now: s.now() });
    s.tick(MIN);
    expect(watchDesk(s.ctx).promiseDue).toBe(0);
    expect(s.items()).toHaveLength(1);
  });

  it('closes the promise_due item when the lead keeps the promise', () => {
    const s = setup();
    s.roundOn();
    const { ask } = leadPromise(s.ctx, s.project.slug, 'Progresser', V, { text: 'Check the tabs', dueAt: new Date(Date.parse(s.now()) + MIN).toISOString(), stepId: s.step.id });
    s.tick(2 * MIN);
    expect(watchDesk(s.ctx).promiseDue).toBe(1);
    s.tick(MIN);
    leadKept(s.ctx, s.project.slug, 'Progresser', V, { askId: ask.id });
    expect(s.items()).toEqual([expect.objectContaining({ kind: 'promise_due', state: 'done', outcome: 'cleared by lead:Progresser', doneAt: s.now() })]);
  });

  it('sweeps a missing item once, for an ask raised since the round, and leaves an older ask alone', async () => {
    const s = setup();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    const old = s.ask('s1', 'question', 'Before the round').ask;
    s.tick(MIN);
    s.roundOn();
    s.tick(MIN);
    const { ask } = s.ask('s1', 'permission', 'May I push?');
    // As if a rolled-back build had raised it: no item.
    s.ctx.db.prepare('DELETE FROM desk_items').run();
    const seen = wakes();
    expect(watchDesk(s.ctx).swept).toBe(1);
    expect(watchDesk(s.ctx).swept).toBe(0);
    expect(s.items()).toEqual([expect.objectContaining({ kind: 'permission', ref: String(ask.id), dueAt: new Date(Date.parse(ask.raisedAt) + DESK_ASK_DUE_MS).toISOString() })]);
    expect(s.items().some((i) => i.ref === String(old.id))).toBe(false);
    await settle();
    expect(seen).toEqual([s.project.id]);
  });
});

describe('the desk read', () => {
  it('lists the open items oldest first with their limits, and says when the desk is empty', () => {
    const s = setup();
    expect(readDesk(s.ctx, s.project.slug)).toEqual({ items: [], text: 'The desk is empty.' });
    s.roundOn();
    s.hook('s1', { event: 'start', source: 'startup', cwd: BOUND });
    const first = s.ask('s1').ask;
    s.tick(MIN);
    const second = s.ask('s1', 'permission', 'May I push?').ask;
    s.tick(5 * MIN);
    const desk = readDesk(s.ctx, s.project.slug);
    const [a, b] = s.items();
    const due = (iso: string) => stamp(iso).slice(11);
    expect(desk.text.split('\n')).toEqual([
      `#${a.id} question ${first.id} step #${s.step.id} due ${due(a.dueAt!)} (3 min over) open`,
      `#${b.id} permission ${second.id} step #${s.step.id} due ${due(b.dueAt!)} (2 min over) open`,
    ]);
    expect(desk.items.map((i) => i.id)).toEqual([a.id, b.id]);
    moveDeskItem(s.ctx.db, a.id, ['open'], 'done', { now: s.now() });
    expect(readDesk(s.ctx, s.project.slug).text).toBe(`#${b.id} permission ${second.id} step #${s.step.id} due ${due(b.dueAt!)} (2 min over) open`);
  });
});
