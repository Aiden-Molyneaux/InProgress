import { afterEach, describe, expect, it } from 'vitest';
import { AIDEN_BROUGHT_LIMIT, LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { openDb } from '../../src/server/db/connection';
import { createCtx, write } from '../../src/server/db/tx';
import { leadAllow } from '../../src/server/lead-commands';
import { morningList } from '../../src/server/lead/morning';
import { createRunner, type TurnWay } from '../../src/server/lead/runner';
import { clearAsk, raiseAsk } from '../../src/server/repo/asks';
import { getDeskItem } from '../../src/server/repo/desk';
import { bringItem, broughtOpen } from '../../src/server/repo/deskBring';
import { produceDeskItem } from '../../src/server/repo/deskProducers';
import { getSend } from '../../src/server/repo/leadSends';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { handleHookEvent } from '../../src/server/session-flow';

const V = LEAD_INSTRUCTIONS_VERSION;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** InProgress led by Progresser, a step with a session s1 on it, and the round on unless `round` is false. */
function world(round = true) {
  let t = Date.parse('2026-11-25T09:00:00.000Z');
  const ctx = createCtx(openDb(':memory:'), () => new Date((t += 1000)).toISOString());
  cleanups.push(() => void ctx.db.close());
  const project = createProject(ctx, 'test', { name: 'InProgress' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InProgress');
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'The desk' }] });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InProgress' });
  if (round) leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
  const review = (text = 'Ship the desk?', sessionId: string | null = 's1') =>
    raiseAsk(ctx, 'session:s1', { nodeId: step!.id, kind: 'review', text, ...(sessionId === null ? {} : { sessionId }) });
  const itemOf = (askId: number) => ctx.db.prepare("SELECT id, state, outcome FROM desk_items WHERE kind = 'review' AND ref = ?").all(String(askId)) as { id: number; state: string; outcome: string }[];
  const lines = () => ctx.db.prepare("SELECT id, item_id AS itemId, retry_key AS retryKey, body, state FROM lead_sends WHERE kind = 'voice_line' ORDER BY id").all() as { id: number; itemId: number; retryKey: string; body: string; state: string }[];
  const picture = (path: string) =>
    Number(ctx.db.prepare("INSERT INTO resources (project_id, node_id, kind, title, path, created_at, updated_at) VALUES (?, ?, 'other', 'shot', ?, ?, ?)").run(project.id, step!.id, path, ctx.now(), ctx.now()).lastInsertRowid);
  return { ctx, project, step: step!, review, itemOf, lines, picture };
}

describe('R1: a review raised with the round on', () => {
  it('is a review item waiting on Aiden at once, brought with its line to the Voice and no turn', () => {
    const w = world();
    const ask = w.review();
    const [item] = w.itemOf(ask.id);
    expect(item).toMatchObject({ state: 'waiting_aiden', outcome: expect.stringMatching(/^AIDEN d\d+$/) });
    const bring = Number(/d(\d+)$/.exec(item!.outcome)![1]);
    expect(w.ctx.db.prepare('SELECT kind, ask_id, text FROM lead_events WHERE id = ?').get(bring)).toEqual({ kind: 'bring', ask_id: ask.id, text: '' });
    expect(w.lines()).toEqual([
      {
        id: expect.any(Number),
        itemId: item!.id,
        retryKey: `voice:bring:d${bring}`,
        body: `Yours, InProgress: #${w.step.id} The desk: a review waits on you. Ship the desk?\nSay "ship it", "not yet", or "show me ${w.step.id}".`,
        state: 'intended',
      },
    ]);
    expect(w.ctx.db.prepare('SELECT COUNT(*) FROM lead_turns').pluck().get()).toBe(0);
  });

  it("names the step's newest picture, not a newer file that is no picture", () => {
    const w = world();
    w.picture('C:/home/resources/inprogress/old.png');
    const newest = w.picture('C:/home/resources/inprogress/new.JPG');
    w.picture('C:/home/resources/inprogress/notes.md');
    w.review();
    expect(w.lines()[0]!.body).toMatch(new RegExp(`Say "ship it", "not yet", or "show me ${w.step.id}"\\. It has a picture: r${newest}\\.$`));
  });

  it('makes no item with the round off, or with no session', () => {
    const off = world(false);
    expect(off.itemOf(off.review().id)).toEqual([]);
    const w = world();
    expect(w.itemOf(w.review('Ship it?', null).id)).toEqual([]);
    expect(w.lines()).toEqual([]);
  });

  it('is brought past the five brought items, and counts toward them', () => {
    const w = world();
    const qs = Array.from({ length: AIDEN_BROUGHT_LIMIT }, (_, i) => raiseAsk(w.ctx, 'test', { nodeId: w.step.id, kind: 'question', text: `q${i}` }));
    write(w.ctx, 'test', () => {
      for (const q of qs) {
        const { item } = produceDeskItem(w.ctx.db, { projectId: w.project.id, kind: 'question', ref: String(q.id), nodeId: w.step.id, state: 'waiting_aiden' }, w.ctx.now());
        bringItem(w.ctx, item, { id: null, kind: 'TASTE', answer: 'x' }, { tell: false });
      }
    });
    expect(broughtOpen(w.ctx, w.project.id)).toBe(AIDEN_BROUGHT_LIMIT);
    const ask = w.review();
    expect(w.lines().filter((l) => l.itemId === w.itemOf(ask.id)[0]!.id)).toHaveLength(1);
    expect(broughtOpen(w.ctx, w.project.id)).toBe(AIDEN_BROUGHT_LIMIT + 1);
  });

  it('clearing the ask closes the item and clears its untried line', () => {
    const w = world();
    const ask = w.review();
    const [line] = w.lines();
    clearAsk(w.ctx, 'window', ask.id, 'ship it');
    expect(getDeskItem(w.ctx.db, w.itemOf(ask.id)[0]!.id)).toMatchObject({ state: 'done', outcome: 'cleared by window' });
    expect(getSend(w.ctx.db, line!.id)!.state).toBe('cleared');
  });

  it("is listed under Yours in the morning list, with no would-have", () => {
    const w = world();
    w.review();
    const list = morningList(w.ctx, w.project.id, '2026-11-25T00:00:00.000Z', w.ctx.now());
    const yours = list.parts.find((p) => p.name === 'Yours');
    expect(yours?.lines).toEqual([expect.stringMatching(/: Ship the desk\?\.?$/)]);
    expect(yours!.lines[0]).not.toContain('I would');
  });

  it('the runner never leases one', async () => {
    const w = world();
    const ask = w.review();
    let runs = 0;
    const way: TurnWay = { name: 'headless', run: async () => (runs++, Promise.reject(new Error('never'))) };
    const r = createRunner(w.ctx, { way, model: 'claude-opus-5-5', home: 'C:/home', port: 4410, tickMs: 60 * 60 * 1000, apply: () => ({ itemState: 'done', outcome: 'x' }), log: { info: () => undefined, error: () => undefined } });
    cleanups.push(() => r.stop());
    r.kick(w.project.id);
    r.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toBe(0);
    expect(w.itemOf(ask.id)[0]!.state).toBe('waiting_aiden');
  });
});
