import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { write as dbWrite } from '../../src/server/db/tx';
import { carriedLine, leadAnswer, leadDeskAdd, readYeses, WORK_PROJECT } from '../../src/server/lead-commands';
import { checkLanding, realGit, type LandingDeps } from '../../src/server/lead/landing';
import { deskUserMessage } from '../../src/server/lead/prompt';
import { createSender, type SenderT3 } from '../../src/server/lead/sends';
import { raiseAsk, requireAsk, undeliveredAnswers } from '../../src/server/repo/asks';
import { applyVerdict } from '../../src/server/lead/apply';
import type { LeadTurn } from '../../src/server/repo/leadTurns';
import { leadUndo } from '../../src/server/lead-commands';
import { morningList } from '../../src/server/lead/morning';
import { getDeskItem } from '../../src/server/repo/desk';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { handleHookEvent } from '../../src/server/session-flow';
import { commit, git, lines, makeRepo, write, type TestRepo } from '../git-repo';
import { makeCtx } from '../helpers';

const V = LEAD_INSTRUCTIONS_VERSION;
const deps: LandingDeps = { git: realGit, visibility: async () => false };
let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => repo.cleanup());

/** A project led by Progresser, bound to the test repo; a T3 Code session on its feature worktree that asks for a review of its step. */
function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, repo.main);
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Tabs' }] });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: repo.main });
  // The session works in the feature worktree, in T3 Code.
  expect(ctx.db.prepare("UPDATE sessions SET cwd = ?, branch = 'feature', app = 't3', t3_thread_id = 'th_1' WHERE id = 's1'").run(repo.wt).changes).toBe(1);
  const review = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'review', text: 'Ship the tabs?', sessionId: 's1' });
  const permission = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'permission', text: 'May I delete the old tabs?', sessionId: 's1' });
  const check = (action: 'merge' | 'deploy' | 'push') => checkLanding(ctx, { ref: project.slug, stepId: step.id, action, folder: repo.wt, ...(action === 'deploy' ? {} : { branch: 'feature' }) }, deps);
  return { ctx, project, step, review, permission, check };
}

describe("the guard on Aiden's go-ahead", () => {
  // Many git reads: under a full parallel run it can pass the default 20 s.
  it('a "ship it" carried for a review keys merge, deploy and push on the change of the branch: each clears that change, after the merge too, and holds when anything else comes between', { timeout: 60_000 }, async () => {
    const t = setup();
    write(repo.wt, 'web/app.ts', lines(20, 'tabs'));
    commit(repo.wt, 'tabs');
    expect(await t.check('merge')).toMatchObject({ clear: false });
    // His word, after the last commit (git's clock is the real one, the test's ctx clock is not).
    const said = new Date(Date.now() + 1000).toISOString();
    const yeses = await readYeses(t.ctx, t.project.slug, t.project.id, t.review.id, ['merge', 'deploy', 'push'], said, deps);
    const merge = (await checkLanding(t.ctx, { ref: t.project.slug, stepId: t.step.id, action: 'merge', folder: repo.wt, branch: 'feature' }, deps)).patchId;
    expect(merge).toMatch(/^[0-9a-f]{40}$/);
    expect(yeses).toEqual([
      { action: 'merge', patchId: merge },
      { action: 'deploy', patchId: merge },
      { action: 'push', patchId: merge },
    ]);
    // The two checks above held and logged; the read logs nothing.
    expect(t.ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'landing_check'").pluck().get()).toBe(2);
    const res = leadAnswer(t.ctx, t.project.slug, 'Progresser', V, { askId: t.review.id, aidenWords: 'ship it', where: 'voice', saidAt: said, shown: [3], yeses: yeses! });
    expect(res.text).toMatch(new RegExp(`^Answered a${t.review.id} with Aiden's words: decision d[0-9]+\\. His yes covers merge, deploy and push of the change as it is now\\. Its session is told in its thread\\.$`));
    expect(requireAsk(t.ctx, t.review.id)).toMatchObject({ answer: 'ship it', answeredVia: 'lead' });
    const yesLines = t.ctx.db.prepare("SELECT text, node_id, aiden_words FROM lead_events WHERE kind = 'yes' ORDER BY id").all() as { text: string; node_id: number; aiden_words: string }[];
    expect(yesLines.map((y) => y.text)).toEqual(yeses!.map((y) => `${y.action} ${y.patchId}`));
    expect(yesLines.every((y) => y.node_id === t.step.id && y.aiden_words === 'ship it')).toBe(true);
    expect(t.ctx.db.prepare("SELECT kind, aiden_words, aiden_answer, said_where FROM lead_decisions").get()).toEqual({ kind: 'technical', aiden_words: 'ship it', aiden_answer: 'ship it', said_where: 'voice' });
    expect(t.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'answer'").pluck().get()).toMatch(/^where voice; said .*; shown r3; yes e[0-9]+,e[0-9]+,e[0-9]+$/);

    expect(await t.check('merge')).toMatchObject({ clear: true, why: 'his yes' });
    expect(await t.check('push')).toMatchObject({ clear: true, why: 'his yes' });
    // Merged: main against the live build is the same change, so the deploy clears on the same yes.
    git(repo.main, 'merge', '-q', '--ff-only', 'feature');
    expect(await t.check('deploy')).toMatchObject({ clear: true, why: 'his yes' });
    // Something else on main before the deploy: the change is not the one he said yes to, and it holds.
    write(repo.main, 'README.md', lines(4, 'readme'));
    commit(repo.main, 'readme');
    expect(await t.check('deploy')).toMatchObject({ clear: false });
    write(repo.wt, 'web/app.ts', lines(21, 'tabs'));
    commit(repo.wt, 'more tabs');
    expect(await t.check('push')).toMatchObject({ clear: false });
  });

  it('records the answer without a yes when the change cannot be read, and says so', async () => {
    const t = setup();
    t.ctx.db.prepare("UPDATE sessions SET cwd = NULL WHERE id = 's1'").run();
    const yeses = await readYeses(t.ctx, t.project.slug, t.project.id, t.review.id, ['merge'], new Date().toISOString(), deps);
    const res = leadAnswer(t.ctx, t.project.slug, 'Progresser', V, { askId: t.review.id, aidenWords: 'ship it', yeses: yeses! });
    expect(res.text).toContain('No yes recorded for merge: its session has no folder on record.');
    expect(t.ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'yes'").pluck().get()).toBe(0);
    expect(requireAsk(t.ctx, t.review.id).answer).toBe('ship it');
  });

  it('carries a permission, as a permission decision, and its line reaches the T3 Code session once', async () => {
    const t = setup();
    const sent: { thread: string; text: string }[] = [];
    const t3: SenderT3 = {
      list: async () => [],
      show: async () => ({ thread: { threadId: 'th_1', title: '', updatedAt: '', createdAt: '' } as never, messages: [] }),
      start: async () => ({ threadId: 'x' }),
      send: async (thread, text) => {
        sent.push({ thread, text });
      },
    };
    const sender = createSender(t.ctx, { t3 }, { log: { info: () => undefined, error: () => undefined } });
    const saidAt = '2026-11-25T14:02:00.000Z';
    const res = leadAnswer(t.ctx, t.project.slug, 'Progresser', V, { askId: t.permission.id, aidenWords: 'go ahead', where: 'voice', saidAt });
    expect(res.carried).toBe(true);
    // Until the carry is done the answer waits for the next prompt; once it is in the thread, the prompt does not repeat it.
    expect(undeliveredAnswers(t.ctx, 's1').map((a) => a.id)).toContain(t.permission.id);
    await sender.wake();
    await sender.tick();
    expect(sent).toEqual([{ thread: 'th_1', text: carriedLine('Progresser', 'voice', saidAt, 'go ahead', t.permission.id) }]);
    expect(undeliveredAnswers(t.ctx, 's1').map((a) => a.id)).not.toContain(t.permission.id);
    // C2: the line names the ask, so a session with several asks knows which one he answered.
    expect(sent[0].text).toMatch(new RegExp(`^Aiden's answer to a${t.permission.id}, carried by Progresser from Grok at [0-9]{2}:02: "go ahead"$`));
    expect(t.ctx.db.prepare('SELECT kind, said_where, said_at FROM lead_decisions').get()).toEqual({ kind: 'permission', said_where: 'voice', said_at: saidAt });
    expect(carriedLine('Progresser', 'thread', saidAt, 'yes')).toContain("from the lead's thread at");
    expect(carriedLine('Progresser', 'thread', saidAt, 'yes')).toMatch(/^Aiden's answer, carried by/);
  });

  it('C1: carries nothing to an ended session: the ask is answered and waits for its next prompt; its undo relays nothing', () => {
    const t = setup();
    t.ctx.db.prepare("UPDATE sessions SET state = 'ended' WHERE id = 's1'").run();
    const res = leadAnswer(t.ctx, t.project.slug, 'Progresser', V, { askId: t.permission.id, aidenWords: 'go ahead', where: 'voice' });
    expect(res.carried).toBe(false);
    expect(res.text).not.toContain('Its session is told in its thread.');
    expect(requireAsk(t.ctx, t.permission.id).answer).toBe('go ahead');
    expect(undeliveredAnswers(t.ctx, 's1').map((a) => a.id)).toContain(t.permission.id);
    expect(t.ctx.db.prepare("SELECT COUNT(*) FROM lead_sends WHERE kind IN ('carry', 'relay')").pluck().get()).toBe(0);
    const d = Number(/decision d(\d+)/.exec(res.text)![1]);
    leadUndo(t.ctx, t.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'take that back' });
    expect(t.ctx.db.prepare("SELECT COUNT(*) FROM lead_sends WHERE kind IN ('carry', 'relay')").pluck().get()).toBe(0);
  });

  it("C1: a carry made while the session was live, undone after it ended, relays no withdrawal: the ask's answer says it", () => {
    const t = setup();
    const res = leadAnswer(t.ctx, t.project.slug, 'Progresser', V, { askId: t.permission.id, aidenWords: 'go ahead', where: 'voice' });
    expect(res.carried).toBe(true);
    t.ctx.db.prepare("UPDATE sessions SET state = 'ended' WHERE id = 's1'").run();
    const d = Number(/decision d(\d+)/.exec(res.text)![1]);
    leadUndo(t.ctx, t.project.slug, 'Progresser', V, { eventId: d, aidenWords: 'take that back' });
    expect(t.ctx.db.prepare("SELECT retry_key FROM lead_sends WHERE kind IN ('carry', 'relay') ORDER BY id").pluck().all()).toEqual([`carry:a${t.permission.id}`]);
    expect(requireAsk(t.ctx, t.permission.id).answer).toMatch(/is withdrawn by Progresser/);
  });

  it("refuses an old ask of a project under C:\\work, and a lead on version 6", () => {
    const t = setup();
    expect(() => leadAnswer(t.ctx, t.project.slug, 'Progresser', 6, { askId: t.review.id, aidenWords: 'ship it' })).toThrow(expect.objectContaining({ status: 409 }));
    const work = createProject(t.ctx, 'test', { name: 'Client' });
    addBinding(t.ctx, 'test', work.slug, 'C:/work/client');
    setProjectLead(t.ctx, 'window', work.slug, 'Progresser');
    const [step] = addNodes(t.ctx, 'test', { parentId: work.rootNodeId, nodes: [{ title: 'Old' }] });
    const old = raiseAsk(t.ctx, 'test', { nodeId: step.id, kind: 'question', text: 'Which?' });
    expect(() => leadAnswer(t.ctx, work.slug, 'Progresser', V, { askId: old.id, aidenWords: 'that one' })).toThrow(expect.objectContaining({ status: 409, message: WORK_PROJECT }));
    expect(requireAsk(t.ctx, old.id).clearedAt).toBeNull();
  });

  it('"you decide" goes to the desk as an aiden_said item whose turn gives his words', () => {
    const t = setup();
    const res = leadDeskAdd(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.step.id, aidenWords: 'you decide the tab order' });
    const item = getDeskItem(t.ctx.db, res.itemId)!;
    expect(item).toMatchObject({ kind: 'aiden_said', nodeId: t.step.id, state: 'open' });
    const msg = dbWrite(t.ctx, 'test', () => deskUserMessage(t.ctx, item));
    expect(msg).toContain('Aiden said: "you decide the tab order"');
    expect(msg).toContain('DECIDE with your answer, or AIDEN');
  });

  it('carries an answer in a project with no lead under its own name, and refuses a project that names another lead', () => {
    const t = setup();
    const free = createProject(t.ctx, 'test', { name: 'Garden' });
    addBinding(t.ctx, 'test', free.slug, 'C:/personal/Garden');
    const [step] = addNodes(t.ctx, 'test', { parentId: free.rootNodeId, nodes: [{ title: 'Beds' }] });
    const old = raiseAsk(t.ctx, 'test', { nodeId: step.id, kind: 'question', text: 'Raised beds?' });
    expect(leadAnswer(t.ctx, free.slug, 'Progresser', V, { askId: old.id, aidenWords: 'yes, raised' }).text).toMatch(new RegExp(`^Answered a${old.id} with Aiden's words: decision d[0-9]+[.]$`));
    expect(requireAsk(t.ctx, old.id)).toMatchObject({ answer: 'yes, raised', clearedBy: 'lead:Progresser' });
    const other = createProject(t.ctx, 'test', { name: 'Theirs' });
    setProjectLead(t.ctx, 'window', other.slug, 'Keeper');
    const [s2] = addNodes(t.ctx, 'test', { parentId: other.rootNodeId, nodes: [{ title: 'X' }] });
    const theirs = raiseAsk(t.ctx, 'test', { nodeId: s2.id, kind: 'question', text: 'Which?' });
    expect(() => leadAnswer(t.ctx, other.slug, 'Progresser', V, { askId: theirs.id, aidenWords: 'that' })).toThrow(expect.objectContaining({ status: 409 }));
    expect(requireAsk(t.ctx, theirs.id).clearedAt).toBeNull();
  });
});

describe('the round on what Aiden left to the lead', () => {
  /** An aiden_said item on the step and a turn on it with this verdict, applied as the runner applies one. */
  function decided(t: ReturnType<typeof setup>, verdict: string, answer: string) {
    const { itemId } = leadDeskAdd(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.step.id, aidenWords: 'you decide the tab order' });
    const now = t.ctx.now();
    const turnId = Number(
      t.ctx.db
        .prepare("INSERT INTO lead_turns (item_id, project_id, way, leased_at, lease_until, state, verdict, answer, why, kind) VALUES (?, ?, 'headless', ?, ?, 'answered', ?, ?, 'Alphabetical reads best', 'TECHNICAL')")
        .run(itemId, t.project.id, now, now, verdict, answer).lastInsertRowid,
    );
    const turn = { id: turnId, itemId, projectId: t.project.id, verdict, answer, why: 'Alphabetical reads best', kind: 'TECHNICAL' } as unknown as LeadTurn;
    const item = getDeskItem(t.ctx.db, itemId)!;
    return dbWrite(t.ctx, 'lead:Progresser', (record) => applyVerdict(t.ctx, turn, item, record));
  }
  const relays = (t: ReturnType<typeof setup>) => t.ctx.db.prepare("SELECT target, retry_key AS retryKey, body FROM lead_sends WHERE kind = 'relay' ORDER BY id").all() as { target: string; retryKey: string; body: string }[];

  it('DECIDE is a numbered decision with his words, relayed to the T3 Code session on the step, in the morning list, and undoable', () => {
    const t = setup();
    t.ctx.db.prepare("UPDATE sessions SET focus_node_id = ? WHERE id = 's1'").run(t.step.id);
    const effect = decided(t, 'DECIDE', 'Alphabetical');
    const id = Number(/^DECIDE d([0-9]+)$/.exec(effect.outcome)![1]);
    expect(effect.itemState).toBe('done');
    expect(t.ctx.db.prepare('SELECT kind, aiden_words, aiden_answer, line FROM lead_decisions WHERE event_id = ?').get(id)).toEqual({ kind: 'technical', aiden_words: 'you decide the tab order', aiden_answer: 'Alphabetical', line: 'Alphabetical' });
    expect(relays(t)).toEqual([{ target: 'th_1', retryKey: `aiden-said:d${id}`, body: expect.stringContaining(`d${id}: Alphabetical`) }]);
    expect(morningList(t.ctx, t.project.id, '2000-01-01T00:00:00.000Z', t.ctx.now()).text).toContain(`d${id}`);
    expect(leadUndo(t.ctx, t.project.slug, 'Progresser', V, { eventId: id, aidenWords: 'undo it' }).text).toBe(`Undid d${id}: the decision is withdrawn.`);
    expect(relays(t).map((r) => r.retryKey)).toEqual([`aiden-said:d${id}`, `undo:d${id}`]);
  });

  it('DECIDE with no T3 Code session on the step is a line on the step; AIDEN brings it with a Voice line; CARD is noted', () => {
    const t = setup();
    const effect = decided(t, 'DECIDE', 'Alphabetical');
    expect(relays(t)).toEqual([]);
    expect(t.ctx.db.prepare('SELECT text FROM log_entries WHERE node_id = ?').pluck().all(t.step.id)).toEqual([expect.stringContaining(`Progresser decided ${effect.outcome.slice(7)}: Alphabetical`)]);
    const brought = decided(t, 'AIDEN', 'Alphabetical');
    expect(brought).toMatchObject({ itemState: 'waiting_aiden', outcome: expect.stringMatching(/^AIDEN d[0-9]+$/) });
    expect(t.ctx.db.prepare("SELECT COUNT(*) FROM lead_sends WHERE kind = 'voice_line'").pluck().get()).toBe(1);
    expect(decided(t, 'CARD', 'nothing to land')).toMatchObject({ itemState: 'done', outcome: expect.stringMatching(/^CARD noted/) });
  });
});
