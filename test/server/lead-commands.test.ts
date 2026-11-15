import { describe, expect, it } from 'vitest';
import { deriveBoard } from '../../src/core/board';
import { buildApp } from '../../src/server/app';
import { stamp } from '../../src/server/digest';
import { ARCHIVED, noLeadNamed, outOfDate, readLeadBrief } from '../../src/server/lead';
import { leadAnswer, leadDrop, leadIntent, leadKept, leadPark, leadPromise } from '../../src/server/lead-commands';
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

describe('leadAnswer', () => {
  it("clears the question with Aiden's words, logs one line, hands it to the asker and cites it in the brief", () => {
    const { ctx, project, question, events, askRow } = setup();
    const res = leadAnswer(ctx, project.slug, 'progresser', 1, { askId: question.id, aidenWords: 'Use the release keystore.' });
    expect(res.text).toBe(`Answered a${question.id} with Aiden's words.`);
    expect(askRow(question.id)).toMatchObject({ answer: 'Use the release keystore.', cleared_by: 'lead:Progresser', answered_via: 'lead' });
    expect(events()).toEqual([
      { kind: 'answer', node_id: question.nodeId, ask_id: question.id, instructions: 1, lead: 'Progresser', text: '', aiden_words: 'Use the release keystore.' },
    ]);
    expect(undeliveredAnswers(ctx, 's1').map((a) => a.id)).toEqual([question.id]);
    const said = readLeadBrief(ctx, project.slug, 1, new Date(ctx.now())).saidInAidensName;
    expect(said[0]).toMatchObject({ kind: 'answer', ref: `a${question.id}`, words: 'Use the release keystore.' });
  });

  it('refuses an ask Aiden answered first, and his answer stands (Review Focus 2)', () => {
    const { ctx, project, question, askRow, refused } = setup();
    clearAsk(ctx, 'window', question.id, 'Mine.');
    const err = refused(() => leadAnswer(ctx, project.slug, 'Progresser', 1, { askId: question.id, aidenWords: 'Theirs.' }));
    expect(err).toMatchObject({ status: 409, message: 'Already answered: "Mine.".' });
    expect(askRow(question.id)).toMatchObject({ answer: 'Mine.', answered_via: null, cleared_by: 'window' });
  });

  it('refuses an ask cleared with no answer in its own words', () => {
    const { ctx, project, question, refused } = setup();
    clearAsk(ctx, 'window', question.id);
    expect(refused(() => leadAnswer(ctx, project.slug, 'Progresser', 1, { askId: question.id, aidenWords: 'Yes.' })).message).toBe(
      `a${question.id} is already cleared, with no answer.`,
    );
  });

  it("refuses a review, a permission, the lead's own promise and an ask of another project, writing nothing", () => {
    const { ctx, project, review, permission, asked, refused } = setup();
    const answer = (askId: number) => () => leadAnswer(ctx, project.slug, 'Progresser', 1, { askId, aidenWords: 'Yes.' });
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
  it('parks a proposed step with no words, and clears its open asks as a park from the window does', () => {
    const { ctx, project, proposed, review, events, askRow } = setup();
    const res = leadPark(ctx, project.slug, 'Progresser', 1, { stepId: proposed.id });
    expect(res.text).toBe(`Parked #${proposed.id} Dark mode.`);
    expect(requireNode(ctx, proposed.id)).toMatchObject({ status: 'parked', parkedReason: 'Parked by Progresser.' });
    expect(askRow(review.id)).toMatchObject({ cleared_by: 'lead:Progresser', answer: '' });
    expect(askRow(review.id).cleared_at).not.toBeNull();
    expect(events()).toEqual([{ kind: 'park', node_id: proposed.id, ask_id: null, instructions: 1, lead: 'Progresser', text: 'Parked by Progresser.', aiden_words: null }]);
  });

  it("refuses a step of Aiden's without his words, and parks it with them, his words the reason when none is given", () => {
    const { ctx, project, asked, mine, events, refused } = setup();
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', 1, { stepId: asked.id }))).toMatchObject({ status: 409, message: aidens('asked') });
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', 1, { stepId: mine.id }))).toMatchObject({ status: 409, message: aidens('me') });
    expect(requireNode(ctx, asked.id).status).toBe('active');
    leadPark(ctx, project.slug, 'Progresser', 1, { stepId: asked.id, aidenWords: 'Park signing till the store answers.' });
    expect(requireNode(ctx, asked.id)).toMatchObject({ status: 'parked', parkedReason: 'Park signing till the store answers.' });
    leadPark(ctx, project.slug, 'Progresser', 1, { stepId: mine.id, reason: 'Later', aidenWords: 'Not now.' });
    expect(requireNode(ctx, mine.id).parkedReason).toBe('Later');
    expect(events().map((e) => [e.kind, e.node_id, e.text, e.aiden_words])).toEqual([
      ['park', asked.id, 'Park signing till the store answers.', 'Park signing till the store answers.'],
      ['park', mine.id, 'Later', 'Not now.'],
    ]);
    const said = readLeadBrief(ctx, project.slug, 1, new Date(ctx.now())).saidInAidensName;
    expect(said[0]).toMatchObject({ kind: 'park', ref: `#${mine.id}`, words: 'Not now.' });
  });

  it('takes a queued step out of the queue', () => {
    const { ctx, project, proposed, other } = setup();
    setQueue(ctx, 'test', project.slug, [proposed.id, other.id], 'unowned');
    const queued = () => resolveProject(ctx, project.slug).queue.map((e) => e.nodeId);
    expect(queued()).toEqual([proposed.id, other.id]);
    leadPark(ctx, project.slug, 'Progresser', 1, { stepId: proposed.id });
    expect(queued()).toEqual([other.id]);
  });

  it('refuses a parked step, a done one and a step of another project', () => {
    const { ctx, project, proposed, other, refused } = setup();
    leadPark(ctx, project.slug, 'Progresser', 1, { stepId: proposed.id });
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', 1, { stepId: proposed.id }))).toMatchObject({ status: 409, message: `#${proposed.id} is already parked.` });
    updateNode(ctx, 'test', other.id, { status: 'done' });
    // A done step keeps its review ask open; the refused park must leave it so, which proves its write rolled back.
    const look = raiseAsk(ctx, 'session:s1', { nodeId: other.id, kind: 'review', text: 'Look at the page' });
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', 1, { stepId: other.id, aidenWords: 'Park it.' })).status).toBe(400);
    expect(requireAsk(ctx, look.id).clearedAt).toBeNull();
    expect(requireNode(ctx, other.id).status).toBe('done');
    const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
    const [step] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Theirs', origin: 'proposed' }] });
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', 1, { stepId: step.id }))).toMatchObject({ status: 409, message: `#${step.id} is not in this project.` });
    // Another project's root is another project's step: only this project's own root is "the project itself".
    const theirs = { status: 409, message: `#${elsewhere.rootNodeId} is not in this project.` };
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', 1, { stepId: elsewhere.rootNodeId }))).toMatchObject(theirs);
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: elsewhere.rootNodeId, reason: 'No.' }))).toMatchObject(theirs);
  });
});

describe('leadDrop', () => {
  it("needs Aiden's words for his step; with them it drops it, clears its asks, and logs the reason", () => {
    const { ctx, project, asked, question, events, askRow, refused } = setup();
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: asked.id, reason: 'Moot' }))).toMatchObject({ status: 409, message: aidens('asked') });
    expect(requireNode(ctx, asked.id).status).toBe('active');
    const res = leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: asked.id, reason: 'The store signs it now', aidenWords: 'Drop it.' });
    expect(res.text).toBe(`Dropped #${asked.id} Play app signing.`);
    expect(requireNode(ctx, asked.id).status).toBe('dropped');
    expect(askRow(question.id)).toMatchObject({ cleared_by: 'lead:Progresser', answer: '' });
    expect(askRow(question.id).cleared_at).not.toBeNull();
    expect(events()).toEqual([{ kind: 'drop', node_id: asked.id, ask_id: null, instructions: 1, lead: 'Progresser', text: 'The store signs it now', aiden_words: 'Drop it.' }]);
  });

  it('drops a proposed step with no words, and refuses one already done or dropped', () => {
    const { ctx, project, proposed, other, refused } = setup();
    leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: proposed.id, reason: 'Not wanted' });
    expect(requireNode(ctx, proposed.id).status).toBe('dropped');
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: proposed.id, reason: 'Again' }))).toMatchObject({ status: 409, message: `#${proposed.id} is dropped.` });
    updateNode(ctx, 'test', other.id, { status: 'done' });
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: other.id, reason: 'x', aidenWords: 'Drop.' }))).toMatchObject({ status: 409, message: `#${other.id} is done.` });
  });

  it('refuses a step a live session drives, and drops it once that session has ended', () => {
    const { ctx, project, proposed, refused } = setup();
    claimStep(ctx, 'test', 's1', proposed.id);
    expect(requireNode(ctx, proposed.id).driverSessionId).toBe('s1');
    const drop = () => leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: proposed.id, reason: 'Not wanted' });
    expect(refused(drop)).toMatchObject({ status: 409, message: `#${proposed.id} Dark mode has a session working on it. Park it, or wait for the session to end.` });
    expect(requireNode(ctx, proposed.id).status).not.toBe('dropped');
    handleHookEvent(ctx, 's1', { event: 'end' });
    expect(drop().text).toBe(`Dropped #${proposed.id} Dark mode.`);
  });

  it('checks a live driver after the words for a step of Aiden\'s, and before the open steps under it', () => {
    const { ctx, project, other, refused } = setup();
    addNodes(ctx, 'test', { parentId: other.id, nodes: [{ title: 'Write the page' }] });
    claimStep(ctx, 'test', 's1', other.id);
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: other.id, reason: 'Moot' })).message).toBe(aidens('asked'));
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: other.id, reason: 'Moot', aidenWords: 'Drop it.' })).message).toBe(
      `#${other.id} Privacy page has a session working on it. Park it, or wait for the session to end.`,
    );
  });

  it('refuses a step with open steps under it, and drops it once they are done', () => {
    const { ctx, project, other, refused } = setup();
    const [child] = addNodes(ctx, 'test', { parentId: other.id, nodes: [{ title: 'Write the page' }] });
    const drop = () => leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: other.id, reason: 'Moot', aidenWords: 'Drop it.' });
    expect(refused(drop)).toMatchObject({ status: 409, message: `#${other.id} Privacy page has open steps under it. Drop or park those first.` });
    updateNode(ctx, 'test', child.id, { status: 'done' });
    expect(drop().text).toBe(`Dropped #${other.id} Privacy page.`);
  });
});

describe('the root step', () => {
  it('is refused by park and by drop, before any other check, and nothing is written', () => {
    const { ctx, project, refused } = setup();
    expect(refused(() => leadPark(ctx, project.slug, 'Progresser', 1, { stepId: project.rootNodeId }))).toMatchObject({ status: 409, message: 'The project itself cannot be parked.' });
    expect(refused(() => leadDrop(ctx, project.slug, 'Progresser', 1, { stepId: project.rootNodeId, reason: 'x', aidenWords: 'Drop it.' }))).toMatchObject({
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
    const res = leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'Send Aiden the draft', dueAt: DUE });
    expect(res.text).toMatch(new RegExp(`^Promised a${res.ask.id}, due \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\.$`));
    expect(askRow(res.ask.id)).toMatchObject({ owner: 'lead', kind: 'review', due_at: DUE, node_id: project.rootNodeId, session_id: null });
    expect(events()).toEqual([{ kind: 'promise', node_id: project.rootNodeId, ask_id: res.ask.id, instructions: 1, lead: 'Progresser', text: 'Send Aiden the draft', aiden_words: null }]);
    const brief = readLeadBrief(ctx, project.slug, 1, new Date(ctx.now()));
    expect(brief.forTheLead).toEqual([{ askId: res.ask.id, stepId: project.rootNodeId, stepTitle: 'InGame', text: 'Send Aiden the draft', dueAt: DUE, overdue: false }]);
    expect(brief.waitingOnAiden.map((a) => a.askId)).not.toContain(res.ask.id);
    expect(listProjectSummaries(ctx).find((p) => p.id === project.id)!.openAsks).toBe(before);
  });

  it('puts it on the step named, and the same promise twice is one ask and one line', () => {
    const { ctx, project, other, leadEvents } = setup();
    const first = leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'Check the page', dueAt: DUE, stepId: other.id });
    expect(first.ask.nodeId).toBe(other.id);
    const again = leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'Check the page', dueAt: DUE, stepId: other.id });
    expect(again.text).toBe(`Already promised: a${first.ask.id}, due ${stamp(DUE)}.`);
    expect(again.ask.id).toBe(first.ask.id);
    expect(leadEvents()).toBe(1);
  });

  it('answers a promise made again with a later due time with the time on record, which stays', () => {
    const { ctx, project, other, leadEvents, askRow } = setup();
    const first = leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'Check the page', dueAt: DUE, stepId: other.id });
    const again = leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'Check the page', dueAt: '2026-12-01T09:00:00.000Z', stepId: other.id });
    expect(again.text).toBe(`Already promised: a${first.ask.id}, due ${stamp(DUE)}.`);
    expect(askRow(first.ask.id).due_at).toBe(DUE);
    expect(leadEvents()).toBe(1);
  });

  it('says so when the open promise it joins has no due time', () => {
    const { ctx, project, other, leadEvents } = setup();
    const open = raiseAsk(ctx, 'lead', { nodeId: other.id, kind: 'review', text: 'Check the page', owner: 'lead' });
    const again = leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'Check the page', dueAt: DUE, stepId: other.id });
    expect(again.text).toBe(`Already promised: a${open.id}, with no due time.`);
    expect(leadEvents()).toBe(0);
  });

  it('refuses a due time that has passed, and a step of another project', () => {
    const { ctx, project, refused } = setup();
    expect(refused(() => leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'Late', dueAt: '2026-09-01T00:00:00.000Z' }))).toMatchObject({
      status: 409,
      message: 'The due time is in the past.',
    });
    const elsewhere = createProject(ctx, 'test', { name: 'Elsewhere' });
    const [step] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Theirs' }] });
    expect(refused(() => leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'x', dueAt: DUE, stepId: step.id }))).toMatchObject({
      status: 409,
      message: `#${step.id} is not in this project.`,
    });
  });
});

describe('leadKept', () => {
  it('clears a promise with no answer, so no session is owed one and its step shows none waiting', () => {
    const { ctx, project, other, events, askRow } = setup();
    const promise = leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'Check the page', dueAt: DUE, stepId: other.id }).ask;
    const res = leadKept(ctx, project.slug, 'Progresser', 1, { askId: promise.id, note: 'Checked, it reads well.' });
    expect(res.text).toBe(`Kept a${promise.id}.`);
    expect(askRow(promise.id)).toMatchObject({ answer: '', cleared_by: 'lead:Progresser', answered_via: null });
    expect(askRow(promise.id).cleared_at).not.toBeNull();
    expect(events().at(-1)).toEqual({ kind: 'kept', node_id: other.id, ask_id: promise.id, instructions: 1, lead: 'Progresser', text: 'Checked, it reads well.', aiden_words: null });
    expect(undeliveredAnswers(ctx, 's1')).toEqual([]);
    const board = deriveBoard(getProjectSnapshot(ctx, project.id), Date.parse(ctx.now()));
    expect(board.byId.get(other.id)!.marks).not.toContain('answer_waiting');
  });

  it("refuses an ask of Aiden's and one already cleared", () => {
    const { ctx, project, question, refused } = setup();
    expect(refused(() => leadKept(ctx, project.slug, 'Progresser', 1, { askId: question.id }))).toMatchObject({
      status: 409,
      message: `a${question.id} is Aiden's. The lead clears only its own promises.`,
    });
    const promise = leadPromise(ctx, project.slug, 'Progresser', 1, { text: 'Check', dueAt: DUE }).ask;
    leadKept(ctx, project.slug, 'Progresser', 1, { askId: promise.id });
    expect(refused(() => leadKept(ctx, project.slug, 'Progresser', 1, { askId: promise.id }))).toMatchObject({ status: 409, message: `a${promise.id} is already cleared.` });
  });
});

describe('leadIntent', () => {
  const INTENT = '# InGame\n\n## Goal\nShip the game to the store.\n\n## Phase\nClosed beta with friends.\n';

  it('stores the record with its time, the brief reads its goal and phase, and the line holds the whole text', () => {
    const { ctx, project, events } = setup();
    const res = leadIntent(ctx, project.slug, 'Progresser', 1, { intent: INTENT });
    expect(res.text).toBe(`Intent record replaced (${INTENT.length} characters).`);
    const stored = resolveProject(ctx, project.slug);
    expect(stored.intent).toBe(INTENT);
    expect(stored.intentUpdatedAt).not.toBeNull();
    expect(readLeadBrief(ctx, project.slug, 1, new Date(ctx.now())).intent).toMatchObject({ goal: 'Ship the game to the store.', phase: 'Closed beta with friends.', updatedAt: stored.intentUpdatedAt });
    expect(events()).toEqual([{ kind: 'intent', node_id: null, ask_id: null, instructions: 1, lead: 'Progresser', text: INTENT, aiden_words: null }]);
  });

  it('refuses a record with no line under Phase as a 400, and writes nothing', () => {
    const { ctx, project, refused } = setup();
    expect(refused(() => leadIntent(ctx, project.slug, 'Progresser', 1, { intent: '## Goal\nShip it.\n\n## Phase\n' }))).toMatchObject({
      status: 400,
      message: 'The intent record needs a line under a Goal heading and a line under a Phase heading.',
    });
    expect(resolveProject(ctx, project.slug).intent).toBe('');
  });

  it('reads the goal and phase of a record with CRLF line endings, and stores it as sent', () => {
    const { ctx, project } = setup();
    const crlf = INTENT.replace(/\n/g, '\r\n');
    leadIntent(ctx, project.slug, 'Progresser', 1, { intent: crlf });
    expect(resolveProject(ctx, project.slug).intent).toBe(crlf);
    expect(readLeadBrief(ctx, project.slug, 1, new Date(ctx.now())).intent).toMatchObject({ goal: 'Ship the game to the store.', phase: 'Closed beta with friends.' });
  });

  it('takes a record of exactly 8,000 characters through the route, and answers one of 8,001 with a 400', async () => {
    const { ctx, app, project, leadEvents } = setup();
    const post = (intent: string) =>
      app.inject({ method: 'POST', url: `/api/lead/${project.slug}/intent`, headers: BEARER, payload: { as: 'Progresser', instructions: 1, intent } });
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
      const res = await post(s, command, { as: 'Progresser', instructions: 1, ...body, ...extra }, headers);
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
    await expectRefused(setup(), { instructions: 0 }, 409, outOfDate(0));
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
    expect((await post(s, 'promise', { as: 'Progresser', instructions: 1, text: 'x'.repeat(501), dueAt: DUE })).statusCode).toBe(400);
    expect((await post(s, 'promise', { as: 'Progresser', instructions: 1, text: 'x', dueAt: 'tomorrow' })).statusCode).toBe(400);
    expect((await post(s, 'intent', { as: 'Progresser', instructions: 1, intent: `## Goal\nShip.\n\n## Phase\nBeta.\n${'x'.repeat(8_001)}` })).statusCode).toBe(400);
    expect((await post(s, 'answer', { as: 'Progresser', instructions: 1, askId: s.question.id, aidenWords: 'x'.repeat(2_001) })).statusCode).toBe(400);
    expect((await post(s, 'drop', { as: 'Progresser', instructions: 1, stepId: s.proposed.id })).statusCode).toBe(400);
    expect(s.leadEvents()).toBe(0);
  });
});

describe('the routes', () => {
  it('answer and park answer { text }', async () => {
    const s = setup();
    const post = (command: string, payload: Record<string, unknown>) =>
      s.app.inject({ method: 'POST', url: `/api/lead/${s.project.slug}/${command}`, headers: BEARER, payload: { as: 'Progresser', instructions: 1, ...payload } });
    const answered = await post('answer', { askId: s.question.id, aidenWords: 'Use the release keystore.' });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().text).toBe(`Answered a${s.question.id} with Aiden's words.`);
    const parked = await post('park', { stepId: s.proposed.id });
    expect(parked.statusCode).toBe(200);
    expect(parked.json().text).toBe(`Parked #${s.proposed.id} Dark mode.`);
    const refusedPark = await post('park', { stepId: s.asked.id });
    expect(refusedPark.statusCode).toBe(409);
    expect(refusedPark.json().error).toBe(aidens('asked'));
  });
});
