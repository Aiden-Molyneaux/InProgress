import { describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { stamp } from '../../src/core/span';
import { buildApp } from '../../src/server/app';
import { noLeadNamed } from '../../src/server/lead';
import { LEAD_RESOURCE_CUT, LEAD_STEP_LOG_CAP, LEAD_STEP_TEXT_CUT, readLeadResource, readLeadStep } from '../../src/server/lead-step';
import { clearAsk, raiseAsk } from '../../src/server/repo/asks';
import { addLog } from '../../src/server/repo/logs';
import { addNodes, updateNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { addResource } from '../../src/server/repo/resources';
import { handleHookEvent } from '../../src/server/session-flow';
import { makeCtx } from '../helpers';

const DAY = 24 * 60 * 60 * 1000;
const W = ['Progresser', LEAD_INSTRUCTIONS_VERSION] as const;

/** A project led by Progresser with a step under its root, and a second project with a step of its own. */
function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Build the backup strategy', status: 'active', label: 'data', origin: 'asked' }] });
  const other = createProject(ctx, 'test', { name: 'Elsewhere' });
  const [foreign] = addNodes(ctx, 'test', { parentId: other.rootNodeId, nodes: [{ title: 'Theirs' }] });
  // Everything on record is seconds old; the lead reads it 27 days on, so every age is `27d`.
  const later = () => new Date(Date.parse(ctx.now()) + 27 * DAY);
  const read = (id = step.id, as: string = W[0], v: number = W[1]) => readLeadStep(ctx, project.slug, as, v, id, later()).text;
  return { ctx, project, step, other, foreign, later, read };
}

describe('readLeadStep', () => {
  it('prints the header, What, Why, a session with its thread, asks open and answered, documents and the log', () => {
    const { ctx, project, step, read } = setup();
    updateNode(ctx, 'test', step.id, { what: 'Back up the data.', why: 'Losing it hurts.', outcome: 'A plan.', body: 'Some notes.' });
    handleHookEvent(ctx, 'abcdef123', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
    ctx.db.prepare("UPDATE sessions SET focus_node_id = ?, t3_thread_id = 'thr-1', title = 'Backups', app = 't3', state = 'working' WHERE id = 'abcdef123'").run(step.id);
    handleHookEvent(ctx, 'ended0001', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
    ctx.db.prepare("UPDATE sessions SET focus_node_id = ?, title = NULL, app = 'cli', state = 'ended', ended_at = last_seen_at WHERE id = 'ended0001'").run(step.id);
    const open = raiseAsk(ctx, 'session:abcdef123', { nodeId: step.id, kind: 'review', text: 'Look at the plan' });
    const answered = raiseAsk(ctx, 'session:abcdef123', { nodeId: step.id, kind: 'question', text: 'Which disk?' });
    clearAsk(ctx, 'window', answered.id, 'The big one');
    const bare = raiseAsk(ctx, 'session:abcdef123', { nodeId: step.id, kind: 'permission', text: 'Run it' });
    clearAsk(ctx, 'window', bare.id, '');
    const promise = raiseAsk(ctx, 'lead', { nodeId: step.id, kind: 'question', text: 'Come back', owner: 'lead' });
    addResource(ctx, 'test', { nodeId: step.id, kind: 'doc', title: 'Data backup strategy', path: 'C:/personal/InGame/docs/spec.md' });
    const stored = addResource(ctx, 'test', { nodeId: step.id, kind: 'doc', title: 'Backup handoff', content: 'x'.repeat(5210), purpose: 'handoff' });
    const [child] = addNodes(ctx, 'test', { parentId: step.id, nodes: [{ title: 'Backups panel', status: 'done' }] });
    const log = addLog(ctx, 'test', step.id, 'Wrote the plan\nin two lines');
    const text = read();
    const lines = text.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      `#${step.id} Build the backup strategy · active · data · origin asked`,
      `Under: #${project.rootNodeId} InGame`,
      expect.stringMatching(/^Changed 27d ago · created \d{4}-\d\d-\d\d \d\d:\d\d$/),
    ]);
    expect(lines).toContain('What: Back up the data.');
    expect(lines).toContain('Why: Losing it hurts.');
    expect(lines).toContain('Outcome: A plan.');
    expect(lines).toContain('Notes: Some notes.');
    expect(lines).toContain('Sessions (2):');
    expect(lines).toContain('  "Backups" · t3 · thread thr-1 · working, seen 27d ago');
    expect(lines).toContain('  "Session ended0" · cli · ended 27d ago');
    expect(lines).toContain('Asks (4):');
    expect(lines).toContain(`  a${open.id} review · open, raised 27d ago: "Look at the plan"`);
    expect(lines).toContain(`  a${answered.id} question · answered 27d ago: "Which disk?" -> "The big one"`);
    expect(lines).toContain(`  a${bare.id} permission · cleared 27d ago with no answer: "Run it"`);
    expect(lines).toContain(`  a${promise.id} promise · open, raised 27d ago: "Come back"`);
    expect(lines).toContain('Documents (2):');
    expect(lines.some((l) => /^ {2}r\d+ doc "Data backup strategy" · file C:\/personal\/InGame\/docs\/spec\.md$/.test(l))).toBe(true);
    expect(lines).toContain(`  r${stored.id} handoff "Backup handoff" · stored in InProgress, 5210 characters: lead resource ingame ${stored.id} --as Progresser --instructions ${LEAD_INSTRUCTIONS_VERSION}`);
    expect(lines).toContain('Steps under it (1):');
    expect(lines).toContain(`  #${child.id} Backups panel · done`);
    expect(lines).toContain('Log, newest first (1 of 1):');
    expect(lines).toContain(`  ${stamp(log.createdAt)} · Wrote the plan in two lines`);
    // The fixed order of the sections.
    const order = ['What:', 'Why:', 'Outcome:', 'Notes:', 'Sessions (', 'Asks (', 'Documents (', 'Steps under it (', 'Log, newest first'];
    const at = order.map((h) => lines.findIndex((l) => l.startsWith(h)));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at.every((i) => i > 0)).toBe(true);
  });

  it('prints the open working tasks, and says how many are done', () => {
    const { ctx, step, read } = setup();
    handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InGame' });
    ctx.db.prepare("UPDATE sessions SET focus_node_id = ? WHERE id = 's1'").run(step.id);
    const project = ctx.db.prepare('SELECT project_id FROM nodes WHERE id = ?').pluck().get(step.id) as number;
    const insert = ctx.db.prepare("INSERT INTO work_items (project_id, node_id, session_id, agent_id, task_key, subject, status, position, created_at, updated_at) VALUES (?, ?, 's1', '', ?, ?, ?, ?, ?, ?)");
    insert.run(project, step.id, 't1', 'Write tests', 'completed', 0, ctx.now(), ctx.now());
    insert.run(project, step.id, 't2', 'Wire the route', 'pending', 1, ctx.now(), ctx.now());
    expect(read()).toContain('Working tasks (1 done, 1 open):\n  open: Wire the route');
  });

  it('leaves out the sections that are empty: a bare step prints its first three lines and nothing else', () => {
    const { step, read } = setup();
    const lines = read().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`#${step.id} Build the backup strategy · active · data · origin asked`);
  });

  it('adds when a step was done, and leaves the label out when it has none', () => {
    const { ctx, project, read } = setup();
    const [plain] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Plain' }] });
    updateNode(ctx, 'test', plain.id, { status: 'done' });
    const lines = read(plain.id).split('\n');
    expect(lines[0]).toBe(`#${plain.id} Plain · done · origin asked`);
    expect(lines[2]).toMatch(/ · done \d{4}-\d\d-\d\d \d\d:\d\d$/);
  });

  it('cuts a long body and says how much it cut', () => {
    const { ctx, step, read } = setup();
    updateNode(ctx, 'test', step.id, { body: 'b'.repeat(LEAD_STEP_TEXT_CUT + 1000) });
    const notes = read().split('\n').find((l) => l.startsWith('Notes: '))!;
    expect(notes).toBe(`Notes: ${'b'.repeat(LEAD_STEP_TEXT_CUT)} (cut: 1000 more characters)`);
  });

  it('cuts a long ask, and keeps What and Why whole', () => {
    const { ctx, step, read } = setup();
    const what = 'w'.repeat(LEAD_STEP_TEXT_CUT + 50);
    updateNode(ctx, 'test', step.id, { what });
    raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'q'.repeat(LEAD_STEP_TEXT_CUT + 7) });
    const lines = read().split('\n');
    expect(lines).toContain(`What: ${what}`);
    expect(lines.find((l) => l.includes('open, raised'))!.endsWith('(cut: 7 more characters)"')).toBe(true);
  });

  it('caps the log and says how many there are', () => {
    const { ctx, step, read } = setup();
    for (let i = 1; i <= 70; i++) addLog(ctx, 'test', step.id, `entry ${i}`);
    const lines = read().split('\n');
    const at = lines.indexOf(`Log, newest first (${LEAD_STEP_LOG_CAP} of 70):`);
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1)).toHaveLength(LEAD_STEP_LOG_CAP);
    expect(lines[at + 1]).toMatch(/ · entry 70$/);
    expect(lines.at(-1)).toMatch(/ · entry 11$/);
  });

  it('cuts one log line at 1000 characters and keeps it on one line', () => {
    const { ctx, step, read } = setup();
    addLog(ctx, 'test', step.id, `${'l'.repeat(2000)}\nsecond`);
    const line = read().split('\n').at(-1)!;
    expect(line.length).toBeLessThan(1100);
    expect(line).not.toContain('second');
  });

  it('refuses a step of another project with a 409', async () => {
    const { ctx, project, foreign } = setup();
    const app = buildApp({ ctx, token: 't', uiToken: 'u', version: 'test' });
    const res = await app.inject({ url: `/api/lead/${project.slug}/step/${foreign.id}?as=Progresser&instructions=${LEAD_INSTRUCTIONS_VERSION}` });
    expect([res.statusCode, res.json().error]).toEqual([409, `#${foreign.id} is not in this project.`]);
  });

  it('prints every open ask and the newest 20 cleared ones, and says how many it left out', () => {
    const { ctx, step, read } = setup();
    for (let i = 1; i <= 25; i++) clearAsk(ctx, 'window', raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: `old ${i}` }).id, 'ok');
    raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'review', text: 'still open' });
    const lines = read().split('\n');
    const at = lines.indexOf('Asks (26):');
    expect(at).toBeGreaterThan(0);
    const asks = lines.slice(at + 1, at + 1 + 22);
    expect(asks[0]).toMatch(/review · open, raised 27d ago: "still open"$/);
    expect(asks[1]).toMatch(/: "old 6" -> "ok"$/);
    expect(asks[20]).toMatch(/: "old 25" -> "ok"$/);
    expect(asks[21]).toBe('  and 5 more, cleared earlier');
    expect(lines.some((l) => l.includes('"old 5"'))).toBe(false);
  });

  it('prints at most 40 steps under it, with the full count in the heading', () => {
    const { ctx, step, read } = setup();
    addNodes(ctx, 'test', { parentId: step.id, nodes: Array.from({ length: 45 }, (_, i) => ({ title: `Child ${i + 1}` })) });
    const lines = read().split('\n');
    const at = lines.indexOf('Steps under it (45):');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1)).toHaveLength(41);
    expect(lines.at(-1)).toBe('  and 5 more');
  });

  it('says how many sessions it left out, and only then', () => {
    const { ctx, step, read } = setup();
    const insert = ctx.db.prepare("INSERT INTO sessions (id, project_id, state, focus_node_id, started_at, last_seen_at) VALUES (?, (SELECT project_id FROM nodes WHERE id = ?), 'idle', ?, ?, ?)");
    for (let i = 0; i < 3; i++) insert.run(`few${i}`, step.id, step.id, ctx.now(), ctx.now());
    expect(read()).toContain('Sessions (3):');
    for (let i = 3; i < 25; i++) insert.run(`few${i}`, step.id, step.id, ctx.now(), ctx.now());
    expect(read()).toContain('Sessions (10 of 25):');
  });

  it('answers a missing step and a missing document with a 404 and a hint of the lead\'s own', () => {
    const { ctx, project, read } = setup();
    expect(() => read(999999)).toThrowError(expect.objectContaining({ status: 404, message: '#999999 not found.', hint: `Run "outline ${project.slug}" to see this project's steps.` }));
    expect(() => readLeadResource(ctx, project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, 999999)).toThrowError(
      expect.objectContaining({ status: 404, message: 'r999999 not found.', hint: "lead step lists a step's documents." }),
    );
  });

  it('refuses a project with no lead, and another lead\'s name', () => {
    const { ctx, project, step, read } = setup();
    expect(() => read(step.id, 'Rich')).toThrow(noLeadNamed('Rich'));
    setProjectLead(ctx, 'window', project.slug, null);
    expect(() => read(step.id, 'Progresser')).toThrow(noLeadNamed('Progresser'));
  });

  it('can be read by a version 1 lead', () => {
    const { step, read } = setup();
    expect(read(step.id, 'Progresser', 1)).toContain(`#${step.id} Build the backup strategy`);
  });

  it('answers through the route for the named lead, and a bad id with a 400, a missing version with a 400', async () => {
    const { ctx, project, step } = setup();
    const app = buildApp({ ctx, token: 't', uiToken: 'u', version: 'test' });
    const ok = await app.inject({ url: `/api/lead/${project.slug}/step/${step.id}?as=progresser&instructions=1` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().text).toContain(`#${step.id} Build the backup strategy`);
    expect((await app.inject({ url: `/api/lead/${project.slug}/step/abc?as=Progresser&instructions=3` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/lead/${project.slug}/step/${step.id}?as=Progresser` })).statusCode).toBe(400);
  });
});

describe('readLeadResource', () => {
  const rd = (s: ReturnType<typeof setup>, id: number, as = 'Progresser') => readLeadResource(s.ctx, s.project.slug, as, LEAD_INSTRUCTIONS_VERSION, id).text;

  it('prints stored content under the document line', () => {
    const s = setup();
    const r = addResource(s.ctx, 'test', { nodeId: s.step.id, kind: 'doc', title: 'Backup handoff', content: 'Line one\nLine two', purpose: 'handoff' });
    expect(rd(s, r.id)).toBe(`r${r.id} handoff "Backup handoff" on #${s.step.id} Build the backup strategy\n\nLine one\nLine two`);
  });

  it('points at the file when nothing is stored', () => {
    const s = setup();
    const r = addResource(s.ctx, 'test', { nodeId: s.step.id, kind: 'doc', title: 'Spec', path: 'C:/personal/InGame/spec.md' });
    expect(rd(s, r.id).split('\n').slice(2)).toEqual(['Not stored in InProgress. Read the file: C:/personal/InGame/spec.md']);
  });

  it('says a link', () => {
    const s = setup();
    const r = addResource(s.ctx, 'test', { nodeId: s.step.id, kind: 'link', title: 'Page', url: 'https://example.com/x' });
    expect(rd(s, r.id).split('\n').slice(2)).toEqual(['A link: https://example.com/x']);
  });

  it('says nothing stored, and never prints null', () => {
    const s = setup();
    const r = addResource(s.ctx, 'test', { nodeId: s.step.id, kind: 'other', title: 'Empty', content: 'x' });
    s.ctx.db.prepare("UPDATE resources SET content = '' WHERE id = ?").run(r.id);
    const text = rd(s, r.id);
    expect(text.split('\n').slice(2)).toEqual([`r${r.id} has nothing stored.`]);
    expect(text).not.toContain('null');
  });

  it('cuts at LEAD_RESOURCE_CUT and says how much it cut', () => {
    const s = setup();
    const r = addResource(s.ctx, 'test', { nodeId: s.step.id, kind: 'doc', title: 'Big', content: 'z'.repeat(LEAD_RESOURCE_CUT + 25) });
    const lines = rd(s, r.id).split('\n');
    expect(lines[2]).toBe('z'.repeat(LEAD_RESOURCE_CUT));
    expect(lines[3]).toBe('(cut: 25 more characters)');
  });

  it('refuses a document of another project, another name, and answers through the route', async () => {
    const s = setup();
    const theirs = addResource(s.ctx, 'test', { nodeId: s.foreign.id, kind: 'doc', title: 'Theirs', content: 'secret' });
    const mine = addResource(s.ctx, 'test', { nodeId: s.step.id, kind: 'doc', title: 'Mine', content: 'open' });
    expect(() => rd(s, theirs.id)).toThrowError(expect.objectContaining({ status: 409, message: `r${theirs.id} is not in this project.` }));
    expect(() => rd(s, mine.id, 'Rich')).toThrow(noLeadNamed('Rich'));
    const app = buildApp({ ctx: s.ctx, token: 't', uiToken: 'u', version: 'test' });
    const res = await app.inject({ url: `/api/lead/${s.project.slug}/resource/${mine.id}?as=Progresser&instructions=1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('open');
    expect((await app.inject({ url: `/api/lead/${s.project.slug}/resource/${theirs.id}?as=Progresser&instructions=3` })).statusCode).toBe(409);
  });
});
