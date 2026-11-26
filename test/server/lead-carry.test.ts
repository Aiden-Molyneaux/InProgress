import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { leadRules } from '../../src/core/lead-rules';
import { buildApp } from '../../src/server/app';
import { write as dbWrite } from '../../src/server/db/tx';
import { leadAnswer, leadDeskAdd, leadUndo, readYeses } from '../../src/server/lead-commands';
import { applyVerdict } from '../../src/server/lead/apply';
import { CHANGED_AFTER } from '../../src/server/lead/carry';
import { checkLanding, realGit, type LandingDeps } from '../../src/server/lead/landing';
import { morningList } from '../../src/server/lead/morning';
import { createSender, type SenderT3 } from '../../src/server/lead/sends';
import { createVoice, intendHeldLine, voiceDayStart, voiceFile } from '../../src/server/lead/voice';
import { raiseAsk, requireAsk, undeliveredAnswers } from '../../src/server/repo/asks';
import { getDeskItem, moveDeskItem } from '../../src/server/repo/desk';
import { bringItem } from '../../src/server/repo/deskBring';
import { produceDeskItem } from '../../src/server/repo/deskProducers';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
import { intendSend } from '../../src/server/repo/leadSends';
import type { LeadTurn } from '../../src/server/repo/leadTurns';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { handleHookEvent } from '../../src/server/session-flow';
import { T3ArgumentRefused } from '../../src/server/t3';
import { commit, lines, makeRepo, write, type TestRepo } from '../git-repo';
import { makeCtx } from '../helpers';

const V = LEAD_INSTRUCTIONS_VERSION;
let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => repo.cleanup());

/** His word just after the last commit: git's clock is the real one, the test's ctx clock is not. */
const saidNow = (): string => new Date(Date.now() + 1000).toISOString();

/** A project led by Progresser bound to the test repo, a T3 Code session on its feature worktree focused on the step, its review, and the app. */
function setup(gitCalls: string[][] = []) {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, repo.main);
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Tabs' }] });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: repo.main });
  ctx.db.prepare("UPDATE sessions SET cwd = ?, branch = 'feature', app = 't3', t3_thread_id = 'th_1', focus_node_id = ? WHERE id = 's1'").run(repo.wt, step.id);
  const review = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'review', text: 'Ship the tabs?', sessionId: 's1' });
  const deps: LandingDeps = {
    git: (folder, args, input) => {
      gitCalls.push(args);
      return realGit(folder, args, input);
    },
    visibility: async () => false,
  };
  const app = buildApp({ ctx, token: 't', uiToken: 'ui', version: 'test', landing: deps });
  const answer = (payload: Record<string, unknown>, slug = project.slug) =>
    app.inject({ method: 'POST', url: `/api/lead/${slug}/answer`, headers: { authorization: 'Bearer t' }, payload: { as: 'Progresser', instructions: V, ...payload } });
  const check = (action: 'merge' | 'push') => checkLanding(ctx, { ref: project.slug, stepId: step.id, action, folder: repo.wt, branch: 'feature' }, deps);
  const yesCount = () => ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'yes'").pluck().get() as number;
  const sends = (kind: string) => ctx.db.prepare('SELECT target, retry_key AS retryKey, body FROM lead_sends WHERE kind = ? ORDER BY id').all(kind) as { target: string; retryKey: string; body: string }[];
  write(repo.wt, 'web/app.ts', lines(20, 'tabs'));
  commit(repo.wt, 'tabs');
  return { ctx, project, step, review, deps, app, answer, check, yesCount, sends };
}

describe('W1: a yes only for the actions his words okayed', () => {
  it('"not yet" carried through the route records his words and no yes, and the landing holds; "merge it" records merge alone', async () => {
    const t = setup();
    const res = await t.answer({ askId: t.review.id, aidenWords: 'not yet', where: 'voice', saidAt: saidNow() });
    expect(res.statusCode).toBe(200);
    expect(requireAsk(t.ctx, t.review.id).answer).toBe('not yet');
    expect(t.yesCount()).toBe(0);
    expect(await t.check('merge')).toMatchObject({ clear: false });

    const second = raiseAsk(t.ctx, 'session:s1', { nodeId: t.step.id, kind: 'review', text: 'Merge the tabs?', sessionId: 's1' });
    expect((await t.answer({ askId: second.id, aidenWords: 'merge it', where: 'voice', saidAt: saidNow(), yes: ['merge'] })).statusCode).toBe(200);
    expect(t.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'yes'").pluck().all()).toEqual([expect.stringMatching(/^merge [0-9a-f]{40}$/)]);
    expect(await t.check('merge')).toMatchObject({ clear: true, why: 'his yes' });
    expect(await t.check('push')).toMatchObject({ clear: false });
  });

  it('the rules pass --yes only on a go-ahead, once per action', () => {
    const text = leadRules({ lead: 'Progresser', projectName: 'InGame', slug: 'ingame', cli: 'node x', folders: [] });
    expect(text).toContain('--yes merge --yes deploy --yes push');
    expect(text).toContain('"Not yet", or anything else, takes no --yes.');
    expect(text).toContain('lead answer ingame --send <send number>');
    expect(text).toContain('pass his word with lead answer --send s42');
    // W11: rule 4 says plainly where he acts.
    expect(text).toContain("you act only in it, and you read nothing under C:\\work or in any other project. The one exception: you may carry Aiden's answer, in his words, on an ask of any of his personal projects, never on one under C:\\work.");
  });
});

describe('W2: his reply to a line from the Voice, by its send', () => {
  it('a bring line answers its ask', async () => {
    const t = setup();
    const question = raiseAsk(t.ctx, 'session:s1', { nodeId: t.step.id, kind: 'question', text: 'Search or Find?', sessionId: 's1' });
    dbWrite(t.ctx, 'test', () => {
      const { item } = produceDeskItem(t.ctx.db, { projectId: t.project.id, kind: 'question', ref: String(question.id), nodeId: t.step.id }, t.ctx.now());
      bringItem(t.ctx, item, { id: null, kind: 'TASTE', answer: 'Search' }, { tell: false });
    });
    const [line] = t.sends('voice_line');
    const send = t.ctx.db.prepare("SELECT id FROM lead_sends WHERE kind = 'voice_line'").pluck().get() as number;
    expect(line).toBeDefined();
    const res = await t.answer({ sendId: send, aidenWords: 'search', where: 'voice' });
    expect(res.statusCode).toBe(200);
    expect(requireAsk(t.ctx, question.id).answer).toBe('search');
  });

  it("a held line: with --yes a yes for that action on the session's change and the item closes; without, his words go to the session and the item closes", async () => {
    const t = setup();
    const held = (ref: string) =>
      dbWrite(t.ctx, 'test', () => {
        const now = t.ctx.now();
        const { item } = produceDeskItem(t.ctx.db, { projectId: t.project.id, kind: 'held', ref, nodeId: t.step.id }, now);
        insertLeadEvent(t.ctx.db, { projectId: t.project.id, lead: 'Progresser', instructions: V, kind: 'held', nodeId: t.step.id, sessionId: 's1', text: 'git push -> it touches src/hooks' }, now);
        intendHeldLine(t.ctx.db, { projectId: t.project.id, itemId: item.id, projectName: 'InGame', stepId: t.step.id, what: 'a push to a remote' }, now);
        const send = t.ctx.db.prepare("SELECT id FROM lead_sends WHERE kind = 'voice_line' AND item_id = ?").pluck().get(item.id) as number;
        return { item, send };
      });
    const a = held('h1');
    const yes = await t.answer({ sendId: a.send, aidenWords: 'go ahead', where: 'voice', saidAt: saidNow(), yes: ['push'] });
    expect(yes.statusCode).toBe(200);
    expect(t.ctx.db.prepare("SELECT text, node_id FROM lead_events WHERE kind = 'yes'").all()).toEqual([{ text: expect.stringMatching(/^push [0-9a-f]{40}$/), node_id: t.step.id }]);
    expect(getDeskItem(t.ctx.db, a.item.id)).toMatchObject({ state: 'done', outcome: expect.stringMatching(/^ANSWERED d[0-9]+$/) });
    expect(await t.check('push')).toMatchObject({ clear: true, why: 'his yes' });

    const b = held('h2');
    expect((await t.answer({ sendId: b.send, aidenWords: 'not yet', where: 'voice' })).statusCode).toBe(200);
    expect(t.yesCount()).toBe(1);
    expect(getDeskItem(t.ctx.db, b.item.id)!.state).toBe('done');
    expect(t.sends('carry').map((s) => [s.target, s.retryKey, s.body.endsWith('"not yet"')])).toEqual([
      ['th_1', `carry:i${a.item.id}`, false],
      ['th_1', `carry:i${b.item.id}`, true],
    ]);
    expect((await t.answer({ sendId: b.send, aidenWords: 'again', where: 'voice' })).statusCode).toBe(409);
  });

  it("a line about what he left to the lead: his words are the answer, relayed to the step's session, and the item closes", async () => {
    const t = setup();
    const { itemId } = leadDeskAdd(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.step.id, aidenWords: 'you decide the tab order' });
    const turn = { id: null, verdict: 'AIDEN', answer: 'Alphabetical', why: 'it is taste', kind: 'TASTE' } as unknown as LeadTurn;
    const effect = dbWrite(t.ctx, 'lead:Progresser', (record) => applyVerdict(t.ctx, turn, getDeskItem(t.ctx.db, itemId)!, record));
    // The runner moves the item as the verdict says.
    expect(effect.itemState).toBe('waiting_aiden');
    moveDeskItem(t.ctx.db, itemId, ['open'], 'waiting_aiden', { outcome: effect.outcome, now: t.ctx.now() });
    // W12: brought back, it is under the morning list's Yours.
    expect(morningList(t.ctx, t.project.id, '2000-01-01T00:00:00.000Z', t.ctx.now()).text).toContain('you left it to me ("you decide the tab order")');
    const send = t.ctx.db.prepare("SELECT id FROM lead_sends WHERE kind = 'voice_line' AND item_id = ?").pluck().get(itemId) as number;
    expect((await t.answer({ sendId: send, aidenWords: 'by use', where: 'voice' })).statusCode).toBe(200);
    expect(getDeskItem(t.ctx.db, itemId)!.state).toBe('done');
    expect(t.sends('carry')).toEqual([{ target: 'th_1', retryKey: `carry:i${itemId}`, body: expect.stringContaining('"by use"') }]);
    expect(t.ctx.db.prepare("SELECT ld.aiden_words, ld.said_where FROM lead_decisions ld JOIN lead_events e ON e.id = ld.event_id WHERE e.kind = 'answer'").get()).toEqual({ aiden_words: 'by use', said_where: 'voice' });
  });

  it('refuses a send that is not a line to the Voice, or of another project, with 409', async () => {
    const t = setup();
    const relay = dbWrite(t.ctx, 'test', () => intendSend(t.ctx.db, { projectId: t.project.id, kind: 'relay', target: 'th_1', body: 'x' }, t.ctx.now()));
    expect((await t.answer({ sendId: relay.id, aidenWords: 'yes' })).statusCode).toBe(409);
    const other = createProject(t.ctx, 'test', { name: 'Other' });
    const theirs = dbWrite(t.ctx, 'test', () => intendSend(t.ctx.db, { projectId: other.id, kind: 'voice_line', target: 'webhook', body: 'x' }, t.ctx.now()));
    expect((await t.answer({ sendId: theirs.id, aidenWords: 'yes' })).statusCode).toBe(409);
    expect((await t.answer({ sendId: relay.id, askId: t.review.id, aidenWords: 'yes' })).statusCode).toBe(400);
  });
});

describe('W3: the undo of a decision on what he left to the lead', () => {
  /** An aiden_said item decided by the round. */
  function decide(t: ReturnType<typeof setup>): number {
    const { itemId } = leadDeskAdd(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.step.id, aidenWords: 'you decide' });
    const turn = { id: null, verdict: 'DECIDE', answer: 'Alphabetical', why: 'reads best', kind: 'TECHNICAL' } as unknown as LeadTurn;
    const effect = dbWrite(t.ctx, 'lead:Progresser', (record) => applyVerdict(t.ctx, turn, getDeskItem(t.ctx.db, itemId)!, record));
    return Number(/^DECIDE d([0-9]+)$/.exec(effect.outcome)![1]);
  }

  it('goes to the thread the decision was relayed to, not the one on the step now', () => {
    const t = setup();
    const d = decide(t);
    // Another T3 session takes the step.
    handleHookEvent(t.ctx, 's2', { event: 'start', source: 'startup', cwd: repo.main });
    t.ctx.db.prepare("UPDATE sessions SET app = 't3', t3_thread_id = 'th_2', focus_node_id = ?, last_seen_at = '2099-01-01T00:00:00.000Z' WHERE id = 's2'").run(t.step.id);
    leadUndo(t.ctx, t.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'undo it' });
    expect(t.sends('relay').map((s) => [s.target, s.retryKey])).toEqual([
      ['th_1', `aiden-said:d${d}`],
      ['th_1', `undo:d${d}`],
    ]);
  });

  it("with no relay, says so in the step's log", () => {
    const u = setup();
    u.ctx.db.prepare("UPDATE sessions SET focus_node_id = NULL WHERE id = 's1'").run();
    const e = decide(u);
    leadUndo(u.ctx, u.project.slug, 'Progresser', V, { eventId: e, aidenWords: 'undo it' });
    expect(u.sends('relay')).toEqual([]);
    expect(u.ctx.db.prepare('SELECT text FROM log_entries WHERE node_id = ? ORDER BY id').pluck().all(u.step.id)).toEqual([
      expect.stringContaining(`decided d${e}`),
      `Progresser: d${e} is withdrawn: Aiden takes it back.`,
    ]);
  });
});

describe('W4: a C:\\work project runs no git', () => {
  it('refuses the answer before the yes is read', async () => {
    const calls: string[][] = [];
    const t = setup(calls);
    const work = createProject(t.ctx, 'test', { name: 'Client' });
    addBinding(t.ctx, 'test', work.slug, 'C:/work/client');
    setProjectLead(t.ctx, 'window', work.slug, 'Progresser');
    const [step] = addNodes(t.ctx, 'test', { parentId: work.rootNodeId, nodes: [{ title: 'Old' }] });
    const old = raiseAsk(t.ctx, 'session:s1', { nodeId: step.id, kind: 'review', text: 'Ship?', sessionId: 's1' });
    const res = await t.answer({ askId: old.id, aidenWords: 'ship it', yes: ['merge'] }, work.slug);
    expect(res.statusCode).toBe(409);
    expect(calls).toEqual([]);
    // readYeses reads only an ask of the project it is given.
    expect(await readYeses(t.ctx, t.project.slug, t.project.id, old.id, ['merge'], saidNow(), t.deps)).toBeUndefined();
  });
});

describe('W8: a change that moved after his word', () => {
  it('records his answer and no yes, and says the work changed after his word', async () => {
    const t = setup();
    const said = new Date(Date.now() - 5000).toISOString();
    const yeses = await readYeses(t.ctx, t.project.slug, t.project.id, t.review.id, ['merge'], said, t.deps);
    expect(yeses).toEqual([{ action: 'merge', patchId: null, why: CHANGED_AFTER }]);
    const res = leadAnswer(t.ctx, t.project.slug, 'Progresser', V, { askId: t.review.id, aidenWords: 'ship it', saidAt: said, yeses: yeses! });
    expect(res.text).toContain(`No yes recorded for merge: ${CHANGED_AFTER}.`);
    expect(t.yesCount()).toBe(0);
  });
});

describe('W9: the undo of a carried answer', () => {
  it('withdraws its yeses, so the landing holds again, and tells the session once', async () => {
    const t = setup();
    const res = await t.answer({ askId: t.review.id, aidenWords: 'ship it', where: 'voice', saidAt: saidNow(), yes: ['merge', 'push'] });
    const d = Number(/decision d([0-9]+)/.exec(res.json().text as string)![1]);
    expect(await t.check('merge')).toMatchObject({ clear: true });
    const undo = leadUndo(t.ctx, t.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'take that back' });
    expect(undo.text).toBe(`Undid d${d}: Aiden's answer is withdrawn, with his yes for merge and push.`);
    expect(await t.check('merge')).toMatchObject({ clear: false });
    expect(await t.check('push')).toMatchObject({ clear: false });
    expect(t.sends('relay').map((s) => [s.target, s.retryKey])).toEqual([['th_1', `undo:d${d}`]]);
    expect(() => leadUndo(t.ctx, t.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'again' })).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe('W10: a carry in flight is never repeated by the prompt', () => {
  it('stamps the ask delivered when the carry is tried, and a carry cleared unsent takes the stamp back', async () => {
    const t = setup();
    const question = raiseAsk(t.ctx, 'session:s1', { nodeId: t.step.id, kind: 'question', text: 'Which?', sessionId: 's1' });
    const seen: number[][] = [];
    let refuse = false;
    const t3: SenderT3 = {
      list: async () => [],
      show: async () => ({ thread: {} as never, messages: [] }),
      start: async () => ({ threadId: 'x' }),
      send: async () => {
        seen.push(undeliveredAnswers(t.ctx, 's1').map((a) => a.id));
        if (refuse) throw new T3ArgumentRefused('bad thread');
      },
    };
    const sender = createSender(t.ctx, { t3 }, { log: { info: () => undefined, error: () => undefined } });
    leadAnswer(t.ctx, t.project.slug, 'Progresser', V, { askId: question.id, aidenWords: 'that one' });
    await sender.wake();
    expect(seen).toEqual([[]]);
    expect(undeliveredAnswers(t.ctx, 's1').map((a) => a.id)).not.toContain(question.id);

    const other = raiseAsk(t.ctx, 'session:s1', { nodeId: t.step.id, kind: 'question', text: 'And this?', sessionId: 's1' });
    refuse = true;
    leadAnswer(t.ctx, t.project.slug, 'Progresser', V, { askId: other.id, aidenWords: 'this one' });
    await sender.wake();
    expect(undeliveredAnswers(t.ctx, 's1').map((a) => a.id)).toContain(other.id);
  });
});

describe('W7: the Voice costs nothing while it waits, and its day is a calendar day', () => {
  it('a project whose lines wait gets no write from a tick', async () => {
    const t = setup();
    const home = mkdtempSync(join(tmpdir(), 'ip-voice-'));
    try {
      mkdirSync(join(home, 'lead'), { recursive: true });
      writeFileSync(voiceFile(home), JSON.stringify({ url: 'https://voice.example.test/x', key: 'k' }));
      const voice = createVoice(t.ctx, { home, fetch: (async () => new Response('ok')) as unknown as typeof fetch });
      const sender = createSender(t.ctx, { t3: {} as SenderT3, webhook: voice.webhook, voiceReady: voice.ready }, { log: { info: () => undefined, error: () => undefined } });
      dbWrite(t.ctx, 'test', () => intendSend(t.ctx.db, { projectId: t.project.id, kind: 'voice_line', target: 'webhook', body: 'still gathering' }, t.ctx.now()));
      const changes = () => t.ctx.db.prepare('SELECT total_changes()').pluck().get() as number;
      const before = changes();
      await sender.tick();
      await sender.tick();
      expect(changes()).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('steps back one calendar day to the end of quiet hours', () => {
    const now = new Date(2026, 2, 29, 5, 0).toISOString();
    const start = new Date(voiceDayStart(now, 9 * 60));
    expect([start.getDate(), start.getHours(), start.getMinutes()]).toEqual([28, 9, 0]);
  });
});

describe('W5: a picture path must be whole', () => {
  it('is a 400 for a relative path, never resolved against the server folder', async () => {
    const t = setup();
    const home = mkdtempSync(join(tmpdir(), 'ip-home-'));
    try {
      const app = buildApp({ ctx: t.ctx, home, token: 't', uiToken: 'ui', version: 'test' });
      const res = await app.inject({ method: 'POST', url: '/api/resources', headers: { authorization: 'Bearer t' }, payload: { nodeId: t.step.id, kind: 'doc', title: 'Mock', path: 'docs/mock.png' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('give the full path');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
