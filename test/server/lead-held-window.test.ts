import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { buildApp } from '../../src/server/app';
import { write as dbWrite } from '../../src/server/db/tx';
import { heldCards } from '../../src/server/lead/carry';
import { heldOutcome, heldRef } from '../../src/server/lead/hold';
import { checkLanding, realGit, type LandingDeps } from '../../src/server/lead/landing';
import { createSender, type SenderT3 } from '../../src/server/lead/sends';
import { intendHeldLine } from '../../src/server/lead/voice';
import { getDeskItem, moveDeskItem } from '../../src/server/repo/desk';
import { produceDeskItem } from '../../src/server/repo/deskProducers';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { handleHookEvent } from '../../src/server/session-flow';
import { commit, lines, makeRepo, write, type TestRepo } from '../git-repo';
import { makeCtx } from '../helpers';

/*
 * Lead stage 1, task D (C4): a command held for Aiden shows as a card in the window's Needs me, and Go ahead or Not yet
 * answers it from there.
 */

const V = LEAD_INSTRUCTIONS_VERSION;
const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui' };

let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => repo.cleanup());

/** A project led by Progresser bound to the test repo, a T3 Code session s1 on its feature worktree focused on the step, and the app. */
function setup(gitCalls: string[][] = []) {
  // The ctx clock runs a minute ahead of the real one: his word is after the commits git stamps.
  const ctx = makeCtx(new Date(Date.now() + 60_000).toISOString());
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, repo.main);
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Tabs' }] });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: repo.main });
  ctx.db.prepare("UPDATE sessions SET cwd = ?, branch = 'feature', app = 't3', t3_thread_id = 'th_1', focus_node_id = ? WHERE id = 's1'").run(repo.wt, step.id);
  const deps: LandingDeps = {
    git: (folder, args, input) => {
      gitCalls.push(args);
      return realGit(folder, args, input);
    },
    visibility: async () => false,
  };
  const fakeT3: SenderT3 = { list: async () => [], show: async () => ({ thread: {} as never, messages: [] }), start: async () => ({ threadId: 'x' }), send: async () => undefined };
  const sender = createSender(ctx, { t3: fakeT3 }, { log: { info: () => undefined, error: () => undefined } });
  const app = buildApp({ ctx, token: 't', uiToken: 'ui', version: 'test', landing: deps, sender });
  const click = (itemId: number, answer: string) => app.inject({ method: 'POST', url: `/api/ui/held/${itemId}`, headers: UI, payload: { answer } });
  const check = (action: 'merge' | 'push' | 'publish') => checkLanding(ctx, { ref: project.slug, stepId: step.id, action, folder: repo.wt, branch: 'feature' }, deps);
  const yesCount = () => ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'yes'").pluck().get() as number;
  write(repo.wt, 'web/app.ts', lines(20, 'tabs'));
  commit(repo.wt, 'tabs');
  const answer = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/lead/${project.slug}/answer`, headers: { authorization: 'Bearer t' }, payload: { as: 'Progresser', instructions: V, ...payload } });
  return { ctx, project, step, app, click, check, answer, yesCount };
}

/** A held item for `command` by session s1, waiting on Aiden as holdCheck leaves it (`what` stored unless null), with its line to the Voice. */
function held(t: ReturnType<typeof setup>, command: string, what: string | null = 'a push of feature to origin') {
  return dbWrite(t.ctx, 'test', () => {
    const now = t.ctx.now();
    const { item } = produceDeskItem(t.ctx.db, { projectId: t.project.id, kind: 'held', ref: heldRef('s1', command), nodeId: t.step.id }, now);
    moveDeskItem(t.ctx.db, item.id, ['open'], 'waiting_aiden', { outcome: what === null ? 'held: by the check' : heldOutcome('by the check', what), now });
    insertLeadEvent(t.ctx.db, { projectId: t.project.id, lead: 'Progresser', instructions: V, kind: 'held', nodeId: t.step.id, sessionId: 's1', text: `${command} -> by the check` }, now);
    intendHeldLine(t.ctx.db, { projectId: t.project.id, itemId: item.id, projectName: 'InGame', stepId: t.step.id, what: what ?? command }, now);
    const send = t.ctx.db.prepare("SELECT id FROM lead_sends WHERE kind = 'voice_line' AND item_id = ?").pluck().get(item.id) as number;
    return { item, send };
  });
}

const sendState = (t: ReturnType<typeof setup>, id: number) => t.ctx.db.prepare('SELECT state FROM lead_sends WHERE id = ?').pluck().get(id) as string;

describe('D1: the snapshot carries the held items waiting on Aiden', () => {
  it('oldest first, with what each does (or its command when none was stored) and its command; an answered one is gone', async () => {
    const t = setup();
    const a = held(t, 'git push');
    const b = held(t, 'git push origin feature', null);
    const c = held(t, 'npm run deploy', 'a deploy of main to the live build');
    t.ctx.db.prepare("UPDATE desk_items SET state = 'done' WHERE id = ?").run(c.item.id);
    expect(getProjectSnapshot(t.ctx, t.project.id).held).toEqual([
      { id: a.item.id, stepId: t.step.id, createdAt: a.item.createdAt, what: 'a push of feature to origin', command: 'git push' },
      { id: b.item.id, stepId: t.step.id, createdAt: b.item.createdAt, what: 'git push origin feature', command: 'git push origin feature' },
    ]);
    // A held item not yet waiting on Aiden (still open) is not a card.
    dbWrite(t.ctx, 'test', () => produceDeskItem(t.ctx.db, { projectId: t.project.id, kind: 'held', ref: heldRef('s2', 'git push'), nodeId: null }, t.ctx.now()));
    expect(heldCards(t.ctx, t.project.id).map((h) => h.id)).toEqual([a.item.id, b.item.id]);
  });
});

describe('D3: POST /api/ui/held/:id', () => {
  it("Go ahead records his yes for exactly the held command's actions, closes the item, clears its unsent Voice line, and the landing check is clear", async () => {
    const t = setup();
    const h = held(t, 'git push');
    expect((await t.check('push')).clear).toBe(false);
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('His yes covers push of the change as it is now.');
    expect(t.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'yes'").pluck().all()).toEqual([expect.stringMatching(/^push /)]);
    expect(t.ctx.db.prepare("SELECT aiden_words FROM lead_events WHERE kind = 'answer'").pluck().get()).toBe('go ahead (window)');
    expect(getDeskItem(t.ctx.db, h.item.id)!.state).toBe('done');
    expect(sendState(t, h.send)).toBe('cleared');
    expect(await t.check('push')).toMatchObject({ clear: true, why: 'his yes' });
    // A merge was not held: his yes does not cover it.
    expect((await t.check('merge')).clear).toBe(false);
    expect(heldCards(t.ctx, t.project.id)).toEqual([]);
  });

  it('a second click is a 409 and changes nothing, before any git', async () => {
    const calls: string[][] = [];
    const t = setup(calls);
    const h = held(t, 'git push');
    expect((await t.click(h.item.id, 'go')).statusCode).toBe(200);
    const after = { yes: t.yesCount(), answers: t.ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'answer'").pluck().get(), git: calls.length };
    for (const answer of ['go', 'not-yet']) {
      const again = await t.click(h.item.id, answer);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe(`Desk item #${h.item.id} is not a held command waiting on you.`);
    }
    expect({ yes: t.yesCount(), answers: t.ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'answer'").pluck().get(), git: calls.length }).toEqual(after);
  });

  it('two clicks at once answer once', async () => {
    const t = setup();
    const h = held(t, 'git push');
    const [one, two] = await Promise.all([t.click(h.item.id, 'go'), t.click(h.item.id, 'go')]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    expect(t.yesCount()).toBe(1);
    expect(t.ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'answer'").pluck().get()).toBe(1);
  });

  it('Not yet records his words and no yes, tells the session in its thread, closes the item and clears its line; the landing still holds', async () => {
    const calls: string[][] = [];
    const t = setup(calls);
    const h = held(t, 'git push');
    const res = await t.click(h.item.id, 'not-yet');
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('Its session is told in its thread.');
    expect(calls).toEqual([]);
    expect(t.yesCount()).toBe(0);
    expect(t.ctx.db.prepare("SELECT body FROM lead_sends WHERE kind = 'carry'").pluck().get()).toMatch(/^Aiden's answer, carried by Progresser from the window at \d\d:\d\d: "not yet \(window\)"$/);
    expect(t.ctx.db.prepare('SELECT said_where FROM lead_decisions').pluck().get()).toBe('window');
    expect(getDeskItem(t.ctx.db, h.item.id)!.state).toBe('done');
    expect(sendState(t, h.send)).toBe('cleared');
    expect((await t.check('push')).clear).toBe(false);
  });

  it('a Voice line already being tried is left to the sender', async () => {
    const t = setup();
    const h = held(t, 'git push');
    t.ctx.db.prepare("UPDATE lead_sends SET result = 'trying' WHERE id = ?").run(h.send);
    expect((await t.click(h.item.id, 'not-yet')).statusCode).toBe(200);
    expect(sendState(t, h.send)).toBe('intended');
  });

  it('refuses an item that is not a held one waiting on Aiden, an unknown item and a wrong answer, changing nothing', async () => {
    const t = setup();
    const open = dbWrite(t.ctx, 'test', () => produceDeskItem(t.ctx.db, { projectId: t.project.id, kind: 'held', ref: heldRef('s1', 'git push'), nodeId: t.step.id }, t.ctx.now()).item);
    expect((await t.click(open.id, 'go')).statusCode).toBe(409);
    const stopped = dbWrite(t.ctx, 'test', () => produceDeskItem(t.ctx.db, { projectId: t.project.id, kind: 'stopped', ref: 's1', nodeId: t.step.id }, t.ctx.now()).item);
    t.ctx.db.prepare("UPDATE desk_items SET state = 'waiting_aiden' WHERE id = ?").run(stopped.id);
    expect((await t.click(stopped.id, 'go')).statusCode).toBe(409);
    expect(getDeskItem(t.ctx.db, open.id)!.state).toBe('open');
    expect(getDeskItem(t.ctx.db, stopped.id)!.state).toBe('waiting_aiden');
    expect((await t.click(99_999, 'go')).statusCode).toBe(404);
    const h = held(t, 'git push origin feature');
    expect((await t.click(h.item.id, 'yes')).statusCode).toBe(400);
    expect(getDeskItem(t.ctx.db, h.item.id)!.state).toBe('waiting_aiden');
    expect(t.ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'answer'").pluck().get()).toBe(0);
  });

  it('needs the window: no UI token, no answer', async () => {
    const t = setup();
    const h = held(t, 'git push');
    const res = await t.app.inject({ method: 'POST', url: `/api/ui/held/${h.item.id}`, headers: { origin: 'http://localhost:80' }, payload: { answer: 'go' } });
    expect(res.statusCode).toBe(401);
    expect(getDeskItem(t.ctx.db, h.item.id)!.state).toBe('waiting_aiden');
  });
});

describe('D3: a yes for a publish', () => {
  it('Go ahead on a held npm publish clears the landing check for publish on that tree, and a later commit holds it again', async () => {
    const t = setup();
    const h = held(t, 'npm publish', 'a publish of x 1.2.0 to npm');
    expect((await t.check('publish')).clear).toBe(false);
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('His yes covers publish of the change as it is now.');
    const tree = (await realGit(repo.wt, ['rev-parse', 'refs/heads/feature^{tree}'])).stdout.trim();
    expect(t.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'yes'").pluck().all()).toEqual([`publish ${tree}`]);
    expect(await t.check('publish')).toMatchObject({ clear: true, why: 'his yes' });
    // His yes covers a publish only: a push of the same change is still held.
    expect((await t.check('push')).clear).toBe(false);
    write(repo.wt, 'web/more.ts', lines(5, 'more'));
    commit(repo.wt, 'more');
    expect((await t.check('publish')).clear).toBe(false);
  });

  it('a reply to the held line by --send with --yes publish records the same yes', async () => {
    const t = setup();
    const h = held(t, 'npm publish', 'a publish of x 1.2.0 to npm');
    const res = await t.answer({ sendId: h.send, aidenWords: 'go ahead', saidAt: new Date(Date.now() + 1000).toISOString(), yes: ['publish'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('His yes covers publish');
    expect(await t.check('publish')).toMatchObject({ clear: true, why: 'his yes' });
  });

  it('a yes for a public push is refused by the route', async () => {
    const t = setup();
    const h = held(t, 'git push');
    expect((await t.answer({ sendId: h.send, aidenWords: 'go ahead', yes: ['push-public'] })).statusCode).toBe(400);
    expect(t.yesCount()).toBe(0);
  });
});
