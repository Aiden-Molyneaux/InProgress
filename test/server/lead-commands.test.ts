import { describe, expect, it } from 'vitest';
import { deriveBoard } from '../../src/core/board';
import { buildApp } from '../../src/server/app';
import { stamp } from '../../src/server/digest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { ARCHIVED, noLeadNamed, outOfDate, readLeadBrief } from '../../src/server/lead';
import { DECIDE_QUESTION_ONLY, leadAnswer, leadDecide, leadDrop, leadIntent, leadKept, leadPark, leadPromise, leadUndo } from '../../src/server/lead-commands';
import { clearAsk, raiseAsk, requireAsk, undeliveredAnswers } from '../../src/server/repo/asks';
import { maxEventId } from '../../src/server/repo/events';
import { addNodes, requireNode, updateNode } from '../../src/server/repo/nodes';
import { addBinding, changeProject, createProject, listProjectSummaries, resolveProject, setProjectLead, setQueue } from '../../src/server/repo/projects';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { claimStep, handleHookEvent } from '../../src/server/session-flow';
import { makeCtx } from '../helpers';

const BEARER = { authorization: 'Bearer t' };
const DUE = '2026-10-01T09:00:00.000Z';
const QUESTION_ONLY = "The lead can carry Aiden's answer to a question only. A permission or a review needs Aiden in the thread or the window.";
const aidens = (origin: string) => `This step is Aiden's (origin ${origin}). Pass his words with --aiden.`;
const parkNeeds = (origin: string) => `This step is Aiden's (origin ${origin}). Pass his words with --aiden, or your reason with --reason when nobody is working on it.`;

/**
 * A project led by Progresser: a step of each origin (Aiden's own, asked, proposed) and one more, a tracked session that
 * asked a question on the asked step, and a review and a permission of Aiden's.
 */
function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [mine] = addNodes(ctx, 'window', { parentId: project.rootNodeId, nodes: [{ title: 'Buy the domain' }] });
  const [asked, proposed, other] = addNodes(ctx, 'test', {
    parentId: project.rootNodeId,
    nodes: [{ title: 'Play app signing', status: 'active' }, { title: 'Dark mode', origin: 'proposed' }, { title: 'Privacy page' }],
  });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
  const question = raiseAsk(ctx, 'session:s1', { nodeId: asked.id, kind: 'question', text: 'Which keystore?', sessionId: 's1' });
  const review = raiseAsk(ctx, 'session:s1', { nodeId: proposed.id, kind: 'review', text: 'Look at the mock' });
  const permission = raiseAsk(ctx, 'session:s1', { nodeId: mine.id, kind: 'permission', text: 'May I push?' });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const app = buildApp({ ctx, token: 't', uiToken: 'ui-token', version: 'test' });
  const events = () =>
    ctx.db.prepare('SELECT kind, node_id, ask_id, instructions, lead, text, aiden_words FROM lead_events ORDER BY id').all() as {
      kind: string;
      node_id: number | null;
      ask_id: number | null;
      instructions: number;
      lead: string;
      text: string;
      aiden_words: string | null;
    }[];
  const leadEvents = () => ctx.db.prepare('SELECT COUNT(*) FROM lead_events').pluck().get() as number;
  const askRow = (id: number) => ctx.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as Record<string, unknown>;
  /** Runs `fn`, which must throw; answers what it threw, having checked that nothing was written. */
  const refused = (fn: () => unknown): { status: number; message: string } => {
    const mark = maxEventId(ctx);
    const count = leadEvents();
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught, 'it should have been refused').toBeDefined();
    expect(maxEventId(ctx)).toBe(mark);
    expect(leadEvents()).toBe(count);
    return caught as { status: number; message: string };
  };
  return { ctx, app, project, mine, asked, proposed, other, question, review, permission, events, leadEvents, askRow, refused };
}

/** The fixture's proposed step has a review ask open; a park or drop on the lead's own judgment needs it answered first. */
const settle = (t: { ctx: Parameters<typeof clearAsk>[0]; review: { id: number } }): void => {
  clearAsk(t.ctx, 'window', t.review.id);
};

describe('leadAnswer', () => {
  it("clears the question with Aiden's words, logs one line, hands it to the asker and cites it in the brief", () => {
    const { ctx, project, question, events, askRow } = setup();
    const res = leadAnswer(ctx, project.slug, 'progresser', LEAD_INSTRUCTIONS_VERSION, { askId: question.id, aidenWords: 'Use the release keystore.' });
    expect(res.text).toBe(`Answered a${question.id} with Aiden's words.`);
    expect(askRow(question.id)).toMatchObject({ answer: 'Use the release keystore.', cleared_by: 'lead:Progresser', answered_via: 'lead' });
    expect(events()).toEqual([
      { kind: 'answer', node_id: question.nodeId, ask_id: question.id, instructions: LEAD_INSTRUCTIONS_VERSION, lead: 'Progresser', text: '', aiden_words: 'Use the release keystore.' },
    ]);
    expect(undeliveredAnswers(ctx, 's1').map((a) => a.id)).toEqual([question.id]);
    const said = readLeadBrief(ctx, project.slug, 1, new Date(ctx.now())).saidInAidensName;
    expect(said[0]).toMatchObject({ kind: 'answer', ref: `a${question.id}`, words: 'Use the release keystore.' });
  });

  it('refuses an ask Aiden answered first, and his answer stands (Review Focus 2)', () => {
    const { ctx, project, question, askRow, refused } = setup();
    clearAsk(ctx, 'window', question.id, 'Mine.');
    const err = refused(() => leadAnswer(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { askId: question.id, aidenWords: 'Theirs.' }));
    expect(err).toMatchObject({ status: 409, message: 'Already answered: "Mine.".' });
    expect(askRow(question.id)).toMatchObject({ answer: 'Mine.', answered_via: null, cleared_by: 'window' });
  });

  it('refuses an ask cleared with no answer in its own words', () => {
    const { ctx, project, question, refused } = setup();
    clearAsk(ctx, 'window', question.id);
    expect(refused(() => leadAnswer(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { askId: question.id, aidenWords: 'Yes.' })).message).toBe(
      `a${question.id} is already cleared, with no answer.`,
    );
  });

  it("refuses a review, a permission, the lead's own promise and an ask of another project, writing nothing", () => {
    const { ctx, project, review, permission, asked, refused } = setup();
    const answer = (askId: number) => () => leadAnswer(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { askId, aidenWords: 'Yes.' });
    expect(refused(answer(review.id))).toMatchObject({ status: 409, message: QUESTION_ONLY });
    expect(refused(answer(permission.id))).toMatchObject({ status: 409, message: QUESTION_ONLY });
    const promise = raiseAsk(ctx, 'lead', { nodeId: asked.id, kind: 'review', text: 'Send the draft', owner: 'lead', dueAt: DUE });
    expect(refused(answer(promise.id))).toMatchObject({ status: 409, message: `a${promise.id} is the lead's own promise. Clear it with kept.` });
    const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
    const [step] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Theirs' }] });
    const foreign = raiseAsk(ctx, 'test', { nodeId: step.id, kind: 'question', text: 'Which?' });
    expect(refused(answer(foreign.id))).toMatchObject({ status: 409, message: `a${foreign.id} is not in this project.` });
    expect(requireAsk(ctx, foreign.id).clearedAt).toBeNull();
  });
});

describe('leadPark', () => {
  it('parks a proposed step with no words once nothing waits on it', () => {
    const t = setup();
    const { ctx, project, proposed, events } = t;
    settle(t);
    const res = leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: proposed.id });
    expect(res.text).toBe(`Parked #${proposed.id} Dark mode. Decision d${res.decision}.`);
    expect(res.decision).toBe(1);
    expect(requireNode(ctx, proposed.id)).toMatchObject({ status: 'parked', parkedReason: 'Parked by Progresser.' });
    expect(events()).toEqual([{ kind: 'park', node_id: proposed.id, ask_id: null, instructions: LEAD_INSTRUCTIONS_VERSION, lead: 'Progresser', text: 'Parked by Progresser.', aiden_words: null }]);
  });

  it("refuses a step of Aiden's without his words, and parks it with them, his words the reason when none is given", () => {
    const { ctx, project, asked, mine, events, refused } = setup();
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: asked.id }))).toMatchObject({ status: 409, message: parkNeeds('asked') });
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: mine.id }))).toMatchObject({ status: 409, message: parkNeeds('me') });
    expect(requireNode(ctx, asked.id).status).toBe('active');
    leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: asked.id, aidenWords: 'Park signing till the store answers.' });
    expect(requireNode(ctx, asked.id)).toMatchObject({ status: 'parked', parkedReason: 'Park signing till the store answers.' });
    leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: mine.id, reason: 'Later', aidenWords: 'Not now.' });
    expect(requireNode(ctx, mine.id).parkedReason).toBe('Later');
    expect(events().map((e) => [e.kind, e.node_id, e.text, e.aiden_words])).toEqual([
      ['park', asked.id, 'Park signing till the store answers.', 'Park signing till the store answers.'],
      ['park', mine.id, 'Later', 'Not now.'],
    ]);
    const said = readLeadBrief(ctx, project.slug, 1, new Date(ctx.now())).saidInAidensName;
    expect(said[0]).toMatchObject({ kind: 'park', ref: `#${mine.id}`, words: 'Not now.' });
  });

  it('takes a queued step out of the queue', () => {
    const t = setup();
    const { ctx, project, proposed, other } = t;
    settle(t);
    setQueue(ctx, 'test', project.slug, [proposed.id, other.id], 'unowned');
    const queued = () => resolveProject(ctx, project.slug).queue.map((e) => e.nodeId);
    expect(queued()).toEqual([proposed.id, other.id]);
    leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: proposed.id });
    expect(queued()).toEqual([other.id]);
  });

  it('refuses a parked step, a done one and a step of another project', () => {
    const t = setup();
    const { ctx, project, proposed, other, refused } = t;
    settle(t);
    leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: proposed.id });
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: proposed.id }))).toMatchObject({ status: 409, message: `#${proposed.id} is already parked.` });
    updateNode(ctx, 'test', other.id, { status: 'done' });
    // A done step keeps its review ask open; the refused park must leave it so, which proves its write rolled back.
    const look = raiseAsk(ctx, 'session:s1', { nodeId: other.id, kind: 'review', text: 'Look at the page' });
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: other.id, aidenWords: 'Park it.' })).status).toBe(400);
    expect(requireAsk(ctx, look.id).clearedAt).toBeNull();
    expect(requireNode(ctx, other.id).status).toBe('done');
    const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
    const [step] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Theirs', origin: 'proposed' }] });
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: step.id }))).toMatchObject({ status: 409, message: `#${step.id} is not in this project.` });
    // Another project's root is another project's step: only this project's own root is "the project itself".
    const theirs = { status: 409, message: `#${elsewhere.rootNodeId} is not in this project.` };
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: elsewhere.rootNodeId }))).toMatchObject(theirs);
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: elsewhere.rootNodeId, reason: 'No.' }))).toMatchObject(theirs);
  });
});

describe('leadDrop', () => {
  it("needs Aiden's words for his step; with them it drops it, clears its asks, and logs the reason", () => {
    const { ctx, project, asked, question, events, askRow, refused } = setup();
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: asked.id, reason: 'Moot' }))).toMatchObject({ status: 409, message: aidens('asked') });
    expect(requireNode(ctx, asked.id).status).toBe('active');
    const res = leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: asked.id, reason: 'The store signs it now', aidenWords: 'Drop it.' });
    expect(res.text).toBe(`Dropped #${asked.id} Play app signing.`);
    expect(requireNode(ctx, asked.id).status).toBe('dropped');
    expect(askRow(question.id)).toMatchObject({ cleared_by: 'lead:Progresser', answer: '' });
    expect(askRow(question.id).cleared_at).not.toBeNull();
    expect(events()).toEqual([{ kind: 'drop', node_id: asked.id, ask_id: null, instructions: LEAD_INSTRUCTIONS_VERSION, lead: 'Progresser', text: 'The store signs it now', aiden_words: 'Drop it.' }]);
  });

  it('drops a proposed step with no words, and refuses one already done or dropped', () => {
    const t = setup();
    const { ctx, project, proposed, other, refused } = t;
    settle(t);
    leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: proposed.id, reason: 'Not wanted' });
    expect(requireNode(ctx, proposed.id).status).toBe('dropped');
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: proposed.id, reason: 'Again' }))).toMatchObject({ status: 409, message: `#${proposed.id} is dropped.` });
    updateNode(ctx, 'test', other.id, { status: 'done' });
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: other.id, reason: 'x', aidenWords: 'Drop.' }))).toMatchObject({ status: 409, message: `#${other.id} is done.` });
  });

  it('refuses a step a live session drives, and drops it once that session has ended', () => {
    const t = setup();
    const { ctx, project, proposed, refused } = t;
    settle(t);
    claimStep(ctx, 'test', 's1', proposed.id);
    expect(requireNode(ctx, proposed.id).driverSessionId).toBe('s1');
    const drop = () => leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: proposed.id, reason: 'Not wanted' });
    expect(refused(drop)).toMatchObject({ status: 409, message: `#${proposed.id} Dark mode has a session working on it. Park it, or wait for the session to end.` });
    expect(requireNode(ctx, proposed.id).status).not.toBe('dropped');
    handleHookEvent(ctx, 's1', { event: 'end' });
    expect(drop().text).toMatch(/^Dropped #\d+ Dark mode\. Decision d\d+\.$/);
  });

  it('checks a live driver after the words for a step of Aiden\'s, and before the open steps under it', () => {
    const { ctx, project, other, refused } = setup();
    addNodes(ctx, 'test', { parentId: other.id, nodes: [{ title: 'Write the page' }] });
    claimStep(ctx, 'test', 's1', other.id);
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: other.id, reason: 'Moot' })).message).toBe(aidens('asked'));
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: other.id, reason: 'Moot', aidenWords: 'Drop it.' })).message).toBe(
      `#${other.id} Privacy page has a session working on it. Park it, or wait for the session to end.`,
    );
  });

  it('refuses a step with open steps under it, and drops it once they are done', () => {
    const { ctx, project, other, refused } = setup();
    const [child] = addNodes(ctx, 'test', { parentId: other.id, nodes: [{ title: 'Write the page' }] });
    const drop = () => leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: other.id, reason: 'Moot', aidenWords: 'Drop it.' });
    expect(refused(drop)).toMatchObject({ status: 409, message: `#${other.id} Privacy page has open steps under it. Drop or park those first.` });
    updateNode(ctx, 'test', child.id, { status: 'done' });
    expect(drop().text).toBe(`Dropped #${other.id} Privacy page.`);
  });
});

describe('the root step', () => {
  it('is refused by park and by drop, before any other check, and nothing is written', () => {
    const { ctx, project, refused } = setup();
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: project.rootNodeId }))).toMatchObject({ status: 409, message: 'The project itself cannot be parked.' });
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { stepId: project.rootNodeId, reason: 'x', aidenWords: 'Drop it.' }))).toMatchObject({
      status: 409,
      message: 'The project itself cannot be dropped.',
    });
    expect(requireNode(ctx, project.rootNodeId).status).toBe('active');
  });

  it("still refuses an ask of Aiden's on the root, as before", () => {
    const { ctx, project } = setup();
    expect(() => raiseAsk(ctx, 'test', { nodeId: project.rootNodeId, kind: 'question', text: 'Which?' })).toThrow(`#${project.rootNodeId} is the project root`);
    let caught: unknown;
    try {
      raiseAsk(ctx, 'test', { nodeId: project.rootNodeId, kind: 'question', text: 'Which?' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 400, hint: 'Raise the ask on the step it concerns.' });
  });
});

describe('leadPromise', () => {
  it("raises a review owned by the lead with its due time, on the root when no step is named, outside Aiden's count", () => {
    const { ctx, project, events, askRow } = setup();
    const before = listProjectSummaries(ctx).find((p) => p.id === project.id)!.openAsks;
    const res = leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'Send Aiden the draft', dueAt: DUE });
    expect(res.text).toMatch(new RegExp(`^Promised a${res.ask.id}, due \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\.$`));
    expect(askRow(res.ask.id)).toMatchObject({ owner: 'lead', kind: 'review', due_at: DUE, node_id: project.rootNodeId, session_id: null });
    expect(events()).toEqual([{ kind: 'promise', node_id: project.rootNodeId, ask_id: res.ask.id, instructions: LEAD_INSTRUCTIONS_VERSION, lead: 'Progresser', text: 'Send Aiden the draft', aiden_words: null }]);
    const brief = readLeadBrief(ctx, project.slug, 1, new Date(ctx.now()));
    expect(brief.forTheLead).toEqual([{ askId: res.ask.id, stepId: project.rootNodeId, stepTitle: 'InGame', text: 'Send Aiden the draft', dueAt: DUE, overdue: false }]);
    expect(brief.waitingOnAiden.map((a) => a.askId)).not.toContain(res.ask.id);
    expect(listProjectSummaries(ctx).find((p) => p.id === project.id)!.openAsks).toBe(before);
  });

  it('puts it on the step named, and the same promise twice is one ask and one line', () => {
    const { ctx, project, other, leadEvents } = setup();
    const first = leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'Check the page', dueAt: DUE, stepId: other.id });
    expect(first.ask.nodeId).toBe(other.id);
    const again = leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'Check the page', dueAt: DUE, stepId: other.id });
    expect(again.text).toBe(`Already promised: a${first.ask.id}, due ${stamp(DUE)}.`);
    expect(again.ask.id).toBe(first.ask.id);
    expect(leadEvents()).toBe(1);
  });

  it('answers a promise made again with a later due time with the time on record, which stays', () => {
    const { ctx, project, other, leadEvents, askRow } = setup();
    const first = leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'Check the page', dueAt: DUE, stepId: other.id });
    const again = leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'Check the page', dueAt: '2026-12-01T09:00:00.000Z', stepId: other.id });
    expect(again.text).toBe(`Already promised: a${first.ask.id}, due ${stamp(DUE)}.`);
    expect(askRow(first.ask.id).due_at).toBe(DUE);
    expect(leadEvents()).toBe(1);
  });

  it('says so when the open promise it joins has no due time', () => {
    const { ctx, project, other, leadEvents } = setup();
    const open = raiseAsk(ctx, 'lead', { nodeId: other.id, kind: 'review', text: 'Check the page', owner: 'lead' });
    const again = leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'Check the page', dueAt: DUE, stepId: other.id });
    expect(again.text).toBe(`Already promised: a${open.id}, with no due time.`);
    expect(leadEvents()).toBe(0);
  });

  it('refuses a due time that has passed, and a step of another project', () => {
    const { ctx, project, refused } = setup();
    expect(refused(() => leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'Late', dueAt: '2026-09-01T00:00:00.000Z' }))).toMatchObject({
      status: 409,
      message: 'The due time is in the past.',
    });
    const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
    const [step] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Theirs' }] });
    expect(refused(() => leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'x', dueAt: DUE, stepId: step.id }))).toMatchObject({
      status: 409,
      message: `#${step.id} is not in this project.`,
    });
  });
});

describe('leadKept', () => {
  it('clears a promise with no answer, so no session is owed one and its step shows none waiting', () => {
    const { ctx, project, other, events, askRow } = setup();
    const promise = leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'Check the page', dueAt: DUE, stepId: other.id }).ask;
    const res = leadKept(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { askId: promise.id, note: 'Checked, it reads well.' });
    expect(res.text).toBe(`Kept a${promise.id}.`);
    expect(askRow(promise.id)).toMatchObject({ answer: '', cleared_by: 'lead:Progresser', answered_via: null });
    expect(askRow(promise.id).cleared_at).not.toBeNull();
    expect(events().at(-1)).toEqual({ kind: 'kept', node_id: other.id, ask_id: promise.id, instructions: LEAD_INSTRUCTIONS_VERSION, lead: 'Progresser', text: 'Checked, it reads well.', aiden_words: null });
    expect(undeliveredAnswers(ctx, 's1')).toEqual([]);
    const board = deriveBoard(getProjectSnapshot(ctx, project.id), Date.parse(ctx.now()));
    expect(board.byId.get(other.id)!.marks).not.toContain('answer_waiting');
  });

  it("refuses an ask of Aiden's and one already cleared", () => {
    const { ctx, project, question, refused } = setup();
    expect(refused(() => leadKept(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { askId: question.id }))).toMatchObject({
      status: 409,
      message: `a${question.id} is Aiden's. The lead clears only its own promises.`,
    });
    const promise = leadPromise(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { text: 'Check', dueAt: DUE }).ask;
    leadKept(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { askId: promise.id });
    expect(refused(() => leadKept(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { askId: promise.id }))).toMatchObject({ status: 409, message: `a${promise.id} is already cleared.` });
  });
});

describe('leadIntent', () => {
  const INTENT = '# InGame\n\n## Goal\nShip the game to the store.\n\n## Phase\nClosed beta with friends.\n';

  it('stores the record with its time, the brief reads its goal and phase, and the line holds the whole text', () => {
    const { ctx, project, events } = setup();
    const res = leadIntent(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { intent: INTENT });
    expect(res.text).toBe(`Intent record replaced (${INTENT.length} characters).`);
    const stored = resolveProject(ctx, project.slug);
    expect(stored.intent).toBe(INTENT);
    expect(stored.intentUpdatedAt).not.toBeNull();
    expect(readLeadBrief(ctx, project.slug, 1, new Date(ctx.now())).intent).toMatchObject({ goal: 'Ship the game to the store.', phase: 'Closed beta with friends.', updatedAt: stored.intentUpdatedAt });
    expect(events()).toEqual([{ kind: 'intent', node_id: null, ask_id: null, instructions: LEAD_INSTRUCTIONS_VERSION, lead: 'Progresser', text: INTENT, aiden_words: null }]);
  });

  it('refuses a record with no line under Phase as a 400, and writes nothing', () => {
    const { ctx, project, refused } = setup();
    expect(refused(() => leadIntent(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { intent: '## Goal\nShip it.\n\n## Phase\n' }))).toMatchObject({
      status: 400,
      message: 'The intent record needs a line under a Goal heading and a line under a Phase heading.',
    });
    expect(resolveProject(ctx, project.slug).intent).toBe('');
  });

  it('reads the goal and phase of a record with CRLF line endings, and stores it as sent', () => {
    const { ctx, project } = setup();
    const crlf = INTENT.replace(/\n/g, '\r\n');
    leadIntent(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { intent: crlf });
    expect(resolveProject(ctx, project.slug).intent).toBe(crlf);
    expect(readLeadBrief(ctx, project.slug, 1, new Date(ctx.now())).intent).toMatchObject({ goal: 'Ship the game to the store.', phase: 'Closed beta with friends.' });
  });

  it('takes a record of exactly 8,000 characters through the route, and answers one of 8,001 with a 400', async () => {
    const { ctx, app, project, leadEvents } = setup();
    const post = (intent: string) =>
      app.inject({ method: 'POST', url: `/api/lead/${project.slug}/intent`, headers: BEARER, payload: { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, intent } });
    const exact = INTENT + 'x'.repeat(8_000 - INTENT.length);
    expect(exact).toHaveLength(8_000);
    const ok = await post(exact);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().text).toBe('Intent record replaced (8000 characters).');
    expect(resolveProject(ctx, project.slug).intent).toBe(exact);
    const over = await post(`${exact}x`);
    expect(over.statusCode).toBe(400);
    expect(resolveProject(ctx, project.slug).intent).toBe(exact);
    expect(leadEvents()).toBe(1);
  });
});

describe('every command (Review Focus 1)', () => {
  type S = ReturnType<typeof setup>;
  const bodies = (s: S): [string, Record<string, unknown>][] => [
    ['answer', { askId: s.question.id, aidenWords: 'Yes.' }],
    ['park', { stepId: s.proposed.id }],
    ['drop', { stepId: s.proposed.id, reason: 'Moot' }],
    ['promise', { text: 'Send the draft', dueAt: DUE }],
    ['kept', { askId: s.question.id }],
    ['intent', { intent: '## Goal\nShip.\n\n## Phase\nBeta.' }],
  ];
  const post = (s: S, command: string, payload: Record<string, unknown>, headers: Record<string, string> = BEARER) =>
    s.app.inject({ method: 'POST', url: `/api/lead/${s.project.slug}/${command}`, headers, payload });

  /** Each command answers `status` with `error` (when given), and writes nothing. */
  async function expectRefused(s: S, extra: Record<string, unknown>, status: number, error?: string, headers?: Record<string, string>) {
    for (const [command, body] of bodies(s)) {
      const mark = maxEventId(s.ctx);
      const count = s.leadEvents();
      const res = await post(s, command, { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, ...body, ...extra }, headers);
      expect(res.statusCode, command).toBe(status);
      if (error !== undefined) expect(res.json().error, command).toBe(error);
      expect(maxEventId(s.ctx), command).toBe(mark);
      expect(s.leadEvents(), command).toBe(count);
    }
  }

  it('is refused on a project with no lead, and under another name', async () => {
    const s = setup();
    await expectRefused(s, { as: 'Rich' }, 409, noLeadNamed('Rich'));
    setProjectLead(s.ctx, 'window', s.project.slug, null);
    await expectRefused(s, {}, 409, noLeadNamed('Progresser'));
  });

  it('is refused with instructions below the current version', async () => {
    await expectRefused(setup(), { instructions: 0 }, 409, outOfDate(0, 'ingame', 'Progresser'));
  });

  it('is refused on an archived project', async () => {
    const s = setup();
    changeProject(s.ctx, 'test', s.project.slug, { status: 'archived' });
    await expectRefused(s, {}, 409, ARCHIVED);
  });

  it('is refused without the bearer token', async () => {
    await expectRefused(setup(), {}, 401, undefined, {});
  });

  it('takes a strict body', async () => {
    const s = setup();
    await expectRefused(s, { extra: true }, 400);
    expect((await post(s, 'promise', { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, text: 'x'.repeat(501), dueAt: DUE })).statusCode).toBe(400);
    expect((await post(s, 'promise', { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, text: 'x', dueAt: 'tomorrow' })).statusCode).toBe(400);
    expect((await post(s, 'intent', { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, intent: `## Goal\nShip.\n\n## Phase\nBeta.\n${'x'.repeat(8_001)}` })).statusCode).toBe(400);
    expect((await post(s, 'answer', { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, askId: s.question.id, aidenWords: 'x'.repeat(2_001) })).statusCode).toBe(400);
    expect((await post(s, 'drop', { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, stepId: s.proposed.id })).statusCode).toBe(400);
    expect(s.leadEvents()).toBe(0);
  });
});

describe('the routes', () => {
  it('answer and park answer { text }', async () => {
    const s = setup();
    const post = (command: string, payload: Record<string, unknown>) =>
      s.app.inject({ method: 'POST', url: `/api/lead/${s.project.slug}/${command}`, headers: BEARER, payload: { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, ...payload } });
    const answered = await post('answer', { askId: s.question.id, aidenWords: 'Use the release keystore.' });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().text).toBe(`Answered a${s.question.id} with Aiden's words.`);
    clearAsk(s.ctx, 'window', s.review.id);
    const parked = await post('park', { stepId: s.proposed.id });
    expect(parked.statusCode).toBe(200);
    expect(parked.json().text).toMatch(/^Parked #\d+ Dark mode\. Decision d\d+\.$/);
    const refusedPark = await post('park', { stepId: s.asked.id });
    expect(refusedPark.statusCode).toBe(409);
    expect(refusedPark.json().error).toBe(parkNeeds('asked'));
  });

  it('decide and undo answer { text } behind the token, and take a strict body', async () => {
    const s = setup();
    const post = (command: string, payload: Record<string, unknown>, headers: Record<string, string> = BEARER) =>
      s.app.inject({ method: 'POST', url: `/api/lead/${s.project.slug}/${command}`, headers, payload: { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, ...payload } });
    const body = { askId: s.question.id, answer: 'The release keystore.', reason: 'The repo signs with it.' };
    expect((await post('decide', body, {})).statusCode).toBe(401);
    expect((await post('decide', { ...body, extra: 1 })).statusCode).toBe(400);
    expect((await post('decide', { ...body, reason: '  ' })).statusCode).toBe(400);
    expect(s.leadEvents()).toBe(0);
    const decided = await post('decide', body);
    expect(decided.statusCode).toBe(200);
    expect(decided.json().text).toBe(`Decided a${s.question.id}: decision d1. Its session reads your answer on its next prompt.`);
    expect((await post('undo', { eventId: 1, aidenWords: 'undo d1' }, {})).statusCode).toBe(401);
    const undone = await post('undo', { eventId: 1, aidenWords: 'undo d1' });
    expect(undone.statusCode).toBe(200);
    expect(undone.json().text).toMatch(/^Undid d1: the question is Aiden's again as a\d+\./);
    expect((await post('undo', { eventId: 1, aidenWords: 'undo d1' })).statusCode).toBe(409);
  });
});

const V = LEAD_INSTRUCTIONS_VERSION;
const prompt = { event: 'prompt' as const, cwd: 'C:/personal/InGame' };

describe('leadAnswer with says', () => {
  it('stores the answer his words accepted with his words beside it, and logs his words alone', () => {
    const { ctx, project, question, events, askRow } = setup();
    leadAnswer(ctx, project.slug, 'Progresser', V, { askId: question.id, aidenWords: 'yes', says: 'Use the release keystore' });
    expect(askRow(question.id)).toMatchObject({ answer: 'Use the release keystore (Aiden said: "yes")', answered_via: 'lead' });
    expect(events()[0]).toMatchObject({ kind: 'answer', aiden_words: 'yes', text: '' });
  });
});

describe('leadDecide', () => {
  it('answers the question on his judgment, logs a decide line with the reason, and the asker reads who decided', () => {
    const { ctx, project, question, events, askRow } = setup();
    const res = leadDecide(ctx, project.slug, 'progresser', V, { askId: question.id, answer: 'Use the release keystore', reason: 'The repo signs with it' });
    expect(res.decision).toBe(1);
    expect(res.text).toBe(`Decided a${question.id}: decision d1. Its session reads your answer on its next prompt.`);
    expect(askRow(question.id)).toMatchObject({ answer: 'Use the release keystore', answered_via: 'lead_decided', cleared_by: 'lead:Progresser' });
    expect(events()).toEqual([{ kind: 'decide', node_id: question.nodeId, ask_id: question.id, instructions: V, lead: 'Progresser', text: 'The repo signs with it', aiden_words: null }]);
    expect(handleHookEvent(ctx, 's1', prompt).context).toContain(
      `Decided by this project's lead, not Aiden: a${question.id} "Use the release keystore" (yours: act on it; Aiden may still undo it)`,
    );
  });

  it("keeps Aiden's words when he told the lead to decide", () => {
    const { ctx, project, question, events } = setup();
    leadDecide(ctx, project.slug, 'Progresser', V, { askId: question.id, answer: 'A', reason: 'B', aidenWords: 'you decide' });
    expect(events()[0]).toMatchObject({ kind: 'decide', aiden_words: 'you decide' });
  });

  it('refuses a permission, a review, a promise, an ask of another project and a cleared ask, writing nothing', () => {
    const { ctx, project, review, permission, asked, question, refused } = setup();
    const decide = (askId: number) => () => leadDecide(ctx, project.slug, 'Progresser', V, { askId, answer: 'Yes', reason: 'Why' });
    expect(refused(decide(review.id))).toMatchObject({ status: 409, message: DECIDE_QUESTION_ONLY });
    expect(refused(decide(permission.id))).toMatchObject({ status: 409, message: DECIDE_QUESTION_ONLY });
    const promise = raiseAsk(ctx, 'lead', { nodeId: asked.id, kind: 'review', text: 'Send the draft', owner: 'lead', dueAt: DUE });
    expect(refused(decide(promise.id)).message).toBe(`a${promise.id} is the lead's own promise. Clear it with kept.`);
    const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
    const [step] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Theirs' }] });
    const foreign = raiseAsk(ctx, 'test', { nodeId: step.id, kind: 'question', text: 'Which?' });
    expect(refused(decide(foreign.id)).message).toBe(`a${foreign.id} is not in this project.`);
    // Answered between the lead's read and his command (Review Focus 1): refused with the stored answer.
    clearAsk(ctx, 'window', question.id, 'Mine.');
    expect(refused(decide(question.id))).toMatchObject({ status: 409, message: 'Already answered: "Mine.".' });
    expect(requireAsk(ctx, question.id).answer).toBe('Mine.');
  });
});

describe('leadPark on his own judgment', () => {
  it("parks a step of Aiden's with a reason when nobody is working on it, and says its decision number", () => {
    const { ctx, project, asked, events, question } = setup();
    clearAsk(ctx, 'window', question.id, 'Done.');
    const res = leadPark(ctx, project.slug, 'Progresser', V, { stepId: asked.id, reason: 'Waiting on the store' });
    expect(res.decision).toBe(1);
    expect(res.text).toBe(`Parked #${asked.id} Play app signing. Decision d1.`);
    expect(requireNode(ctx, asked.id)).toMatchObject({ status: 'parked', parkedReason: 'Waiting on the store' });
    expect(events()[0]).toMatchObject({ kind: 'park', aiden_words: null });
  });

  it('has no decision number when Aiden gave his words', () => {
    const { ctx, project, asked } = setup();
    const res = leadPark(ctx, project.slug, 'Progresser', V, { stepId: asked.id, aidenWords: 'Park it.' });
    expect(res.decision).toBeNull();
    expect(res.text).toBe(`Parked #${asked.id} Play app signing.`);
  });

  it("refuses a step of Aiden's while a driver works on it, and while a helper session has it as its focus", () => {
    const { ctx, project, asked, other, refused } = setup();
    claimStep(ctx, 'test', 's1', asked.id);
    const park = (stepId: number) => () => leadPark(ctx, project.slug, 'Progresser', V, { stepId, reason: 'Later' });
    expect(refused(park(asked.id)).message).toBe(
      `#${asked.id} Play app signing has a session working on it, and it is Aiden's (origin asked). Parking it needs his words: pass them with --aiden.`,
    );
    // A helper: a live session whose focus is the step, though no driver is named on it (Review Focus 4).
    handleHookEvent(ctx, 's2', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
    ctx.db.prepare('UPDATE sessions SET focus_node_id = ? WHERE id = ?').run(other.id, 's2');
    expect(refused(park(other.id)).message).toContain('has a session working on it');
    expect(requireNode(ctx, other.id).status).not.toBe('parked');
    handleHookEvent(ctx, 's2', { event: 'end' });
    expect(park(other.id)().text).toMatch(/^Parked #\d+ Privacy page\. Decision d\d+\.$/);
  });
});

describe('leadUndo', () => {
  it('puts a decided question back as a new ask of Aiden, once', () => {
    const { ctx, project, question, events, refused } = setup();
    leadDecide(ctx, project.slug, 'Progresser', V, { askId: question.id, answer: 'Use the release keystore', reason: 'Repo does' });
    const res = leadUndo(ctx, project.slug, 'Progresser', V, { eventId: 1, aidenWords: 'undo d1' });
    const open = ctx.db.prepare('SELECT id, text, kind, owner FROM asks WHERE node_id = ? AND cleared_at IS NULL').all(question.nodeId) as { id: number; text: string; kind: string; owner: string }[];
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ text: 'Which keystore?', kind: 'question', owner: 'aiden' });
    expect(res.text).toBe(`Undid d1: the question is Aiden's again as a${open[0].id}. Your answer was: "Use the release keystore".`);
    expect(events().at(-1)).toMatchObject({ kind: 'undo', text: 'd1', aiden_words: 'undo d1', ask_id: question.id, node_id: question.nodeId });
    expect(refused(() => leadUndo(ctx, project.slug, 'Progresser', V, { eventId: 1, aidenWords: 'again' }))).toMatchObject({ status: 409, message: 'd1 is already undone.' });
  });

  it('puts a parked step back in the backlog, and refuses once it is no longer parked', () => {
    const t = setup();
    const { ctx, project, proposed, refused } = t;
    settle(t);
    leadPark(ctx, project.slug, 'Progresser', V, { stepId: proposed.id });
    expect(leadUndo(ctx, project.slug, 'Progresser', V, { eventId: 1, aidenWords: 'undo d1' }).text).toBe(`Undid d1: #${proposed.id} Dark mode is back in the backlog.`);
    expect(requireNode(ctx, proposed.id).status).toBe('todo');
    leadPark(ctx, project.slug, 'Progresser', V, { stepId: proposed.id });
    updateNode(ctx, 'test', proposed.id, { status: 'todo' });
    const second = ctx.db.prepare("SELECT MAX(id) FROM lead_events WHERE kind = 'park'").pluck().get() as number;
    expect(refused(() => leadUndo(ctx, project.slug, 'Progresser', V, { eventId: second, aidenWords: 'x' }))).toMatchObject({
      status: 409,
      message: `#${proposed.id} is not parked any more: nothing to undo.`,
    });
  });

  it('puts a dropped step back in the backlog, and refuses once it is no longer dropped', () => {
    const t = setup();
    const { ctx, project, proposed, other, refused } = t;
    settle(t);
    leadDrop(ctx, project.slug, 'Progresser', V, { stepId: proposed.id, reason: 'Not wanted' });
    expect(leadUndo(ctx, project.slug, 'Progresser', V, { eventId: 1, aidenWords: 'undo d1' }).text).toBe(`Undid d1: #${proposed.id} Dark mode is back in the backlog.`);
    expect(requireNode(ctx, proposed.id).status).toBe('todo');
    leadDrop(ctx, project.slug, 'Progresser', V, { stepId: other.id, reason: 'Moot', aidenWords: 'Drop.' });
    updateNode(ctx, 'test', other.id, { status: 'todo' });
    const second = ctx.db.prepare("SELECT MAX(id) FROM lead_events WHERE kind = 'drop'").pluck().get() as number;
    expect(refused(() => leadUndo(ctx, project.slug, 'Progresser', V, { eventId: second, aidenWords: 'x' })).message).toBe(`#${other.id} is not dropped any more: nothing to undo.`);
  });

  it("refuses an unknown number, an answer's line, and another project's decision, with 404", () => {
    const { ctx, project, question, refused } = setup();
    expect(refused(() => leadUndo(ctx, project.slug, 'Progresser', V, { eventId: 99, aidenWords: 'x' }))).toMatchObject({ status: 404, message: 'd99 not found.' });
    leadAnswer(ctx, project.slug, 'Progresser', V, { askId: question.id, aidenWords: 'Yes.' });
    expect(refused(() => leadUndo(ctx, project.slug, 'Progresser', V, { eventId: 1, aidenWords: 'x' })).status).toBe(404);
    const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
    addBinding(ctx, 'test', elsewhere.slug, 'C:/personal/Elsewhere');
    setProjectLead(ctx, 'window', elsewhere.slug, 'Rich');
    const [step] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Theirs', origin: 'proposed' }] });
    leadPark(ctx, elsewhere.slug, 'Rich', V, { stepId: step.id });
    const theirs = ctx.db.prepare("SELECT id FROM lead_events WHERE kind = 'park'").pluck().get() as number;
    expect(refused(() => leadUndo(ctx, project.slug, 'Progresser', V, { eventId: theirs, aidenWords: 'x' })).status).toBe(404);
  });

  it('is refused for an old rules version, writing nothing', () => {
    const t = setup();
    const { ctx, project, proposed, refused } = t;
    settle(t);
    leadPark(ctx, project.slug, 'Progresser', V, { stepId: proposed.id });
    expect(refused(() => leadUndo(ctx, project.slug, 'Progresser', V - 1, { eventId: 1, aidenWords: 'x' })).status).toBe(409);
    expect(requireNode(ctx, proposed.id).status).toBe('parked');
  });
});

type T = ReturnType<typeof setup>;
/** Points session s1's focus at a step, as a helper working below the one the lead means to park. */
const focusOn = (t: T, nodeId: number): void => {
  t.ctx.db.prepare("UPDATE sessions SET focus_node_id = ? WHERE id = 's1'").run(nodeId);
};

describe('the fix round after review', () => {
  const decideQ = (t: T) => leadDecide(t.ctx, t.project.slug, 'Progresser', V, { askId: t.question.id, answer: 'Inter', reason: 'In use' });
  const undo = (t: T, eventId: number) => () => leadUndo(t.ctx, t.project.slug, 'Progresser', V, { eventId, aidenWords: 'undo' });

  it('A.1: undo of a decide refuses when the question step has since been parked or dropped', () => {
    const t = setup();
    decideQ(t);
    updateNode(t.ctx, 'window', t.asked.id, { status: 'parked', parkedReason: 'later' });
    expect(t.refused(undo(t, 1))).toMatchObject({ status: 409, message: `#${t.asked.id} is parked now, so its question cannot be asked again. Tell Aiden.` });
    updateNode(t.ctx, 'window', t.asked.id, { status: 'dropped' });
    expect(t.refused(undo(t, 1)).message).toBe(`#${t.asked.id} is dropped now, so its question cannot be asked again. Tell Aiden.`);
  });

  it('A.2: undo of a decide reopens a question step it finished, and refuses a finished step whose outcome moved on', () => {
    const t = setup();
    const [q] = addNodes(t.ctx, 'test', { parentId: t.project.rootNodeId, nodes: [{ title: 'Pick a font', kind: 'question' }] });
    const ask = raiseAsk(t.ctx, 'session:s1', { nodeId: q.id, kind: 'question', text: 'Which font?', sessionId: 's1' });
    const first = leadDecide(t.ctx, t.project.slug, 'Progresser', V, { askId: ask.id, answer: 'Inter', reason: 'In use' });
    expect(requireNode(t.ctx, q.id)).toMatchObject({ status: 'done', outcome: 'Inter' });
    leadUndo(t.ctx, t.project.slug, 'Progresser', V, { eventId: first.decision, aidenWords: 'undo' });
    expect(requireNode(t.ctx, q.id)).toMatchObject({ status: 'todo', outcome: '' });
    expect(t.ctx.db.prepare('SELECT COUNT(*) FROM asks WHERE node_id = ? AND cleared_at IS NULL').pluck().get(q.id)).toBe(1);
    // A step finished on someone else's outcome stays finished.
    const again = t.ctx.db.prepare('SELECT id FROM asks WHERE node_id = ? AND cleared_at IS NULL').pluck().get(q.id) as number;
    const second = leadDecide(t.ctx, t.project.slug, 'Progresser', V, { askId: again, answer: 'Roboto', reason: 'Why' });
    updateNode(t.ctx, 'window', q.id, { outcome: 'Something else' });
    expect(t.refused(undo(t, second.decision))).toMatchObject({ status: 409, message: `#${q.id} is finished, so its question cannot be asked again. Tell Aiden.` });
    // A done step that is not a question step is refused too.
    const decided = decideQ(t);
    updateNode(t.ctx, 'window', t.asked.id, { status: 'done' });
    expect(t.refused(undo(t, decided.decision)).message).toBe(`#${t.asked.id} is finished, so its question cannot be asked again. Tell Aiden.`);
  });

  it('A.3: undo withdraws an answer its session has not read yet', () => {
    const t = setup();
    const d = decideQ(t);
    leadUndo(t.ctx, t.project.slug, 'Progresser', V, { eventId: d.decision, aidenWords: 'undo' });
    expect(handleHookEvent(t.ctx, 's1', prompt).context ?? '').not.toContain('Decided by');
  });

  it('B.1: a park or drop on his own judgment is refused while a session works on the step or any step under it', () => {
    const t = setup();
    clearAsk(t.ctx, 'window', t.review.id);
    const [child] = addNodes(t.ctx, 'test', { parentId: t.proposed.id, nodes: [{ title: 'Child' }] });
    focusOn(t, child.id);
    const sentence = `#${t.proposed.id} Dark mode has a session working on it. Wait for it to end, or pass Aiden's words with --aiden.`;
    expect(t.refused(() => leadPark(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.proposed.id, reason: 'x' })).message).toBe(sentence);
    expect(t.refused(() => leadDrop(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.proposed.id, reason: 'x' })).message).toBe(sentence);
    // His own words lift it, as before.
    expect(leadPark(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.proposed.id, aidenWords: 'Park it.' }).decision).toBeNull();
  });

  it("B.1: a step under a step of Aiden's counts for the check too", () => {
    const t = setup();
    const [child] = addNodes(t.ctx, 'test', { parentId: t.other.id, nodes: [{ title: 'Child' }] });
    focusOn(t, child.id);
    expect(t.refused(() => leadPark(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.other.id, reason: 'x' })).message).toBe(
      `#${t.other.id} Privacy page has a session working on it, and it is Aiden's (origin asked). Parking it needs his words: pass them with --aiden.`,
    );
  });

  it('B.2: a park or drop on his own judgment is refused while a question waits on Aiden on the step or under it', () => {
    const t = setup();
    const [child] = addNodes(t.ctx, 'test', { parentId: t.other.id, nodes: [{ title: 'Child' }] });
    const q = raiseAsk(t.ctx, 'session:s1', { nodeId: child.id, kind: 'question', text: 'Which?' });
    expect(t.refused(() => leadPark(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.other.id, reason: 'x' })).message).toBe(
      `#${t.other.id} Privacy page has an ask waiting on Aiden (a${q.id}). Bring it to him first, or pass his words with --aiden.`,
    );
    const p = t.proposed;
    expect(t.refused(() => leadDrop(t.ctx, t.project.slug, 'Progresser', V, { stepId: p.id, reason: 'x' })).message).toBe(
      `#${p.id} Dark mode has an ask waiting on Aiden (a${t.review.id}). Bring it to him first, or pass his words with --aiden.`,
    );
    expect(leadDrop(t.ctx, t.project.slug, 'Progresser', V, { stepId: p.id, reason: 'x', aidenWords: 'Drop it.' }).decision).toBeNull();
  });

  it('C: undo of a park refuses when the step was parked again since, and says when it stays under a parked step', () => {
    const t = setup();
    clearAsk(t.ctx, 'window', t.review.id);
    leadPark(t.ctx, t.project.slug, 'Progresser', V, { stepId: t.proposed.id, reason: 'Later' });
    updateNode(t.ctx, 'window', t.proposed.id, { status: 'todo' });
    updateNode(t.ctx, 'window', t.proposed.id, { status: 'parked', parkedReason: 'Aiden parked it' });
    expect(t.refused(undo(t, 1))).toMatchObject({ status: 409, message: `#${t.proposed.id} was parked again since d1: that park is not yours to undo.` });
    const u = setup();
    clearAsk(u.ctx, 'window', u.review.id);
    const [kid] = addNodes(u.ctx, 'test', { parentId: u.proposed.id, nodes: [{ title: 'Kid' }] });
    leadPark(u.ctx, u.project.slug, 'Progresser', V, { stepId: kid.id, reason: 'Kid later' });
    updateNode(u.ctx, 'window', u.proposed.id, { status: 'parked', parkedReason: 'Parent later' });
    expect(leadUndo(u.ctx, u.project.slug, 'Progresser', V, { eventId: 1, aidenWords: 'undo' }).text).toBe(
      `Undid d1: #${kid.id} Kid is unparked, but it stays set aside under parked #${u.proposed.id}.`,
    );
  });

  it('E: decide on an ask no session holds says no session is waiting', () => {
    const t = setup();
    const ask = raiseAsk(t.ctx, 'test', { nodeId: t.other.id, kind: 'question', text: 'Which colour?' });
    expect(leadDecide(t.ctx, t.project.slug, 'Progresser', V, { askId: ask.id, answer: 'Blue', reason: 'Brand' }).text).toBe(
      `Decided a${ask.id}: decision d1. No session is waiting on it.`,
    );
  });
});
