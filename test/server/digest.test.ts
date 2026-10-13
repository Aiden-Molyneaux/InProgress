import { describe, expect, it } from 'vitest';
import { formatCounts, formatDigest, readDigest, stamp } from '../../src/server/digest';
import { clearAsk, raiseAsk } from '../../src/server/repo/asks';
import { addNodes, updateNode } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { addResource } from '../../src/server/repo/resources';
import { write, type Ctx } from '../../src/server/db/tx';
import { makeCtx } from '../helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** A project whose clock sits at `start`; `at(ms)` moves nothing, it just names a time relative to start. */
function setup() {
  const ctx = makeCtx('2026-10-01T12:00:00.000Z');
  const project = createProject(ctx, 'test', { name: 'InProgress' });
  const [group] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Group', status: 'active' }] });
  return { ctx, project, group, t0: Date.parse(ctx.now()) };
}

/** Moves the clock: the next ctx.now() reads `ms`. */
function setClock(ctx: Ctx, ms: number): void {
  let t = ms - 1000;
  ctx.now = () => new Date((t += 1000)).toISOString();
}

function insertSession(ctx: Ctx, projectId: number, id: string, o: { slot?: number | null; startedAt: string; state?: string; lastSeenAt?: string; endedAt?: string | null; focus?: number | null; title?: string | null }) {
  ctx.db
    .prepare('INSERT INTO sessions (id, project_id, state, started_at, last_seen_at, ended_at, slot, focus_node_id, title) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, projectId, o.state ?? 'ended', o.startedAt, o.lastSeenAt ?? o.endedAt ?? o.startedAt, o.endedAt ?? null, o.slot ?? 1, o.focus ?? null, o.title ?? null);
}

describe('readDigest: the window', () => {
  it('reads --since, else the state note, else 7 days', () => {
    const { ctx, project, t0 } = setup();
    setClock(ctx, t0 + 10 * DAY);
    const def = readDigest(ctx, project.slug);
    expect(def.sinceSource).toBe('default');
    expect(Math.abs(Date.parse(def.since) - (t0 + 3 * DAY))).toBeLessThan(30_000);

    const note = addResource(ctx, 'test', { nodeId: project.rootNodeId, kind: 'doc', title: 'State', content: 'where we are', purpose: 'state' });
    const fromNote = readDigest(ctx, project.slug);
    expect(fromNote.sinceSource).toBe('state_note');
    expect(fromNote.since).toBe(note.updatedAt);

    const given = readDigest(ctx, project.slug, '2026-10-02T00:00:00.000Z');
    expect(given).toMatchObject({ sinceSource: 'given', since: '2026-10-02T00:00:00.000Z' });
  });
});

describe('readDigest: done, asks, documents', () => {
  it('lists a done step inside the window and not one before it', () => {
    const { ctx, project, group, t0 } = setup();
    const [early, late] = addNodes(ctx, 'test', { parentId: group.id, nodes: [{ title: 'Early' }, { title: 'Late' }] });
    setClock(ctx, t0 + 1 * DAY);
    updateNode(ctx, 'test', early.id, { status: 'done', outcome: 'before the window' });
    setClock(ctx, t0 + 3 * DAY);
    updateNode(ctx, 'test', late.id, { status: 'done', outcome: 'inside' });
    const d = readDigest(ctx, project.slug, iso(t0 + 2 * DAY));
    expect(d.done.map((n) => [n.id, n.outcome])).toEqual([[late.id, 'inside']]);
  });

  it('lists an ask raised and one cleared with an answer, from the table', () => {
    const { ctx, project, group, t0 } = setup();
    const [step] = addNodes(ctx, 'test', { parentId: group.id, nodes: [{ title: 'Pick a port' }] });
    setClock(ctx, t0 + 1 * DAY);
    const old = raiseAsk(ctx, 'scribe', { nodeId: step.id, kind: 'question', text: 'Before the window?' });
    setClock(ctx, t0 + 3 * DAY);
    const a = raiseAsk(ctx, 'scribe', { nodeId: step.id, kind: 'question', text: 'Which port?' });
    const b = raiseAsk(ctx, 'scribe', { nodeId: step.id, kind: 'review', text: 'Look at it' });
    clearAsk(ctx, 'window', b.id, 'looks good');
    const d = readDigest(ctx, project.slug, iso(t0 + 2 * DAY));
    expect(d.asksRaised.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(d.asksCleared.map((x) => [x.id, x.answer, x.clearedBy])).toEqual([[b.id, 'looks good', 'window']]);
    expect(d.asksRaised.map((x) => x.id)).not.toContain(old.id);
    expect(formatDigest(d, Date.parse(ctx.now()))).toContain(`Asks cleared (1): a${b.id} on #${step.id}: "looks good" (window)`);
  });

  it('lists a quick-add by the window, a window move, and a new document', () => {
    const { ctx, project, group, t0 } = setup();
    setClock(ctx, t0 + 3 * DAY);
    const [quick] = addNodes(ctx, 'window', { parentId: group.id, nodes: [{ title: 'Quick one' }] });
    addNodes(ctx, 'scribe', { parentId: group.id, nodes: [{ title: 'By the scribe' }] });
    write(ctx, 'window', (record) => record({ projectId: project.id, type: 'project.updated', entity: 'project', entityId: project.id, data: { op: 'move', node: quick.id, changes: { queue: { from: [], to: [] } } } }));
    write(ctx, 'window', (record) => record({ projectId: project.id, type: 'project.updated', entity: 'project', entityId: project.id, data: { op: 'remove', node: quick.id } }));
    write(ctx, 'scribe', (record) => record({ projectId: project.id, type: 'project.updated', entity: 'project', entityId: project.id, data: { op: 'move', node: 999 } }));
    const doc = addResource(ctx, 'scribe', { nodeId: group.id, kind: 'doc', title: 'Handoff', content: 'x', purpose: 'handoff' });
    const d = readDigest(ctx, project.slug, iso(t0 + 2 * DAY));
    expect(d.quickAdds.map((n) => [n.id, n.title])).toEqual([[quick.id, 'Quick one']]);
    expect(d.moves.map((m) => [m.op, m.nodeId])).toEqual([['move', quick.id], ['remove', quick.id]]);
    expect(d.documents.map((r) => [r.id, r.purpose])).toEqual([[doc.id, 'handoff']]);
    const text = formatDigest(d, Date.parse(ctx.now()));
    expect(text).toContain(`Quick-added (1): #${quick.id} Quick one`);
    expect(text).toContain(`Moved in Next (2): #${quick.id} moved, #${quick.id} removed`);
    expect(text).toContain(`New documents (1): r${doc.id} "Handoff" on #${group.id} (handoff)`);
  });

  it('puts a done step with no outcome in the marks', () => {
    const { ctx, project, group, t0 } = setup();
    const [step] = addNodes(ctx, 'test', { parentId: group.id, nodes: [{ title: 'Bare', status: 'done' }] });
    setClock(ctx, t0 + 1 * DAY);
    const d = readDigest(ctx, project.slug);
    expect(d.marked).toEqual([{ id: step.id, title: 'Bare', marks: ['no_outcome'] }]);
    expect(formatDigest(d, Date.parse(ctx.now()))).toContain(`Marks (1): #${step.id} no_outcome`);
  });
});

describe('readDigest: sessions', () => {
  it('tells a session that ended without a handoff from one with a handoff by session_id, and counts open tasks', () => {
    const { ctx, project, group, t0 } = setup();
    setClock(ctx, t0 + 3 * DAY);
    insertSession(ctx, project.id, 'aaaaaaaa-1111', { slot: 1, startedAt: iso(t0 + 2 * DAY), endedAt: iso(t0 + 2 * DAY + 5 * HOUR), title: 'Bare end' });
    insertSession(ctx, project.id, 'bbbbbbbb-2222', { slot: 0, startedAt: iso(t0 + 2 * DAY), endedAt: iso(t0 + 2 * DAY + 3 * HOUR), title: 'Clean end' });
    addResource(ctx, 'scribe', { nodeId: group.id, kind: 'doc', title: 'Handoff', content: 'x', purpose: 'handoff', sessionId: 'bbbbbbbb-2222' });
    for (const [key, status] of [['t1', 'pending'], ['t2', 'in_progress'], ['t3', 'completed']]) {
      ctx.db
        .prepare("INSERT INTO work_items (project_id, node_id, session_id, agent_id, task_key, subject, status, blocks, position, created_at, updated_at) VALUES (?,?,?,'',?,?,?,'[]',1,?,?)")
        .run(project.id, group.id, 'aaaaaaaa-1111', key, `Task ${key}`, status, ctx.now(), ctx.now());
    }
    const d = readDigest(ctx, project.slug, iso(t0 + 1 * DAY));
    const bare = d.sessions.find((s) => s.id === 'aaaaaaaa-1111')!;
    const clean = d.sessions.find((s) => s.id === 'bbbbbbbb-2222')!;
    expect(bare).toMatchObject({ letter: 'B', handoff: false, openTasks: 2, endedAt: iso(t0 + 2 * DAY + 5 * HOUR) });
    expect(clean).toMatchObject({ letter: 'A', handoff: true, openTasks: 0 });
    const now = Date.parse(ctx.now());
    const text = formatDigest(d, now);
    expect(text).toContain('B aaaaaaaa "Bare end" ended 19h ago, no handoff, 2 open tasks');
    expect(text).toContain('A bbbbbbbb "Clean end" ended 21h ago');
    expect(text).not.toContain('Clean end" ended 21h ago, no handoff');
    expect(formatCounts(d, now)).toBe('Since your last look (2d): 2 sessions ended, 1 without a handoff.');
  });

  it("dates a swept session's end by the last time it was heard from", () => {
    const { ctx, project, t0 } = setup();
    setClock(ctx, t0 + 3 * DAY);
    // ended_at is when the sweep ran; last_seen_at is when it last spoke.
    insertSession(ctx, project.id, 'sweep-1', { startedAt: iso(t0 + 1 * DAY), lastSeenAt: iso(t0 + 2 * DAY), endedAt: iso(t0 + 3 * DAY) });
    const [s] = readDigest(ctx, project.slug, iso(t0 + 1 * DAY)).sessions;
    expect(s.endedAt).toBe(iso(t0 + 2 * DAY));
  });

  it('keeps an ended session only within the 7-day trail, but a session started in the window at any age', () => {
    const { ctx, project, t0 } = setup();
    setClock(ctx, t0 + 20 * DAY);
    insertSession(ctx, project.id, 'old-end', { startedAt: iso(t0), endedAt: iso(t0 + 5 * DAY) });
    insertSession(ctx, project.id, 'old-live', { state: 'working', startedAt: iso(t0 + 2 * DAY), lastSeenAt: iso(t0 + 20 * DAY) });
    const ids = readDigest(ctx, project.slug, iso(t0 + 1 * DAY)).sessions.map((s) => s.id);
    expect(ids).toEqual(['old-live']);
  });

  it('prints a run of three ends in one minute as one swept line', () => {
    const { ctx, project, t0 } = setup();
    setClock(ctx, t0 + 3 * DAY);
    const endAt = t0 + 2 * DAY;
    for (let i = 0; i < 5; i++) insertSession(ctx, project.id, `sw-${i}`, { slot: i, startedAt: iso(t0 + 1 * DAY), endedAt: iso(endAt + i * 5000) });
    insertSession(ctx, project.id, 'single', { slot: 7, startedAt: iso(t0 + 1 * DAY), endedAt: iso(endAt + 2 * HOUR), title: 'Single' });
    const d = readDigest(ctx, project.slug, iso(t0 + 1 * DAY));
    const text = formatDigest(d, Date.parse(ctx.now()));
    const at = new Date(endAt);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    expect(text).toContain(`5 sessions swept as ended at ${hhmm}`);
    expect(text).toContain('Sessions (2):');
    expect(text.match(/sw-/g)).toBeNull();
  });
});

describe('formatDigest and formatCounts', () => {
  it('caps the item lines at 20 and says how many more', () => {
    const { ctx, project, group, t0 } = setup();
    addNodes(ctx, 'test', { parentId: group.id, nodes: Array.from({ length: 25 }, (_, i) => ({ title: `Step ${i + 1}`, status: 'done' as const, outcome: `Out ${i + 1}` })) });
    setClock(ctx, t0 + 1 * DAY);
    const d = readDigest(ctx, project.slug, iso(t0 - DAY));
    expect(d.done).toHaveLength(25);
    const lines = formatDigest(d, Date.parse(ctx.now())).split('\n');
    expect(lines[0]).toBe(`Digest for InProgress since ${stamp(d.since)} (given):`);
    expect(lines[1]).toBe('Done (25):');
    expect(lines.filter((l) => l.startsWith('  #'))).toHaveLength(20);
    expect(lines[lines.length - 1]).toBe(`+5 more (inprogress digest ${project.slug} --since ${d.since})`);
  });

  it('prints a section of three or fewer on one line, and nothing at all as "Nothing since"', () => {
    const { ctx, project, group, t0 } = setup();
    setClock(ctx, t0 + 1 * DAY);
    const empty = readDigest(ctx, project.slug, iso(t0 + 1 * DAY));
    expect(formatDigest(empty, Date.parse(ctx.now()))).toBe(`Nothing since ${stamp(empty.since)}.`);
    const [a, b] = addNodes(ctx, 'test', { parentId: group.id, nodes: [{ title: 'A', status: 'done', outcome: 'x' }, { title: 'B', status: 'done', outcome: 'y' }] });
    const d = readDigest(ctx, project.slug, iso(t0));
    expect(formatDigest(d, Date.parse(ctx.now())).split('\n')[1]).toBe(`Done (2): #${a.id} A: "x" · #${b.id} B: "y"`);
  });

  it('counts: zero parts leave out their clause', () => {
    const { ctx, project, group, t0 } = setup();
    setClock(ctx, t0 + 3 * DAY);
    const now = Date.parse(ctx.now());
    expect(formatCounts(readDigest(ctx, project.slug, iso(t0 + 3 * DAY)), now)).toBe('Since your last look (0m): nothing new.');
    addNodes(ctx, 'test', { parentId: group.id, nodes: Array.from({ length: 4 }, (_, i) => ({ title: `D${i}`, status: 'done' as const, outcome: 'ok' })) });
    const [q] = addNodes(ctx, 'test', { parentId: group.id, nodes: [{ title: 'Q' }] });
    const a1 = raiseAsk(ctx, 'scribe', { nodeId: q.id, kind: 'question', text: 'one' });
    raiseAsk(ctx, 'scribe', { nodeId: q.id, kind: 'question', text: 'two' });
    clearAsk(ctx, 'window', a1.id, 'yes');
    insertSession(ctx, project.id, 's-1', { startedAt: iso(t0 + 2 * DAY), endedAt: iso(t0 + 2 * DAY + HOUR) });
    insertSession(ctx, project.id, 's-2', { startedAt: iso(t0 + 2 * DAY), endedAt: iso(t0 + 2 * DAY + 2 * HOUR) });
    addResource(ctx, 'scribe', { nodeId: group.id, kind: 'doc', title: 'H', content: 'x', purpose: 'handoff', sessionId: 's-2' });
    const text = formatCounts(readDigest(ctx, project.slug, iso(t0)), now);
    expect(text).toBe('Since your last look (3d): 4 done · 2 asks raised, 1 answered · 2 sessions ended, 1 without a handoff.');
  });
});
