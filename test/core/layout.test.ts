import { describe, expect, it } from 'vitest';
import { BADGE_ROW, ENDED_AGENT_MS, INDENT, ROW, WORK_GAP, WORK_ROW, eventTarget, findFrontier, layoutOutline, queueView, type LayoutItem, type LayoutResult } from '../../src/core/layout';
import type { EventRow, PastSession, QueueEntry, ResourceMeta, Session, SubagentInfo, TrailAgent, TreeNode, WorkItem, WorkStatus } from '../../src/core/types';

let nextId = 1;
function n(parentId: number | null, title: string, extra: Partial<TreeNode> = {}): TreeNode {
  const id = nextId++;
  return { id, projectId: 1, parentId, position: id, kind: parentId === null ? 'goal' : 'task', title, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null, createdAt: 't', updatedAt: `2026-09-27T00:00:${String(id).padStart(2, '0')}Z`, completedAt: null, ...extra };
}
function session(id: string, focusNodeId: number | null, state: Session['state'], lastSeenAt = '2026-09-27T01:00:00Z'): Session {
  return { id, projectId: 1, title: id, cwd: null, branch: null, transcriptPath: null, state, focusNodeId, promptsSinceUpdate: 0, startedAt: 't', lastSeenAt, endedAt: null, slot: 0, subagents: [] };
}
/** Unowned queue entries. */
const later = (...ids: number[]): QueueEntry[] => ids.map((nodeId) => ({ nodeId, sessionId: null }));
const entry = (nodeId: number, sessionId: string | null = null): QueueEntry => ({ nodeId, sessionId });
const resource = (id: number, nodeId: number): ResourceMeta => ({ id, projectId: 1, nodeId, kind: 'doc', title: `R${id}`, path: null, url: null, contentLength: 1, sessionId: null, createdAt: 't', updatedAt: 't' });

function sample() {
  nextId = 1;
  const root = n(null, 'Root', { status: 'active' });
  const a = n(root.id, 'A', { status: 'active' });
  const a1 = n(a.id, 'A1', { status: 'active' });
  const a2 = n(a.id, 'A2', { assignee: 'me' });
  const b = n(root.id, 'B');
  const c = n(root.id, 'C');
  const d = n(root.id, 'D');
  const e = n(root.id, 'E');
  return { nodes: [root, a, a1, a2, b, c, d, e], root, a, a1, a2, b, c, d, e };
}

describe('layoutOutline', () => {
  it('stacks rows downward and indents by depth', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    const rows = l.items.map((i) => (i.kind === 'node' ? [i.id, i.x, i.y] : [i.id, i.x, i.y]));
    expect(rows).toEqual([
      [`n${t.root.id}`, 0, 0], [`n${t.a.id}`, INDENT, ROW], [`n${t.a1.id}`, 2 * INDENT, 2 * ROW], [`n${t.a2.id}`, 2 * INDENT, 3 * ROW],
      [`n${t.b.id}`, INDENT, 4 * ROW], [`n${t.c.id}`, INDENT, 5 * ROW], [`more${t.root.id}-0`, INDENT, 6 * ROW],
    ]);
    expect(l.edges).toContainEqual({ id: `e-more${t.root.id}-0`, source: `n${t.root.id}`, target: `more${t.root.id}-0` });
    expect(l.edges).toContainEqual({ id: `e-n${t.a1.id}`, source: `n${t.a.id}`, target: `n${t.a1.id}` });
    expect(l.height).toBe(7 * ROW);
  });

  it('adds a badge row under a focused node and marks the working chain', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [resource(9, t.a2.id)], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.b.id, 'ended')] });
    const badge = l.items.find((i) => i.kind === 'badge')!;
    expect(badge).toMatchObject({ id: 'bs1', sessionId: 's1', nodeId: t.a1.id, x: 3 * INDENT, y: 3 * ROW });
    expect(l.nodeItems.get(t.a2.id)).toMatchObject({ y: 3 * ROW + BADGE_ROW, needsYou: true, resourceIds: [9] });
    expect(l.nodeItems.get(t.a.id)?.working).toBe(true);
    expect(l.nodeItems.get(t.b.id)?.working).toBe(false);
    expect(l.items.filter((i) => i.kind === 'badge')).toHaveLength(1);
  });

  it('reports folded done counts and progress', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.a.id || x.id === t.a1.id ? { ...x, status: 'done' as const } : x.id === t.a2.id ? { ...x, assignee: 'claude' as const, status: 'done' as const } : x));
    const l = layoutOutline({ nodes, resources: [], sessions: [] });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ folded: true, doneCount: 2, progress: { done: 2, total: 2 } });
    expect(l.nodeItems.has(t.a1.id)).toBe(false);
  });

  it('badges the nearest visible ancestor when a manual fold hides the focus', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working')], overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(l.nodeItems.has(t.a1.id)).toBe(false);
    expect(l.items.find((i) => i.kind === 'badge')).toMatchObject({ id: 'bs1', nodeId: t.a.id, x: 2 * INDENT, y: 2 * ROW });
    expect(l.nodeItems.get(t.a.id)?.working).toBe(true);
  });

  it('gives no badge to a session without a focus or focused on a node that is gone', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', null, 'working'), session('s2', 999, 'working')] });
    expect(l.items.filter((i) => i.kind === 'badge')).toEqual([]);
    expect([...l.nodeItems.values()].filter((i) => i.working)).toEqual([]);
    expect(l.height).toBe(layoutOutline({ nodes: t.nodes, resources: [], sessions: [] }).height);
  });

  it('stacks the badges of sessions sharing an anchor, one BADGE_ROW each', () => {
    const t = sample();
    const both = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.a1.id, 'idle')] });
    const badges = both.items.filter((i) => i.kind === 'badge');
    expect(badges.map((b) => [b.id, b.nodeId, b.x, b.y])).toEqual([['bs1', t.a1.id, 3 * INDENT, 3 * ROW], ['bs2', t.a1.id, 3 * INDENT, 3 * ROW + BADGE_ROW]]);
    expect(both.nodeItems.get(t.a2.id)?.y).toBe(3 * ROW + 2 * BADGE_ROW);
    expect(both.height).toBe(7 * ROW + 2 * BADGE_ROW);
    // A fold that hides one session's focus stacks it on the anchor with the session already there.
    const folded = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.a.id, 'idle')], overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(folded.items.filter((i) => i.kind === 'badge').map((b) => [b.id, b.nodeId, b.y])).toEqual([['bs1', t.a.id, 2 * ROW], ['bs2', t.a.id, 2 * ROW + BADGE_ROW]]);
  });

  it('draws one uniquely named edge into every visible row but the root', () => {
    const t = sample();
    // A pinned needs-you child in the hidden tail splits it into two "+n more" runs.
    const f = n(t.root.id, 'F', { assignee: 'me' });
    const g = n(t.root.id, 'G');
    const h = n(t.root.id, 'H');
    const l = layoutOutline({ nodes: [...t.nodes, f, g, h], resources: [], sessions: [session('s1', t.a1.id, 'working')] });
    expect(l.items.filter((i) => i.kind === 'more').map((i) => i.id)).toEqual([`more${t.root.id}-0`, `more${t.root.id}-1`]);
    const ids = l.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rows = l.items.filter((i) => i.kind !== 'badge' && i.id !== `n${t.root.id}`).map((i) => i.id);
    expect(l.edges.map((e) => e.target)).toEqual(rows);
  });

  it('folds a run of old finished steps into one "done" row and tells it from the tail', () => {
    const t = sample();
    const now = Date.parse('2026-10-04T12:00:00Z');
    const old = '2026-10-02T12:00:00Z';
    // A, B and C finished two days ago; D and E stay todo, past the frontier at C.
    const nodes = t.nodes.map((x) =>
      x.id === t.a.id || x.id === t.a1.id || x.id === t.b.id ? { ...x, status: 'done' as const, assignee: 'claude' as const, completedAt: old }
      : x.id === t.a2.id ? { ...x, status: 'dropped' as const, assignee: 'claude' as const, updatedAt: old }
      : x.id === t.c.id ? { ...x, status: 'dropped' as const, updatedAt: old }
      : x,
    );
    const l = layoutOutline({ nodes, resources: [], sessions: [], now });
    const id = `done${t.root.id}-0`;
    expect(l.items.map((i) => i.id)).toEqual([`n${t.root.id}`, id, `n${t.d.id}`, `n${t.e.id}`]);
    expect(l.items[1]).toEqual({ kind: 'more', id, parentId: t.root.id, run: 0, x: INDENT, y: ROW, depth: 1, hiddenIds: [t.a.id, t.b.id, t.c.id], variant: 'done' });
    expect(l.edges).toContainEqual({ id: `e-${id}`, source: `n${t.root.id}`, target: id });
    // Within a day of finishing, they show.
    expect(layoutOutline({ nodes, resources: [], sessions: [], now: Date.parse(old) + 60_000 }).items.some((i) => i.kind === 'more')).toBe(false);
    // The done: override opens the run.
    expect(layoutOutline({ nodes, resources: [], sessions: [], now, overrides: { [`done:${t.root.id}`]: 'open' } }).nodeItems.has(t.b.id)).toBe(true);
    // The tail keeps its id and says what it is.
    expect(layoutOutline({ nodes: t.nodes, resources: [], sessions: [], now }).items.find((i) => i.kind === 'more')).toMatchObject({ id: `more${t.root.id}-0`, variant: 'tail' });
  });
});

const T0 = Date.parse('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(T0 - ms).toISOString();
const agent = (agentId: string, extra: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId, agentType: 'general-purpose', startedAt: ago(60_000), description: `Agent ${agentId}`, model: 'sonnet', nodeId: null, endedAt: null, ordinal: 1, ...extra,
});
let nextWork = 100;
function work(nodeId: number, status: WorkStatus, extra: Partial<WorkItem> = {}): WorkItem {
  const id = nextWork++;
  return { id, nodeId, sessionId: 's1', agentId: '', subject: `Task ${id}`, status, blocks: [], position: id, updatedAt: 't', endedAt: null, ...extra };
}
const withAgents = (s: Session, subagents: SubagentInfo[]): Session => ({ ...s, subagents });
/** A stopped subagent as the snapshot's trail lists it; of the ended session s0 unless it says otherwise. */
const trailAgent = (agentId: string, extra: Partial<TrailAgent> = {}): TrailAgent => ({ ...agent(agentId, { endedAt: ago(10 * 60_000) }), sessionId: 's0', ...extra });
const past = (id: string, focusNodeId: number | null): PastSession => ({ id, title: `Past ${id}`, focusNodeId, endedAt: ago(60_000) });
/** The layout's rows of these kinds, as [kind, id, nodeId, x, y]. */
const rowsOf = (l: LayoutResult, ...kinds: LayoutItem['kind'][]) =>
  l.items.filter((i) => kinds.includes(i.kind)).map((i) => [i.kind, i.id, 'nodeId' in i ? i.nodeId : null, i.x, i.y]);

describe('working tasks', () => {
  it('sit in compact rows one level under their node, in position order, with a gap after them', () => {
    const t = sample();
    const first = work(t.a1.id, 'in_progress', { position: 1 });
    const second = work(t.a1.id, 'pending', { position: 2 });
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], workItems: [second, first], now: T0 });
    expect(rowsOf(l, 'work', 'workDone')).toEqual([
      ['work', `w${first.id}`, t.a1.id, 3 * INDENT, 3 * ROW],
      ['work', `w${second.id}`, t.a1.id, 3 * INDENT, 3 * ROW + WORK_ROW],
    ]);
    expect(l.items.find((i) => i.kind === 'work')).toMatchObject({ workId: first.id });
    expect(l.nodeItems.get(t.a2.id)?.y).toBe(3 * ROW + 2 * WORK_ROW + WORK_GAP);
    expect(l.height).toBe(7 * ROW + 2 * WORK_ROW + WORK_GAP);
  });

  it('come after the badges under their node', () => {
    const t = sample();
    const task = work(t.a1.id, 'pending');
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working')], workItems: [task], now: T0 });
    expect(rowsOf(l, 'badge', 'work')).toEqual([
      ['badge', 'bs1', t.a1.id, 3 * INDENT, 3 * ROW],
      ['work', `w${task.id}`, t.a1.id, 3 * INDENT, 3 * ROW + BADGE_ROW],
    ]);
  });

  it('fold completed tasks into one "✓ n done" row first, which a work:<id> override opens', () => {
    const t = sample();
    const c1 = work(t.a1.id, 'completed', { position: 1 });
    const p = work(t.a1.id, 'pending', { position: 2 });
    const c2 = work(t.a1.id, 'completed', { position: 3 });
    const input = { nodes: t.nodes, resources: [], sessions: [], workItems: [c1, p, c2], now: T0 };
    const y = 3 * ROW;
    const shut = layoutOutline(input);
    expect(rowsOf(shut, 'work', 'workDone')).toEqual([
      ['workDone', `wd${t.a1.id}`, t.a1.id, 3 * INDENT, y],
      ['work', `w${p.id}`, t.a1.id, 3 * INDENT, y + WORK_ROW],
    ]);
    expect(shut.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 2, open: false });
    const open = layoutOutline({ ...input, overrides: { [`work:${t.a1.id}`]: 'open' } });
    expect(rowsOf(open, 'work', 'workDone').map(([kind, id, , , rowY]) => [kind, id, rowY])).toEqual([
      ['workDone', `wd${t.a1.id}`, y],
      ['work', `w${c1.id}`, y + WORK_ROW],
      ['work', `w${p.id}`, y + 2 * WORK_ROW],
      ['work', `w${c2.id}`, y + 3 * WORK_ROW],
    ]);
    expect(open.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 2, open: true });
    // All done: the one row.
    const allDone = layoutOutline({ ...input, workItems: [c1, c2] });
    expect(rowsOf(allDone, 'work', 'workDone').map(([kind]) => kind)).toEqual(['workDone']);
    expect(allDone.nodeItems.get(t.a2.id)?.y).toBe(y + WORK_ROW + WORK_GAP);
  });

  it('fold with their node, and stay hidden with it under a folded ancestor or in a "+n more" run', () => {
    const t = sample();
    const onA = work(t.a.id, 'pending');
    const onA1 = work(t.a1.id, 'pending');
    const onD = work(t.d.id, 'pending');
    const input = { nodes: t.nodes, resources: [], sessions: [], workItems: [onA, onA1, onD], now: T0 };
    const open = layoutOutline(input);
    expect(rowsOf(open, 'work').map(([, id]) => id)).toEqual([`w${onA.id}`, `w${onA1.id}`]);
    expect(open.items.find((i) => i.kind === 'more')).toMatchObject({ hiddenIds: [t.d.id, t.e.id] });
    const folded = layoutOutline({ ...input, overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(rowsOf(folded, 'work')).toEqual([]);
    // Root, A (folded), B, C and "+2 more".
    expect(folded.height).toBe(5 * ROW);
  });

  it('never count in plan progress', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], workItems: [work(t.a.id, 'completed'), work(t.a.id, 'pending'), work(t.a2.id, 'completed')], now: T0 });
    expect(l.nodeItems.get(t.a.id)?.progress).toEqual({ done: 0, total: 2 });
    expect(l.nodeItems.get(t.a2.id)?.progress).toBeNull();
  });

  it('pulse while in progress and their session works, or their subagent runs', () => {
    const t = sample();
    const items = [
      work(t.a1.id, 'in_progress'),
      work(t.a1.id, 'pending'),
      work(t.a1.id, 'in_progress', { agentId: 'x' }),
      work(t.a1.id, 'in_progress', { agentId: 'y' }),
      work(t.a1.id, 'in_progress', { agentId: 'gone' }),
      work(t.a1.id, 'completed', { agentId: 'x' }),
    ];
    const subagents = [agent('x'), agent('y', { endedAt: ago(60_000) })];
    const pulses = (state: Session['state']) =>
      layoutOutline({ nodes: t.nodes, resources: [], sessions: [withAgents(session('s1', t.a1.id, state), subagents)], workItems: items, overrides: { [`work:${t.a1.id}`]: 'open' }, now: T0 })
        .items.flatMap((i) => (i.kind === 'work' ? [i.pulse] : []));
    expect(pulses('working')).toEqual([true, false, true, false, false, false]);
    expect(pulses('idle')).toEqual([false, false, true, false, false, false]);
  });
});

describe('subagent badges', () => {
  it('give each subagent a badge under its node, after its session badge, falling back to the focus', () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [agent('x', { nodeId: t.b.id }), agent('y'), agent('z', { nodeId: 999 })]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], now: T0 });
    expect(rowsOf(l, 'badge', 'agent')).toEqual([
      ['badge', 'bs1', t.a1.id, 3 * INDENT, 3 * ROW],
      ['agent', 'as1:y', t.a1.id, 3 * INDENT, 3 * ROW + BADGE_ROW],
      ['agent', 'as1:z', t.a1.id, 3 * INDENT, 3 * ROW + 2 * BADGE_ROW],
      ['agent', 'as1:x', t.b.id, 2 * INDENT, 5 * ROW + 3 * BADGE_ROW],
    ]);
    expect(l.items.find((i) => i.id === 'as1:x')).toMatchObject({ sessionId: 's1', agentId: 'x', ended: false });
    expect(l.nodeItems.get(t.c.id)?.y).toBe(5 * ROW + 4 * BADGE_ROW);
  });

  it('keep an ended subagent, greyed, for 5 minutes after it stopped', () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'idle'), [agent('x', { endedAt: ago(ENDED_AGENT_MS - 1000) }), agent('y', { endedAt: ago(ENDED_AGENT_MS) })]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], now: T0 });
    expect(l.items.filter((i) => i.kind === 'agent')).toEqual([expect.objectContaining({ id: 'as1:x', ended: true })]);
  });

  it("sit on the nearest visible ancestor when a manual fold hides their node, and need a node or their session's focus", () => {
    const t = sample();
    const s1 = withAgents(session('s1', null, 'working'), [agent('x', { nodeId: t.a1.id }), agent('y')]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], overrides: { ['n:' + t.a.id]: 'closed' }, now: T0 });
    expect(rowsOf(l, 'badge', 'agent')).toEqual([['agent', 'as1:x', t.a.id, 2 * INDENT, 2 * ROW]]);
  });

  it("leave an ended session's subagents out", () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [withAgents(session('s1', t.a1.id, 'ended'), [agent('x')])], now: T0 });
    expect(rowsOf(l, 'badge', 'agent')).toEqual([]);
  });
});

describe('live work and the fold rules', () => {
  it("keep a subagent's node and a node with a task in progress in view; a pending task does not", () => {
    const t = sample();
    const f = n(t.root.id, 'F');
    const g = n(t.root.id, 'G');
    const nodes = [...t.nodes, f, g];
    const hidden = (l: LayoutResult) => l.items.flatMap((i) => (i.kind === 'more' ? [i.hiddenIds] : []));
    expect(hidden(layoutOutline({ nodes, resources: [], sessions: [], now: T0 }))).toEqual([[t.d.id, t.e.id, f.id, g.id]]);
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [agent('x', { nodeId: t.e.id })]);
    const onG = work(g.id, 'in_progress');
    const l = layoutOutline({ nodes, resources: [], sessions: [s1], workItems: [onG, work(t.d.id, 'pending')], now: T0 });
    expect(hidden(l)).toEqual([[t.d.id], [f.id]]);
    expect(rowsOf(l, 'agent', 'work').map(([kind, id, nodeId]) => [kind, id, nodeId])).toEqual([
      ['agent', 'as1:x', t.e.id],
      ['work', `w${onG.id}`, g.id],
    ]);
  });

  it('number queued nodes in queue order, per owner', () => {
    const t = sample();
    let l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], queue: later(t.c.id, t.a1.id, 999, t.c.id), now: T0 });
    expect(l.nodeItems.get(t.c.id)?.queue).toEqual({ pos: 1, sessionId: null });
    expect(l.nodeItems.get(t.a1.id)?.queue).toEqual({ pos: 2, sessionId: null });
    expect(l.nodeItems.get(t.b.id)?.queue).toBeNull();
    const sessions = [session('s1', t.b.id, 'idle'), session('s2', null, 'idle')];
    l = layoutOutline({ nodes: t.nodes, resources: [], sessions, queue: [entry(t.c.id, 's1'), entry(t.a1.id, 's1'), entry(t.d.id, 's2'), entry(t.e.id)], now: T0 });
    expect([t.c, t.a1, t.d, t.e].map((x) => l.nodeItems.get(x.id)?.queue)).toEqual([
      { pos: 1, sessionId: 's1' }, { pos: 2, sessionId: 's1' }, { pos: 1, sessionId: 's2' }, { pos: 1, sessionId: null },
    ]);
  });
});

describe('camera helpers', () => {
  it('prefers the freshest working focus, then the latest active node, then the last row', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    expect(findFrontier(t.nodes, [session('s1', t.b.id, 'idle'), session('s2', t.a2.id, 'working')], l)).toBe(t.a2.id);
    expect(findFrontier(t.nodes, [], l)).toBe(t.a1.id);
    const idle = t.nodes.map((x) => (x.parentId === null ? x : { ...x, status: 'todo' as const }));
    expect(findFrontier(idle, [], layoutOutline({ nodes: idle, resources: [], sessions: [] }))).toBe(t.c.id);
  });

  it("takes the first owned entry when no session works, else the first unowned one, never a session's own focus", () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    const idle = [session('s1', t.b.id, 'idle'), session('s2', t.c.id, 'idle')];
    // s1's focus is left out of its own list; an ended owner's entry reads as unowned, behind every owned one.
    const queue = [entry(t.e.id, 'gone'), entry(t.b.id, 's1'), entry(t.d.id, 's1'), entry(t.a2.id, 's2')];
    expect(findFrontier(t.nodes, idle, l, queue)).toBe(t.d.id);
    expect(findFrontier(t.nodes, idle, l, [entry(t.b.id, 's1'), entry(t.e.id, 'gone'), entry(t.c.id)])).toBe(t.e.id);
  });

  it('takes the head of the queue when no session works, skipping entries that are gone or finished', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    const idle = [session('s1', t.b.id, 'idle')];
    expect(findFrontier(t.nodes, idle, l, later(t.c.id, t.b.id))).toBe(t.c.id);
    // A working session's focus still comes first.
    expect(findFrontier(t.nodes, [session('s2', t.a2.id, 'working')], l, later(t.c.id))).toBe(t.a2.id);
    const finished = t.nodes.map((x) => (x.id === t.c.id ? { ...x, status: 'done' as const } : x.id === t.d.id ? { ...x, status: 'dropped' as const } : x));
    expect(findFrontier(finished, idle, l, later(999, t.c.id, t.d.id, t.e.id))).toBe(t.e.id);
    // With nothing queued: the latest active node, as before.
    expect(findFrontier(t.nodes, idle, l, [])).toBe(t.a1.id);
  });

  it('maps events to the node the camera should visit', () => {
    const ev = (type: string, entityId: string, data: unknown): EventRow => ({ id: 1, ts: 't', projectId: 1, actor: 'x', type, entity: 'x', entityId, data });
    expect(eventTarget(ev('node.created', '5', { ids: [5, 6, 7] }))).toBe(7);
    expect(eventTarget(ev('node.updated', '4', {}))).toBe(4);
    expect(eventTarget(ev('node.moved', '6', { fromParentId: 1, toParentId: 2 }))).toBe(6);
    expect(eventTarget(ev('resource.created', '9', { nodeId: 3 }))).toBe(3);
    expect(eventTarget(ev('resource.updated', '9', { nodeId: 4, fromNodeId: 3 }))).toBe(4);
    expect(eventTarget(ev('log.created', '2', { nodeId: 8 }))).toBe(8);
    expect(eventTarget(ev('session.updated', 's1', { changed: ['focusNodeId'], focusNodeId: 11 }))).toBe(11);
    expect(eventTarget(ev('session.updated', 's1', { changed: ['focusNodeId'], focusNodeId: null }))).toBeUndefined();
    expect(eventTarget(ev('session.updated', 's1', { changed: ['state'], state: 'working' }))).toBeUndefined();
    expect(eventTarget(ev('work.updated', '57', { nodeId: 57 }))).toBe(57);
    expect(eventTarget(ev('project.updated', '1', { changes: { queue: { from: [], to: [5] } } }))).toBeUndefined();
    expect(eventTarget(ev('node.deleted', '4', { ids: [4] }))).toBeUndefined();
  });
});

describe('queued steps', () => {
  it('stay in view past the fold rules, so Up next never points into a "+n more" run', () => {
    const t = sample();
    const before = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    expect(before.nodeItems.has(t.e.id)).toBe(false);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], queue: later(t.e.id) });
    expect(l.nodeItems.get(t.e.id)).toMatchObject({ queue: { pos: 1, sessionId: null } });
  });

  it('stay in view whoever owns them', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.b.id, 'idle')], queue: [entry(t.d.id, 's1'), entry(t.e.id, 'gone')] });
    expect(l.nodeItems.get(t.d.id)).toMatchObject({ queue: { pos: 1, sessionId: 's1' } });
    expect(l.nodeItems.get(t.e.id)).toMatchObject({ queue: { pos: 1, sessionId: null } });
  });
});

describe('queueView', () => {
  it('lists open steps once, in order, leaving out ids that are gone and steps already finished', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.d.id ? { ...x, status: 'done' as const } : x.id === t.e.id ? { ...x, status: 'dropped' as const } : x));
    expect(queueView(later(t.c.id, t.a1.id, 999, t.c.id, t.d.id, t.e.id), nodes, [])).toEqual({ bySession: new Map(), unowned: [t.c.id, t.a1.id] });
  });

  it("splits the entries by owner, owners in stored order, each session's focus left out of its own list", () => {
    const t = sample();
    const sessions = [session('s1', t.a1.id, 'working'), session('s2', t.b.id, 'idle'), session('s3', t.e.id, 'idle')];
    const queue = [entry(t.c.id, 's2'), entry(t.a1.id, 's1'), entry(t.d.id, 's1'), entry(t.b.id, 's2'), entry(t.e.id, 's3'), entry(t.a2.id)];
    const view = queueView(queue, t.nodes, sessions);
    // s3 queued only its own focus, so it has no list at all.
    expect([...view.bySession]).toEqual([['s2', [t.c.id]], ['s1', [t.d.id]]]);
    expect(view.unowned).toEqual([t.a2.id]);
    // Another session's focus stays in the list of the session that queued it.
    expect([...queueView([entry(t.a1.id, 's2')], t.nodes, sessions).bySession]).toEqual([['s2', [t.a1.id]]]);
  });

  it('reads the entries of a session that has ended, or is not given, as unowned in their stored place', () => {
    const t = sample();
    const sessions = [session('s1', null, 'idle'), session('s2', t.c.id, 'ended')];
    const view = queueView([entry(t.c.id, 's2'), entry(t.a1.id, 's1'), entry(t.d.id, 'gone'), entry(t.e.id)], t.nodes, sessions);
    expect([...view.bySession]).toEqual([['s1', [t.a1.id]]]);
    expect(view.unowned).toEqual([t.c.id, t.d.id, t.e.id]);
  });
});

describe('the trail of ended work', () => {
  const ENDED = ago(60_000);

  it('counts a stale completed task as done and a stale open one as unfinished, shown only while the row is open, marked stale', () => {
    const t = sample();
    const live = work(t.a1.id, 'pending', { position: 1 });
    const finished = work(t.a1.id, 'completed', { position: 2, sessionId: 's0', endedAt: ENDED });
    const leftDoing = work(t.a1.id, 'in_progress', { position: 3, sessionId: 's0', endedAt: ENDED });
    const leftTodo = work(t.a1.id, 'pending', { position: 4, sessionId: 's0', endedAt: ENDED });
    const input = { nodes: t.nodes, resources: [], sessions: [], workItems: [live, finished, leftDoing, leftTodo], now: T0 };
    const shut = layoutOutline(input);
    expect(shut.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 1, unfinished: 2, agents: 0, open: false });
    expect(rowsOf(shut, 'work', 'workDone').map(([kind, id]) => [kind, id])).toEqual([['workDone', `wd${t.a1.id}`], ['work', `w${live.id}`]]);
    const open = layoutOutline({ ...input, overrides: { [`work:${t.a1.id}`]: 'open' } });
    expect(open.items.flatMap((i) => (i.kind === 'work' ? [[i.id, i.stale]] : []))).toEqual([
      [`w${live.id}`, false], [`w${finished.id}`, true], [`w${leftDoing.id}`, true], [`w${leftTodo.id}`, true],
    ]);
    // With nothing done, the unfinished ones still make the row.
    const unfinishedOnly = layoutOutline({ ...input, workItems: [leftTodo] });
    expect(rowsOf(unfinishedOnly, 'work', 'workDone').map(([kind]) => kind)).toEqual(['workDone']);
    expect(unfinishedOnly.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 0, unfinished: 1, agents: 0 });
  });

  it('counts the trail agents on a step and lists them after its tasks while the row is open', () => {
    const t = sample();
    const task = work(t.a1.id, 'completed', { sessionId: 's0', endedAt: ENDED });
    const input = {
      nodes: t.nodes, resources: [], sessions: [], workItems: [task], now: T0,
      trailAgents: [trailAgent('x', { nodeId: t.a1.id }), trailAgent('y', { nodeId: t.a1.id })], pastSessions: [past('s0', t.a1.id)],
    };
    const y = 3 * ROW;
    const shut = layoutOutline(input);
    expect(shut.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 1, unfinished: 0, agents: 2, open: false });
    expect(rowsOf(shut, 'work', 'workDone', 'trailAgent').map(([kind]) => kind)).toEqual(['workDone']);
    const open = layoutOutline({ ...input, overrides: { [`work:${t.a1.id}`]: 'open' } });
    expect(rowsOf(open, 'work', 'workDone', 'trailAgent')).toEqual([
      ['workDone', `wd${t.a1.id}`, t.a1.id, 3 * INDENT, y],
      ['work', `w${task.id}`, t.a1.id, 3 * INDENT, y + WORK_ROW],
      ['trailAgent', 'ts0:x', t.a1.id, 3 * INDENT, y + 2 * WORK_ROW],
      ['trailAgent', 'ts0:y', t.a1.id, 3 * INDENT, y + 3 * WORK_ROW],
    ]);
    expect(open.items.find((i) => i.id === 'ts0:x')).toEqual({ kind: 'trailAgent', id: 'ts0:x', sessionId: 's0', agentId: 'x', nodeId: t.a1.id, x: 3 * INDENT, y: y + 2 * WORK_ROW });
    expect(open.nodeItems.get(t.a2.id)?.y).toBe(y + 4 * WORK_ROW + WORK_GAP);
    // Agents alone make the row too.
    const agentsOnly = layoutOutline({ ...input, workItems: [] });
    expect(agentsOnly.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 0, unfinished: 0, agents: 2 });
  });

  it('never pins a step open and never pulses', () => {
    const t = sample();
    // D and E sit in the "+2 more" tail: an unfinished task in progress and a trail agent there keep them hidden.
    const left = work(t.e.id, 'in_progress', { sessionId: 's0', endedAt: ENDED });
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], workItems: [left], trailAgents: [trailAgent('x', { nodeId: t.d.id })], pastSessions: [past('s0', null)], now: T0 });
    expect(l.items.find((i) => i.kind === 'more')).toMatchObject({ hiddenIds: [t.d.id, t.e.id] });
    expect(rowsOf(l, 'work', 'workDone', 'trailAgent')).toEqual([]);
    const onA1 = work(t.a1.id, 'in_progress', { sessionId: 's0', endedAt: ENDED });
    const shown = layoutOutline({
      nodes: t.nodes, resources: [], sessions: [session('s0', t.a1.id, 'ended'), session('s1', t.a1.id, 'working')], workItems: [onA1],
      overrides: { [`work:${t.a1.id}`]: 'open' }, now: T0,
    });
    expect(shown.items.flatMap((i) => (i.kind === 'work' ? [[i.stale, i.pulse]] : []))).toEqual([[true, false]]);
  });

  it("shows a live session's stopped subagent as its greyed badge for 5 minutes and as trail after, an ended session's as trail at once, never both", () => {
    const t = sample();
    const recent = agent('x', { nodeId: t.a1.id, endedAt: ago(ENDED_AGENT_MS - 1000) });
    // The session's list can still carry an agent past 5 minutes on the client's clock: the snapshot is only refetched on events.
    const older = agent('y', { nodeId: t.a1.id, endedAt: ago(ENDED_AGENT_MS) });
    const s1 = withAgents(session('s1', t.a1.id, 'idle'), [recent, older]);
    const trailAgents = [{ ...recent, sessionId: 's1' }, { ...older, sessionId: 's1' }, trailAgent('z', { nodeId: t.a1.id, endedAt: ago(1000) })];
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], trailAgents, pastSessions: [past('s0', t.a1.id)], overrides: { [`work:${t.a1.id}`]: 'open' }, now: T0 });
    expect(rowsOf(l, 'agent', 'workDone', 'trailAgent').map(([kind, id]) => [kind, id])).toEqual([
      ['agent', 'as1:x'], ['workDone', `wd${t.a1.id}`], ['trailAgent', 'ts1:y'], ['trailAgent', 'ts0:z'],
    ]);
    expect(l.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 0, unfinished: 0, agents: 2 });
  });

  it("puts a trail agent on its step while that is in the tree; with no step, on its session's focus, live or past; else leaves it out", () => {
    const t = sample();
    const trailAgents = [
      trailAgent('x', { nodeId: t.b.id }),
      // Its step is not in this tree (its session moved to another project, say): left out, not moved to the focus.
      trailAgent('g', { nodeId: 999 }),
      trailAgent('p', { nodeId: null }),
      trailAgent('l', { sessionId: 's1', nodeId: null }),
      trailAgent('u', { sessionId: 'unknown', nodeId: null }),
      trailAgent('f', { sessionId: 's2', nodeId: null }),
      trailAgent('q', { sessionId: 's3', nodeId: null }),
    ];
    const pastSessions = [past('s0', t.a1.id), past('s2', null), past('s3', 999)];
    const overrides = Object.fromEntries([t.a1.id, t.b.id, t.c.id].map((id) => [`work:${id}`, 'open' as const]));
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.c.id, 'idle')], trailAgents, pastSessions, overrides, now: T0 });
    expect(rowsOf(l, 'trailAgent').map(([, id, nodeId]) => [id, nodeId])).toEqual([['ts0:p', t.a1.id], ['ts0:x', t.b.id], ['ts1:l', t.c.id]]);
  });

  it('folds with its node: hidden under a folded ancestor or in a done run until that opens, never moved up to a visible row', () => {
    const t = sample();
    const onA1 = { nodes: t.nodes, resources: [], sessions: [], trailAgents: [trailAgent('x', { nodeId: t.a1.id })], pastSessions: [past('s0', null)], now: T0 };
    expect(rowsOf(layoutOutline({ ...onA1, overrides: { ['n:' + t.a.id]: 'closed' } }), 'workDone', 'trailAgent')).toEqual([]);
    // A, B and C finished two days ago and fold into one "✓ 3 done" run under the root.
    const old = '2026-09-30T12:00:00Z';
    const nodes = t.nodes.map((x) =>
      x.id === t.a.id || x.id === t.a1.id || x.id === t.b.id ? { ...x, status: 'done' as const, assignee: 'claude' as const, completedAt: old }
      : x.id === t.a2.id || x.id === t.c.id ? { ...x, status: 'dropped' as const, assignee: 'claude' as const, updatedAt: old }
      : x,
    );
    const onB = { nodes, resources: [], sessions: [], trailAgents: [trailAgent('x', { nodeId: t.b.id })], pastSessions: [past('s0', null)], now: T0 };
    const folded = layoutOutline(onB);
    expect(folded.items.find((i) => i.kind === 'more')).toMatchObject({ variant: 'done', hiddenIds: [t.a.id, t.b.id, t.c.id] });
    expect(rowsOf(folded, 'workDone', 'trailAgent')).toEqual([]);
    const opened = layoutOutline({ ...onB, overrides: { [`done:${t.root.id}`]: 'open' } });
    expect(rowsOf(opened, 'workDone').map(([kind, , nodeId]) => [kind, nodeId])).toEqual([['workDone', t.b.id]]);
  });
});
