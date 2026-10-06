import { describe, expect, it } from 'vitest';
import { AGENT_LINE, CARD_GAP, CARD_PAD, DONE_LINE, FOLD_ROW, NODE_H, READERS_LINE, ROW, STACK_HEAD, TASK_ROW, agentVisible, eventTarget, findFrontier, formatUpNext, isPaused, layoutOutline, occupiedSteps, queueView, type LayoutItem, type LayoutResult } from '../../src/core/layout';
import { ENDED_AGENT_MS, READER_AGENT_TYPES, isReader, type EventRow, type PastSession, type QueueEntry, type ResourceMeta, type Session, type SubagentInfo, type TrailAgent, type TreeNode, type WorkItem, type WorkStatus } from '../../src/core/types';

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
  it('stacks one-line cards a ROW apart: the root at x 8, a depth-1 step at 56, its children at 84, every card ending at x 506', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    expect(l.items.map((i) => (i.kind === 'node' ? [i.id, i.x, i.y, i.h, i.w] : [i.id, i.x, i.y]))).toEqual([
      [`n${t.root.id}`, 8, 0, NODE_H, 498], [`n${t.a.id}`, 56, ROW, NODE_H, 450], [`n${t.a1.id}`, 84, 2 * ROW, NODE_H, 422],
      [`n${t.a2.id}`, 84, 3 * ROW, NODE_H, 422], [`n${t.b.id}`, 56, 4 * ROW, NODE_H, 450], [`n${t.c.id}`, 56, 5 * ROW, NODE_H, 450],
      [`more${t.root.id}-0`, 56, 6 * ROW],
    ]);
    expect(l.lanes).toEqual([]);
    // A fold row is 26 px tall: FOLD_ROW less the gap under it.
    expect(l.height).toBe(6 * ROW + FOLD_ROW - CARD_GAP);
  });

  it("draws a session's lead line inside its focus's card, marks the working chain, and the focus alone as the working focus", () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [resource(9, t.a2.id)], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.b.id, 'ended')] });
    expect(l.items.filter((i) => i.kind === 'line')).toEqual([
      { kind: 'line', id: `ls1:${t.a1.id}`, sessionId: 's1', nodeId: t.a1.id, lead: true, agentIds: [], x: 84, y: 2 * ROW + NODE_H },
    ]);
    expect(l.nodeItems.get(t.a1.id)).toMatchObject({ h: NODE_H + AGENT_LINE + CARD_PAD, working: true, workingFocus: true });
    expect(l.nodeItems.get(t.a2.id)).toMatchObject({ y: 2 * ROW + NODE_H + AGENT_LINE + CARD_PAD + CARD_GAP, needsYou: true, resourceIds: [9] });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ working: true, workingFocus: false });
    expect(l.nodeItems.get(t.b.id)).toMatchObject({ working: false, workingFocus: false });
  });

  it("marks only a working session's focus as the working focus: never its ancestors, nor an idle or waiting session's focus", () => {
    const t = sample();
    const sessions = [session('s1', t.a1.id, 'working'), session('s2', t.b.id, 'idle'), session('s3', t.c.id, 'permission')];
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions });
    expect([...l.nodeItems.values()].filter((i) => i.workingFocus).map((i) => i.nodeId)).toEqual([t.a1.id]);
    expect([...l.nodeItems.values()].filter((i) => i.working).map((i) => i.nodeId)).toEqual([t.root.id, t.a.id, t.a1.id]);
  });

  it('reports folded done counts and progress', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.a.id || x.id === t.a1.id ? { ...x, status: 'done' as const } : x.id === t.a2.id ? { ...x, assignee: 'claude' as const, status: 'done' as const } : x));
    const l = layoutOutline({ nodes, resources: [], sessions: [] });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ folded: true, doneCount: 2, progress: { done: 2, total: 2 } });
    expect(l.nodeItems.has(t.a1.id)).toBe(false);
  });

  it('draws the lead line on the nearest visible ancestor when a manual fold hides the focus', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working')], overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(l.nodeItems.has(t.a1.id)).toBe(false);
    expect(l.items.find((i) => i.kind === 'line')).toMatchObject({ id: `ls1:${t.a.id}`, nodeId: t.a.id, lead: true, x: 56, y: ROW + NODE_H });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ working: true, h: NODE_H + AGENT_LINE + CARD_PAD });
  });

  it('gives no line to a session without a focus or focused on a node that is gone', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', null, 'working'), session('s2', 999, 'working')] });
    expect(l.items.filter((i) => i.kind === 'line')).toEqual([]);
    expect([...l.nodeItems.values()].filter((i) => i.working || i.workingFocus)).toEqual([]);
    expect(l.height).toBe(layoutOutline({ nodes: t.nodes, resources: [], sessions: [] }).height);
  });

  it('gives each session on a card a line of its own, one AGENT_LINE each, in session order', () => {
    const t = sample();
    const both = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.a1.id, 'idle')] });
    const top = 2 * ROW + NODE_H;
    expect(both.items.filter((i) => i.kind === 'line').map((b) => [b.id, b.nodeId, b.x, b.y])).toEqual([
      [`ls1:${t.a1.id}`, t.a1.id, 84, top],
      [`ls2:${t.a1.id}`, t.a1.id, 84, top + AGENT_LINE],
    ]);
    expect(both.nodeItems.get(t.a1.id)?.h).toBe(NODE_H + 2 * AGENT_LINE + CARD_PAD);
    expect(both.nodeItems.get(t.a2.id)?.y).toBe(top + 2 * AGENT_LINE + CARD_PAD + CARD_GAP);
    expect(both.height).toBe(6 * ROW + FOLD_ROW - CARD_GAP + 2 * AGENT_LINE + CARD_PAD);
    // A fold that hides one session's focus puts its line on the anchor, after the line of the session already there.
    const folded = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.a.id, 'idle')], overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(folded.items.filter((i) => i.kind === 'line').map((b) => [b.id, b.nodeId, b.y])).toEqual([
      [`ls1:${t.a.id}`, t.a.id, ROW + NODE_H],
      [`ls2:${t.a.id}`, t.a.id, ROW + NODE_H + AGENT_LINE],
    ]);
  });

  it("draws edges only inside a card's subtree, never out of the root or a stack head, each uniquely named", () => {
    const t = sample();
    // A pinned needs-you child in the hidden tail splits it into two "+n more" runs. The root's rows get no edge.
    const f = n(t.root.id, 'F', { assignee: 'me' });
    const g = n(t.root.id, 'G');
    const h = n(t.root.id, 'H');
    const l = layoutOutline({ nodes: [...t.nodes, f, g, h], resources: [], sessions: [session('s1', t.a1.id, 'working')] });
    expect(l.items.filter((i) => i.kind === 'more').map((i) => i.id)).toEqual([`more${t.root.id}-0`, `more${t.root.id}-1`]);
    expect(l.edges).toEqual([
      { id: `e-n${t.a1.id}`, source: `n${t.a.id}`, target: `n${t.a1.id}` },
      { id: `e-n${t.a2.id}`, source: `n${t.a.id}`, target: `n${t.a2.id}` },
    ]);
    // Under a phase: none into the stack head's children, one into theirs.
    const a1a = n(t.a1.id, 'A1a');
    const phased = [...t.nodes.map((x) => (x.id === t.a.id ? { ...x, kind: 'phase' as const } : x)), a1a];
    expect(layoutOutline({ nodes: phased, resources: [], sessions: [] }).edges).toEqual([{ id: `e-n${a1a.id}`, source: `n${t.a1.id}`, target: `n${a1a.id}` }]);
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
    expect(l.items[1]).toEqual({ kind: 'more', id, parentId: t.root.id, run: 0, x: 56, y: ROW, depth: 1, hiddenIds: [t.a.id, t.b.id, t.c.id], variant: 'done' });
    expect(l.nodeItems.get(t.d.id)?.y).toBe(ROW + FOLD_ROW);
    // A fold row under the root gets no edge.
    expect(l.edges).toEqual([]);
    // Within a day of finishing, they show.
    expect(layoutOutline({ nodes, resources: [], sessions: [], now: Date.parse(old) + 60_000 }).items.some((i) => i.kind === 'more')).toBe(false);
    // The done: override opens the run.
    expect(layoutOutline({ nodes, resources: [], sessions: [], now, overrides: { [`done:${t.root.id}`]: 'open' } }).nodeItems.has(t.b.id)).toBe(true);
    // The tail keeps its id and says what it is.
    expect(layoutOutline({ nodes: t.nodes, resources: [], sessions: [], now }).items.find((i) => i.kind === 'more')).toMatchObject({ id: `more${t.root.id}-0`, variant: 'tail' });
  });

  it('keeps a deep card at least 240 wide', () => {
    nextId = 1;
    const chain = [n(null, 'Root', { status: 'active' })];
    for (let d = 1; d <= 9; d++) chain.push(n(chain[d - 1].id, `D${d}`, { status: 'active' }));
    const l = layoutOutline({ nodes: chain, resources: [], sessions: [] });
    expect(l.nodeItems.get(chain[8].id)).toMatchObject({ x: 252, w: 254 });
    expect(l.nodeItems.get(chain[9].id)).toMatchObject({ x: 280, w: 240 });
  });
});

describe('stacks and lanes', () => {
  /** sample(), with A and B as phases. */
  function phased() {
    const t = sample();
    return { ...t, nodes: t.nodes.map((x) => (x.id === t.a.id || x.id === t.b.id ? { ...x, kind: 'phase' as const } : x)) };
  }
  /** Each row as [id, x, y], with h, w and stack on a card. */
  const boxes = (l: LayoutResult) => l.items.map((i) => (i.kind === 'node' ? [i.id, i.x, i.y, i.h, i.w, i.stack] : [i.id, i.x, i.y]));

  it("draws a depth-1 phase as a stack head at x 22 that opens a lane, with its children at 56 inside it and no edges", () => {
    const t = phased();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    // A's lane opens 18 below the root's card (32 + 18 = 50), and its head sits 9 into it (59). A1 starts STACK_HEAD
    // below the head's top. The lane closes 12 below A2 (176 + 12 = 188), and B's lane opens 18 below that (206).
    expect(boxes(l)).toEqual([
      [`n${t.root.id}`, 8, 0, 32, 498, false],
      [`n${t.a.id}`, 22, 59, 33, 484, true],
      [`n${t.a1.id}`, 56, 59 + STACK_HEAD, 32, 450, false],
      [`n${t.a2.id}`, 56, 144, 32, 450, false],
      [`n${t.b.id}`, 22, 215, 33, 484, true],
      [`n${t.c.id}`, 56, 278, 32, 450, false],
      [`more${t.root.id}-0`, 56, 320],
    ]);
    expect(l.lanes).toEqual([
      { id: `lane${t.a.id}`, nodeId: t.a.id, x: 8, y: 50, w: 504, h: 138 },
      { id: `lane${t.b.id}`, nodeId: t.b.id, x: 8, y: 206, w: 504, h: 54 },
    ]);
    expect(l.edges).toEqual([]);
    expect(l.height).toBe(346);
  });

  it('gives a folded phase a lane that holds only its head', () => {
    const t = phased();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ y: 59, h: 33, folded: true, stack: true });
    // 9 above the head, the 33 px head, 12 below it.
    expect(l.lanes[0]).toEqual({ id: `lane${t.a.id}`, nodeId: t.a.id, x: 8, y: 50, w: 504, h: 54 });
  });

  it("closes a lane at the root's fold row, which sits at x 56 outside it", () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.a.id || x.id === t.c.id ? { ...x, kind: 'phase' as const } : x));
    const l = layoutOutline({ nodes, resources: [], sessions: [] });
    expect(l.lanes.map((x) => [x.id, x.y, x.h])).toEqual([[`lane${t.a.id}`, 50, 138], [`lane${t.c.id}`, 256, 54]]);
    // C's lane ends 12 below its head (298 + 12 = 310), and the fold row starts LANE_GAP (18) below that.
    expect(l.items.at(-1)).toMatchObject({ id: `more${t.root.id}-0`, x: 56, y: 328 });
    expect(l.height).toBe(354);
  });

  it('draws a depth-1 step that is not a phase at x 56 outside any lane, its children at 84 with edges, and the root\'s fold rows at 56', () => {
    const t = phased();
    const c1 = n(t.c.id, 'C1');
    const l = layoutOutline({ nodes: [...t.nodes, c1], resources: [], sessions: [] });
    expect(boxes(l).slice(5)).toEqual([
      [`n${t.c.id}`, 56, 278, 32, 450, false],
      [`n${c1.id}`, 84, 320, 32, 422, false],
      [`more${t.root.id}-0`, 56, 362],
    ]);
    expect(l.lanes.map((x) => x.id)).toEqual([`lane${t.a.id}`, `lane${t.b.id}`]);
    expect(l.edges).toEqual([{ id: `e-n${c1.id}`, source: `n${t.c.id}`, target: `n${c1.id}` }]);
    expect(l.height).toBe(388);
  });

  it("puts a session's line on a stack head STACK_HEAD below its top, and the lane grows with it", () => {
    const t = phased();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a.id, 'idle')] });
    expect(l.items.filter((i) => i.kind === 'line')).toEqual([
      { kind: 'line', id: `ls1:${t.a.id}`, sessionId: 's1', nodeId: t.a.id, lead: true, agentIds: [], x: 22, y: 59 + STACK_HEAD },
    ]);
    // A stack head's box ends with its own lines: no CARD_PAD.
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ y: 59, h: STACK_HEAD + AGENT_LINE });
    expect([t.a1, t.a2, t.b, t.c].map((x) => l.nodeItems.get(x.id)?.y)).toEqual([140, 182, 253, 316]);
    expect(l.lanes.map((x) => [x.id, x.y, x.h])).toEqual([[`lane${t.a.id}`, 50, 176], [`lane${t.b.id}`, 244, 54]]);
    expect(l.height).toBe(384);
  });
});

const T0 = Date.parse('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(T0 - ms).toISOString();
const agent = (agentId: string, extra: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId, agentType: 'general-purpose', startedAt: ago(60_000), description: `Agent ${agentId}`, model: 'sonnet', nodeId: null, endedAt: null, ordinal: 1, purpose: null, endReason: null, lastActiveAt: null, ...extra,
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
  it('sit in TASK_ROW rows inside their card, in position order, with CARD_PAD under the last', () => {
    const t = sample();
    const first = work(t.a1.id, 'in_progress', { position: 1 });
    const second = work(t.a1.id, 'pending', { position: 2 });
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], workItems: [second, first], now: T0 });
    const top = 2 * ROW + NODE_H;
    expect(rowsOf(l, 'work', 'workDone')).toEqual([
      ['work', `w${first.id}`, t.a1.id, 84, top],
      ['work', `w${second.id}`, t.a1.id, 84, top + TASK_ROW],
    ]);
    expect(l.items.find((i) => i.kind === 'work')).toMatchObject({ workId: first.id });
    expect(l.nodeItems.get(t.a1.id)?.h).toBe(NODE_H + 2 * TASK_ROW + CARD_PAD);
    expect(l.nodeItems.get(t.a2.id)?.y).toBe(top + 2 * TASK_ROW + CARD_PAD + CARD_GAP);
    expect(l.height).toBe(6 * ROW + FOLD_ROW - CARD_GAP + 2 * TASK_ROW + CARD_PAD);
  });

  it('come after the lines in their card', () => {
    const t = sample();
    const task = work(t.a1.id, 'pending');
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working')], workItems: [task], now: T0 });
    expect(rowsOf(l, 'line', 'work')).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id, 84, 2 * ROW + NODE_H],
      ['work', `w${task.id}`, t.a1.id, 84, 2 * ROW + NODE_H + AGENT_LINE],
    ]);
  });

  it('fold completed tasks into one "✓ n done" row first, which a work:<id> override opens', () => {
    const t = sample();
    const c1 = work(t.a1.id, 'completed', { position: 1 });
    const p = work(t.a1.id, 'pending', { position: 2 });
    const c2 = work(t.a1.id, 'completed', { position: 3 });
    const input = { nodes: t.nodes, resources: [], sessions: [], workItems: [c1, p, c2], now: T0 };
    const y = 2 * ROW + NODE_H;
    const shut = layoutOutline(input);
    // With no agent or readers line on the card, the done row takes a line of its own.
    expect(rowsOf(shut, 'work', 'workDone')).toEqual([
      ['workDone', `wd${t.a1.id}`, t.a1.id, 84, y],
      ['work', `w${p.id}`, t.a1.id, 84, y + DONE_LINE],
    ]);
    expect(shut.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 2, open: false, shared: false });
    const open = layoutOutline({ ...input, overrides: { [`work:${t.a1.id}`]: 'open' } });
    expect(rowsOf(open, 'work', 'workDone').map(([kind, id, , , rowY]) => [kind, id, rowY])).toEqual([
      ['workDone', `wd${t.a1.id}`, y],
      ['work', `w${c1.id}`, y + DONE_LINE],
      ['work', `w${p.id}`, y + DONE_LINE + TASK_ROW],
      ['work', `w${c2.id}`, y + DONE_LINE + 2 * TASK_ROW],
    ]);
    expect(open.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 2, open: true });
    // All done: the one row.
    const allDone = layoutOutline({ ...input, workItems: [c1, c2] });
    expect(rowsOf(allDone, 'work', 'workDone').map(([kind]) => kind)).toEqual(['workDone']);
    expect(allDone.nodeItems.get(t.a2.id)?.y).toBe(y + DONE_LINE + CARD_PAD + CARD_GAP);
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
    expect(folded.height).toBe(4 * ROW + FOLD_ROW - CARD_GAP);
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

describe('agent lines', () => {
  /** What one line adds to a card that had none: the line and the pad under it. */
  const grow = AGENT_LINE + CARD_PAD;

  it("put a session's workers as kin on its lead line at its focus, and on a line without a lead on any other card", () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [agent('x', { nodeId: t.b.id }), agent('y'), agent('z', { nodeId: 999 })]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], now: T0 });
    expect(rowsOf(l, 'line')).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id, 84, 2 * ROW + NODE_H],
      ['line', `ls1:${t.b.id}`, t.b.id, 56, 4 * ROW + grow + NODE_H],
    ]);
    expect(l.items.find((i) => i.id === `ls1:${t.a1.id}`)).toMatchObject({ sessionId: 's1', lead: true, agentIds: ['y', 'z'] });
    expect(l.items.find((i) => i.id === `ls1:${t.b.id}`)).toMatchObject({ sessionId: 's1', lead: false, agentIds: ['x'] });
    expect(l.nodeItems.get(t.c.id)?.y).toBe(5 * ROW + 2 * grow);
  });

  it('keep an ended worker as a kin for 5 minutes after it stopped', () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'idle'), [agent('x', { endedAt: ago(ENDED_AGENT_MS - 1000) }), agent('y', { endedAt: ago(ENDED_AGENT_MS) })]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], now: T0 });
    expect(l.items.filter((i) => i.kind === 'line')).toEqual([expect.objectContaining({ id: `ls1:${t.a1.id}`, lead: true, agentIds: ['x'] })]);
  });

  it('keep a worker that hit the usage limit as a kin past 5 minutes while its session lives; any other end leaves after 5', () => {
    const t = sample();
    const hour = 60 * 60_000;
    const limit = agent('x', { endedAt: ago(hour), endReason: 'limit', lastActiveAt: ago(hour + 60_000) });
    const killed = agent('y', { endedAt: ago(hour), endReason: 'killed', lastActiveAt: ago(hour + 60_000) });
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [withAgents(session('s1', t.a1.id, 'idle'), [limit, killed])], now: T0 });
    expect(l.items.filter((i) => i.kind === 'line')).toEqual([expect.objectContaining({ id: `ls1:${t.a1.id}`, agentIds: ['x'] })]);
    expect(agentVisible(limit, T0)).toBe(true);
    expect(agentVisible(killed, T0)).toBe(false);
  });

  it("sit on the nearest visible ancestor when a manual fold hides their node, and need a node or their session's focus", () => {
    const t = sample();
    const s1 = withAgents(session('s1', null, 'working'), [agent('x', { nodeId: t.a1.id }), agent('y')]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], overrides: { ['n:' + t.a.id]: 'closed' }, now: T0 });
    expect(rowsOf(l, 'line')).toEqual([['line', `ls1:${t.a.id}`, t.a.id, 56, ROW + NODE_H]]);
    expect(l.items.find((i) => i.kind === 'line')).toMatchObject({ lead: false, agentIds: ['x'] });
  });

  it("leave an ended session's subagents out", () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [withAgents(session('s1', t.a1.id, 'ended'), [agent('x')])], now: T0 });
    expect(rowsOf(l, 'line')).toEqual([]);
  });
});

describe('readers', () => {
  const reader = (agentId: string, extra: Partial<SubagentInfo> = {}) => agent(agentId, { agentType: 'Explore', ...extra });

  it('give a running reader no kin: each session folds its running readers on a card into one readers line after its own line', () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [
      reader('r1'), agent('w1'), reader('r2', { agentType: 'Plan', nodeId: t.a1.id }), reader('r3', { agentType: 'claude-code-guide', nodeId: t.b.id }),
    ]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], now: T0 });
    const top = 2 * ROW + NODE_H;
    const bY = 4 * ROW + AGENT_LINE + READERS_LINE + CARD_PAD;
    expect(rowsOf(l, 'line', 'readers')).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id, 84, top],
      ['readers', `rs1:${t.a1.id}`, t.a1.id, 84, top + AGENT_LINE],
      ['readers', `rs1:${t.b.id}`, t.b.id, 56, bY + NODE_H],
    ]);
    expect(l.items.find((i) => i.id === `ls1:${t.a1.id}`)).toMatchObject({ lead: true, agentIds: ['w1'] });
    expect(l.items.find((i) => i.id === `rs1:${t.a1.id}`)).toEqual({ kind: 'readers', id: `rs1:${t.a1.id}`, sessionId: 's1', nodeId: t.a1.id, agentIds: ['r1', 'r2'], x: 84, y: top + AGENT_LINE });
    expect(l.nodeItems.get(t.c.id)?.y).toBe(bY + NODE_H + READERS_LINE + CARD_PAD + CARD_GAP);
  });

  it("keep each session's readers apart on a shared card, each after its own session's line", () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [reader('r1')]);
    const s2 = withAgents(session('s2', t.a1.id, 'working'), [reader('r2'), reader('r3')]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1, s2], now: T0 });
    expect(rowsOf(l, 'line', 'readers').map(([kind, id]) => [kind, id])).toEqual([
      ['line', `ls1:${t.a1.id}`], ['readers', `rs1:${t.a1.id}`], ['line', `ls2:${t.a1.id}`], ['readers', `rs2:${t.a1.id}`],
    ]);
    expect(l.items.find((i) => i.id === `rs2:${t.a1.id}`)).toMatchObject({ agentIds: ['r2', 'r3'] });
  });

  it('fold readers on a hidden step into the row of its nearest visible ancestor', () => {
    const t = sample();
    const s1 = withAgents(session('s1', null, 'working'), [reader('r1', { nodeId: t.a1.id }), reader('r2', { nodeId: t.a2.id })]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], overrides: { ['n:' + t.a.id]: 'closed' }, now: T0 });
    expect(l.items.filter((i) => i.kind === 'readers')).toEqual([expect.objectContaining({ id: `rs1:${t.a.id}`, nodeId: t.a.id, agentIds: ['r1', 'r2'] })]);
  });

  it('show an ended reader nowhere, pinning nothing, while a running one pins its step as a worker does', () => {
    const t = sample();
    const f = n(t.root.id, 'F');
    const g = n(t.root.id, 'G');
    const nodes = [...t.nodes, f, g];
    const hidden = (l: LayoutResult) => l.items.flatMap((i) => (i.kind === 'more' ? i.hiddenIds : []));
    const kin = (l: LayoutResult) => l.items.flatMap((i) => (i.kind === 'line' ? i.agentIds : []));
    const ended = withAgents(session('s1', t.a1.id, 'working'), [reader('r1', { nodeId: t.e.id, endedAt: ago(60_000) })]);
    const gone = layoutOutline({ nodes, resources: [], sessions: [ended], now: T0 });
    expect(rowsOf(gone, 'readers')).toEqual([]);
    expect(kin(gone)).toEqual([]);
    expect(hidden(gone)).toContain(t.e.id);
    const running = withAgents(session('s1', t.a1.id, 'working'), [reader('r1', { nodeId: t.e.id })]);
    const shown = layoutOutline({ nodes, resources: [], sessions: [running], now: T0 });
    expect(hidden(shown)).not.toContain(t.e.id);
    expect(rowsOf(shown, 'readers').map(([kind, id]) => [kind, id])).toEqual([['readers', `rs1:${t.e.id}`]]);
    // A reader is never a kin.
    expect(kin(shown)).toEqual([]);
  });

  it('tell readers by type, and agentVisible keeps a running reader and drops an ended one', () => {
    expect(READER_AGENT_TYPES).toEqual(['Explore', 'Plan', 'claude-code-guide']);
    expect(['Explore', 'Plan', 'claude-code-guide', 'general-purpose', 'explore', 'inprogress-scribe'].map(isReader)).toEqual([true, true, true, false, false, false]);
    expect(agentVisible(reader('r1'), T0)).toBe(true);
    expect(agentVisible(reader('r1', { endedAt: ago(1000) }), T0)).toBe(false);
    expect(agentVisible(agent('w1', { endedAt: ago(1000) }), T0)).toBe(true);
    expect(agentVisible(agent('w1', { endedAt: ago(ENDED_AGENT_MS) }), T0)).toBe(false);
  });
});

describe('the done row in a card', () => {
  /** s1 works on A1 with a worker x, and with two readers when asked; A1 holds four tasks, the first completed. */
  function busy(readers: boolean) {
    const t = sample();
    const reading = readers ? [agent('r1', { agentType: 'Explore' }), agent('r2', { agentType: 'Explore' })] : [];
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [agent('x'), ...reading]);
    const tasks = [1, 2, 3, 4].map((position) => work(t.a1.id, position === 1 ? 'completed' : 'pending', { position }));
    return { t, tasks, l: layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], workItems: tasks, now: T0 }) };
  }

  it("shares the card's last line when that line holds no kin: here the readers line", () => {
    const { t, tasks, l } = busy(true);
    // 116 is A1's y (84) plus NODE_H; then the 28 px agent line, the 20 px readers line and three 22 px task rows.
    expect(rowsOf(l, 'line', 'readers', 'workDone', 'work')).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id, 84, 116],
      ['readers', `rs1:${t.a1.id}`, t.a1.id, 84, 144],
      ['workDone', `wd${t.a1.id}`, t.a1.id, 84, 144],
      ['work', `w${tasks[1].id}`, t.a1.id, 84, 164],
      ['work', `w${tasks[2].id}`, t.a1.id, 84, 186],
      ['work', `w${tasks[3].id}`, t.a1.id, 84, 208],
    ]);
    expect(l.items.find((i) => i.kind === 'line')).toMatchObject({ lead: true, agentIds: ['x'] });
    expect(l.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 1, shared: true });
    // 32 + 28 + 20 + 3 × 22 + 8: the done row adds nothing.
    expect(l.nodeItems.get(t.a1.id)).toMatchObject({ y: 84, h: 154, workingFocus: true });
    expect(l.nodeItems.get(t.a2.id)?.y).toBe(248);
    expect(l.height).toBe(400);
  });

  it('takes a DONE_LINE of its own when the last line holds kin', () => {
    const { t, l } = busy(false);
    expect(rowsOf(l, 'line', 'readers', 'workDone', 'work').map(([kind, , , , y]) => [kind, y])).toEqual([
      ['line', 116], ['workDone', 144], ['work', 164], ['work', 186], ['work', 208],
    ]);
    expect(l.items.find((i) => i.kind === 'workDone')).toMatchObject({ shared: false });
    // 32 + 28 + 20 + 3 × 22 + 8.
    expect(l.nodeItems.get(t.a1.id)?.h).toBe(154);
  });

  it('shares a lead line that holds no kin, and adds no height', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'idle')], workItems: [work(t.a1.id, 'completed')], now: T0 });
    expect(rowsOf(l, 'line', 'workDone').map(([kind, , , , y]) => [kind, y])).toEqual([['line', 116], ['workDone', 116]]);
    expect(l.items.find((i) => i.kind === 'workDone')).toMatchObject({ shared: true });
    expect(l.nodeItems.get(t.a1.id)?.h).toBe(NODE_H + AGENT_LINE + CARD_PAD);
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
    expect(rowsOf(l, 'line', 'work').map(([kind, id, nodeId]) => [kind, id, nodeId])).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id],
      ['line', `ls1:${t.e.id}`, t.e.id],
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

describe('formatUpNext', () => {
  /** s1 is A and s2 is B; s3 has no slot yet. */
  function owners() {
    const t = sample();
    const sessions = [session('s1', t.b.id, 'idle'), { ...session('s2', null, 'idle'), slot: 1 }, { ...session('s3', null, 'idle'), slot: null }];
    return { t, sessions };
  }

  it('prints each owner by its letter, then later, with bare ids: the outline and set_queue form', () => {
    const { t, sessions } = owners();
    const view = queueView([entry(t.c.id, 's1'), entry(t.a1.id, 's1'), entry(t.d.id, 's2'), entry(t.e.id)], t.nodes, sessions);
    expect(formatUpNext(view, sessions)).toBe(`Up next: A: #${t.c.id} → #${t.a1.id} | B: #${t.d.id} | later: #${t.e.id}`);
    expect(formatUpNext(queueView(later(t.e.id, t.d.id), t.nodes, sessions), sessions)).toBe(`Up next: later: #${t.e.id} → #${t.d.id}`);
    expect(formatUpNext(queueView([entry(t.c.id, 's2')], t.nodes, sessions), sessions)).toBe(`Up next: B: #${t.c.id}`);
  });

  it('prints ? for an owner whose slot is still empty, never an empty letter', () => {
    const { t, sessions } = owners();
    const view = queueView([entry(t.c.id, 's3'), entry(t.d.id)], t.nodes, sessions);
    expect(formatUpNext(view, sessions)).toBe(`Up next: ?: #${t.c.id} | later: #${t.d.id}`);
    expect(formatUpNext(view, sessions, { sessionId: 's1', nodes: t.nodes })).toBe(`Up next: ?: #${t.c.id} · later: #${t.d.id}`);
    // The reader's own part leaves the letter out instead.
    expect(formatUpNext(view, sessions, { sessionId: 's3', nodes: t.nodes })).toBe(`Up next (you): #${t.c.id} C · later: #${t.d.id}`);
  });

  it("prints nothing when no step is up next, as when the only entry is a session's own focus", () => {
    const { t, sessions } = owners();
    expect(formatUpNext(queueView([], t.nodes, sessions), sessions)).toBeUndefined();
    const focusOnly = queueView([entry(t.b.id, 's1')], t.nodes, sessions);
    expect(formatUpNext(focusOnly, sessions)).toBeUndefined();
    expect(formatUpNext(focusOnly, sessions, { sessionId: 's1', nodes: t.nodes })).toBeUndefined();
  });

  it("puts the reader's own part first, titled and capped at five, then the others with bare ids: the briefing form", () => {
    const { t, sessions } = owners();
    const glyphed = t.nodes.map((x) => (x.id === t.c.id ? { ...x, label: 'server' as const } : x));
    const view = queueView([entry(t.d.id, 's2'), entry(t.c.id, 's1'), entry(t.a1.id, 's1'), entry(t.e.id)], glyphed, sessions);
    expect(formatUpNext(view, sessions, { sessionId: 's1', nodes: glyphed })).toBe(`Up next (you, A): #${t.c.id} ⚙ C → #${t.a1.id} A1 · B: #${t.d.id} · later: #${t.e.id}`);
    // With none of its own, the reader's part is left out, and the owners keep their stored order.
    expect(formatUpNext(view, sessions, { sessionId: 's3', nodes: glyphed })).toBe(`Up next: B: #${t.d.id} · A: #${t.c.id} → #${t.a1.id} · later: #${t.e.id}`);
    const many = [t.a.id, t.a1.id, t.a2.id, t.c.id, t.d.id, t.e.id, t.root.id];
    const long = queueView(many.map((id) => entry(id, 's2')), t.nodes, sessions);
    expect(formatUpNext(long, sessions, { sessionId: 's2', nodes: t.nodes })).toBe(`Up next (you, B): ${['A', 'A1', 'A2', 'C', 'D'].map((title, i) => `#${many[i]} ${title}`).join(' → ')} (+2 more)`);
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
    const y = 2 * ROW + NODE_H;
    const shut = layoutOutline(input);
    expect(shut.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 1, unfinished: 0, agents: 2, open: false, shared: false });
    expect(rowsOf(shut, 'work', 'workDone', 'trailAgent').map(([kind]) => kind)).toEqual(['workDone']);
    const open = layoutOutline({ ...input, overrides: { [`work:${t.a1.id}`]: 'open' } });
    expect(rowsOf(open, 'work', 'workDone', 'trailAgent')).toEqual([
      ['workDone', `wd${t.a1.id}`, t.a1.id, 84, y],
      ['work', `w${task.id}`, t.a1.id, 84, y + DONE_LINE],
      ['trailAgent', 'ts0:x', t.a1.id, 84, y + DONE_LINE + TASK_ROW],
      ['trailAgent', 'ts0:y', t.a1.id, 84, y + DONE_LINE + 2 * TASK_ROW],
    ]);
    expect(open.items.find((i) => i.id === 'ts0:x')).toEqual({ kind: 'trailAgent', id: 'ts0:x', sessionId: 's0', agentId: 'x', nodeId: t.a1.id, x: 84, y: y + DONE_LINE + TASK_ROW });
    expect(open.nodeItems.get(t.a2.id)?.y).toBe(y + DONE_LINE + 3 * TASK_ROW + CARD_PAD + CARD_GAP);
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

  it("shows a live session's stopped subagent as an ended kin for 5 minutes and as trail after, an ended session's as trail at once, never both", () => {
    const t = sample();
    const recent = agent('x', { nodeId: t.a1.id, endedAt: ago(ENDED_AGENT_MS - 1000) });
    // The session's list can still carry an agent past 5 minutes on the client's clock: the snapshot is only refetched on events.
    const older = agent('y', { nodeId: t.a1.id, endedAt: ago(ENDED_AGENT_MS) });
    const s1 = withAgents(session('s1', t.a1.id, 'idle'), [recent, older]);
    const trailAgents = [{ ...recent, sessionId: 's1' }, { ...older, sessionId: 's1' }, trailAgent('z', { nodeId: t.a1.id, endedAt: ago(1000) })];
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], trailAgents, pastSessions: [past('s0', t.a1.id)], overrides: { [`work:${t.a1.id}`]: 'open' }, now: T0 });
    expect(rowsOf(l, 'line', 'workDone', 'trailAgent').map(([kind, id]) => [kind, id])).toEqual([
      ['line', `ls1:${t.a1.id}`], ['workDone', `wd${t.a1.id}`], ['trailAgent', 'ts1:y'], ['trailAgent', 'ts0:z'],
    ]);
    expect(l.items.find((i) => i.kind === 'line')).toMatchObject({ lead: true, agentIds: ['x'] });
    expect(l.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 0, unfinished: 0, agents: 2 });
  });

  it("keeps a live session's usage-limit agent out of the trail while it waits as a kin, and puts it there once its session ends", () => {
    const t = sample();
    const limit = agent('x', { nodeId: t.a1.id, endedAt: ago(60 * 60_000), endReason: 'limit', lastActiveAt: ago(61 * 60_000) });
    const trailAgents = [{ ...limit, sessionId: 's1' }];
    const input = { nodes: t.nodes, resources: [], trailAgents, overrides: { [`work:${t.a1.id}`]: 'open' as const }, now: T0 };
    const live = layoutOutline({ ...input, sessions: [withAgents(session('s1', t.a1.id, 'idle'), [limit])] });
    expect(rowsOf(live, 'trailAgent')).toEqual([]);
    expect(live.items.find((i) => i.kind === 'line')).toMatchObject({ agentIds: ['x'] });
    const ended = layoutOutline({ ...input, sessions: [], pastSessions: [past('s1', t.a1.id)] });
    expect(rowsOf(ended, 'trailAgent').map(([kind, id]) => [kind, id])).toEqual([['trailAgent', 'ts1:x']]);
  });

  it('leaves a reader out of the trail, should the snapshot ever list one: readers leave no trail', () => {
    const t = sample();
    const task = work(t.a1.id, 'completed', { sessionId: 's0', endedAt: ENDED });
    const l = layoutOutline({
      nodes: t.nodes, resources: [], sessions: [], workItems: [task], now: T0,
      trailAgents: [trailAgent('r', { nodeId: t.a1.id, agentType: 'Explore' })], pastSessions: [past('s0', t.a1.id)],
      overrides: { [`work:${t.a1.id}`]: 'open' },
    });
    expect(rowsOf(l, 'trailAgent')).toEqual([]);
    expect(l.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 1, unfinished: 0, agents: 0 });
  });

  it("puts a trail agent on its step while that is in the tree; with no node (no step, no start focus), on its session's focus, live or past; else leaves it out", () => {
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

describe('paused', () => {
  /** The ids of the rows drawn paused, in row order. */
  const pausedIds = (l: LayoutResult) => [...l.nodeItems.values()].filter((i) => i.paused).map((i) => i.nodeId);
  const layout = (t: ReturnType<typeof sample>, extra: Partial<Parameters<typeof layoutOutline>[0]> = {}) =>
    layoutOutline({ nodes: t.nodes, resources: [], sessions: [], now: T0, ...extra });

  it("marks an active step of Claude's that nothing occupies, its parent too, never the root", () => {
    const t = sample();
    expect(pausedIds(layout(t))).toEqual([t.a.id, t.a1.id]);
    expect(layout(t).nodeItems.get(t.root.id)?.paused).toBe(false);
  });

  it("keeps a live session's focus and its ancestors unpaused, an idle session's too, but not an ended one's", () => {
    const t = sample();
    for (const state of ['working', 'idle', 'permission'] as const) {
      expect(pausedIds(layout(t, { sessions: [session('s1', t.a1.id, state)] })), state).toEqual([]);
    }
    expect(pausedIds(layout(t, { sessions: [session('s1', t.a1.id, 'ended')] }))).toEqual([t.a.id, t.a1.id]);
  });

  it('keeps a parent unpaused while any descendant is occupied, and leaves the siblings paused', () => {
    const t = sample();
    // A focus on Aiden's step under A keeps A unpaused; A1 beside it is still nobody's.
    expect(pausedIds(layout(t, { sessions: [session('s1', t.a2.id, 'idle')] }))).toEqual([t.a1.id]);
  });

  it("keeps a running subagent's step unpaused, a worker's or a reader's, but not one that has stopped", () => {
    const t = sample();
    const on = (a: SubagentInfo) => layout(t, { sessions: [withAgents(session('s1', t.b.id, 'working'), [a])] });
    expect(pausedIds(on(agent('w1', { nodeId: t.a1.id })))).toEqual([]);
    expect(pausedIds(on(agent('r1', { agentType: 'Explore', nodeId: t.a1.id })))).toEqual([]);
    // Stopped a minute ago, it still shows greyed, but nobody is on the step any more.
    expect(pausedIds(on(agent('w2', { nodeId: t.a1.id, endedAt: ago(60_000) })))).toEqual([t.a.id, t.a1.id]);
    expect(pausedIds(on(agent('r2', { agentType: 'Explore', nodeId: t.a1.id, endedAt: ago(60_000) })))).toEqual([t.a.id, t.a1.id]);
    // With no node of its own (no step and no start focus), a subagent is on its session's focus.
    const s = withAgents(session('s1', t.a1.id, 'working'), [agent('w3')]);
    expect(pausedIds(layout(t, { sessions: [s] }))).toEqual([]);
  });

  it('keeps a step unpaused while a subagent waits on it at the usage limit, and frees it for any other end', () => {
    const t = sample();
    const on = (a: SubagentInfo, state: Session['state'] = 'working') => layout(t, { sessions: [withAgents(session('s1', t.b.id, state), [a])] });
    const ended = { nodeId: t.a1.id, endedAt: ago(60 * 60_000), lastActiveAt: ago(61 * 60_000) };
    expect(pausedIds(on(agent('w1', { ...ended, endReason: 'limit' })))).toEqual([]);
    for (const endReason of ['error', 'killed', 'silent', 'session'] as const) {
      expect(pausedIds(on(agent('w2', { ...ended, endedAt: ago(60_000), endReason }))), endReason).toEqual([t.a.id, t.a1.id]);
    }
    // Its session's end frees it too.
    expect(pausedIds(on(agent('w3', { ...ended, endReason: 'limit' }), 'ended'))).toEqual([t.a.id, t.a1.id]);
  });

  it("keeps a step with a live session's task in progress unpaused, but not an ended session's or a pending one", () => {
    const t = sample();
    expect(pausedIds(layout(t, { workItems: [work(t.a1.id, 'in_progress')] }))).toEqual([]);
    expect(pausedIds(layout(t, { workItems: [work(t.a1.id, 'in_progress', { endedAt: ago(60_000) })] }))).toEqual([t.a.id, t.a1.id]);
    expect(pausedIds(layout(t, { workItems: [work(t.a1.id, 'pending'), work(t.a1.id, 'completed')] }))).toEqual([t.a.id, t.a1.id]);
  });

  it('leaves a step assigned to Aiden, or not active, unpaused', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.a1.id ? { ...x, assignee: 'me' as const } : x.id === t.b.id ? { ...x, status: 'blocked' as const } : x));
    const l = layout({ ...t, nodes });
    expect(pausedIds(l)).toEqual([t.a.id]);
    expect(l.nodeItems.get(t.a1.id)).toMatchObject({ needsYou: true, paused: false });
  });

  it('never changes with a manual fold: the hidden focus still keeps its ancestors unpaused', () => {
    const t = sample();
    const overrides = { ['n:' + t.a.id]: 'closed' as const };
    expect(layout(t, { overrides }).nodeItems.has(t.a1.id)).toBe(false);
    expect(pausedIds(layout(t, { overrides }))).toEqual([t.a.id]);
    expect(pausedIds(layout(t, { overrides, sessions: [session('s1', t.a1.id, 'idle')] }))).toEqual([]);
    expect(pausedIds(layout(t, { overrides, workItems: [work(t.a1.id, 'in_progress')] }))).toEqual([]);
  });

  it('is the test Details runs on the snapshot: occupiedSteps and isPaused pick the steps the layout draws paused', () => {
    const t = sample();
    const byId = new Map(t.nodes.map((x) => [x.id, x]));
    const pausedBy = (sessions: Session[], workItems: WorkItem[] = []) => t.nodes.filter((x) => isPaused(x, occupiedSteps(byId, sessions, workItems))).map((x) => x.id);
    for (const [sessions, workItems] of [
      [[], []],
      [[session('s1', t.a2.id, 'idle')], []],
      [[session('s1', t.a1.id, 'ended')], []],
      [[withAgents(session('s1', t.b.id, 'working'), [agent('w1', { nodeId: t.a1.id })])], []],
      [[], [work(t.a1.id, 'in_progress')]],
    ] as [Session[], WorkItem[]][]) {
      expect(pausedBy(sessions, workItems)).toEqual(pausedIds(layout(t, { sessions, workItems })));
    }
    expect(pausedBy([])).toEqual([t.a.id, t.a1.id]);
    expect(pausedBy([session('s1', t.a2.id, 'idle')])).toEqual([t.a1.id]);
  });
});
