import { buildIndex, computeVisible, countDone, isNeedsYou, progress, type FoldOverrides } from './tree';
import { ENDED_AGENT_MS, glyphTitle, isReader, ownerTag, sessionTag, type EventRow, type PastSession, type QueueEntry, type ResourceMeta, type Session, type SubagentInfo, type TrailAgent, type TreeNode, type WorkItem } from './types';

/** A card's header box and a one-line card: a 30 px header inside the frame's 1 px border. The camera aims at y + NODE_H / 2. */
export const NODE_H = 32;
/** Between a card's frame and the next row. */
export const CARD_GAP = 10;
/** A one-line card's pitch. */
export const ROW = NODE_H + CARD_GAP; // 42
/** A fold row's pitch: the row is 26 px tall, then CARD_GAP. */
export const FOLD_ROW = 36;
/** A session's agent line in a card, whatever its lead's size. */
export const AGENT_LINE = 28;
/** A session's readers line (`◇ c · 2 reading`). */
export const READERS_LINE = 20;
/** The done row on a line of its own. It adds nothing when it shares a kin-less last line. */
export const DONE_LINE = 20;
/** A working task's row, and an opened done row's trail-agent row. */
export const TASK_ROW = 22;
/** Under the last line of a card that has lines. */
export const CARD_PAD = 8;
export const INDENT = 28;
/** From a stack head's box top to the first row under it. */
export const STACK_HEAD = 43;

/** The root card's x. */
const ROOT_X = 8;
/** A stack head's x. */
const STACK_X = 22;
/** Every card ends here: w = Math.max(CARD_MIN_W, CARD_RIGHT - x). */
const CARD_RIGHT = 506;
const CARD_MIN_W = 240;
const LANE_X = 8;
const LANE_W = 504;
/** A lane's top, above its head box. */
const LANE_PAD_TOP = 9;
/** Below the last row of the phase's subtree. */
const LANE_PAD_BOTTOM = 12;
/** Clear space between a lane and the next lane, or any row outside lanes. */
const LANE_GAP = 18;

export interface LayoutNodeItem {
  kind: 'node';
  id: string;
  nodeId: number;
  x: number;
  y: number;
  depth: number;
  folded: boolean;
  doneCount: number;
  progress: { done: number; total: number } | null;
  resourceIds: number[];
  needsYou: boolean;
  hasChildren: boolean;
  working: boolean;
  /**
   * Its place in the project's Up next queue, or null when it isn't queued: its number in its owner's list (1 is next),
   * and the owner, a live session, or null for the unowned list.
   */
  queue: { pos: number; sessionId: string | null } | null;
  /**
   * An active step of Claude's that nobody is on: no live session focuses it or a descendant, and no running subagent or
   * live task in progress is there. Never the root. Display only: the stored status stays active.
   */
  paused: boolean;
  /** A card: its frame's height. A stack head: its box, from the head's top to the end of its own lines. */
  h: number;
  /** Math.max(240, 506 - x): 498 for the root, 484 for a stack head, 450 at x 56, 422 at x 84. */
  w: number;
  /** A depth-1 step of kind 'phase': drawn as an unframed stack head that opens a lane. */
  stack: boolean;
  /** The focus of a live session whose state is 'working'. Never its ancestors: `working` still marks the chain. */
  workingFocus: boolean;
}

/**
 * Hidden siblings as one row: the far todo tail ("+n more", id `more<parentId>-<run>`) or a run of old finished steps
 * ("✓ n done", id `done<parentId>-<run>`).
 */
export interface LayoutMoreItem {
  kind: 'more';
  id: string;
  parentId: number;
  run: number;
  x: number;
  y: number;
  depth: number;
  hiddenIds: number[];
  variant: 'tail' | 'done';
}

/** One session's line on one card, one per session per card: its character where its focus anchors, then its kin. */
export interface LayoutLineItem {
  kind: 'line';
  /** `l<sessionId>:<nodeId>` */
  id: string;
  sessionId: string;
  nodeId: number;
  /** The session's focus anchors on this card: the line draws the session's character and label. */
  lead: boolean;
  /**
   * The session's shown non-reader subagents homed on this card (agentVisible: running, or stopped less than
   * ENDED_AGENT_MS ago), in the session's `subagents` order. Each is one kin.
   */
  agentIds: string[];
  x: number;
  y: number;
}

/**
 * A session's running readers (READER_AGENT_TYPES) on one card, as one small line, `◇ a · 2 reading`: after that
 * session's agent line there, in place of a kin each. Id `r<sessionId>:<nodeId>`.
 */
export interface LayoutReadersItem {
  kind: 'readers';
  id: string;
  sessionId: string;
  /** The row it sits under. */
  nodeId: number;
  /** The readers it stands for, in the session's order. */
  agentIds: string[];
  x: number;
  y: number;
}

/** One of Claude's working tasks, in its node's checklist. */
export interface LayoutWorkItem {
  kind: 'work';
  id: string;
  workId: number;
  nodeId: number;
  x: number;
  y: number;
  /** In progress while its session works, or while its subagent runs. */
  pulse: boolean;
  /** Its session has ended: it is trail, shown only while the node's done row is open, and never pulses. */
  stale: boolean;
}

/**
 * "✓ n done · n unfinished · n agents": a node's completed working tasks and its trail of ended work folded into one
 * row. A `work:<nodeId>` override opens it.
 */
export interface LayoutWorkDoneItem {
  kind: 'workDone';
  id: string;
  nodeId: number;
  /** Completed tasks, of live and ended sessions. */
  count: number;
  /** Tasks an ended session left pending or in progress. */
  unfinished: number;
  /** Trail agents on the node: subagents that stopped (a live session's, five minutes after). */
  agents: number;
  open: boolean;
  x: number;
  y: number;
  /** True: it sits at the right end of the card's last line and has that line's y. False: a DONE_LINE of its own. */
  shared: boolean;
}

/** A subagent in the trail, listed under its node's open done row after the node's tasks. Neutral: no colour, never pulsing. */
export interface LayoutTrailAgentItem {
  kind: 'trailAgent';
  id: string;
  sessionId: string;
  agentId: string;
  nodeId: number;
  x: number;
  y: number;
}

export type LayoutItem =
  | LayoutNodeItem
  | LayoutMoreItem
  | LayoutLineItem
  | LayoutReadersItem
  | LayoutWorkItem
  | LayoutWorkDoneItem
  | LayoutTrailAgentItem;

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

/** A depth-1 phase's lane, drawn behind its subtree. */
export interface LayoutLane {
  /** `lane<nodeId>`: the React Flow node id. */
  id: string;
  /** The phase. */
  nodeId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutResult {
  items: LayoutItem[];
  edges: LayoutEdge[];
  nodeItems: Map<number, LayoutNodeItem>;
  /** One per depth-1 phase, in outline order. Kept out of `items`, so `items` keeps its shape. */
  lanes: LayoutLane[];
  /** The bottom of the last row or lane. */
  height: number;
}

export interface LayoutInput {
  nodes: TreeNode[];
  resources: ResourceMeta[];
  sessions: Session[];
  overrides?: FoldOverrides;
  /** The snapshot's working tasks, live and trail. */
  workItems?: WorkItem[];
  /** The snapshot's stopped subagents. Those a live session still shows as ended kin are left out of the trail. */
  trailAgents?: TrailAgent[];
  /** The ended sessions the trail names, for the focus of a trail agent that has no node. */
  pastSessions?: PastSession[];
  /** The project's Up next queue, as stored: owned entries first, next first. */
  queue?: readonly QueueEntry[];
  /**
   * When it is (ms). It decides which stopped subagents still show, and which finished steps are old enough to fold
   * into a done run. Defaults to now.
   */
  now?: number;
}

/** Whether a subagent still shows: running, or stopped less than ENDED_AGENT_MS ago. */
export function agentShown(a: Pick<SubagentInfo, 'endedAt'>, now: number): boolean {
  return a.endedAt === null || now - Date.parse(a.endedAt) < ENDED_AGENT_MS;
}

/**
 * Whether the window shows a subagent anywhere, and lets it pin its step: as agentShown, but a reader shows only while it
 * runs. An ended reader drops out of its readers line and leaves no trail.
 */
export function agentVisible(a: Pick<SubagentInfo, 'endedAt' | 'agentType'>, now: number): boolean {
  return agentShown(a, now) && !(isReader(a.agentType) && a.endedAt !== null);
}

/** The node a subagent works on: the one its dispatch named, while that is still in the tree, else its session's focus. */
export function agentHome(s: Pick<Session, 'focusNodeId'>, a: Pick<SubagentInfo, 'nodeId'>, inTree: (id: number) => boolean): number | null {
  return a.nodeId !== null && inTree(a.nodeId) ? a.nodeId : s.focusNodeId;
}

/**
 * Who is on a step, for paused: each live session's focus (an idle one's too), each running subagent's home (a reader's
 * too), each live session's task in progress, and every ancestor of those, walked in the tree itself, so a manual fold
 * never changes it. A stopped subagent no longer counts, though it still shows as an ended kin for a while. The layout
 * and Details both read it, so a step's marker draws the same on its card and in Details.
 */
export function occupiedSteps(byId: ReadonlyMap<number, TreeNode>, sessions: readonly Session[], workItems: readonly WorkItem[] = []): Set<number> {
  const occupied = new Set<number>();
  const occupy = (id: number | null) => {
    let cur = id === null ? undefined : byId.get(id);
    while (cur && !occupied.has(cur.id)) {
      occupied.add(cur.id);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
  };
  for (const s of sessions) {
    if (s.state === 'ended') continue;
    occupy(s.focusNodeId);
    for (const a of s.subagents) if (a.endedAt === null) occupy(agentHome(s, a, (id) => byId.has(id)));
  }
  for (const w of workItems) if (w.status === 'in_progress' && w.endedAt === null) occupy(w.nodeId);
  return occupied;
}

/** An active step of Claude's that nobody is on (occupiedSteps): its marker draws the hollow sky ring. Never the root. */
export function isPaused(node: Pick<TreeNode, 'id' | 'parentId' | 'status' | 'assignee'>, occupied: ReadonlySet<number>): boolean {
  return node.parentId !== null && node.status === 'active' && node.assignee === 'claude' && !occupied.has(node.id);
}

/**
 * The trail's subagents, each with the node it shows under. A live session's stopped subagent stays out while it still
 * shows as an ended kin (agentShown), so none is both. Its node is the one it worked on, while that is in this tree;
 * one whose node is set but not in the tree (its session moved to another project, say) is left out. Only one with no
 * node falls back to its session's focus, live or past; with neither it is left out. A deleted step's agents fall back
 * too: its `node_id` is ON DELETE SET NULL, which can't tell a deleted step from none. Readers leave no trail: the
 * server's query leaves them out already, and so does this.
 */
export function homedTrailAgents(
  input: { sessions: Session[]; trailAgents?: TrailAgent[]; pastSessions?: PastSession[]; now: number },
  inTree: (id: number) => boolean,
): { agent: TrailAgent; nodeId: number }[] {
  const live = input.sessions.filter((s) => s.state !== 'ended');
  const key = (sessionId: string, agentId: string) => `${sessionId}\u0000${agentId}`;
  const stillKin = new Set(live.flatMap((s) => s.subagents.filter((a) => agentShown(a, input.now)).map((a) => key(s.id, a.agentId))));
  const focusOf = new Map<string, number | null>([...(input.pastSessions ?? []), ...live].map((s) => [s.id, s.focusNodeId]));
  return (input.trailAgents ?? []).flatMap((agent) => {
    if (isReader(agent.agentType) || stillKin.has(key(agent.sessionId, agent.agentId))) return [];
    const nodeId = agent.nodeId ?? focusOf.get(agent.sessionId) ?? null;
    return nodeId !== null && inTree(nodeId) ? [{ agent, nodeId }] : [];
  });
}

/** The Up next queue as it reads: each live session's own list, in the order the owners first appear, then the unowned list. */
export interface QueueView {
  bySession: Map<string, number[]>;
  unowned: number[];
}

/**
 * The queue as the window and the text show it: open steps only, each once, in order, without ids that are gone. A
 * session's focus is "now", not "next", so it is left out of its own list, and a session whose list is then empty has
 * none. Entries of a session that is not live, or not among `sessions`, read as unowned in their stored place, which is
 * ahead of the older unowned ones (releaseQueue puts them there when it runs).
 */
export function queueView(
  queue: readonly QueueEntry[],
  nodes: Pick<TreeNode, 'id' | 'status'>[],
  sessions: Pick<Session, 'id' | 'state' | 'focusNodeId'>[],
): QueueView {
  const open = new Set(nodes.filter((n) => n.status !== 'done' && n.status !== 'dropped').map((n) => n.id));
  const focusOf = new Map(sessions.filter((s) => s.state !== 'ended').map((s) => [s.id, s.focusNodeId]));
  const view: QueueView = { bySession: new Map(), unowned: [] };
  const seen = new Set<number>();
  for (const { nodeId, sessionId } of queue) {
    if (seen.has(nodeId) || !open.has(nodeId)) continue;
    seen.add(nodeId);
    if (sessionId === null || !focusOf.has(sessionId)) view.unowned.push(nodeId);
    else if (focusOf.get(sessionId) !== nodeId) view.bySession.set(sessionId, [...(view.bySession.get(sessionId) ?? []), nodeId]);
  }
  return view;
}

/** Every step in the view, owners' lists first: what the queue pins in view. */
const viewedSteps = (view: QueueView): number[] => [...[...view.bySession.values()].flat(), ...view.unowned];

/** How many of the reader's own steps the briefing's Up next line names, with their titles. */
export const MAX_UP_NEXT = 5;

/** Who reads the Up next line, in the briefing and the status answer: its own part leads, with titles. */
export interface UpNextReader {
  sessionId: string;
  nodes: Pick<TreeNode, 'id' | 'title' | 'label'>[];
}

/**
 * The Up next line as text, or undefined when no step is up next. Each owner is named by its letter (`?` while its slot
 * is empty), in the view's order, and a part with no steps is left out. Without a reader (the outline, set_queue's
 * result): `Up next: A: #82 → #78 | B: #90 | later: #79`. With one (the briefing, the status answer), its own part comes
 * first, as `#id glyph Title` up to MAX_UP_NEXT, and the rest keep bare ids:
 * `Up next (you, A): #82 ⚙ Trail → #78 ⧉ Guide · B: #90 · later: #79`. A reader with no steps of its own reads
 * `Up next: B: #90 · later: #79`.
 */
export function formatUpNext(view: QueueView, sessions: Pick<Session, 'id' | 'slot'>[], reader?: UpNextReader): string | undefined {
  const slotOf = new Map(sessions.map((s) => [s.id, s.slot]));
  const ids = (list: number[]) => list.map((id) => `#${id}`).join(' → ');
  const parts = [
    ...[...view.bySession].filter(([id]) => id !== reader?.sessionId).map(([id, list]) => `${ownerTag(slotOf.get(id) ?? null)}: ${ids(list)}`),
    ...(view.unowned.length ? [`later: ${ids(view.unowned)}`] : []),
  ];
  const own = reader ? (view.bySession.get(reader.sessionId) ?? []) : [];
  if (!reader || !own.length) return parts.length ? `Up next: ${parts.join(reader ? ' · ' : ' | ')}` : undefined;
  const byId = new Map(reader.nodes.map((n) => [n.id, n]));
  const titled = own.slice(0, MAX_UP_NEXT).map((id) => {
    const n = byId.get(id);
    return n ? `#${id} ${glyphTitle(n)}` : `#${id}`;
  });
  const more = own.length > MAX_UP_NEXT ? ` (+${own.length - MAX_UP_NEXT} more)` : '';
  // Its own letter, as the briefing's first line gives it; left out while its slot is empty.
  const letter = sessionTag(slotOf.get(reader.sessionId) ?? null);
  return [`Up next (you${letter ? `, ${letter}` : ''}): ${titled.join(' → ')}${more}`, ...parts].join(' · ');
}

export function layoutOutline(input: LayoutInput): LayoutResult {
  const now = input.now ?? Date.now();
  const index = buildIndex(input.nodes);
  const live = input.sessions.filter((s) => s.state !== 'ended');
  const work = [...(input.workItems ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  const shownAgents = (s: Session) => s.subagents.filter((a) => agentVisible(a, now));
  const homeOf = (s: Session, a: SubagentInfo) => agentHome(s, a, (id) => index.byId.has(id));
  const queue = queueView(input.queue ?? [], input.nodes, input.sessions);
  // Where Claude works or plans to go next shows past the fold rules, as a session's focus does: a subagent's node
  // (a running reader's too; an ended reader shows nowhere), a live session's task in progress, and every queued step,
  // whoever owns it (so an Up next entry never points into a "+n more" run). The trail never pins.
  const pins = [
    ...live.flatMap((s) => shownAgents(s).flatMap((a) => homeOf(s, a) ?? [])),
    ...work.filter((w) => w.status === 'in_progress' && w.endedAt === null).map((w) => w.nodeId),
    ...viewedSteps(queue),
  ];
  // Old finished steps fold into "✓ n done" rows on the canvas only; the text outline shows them all.
  const visible = computeVisible(index, live, { overrides: input.overrides, pins, doneRuns: { now } });

  const resourcesByNode = new Map<number, number[]>();
  for (const r of [...input.resources].sort((a, b) => a.id - b.id)) resourcesByNode.set(r.nodeId, [...(resourcesByNode.get(r.nodeId) ?? []), r.id]);
  // A manual fold can hide a live session's focus or a subagent's node: its line goes on the nearest visible ancestor,
  // so a fold never hides a session or a subagent.
  const visibleIds = new Set(visible.flatMap((v) => (v.type === 'node' ? [v.node.id] : [])));
  const anchorOf = (id: number | null): number | undefined => {
    let cur = id === null ? undefined : index.byId.get(id);
    while (cur && !visibleIds.has(cur.id)) cur = cur.parentId === null ? undefined : index.byId.get(cur.parentId);
    return cur?.id;
  };
  /**
   * On each card, per live session in `live` order: whether its focus anchors there (the lead), its shown workers homed
   * there (the kin) and its running readers there, each in the session's order.
   */
  type Group = { session: Session; lead: boolean; agentIds: string[]; readerIds: string[] };
  const groupsByNode = new Map<number, Map<string, Group>>();
  const groupAt = (at: number, s: Session): Group => {
    const bySession = groupsByNode.get(at) ?? new Map<string, Group>();
    groupsByNode.set(at, bySession);
    const group = bySession.get(s.id) ?? { session: s, lead: false, agentIds: [], readerIds: [] };
    bySession.set(s.id, group);
    return group;
  };
  for (const s of live) {
    const focusAt = anchorOf(s.focusNodeId);
    if (focusAt !== undefined) groupAt(focusAt, s).lead = true;
    for (const agent of shownAgents(s)) {
      const at = anchorOf(homeOf(s, agent));
      if (at === undefined) continue;
      // Only running readers are shown (agentVisible), each in its session's readers line on the card it anchors to.
      if (isReader(agent.agentType)) groupAt(at, s).readerIds.push(agent.agentId);
      else groupAt(at, s).agentIds.push(agent.agentId);
    }
  }
  const working = new Set<number>();
  for (const s of live) {
    if (s.state !== 'working' || s.focusNodeId === null) continue;
    let cur = index.byId.get(s.focusNodeId);
    while (cur) {
      working.add(cur.id);
      cur = cur.parentId === null ? undefined : index.byId.get(cur.parentId);
    }
  }
  /** Each working session's focus: its card alone wears the orange frame. */
  const workingFoci = new Set(live.flatMap((s) => (s.state === 'working' && s.focusNodeId !== null ? [s.focusNodeId] : [])));
  const occupied = occupiedSteps(index.byId, live, work);
  const sessionsById = new Map(live.map((s) => [s.id, s]));
  const pulses = (w: WorkItem): boolean => {
    const s = sessionsById.get(w.sessionId);
    if (w.status !== 'in_progress' || !s) return false;
    return w.agentId === '' ? s.state === 'working' : s.subagents.some((a) => a.agentId === w.agentId && a.endedAt === null);
  };
  const workByNode = new Map<number, WorkItem[]>();
  for (const w of work) workByNode.set(w.nodeId, [...(workByNode.get(w.nodeId) ?? []), w]);
  const trailByNode = new Map<number, TrailAgent[]>();
  for (const { agent, nodeId } of homedTrailAgents({ ...input, now }, (id) => index.byId.has(id))) trailByNode.set(nodeId, [...(trailByNode.get(nodeId) ?? []), agent]);
  /** Each queued step's number in its owner's list. */
  const queued = new Map<number, { pos: number; sessionId: string | null }>();
  for (const [sessionId, ids] of [...queue.bySession, [null, queue.unowned] as const]) ids.forEach((id, i) => queued.set(id, { pos: i + 1, sessionId }));

  const items: LayoutItem[] = [];
  const edges: LayoutEdge[] = [];
  const nodeItems = new Map<number, LayoutNodeItem>();
  const lanes: LayoutLane[] = [];
  /** Where the next row goes. */
  let y = 0;
  /** The bottom of the last row or lane. */
  let bottom = 0;
  /** The open lane: its phase and its top. */
  let lane: { nodeId: number; top: number } | null = null;
  /** The rows walked now sit under a stack head, so they draw one indent further left. */
  let underStack = false;
  const closeLane = () => {
    if (!lane) return;
    const laneBottom = bottom + LANE_PAD_BOTTOM;
    lanes.push({ id: `lane${lane.nodeId}`, nodeId: lane.nodeId, x: LANE_X, y: lane.top, w: LANE_W, h: laneBottom - lane.top });
    bottom = laneBottom;
    y = laneBottom + LANE_GAP;
    lane = null;
  };
  for (const v of visible) {
    const stack = v.type === 'node' && v.depth === 1 && v.node.kind === 'phase';
    // A row at depth 0 or 1 closes the open lane, and a stack head opens its own.
    if (v.depth <= 1) {
      closeLane();
      underStack = stack;
    }
    if (stack) {
      const top = items.length ? bottom + LANE_GAP : 0;
      lane = { nodeId: v.node.id, top };
      y = top + LANE_PAD_TOP;
    }
    const x = v.depth === 0 ? ROOT_X : stack ? STACK_X : (v.depth + (underStack ? 0 : 1)) * INDENT;
    // Edges run only inside a card's subtree: never out of the root or a stack head.
    const parentId = v.type === 'more' ? v.parentId : v.node.parentId;
    const parent = parentId === null ? undefined : index.byId.get(parentId);
    const edge = v.depth >= 3 || (v.depth === 2 && parent?.kind !== 'phase');
    if (v.type === 'more') {
      const id = `${v.variant === 'done' ? 'done' : 'more'}${v.parentId}-${v.run}`;
      items.push({ kind: 'more', id, parentId: v.parentId, run: v.run, x, y, depth: v.depth, hiddenIds: v.hiddenIds, variant: v.variant });
      if (edge) edges.push({ id: `e-${id}`, source: `n${v.parentId}`, target: id });
      bottom = y + FOLD_ROW - CARD_GAP;
      y += FOLD_ROW;
      continue;
    }
    const node = v.node;
    const item: LayoutNodeItem = {
      kind: 'node',
      id: `n${node.id}`,
      nodeId: node.id,
      x,
      y,
      depth: v.depth,
      folded: v.folded,
      doneCount: v.folded ? countDone(index, node.id) : 0,
      progress: progress(index, node.id),
      resourceIds: resourcesByNode.get(node.id) ?? [],
      needsYou: isNeedsYou(node),
      hasChildren: v.hasChildren,
      working: working.has(node.id),
      queue: queued.get(node.id) ?? null,
      paused: isPaused(node, occupied),
      h: NODE_H,
      w: Math.max(CARD_MIN_W, CARD_RIGHT - x),
      stack,
      workingFocus: workingFoci.has(node.id),
    };
    items.push(item);
    nodeItems.set(node.id, item);
    if (edge) edges.push({ id: `e-${item.id}`, source: `n${node.parentId}`, target: item.id });
    // The card's lines, from under its header (a stack head's: under its track). Row items take the card's x.
    const top = y + (stack ? STACK_HEAD : NODE_H);
    let ly = top;
    /** The card's last agent or readers line, and whether it holds kin. */
    let last: { y: number; kin: boolean } | null = null;
    for (const { session, lead, agentIds, readerIds } of groupsByNode.get(node.id)?.values() ?? []) {
      if (lead || agentIds.length) {
        items.push({ kind: 'line', id: `l${session.id}:${node.id}`, sessionId: session.id, nodeId: node.id, lead, agentIds, x, y: ly });
        last = { y: ly, kin: agentIds.length > 0 };
        ly += AGENT_LINE;
      }
      if (readerIds.length) {
        items.push({ kind: 'readers', id: `r${session.id}:${node.id}`, sessionId: session.id, nodeId: node.id, agentIds: readerIds, x, y: ly });
        last = { y: ly, kin: false };
        ly += READERS_LINE;
      }
    }
    // The node's checklist: completed tasks and the trail folded into one done row first, then the live open tasks in
    // the order Claude made them. Opened, the row shows every task in that order, then the trail's agents. It folds
    // with its node.
    const tasks = v.folded ? [] : (workByNode.get(node.id) ?? []);
    const trail = v.folded ? [] : (trailByNode.get(node.id) ?? []);
    const done = tasks.filter((w) => w.status === 'completed').length;
    const unfinished = tasks.filter((w) => w.endedAt !== null && w.status !== 'completed').length;
    const open = input.overrides?.[`work:${node.id}`] === 'open';
    if (done || unfinished || trail.length) {
      // At the end of the card's last line when that line holds no kin; else on a line of its own.
      const sharedY = last && !last.kin ? last.y : null;
      items.push({ kind: 'workDone', id: `wd${node.id}`, nodeId: node.id, count: done, unfinished, agents: trail.length, open, x, y: sharedY ?? ly, shared: sharedY !== null });
      if (sharedY === null) ly += DONE_LINE;
    }
    for (const w of tasks) {
      const stale = w.endedAt !== null;
      if ((w.status === 'completed' || stale) && !open) continue;
      items.push({ kind: 'work', id: `w${w.id}`, workId: w.id, nodeId: node.id, x, y: ly, pulse: pulses(w), stale });
      ly += TASK_ROW;
    }
    if (open) {
      for (const a of trail) {
        items.push({ kind: 'trailAgent', id: `t${a.sessionId}:${a.agentId}`, sessionId: a.sessionId, agentId: a.agentId, nodeId: node.id, x, y: ly });
        ly += TASK_ROW;
      }
    }
    const lines = ly - top;
    item.h = stack ? (lines ? STACK_HEAD + lines : STACK_HEAD - CARD_GAP) : lines ? NODE_H + lines + CARD_PAD : NODE_H;
    bottom = y + item.h;
    y = bottom + CARD_GAP;
  }
  closeLane();
  return { items, edges, nodeItems, lanes, height: bottom };
}

/**
 * Where the camera opens: the focus of the session that worked last; with no session working, the first owned entry of
 * the Up next queue (the first numbered owned marker, owners in stored order; never a session's own focus), else the
 * first unowned one; else the most recently updated active node; else the last row.
 */
export function findFrontier(nodes: TreeNode[], sessions: Session[], layout: LayoutResult, queue: readonly QueueEntry[] = []): number | undefined {
  const workingFocus = sessions
    .filter((s) => s.state === 'working' && s.focusNodeId !== null)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  if (workingFocus.length) return workingFocus[0].focusNodeId!;
  const head = viewedSteps(queueView(queue, nodes, sessions))[0];
  if (head !== undefined) return head;
  const active = nodes.filter((n) => n.parentId !== null && n.status === 'active').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (active.length) return active[0].id;
  const rows = layout.items.filter((i): i is LayoutNodeItem => i.kind === 'node');
  return rows.length ? rows[rows.length - 1].nodeId : undefined;
}

export function eventTarget(e: EventRow): number | undefined {
  const d = (e.data ?? {}) as { ids?: number[]; nodeId?: number; changed?: string[]; focusNodeId?: number | null };
  switch (e.type) {
    case 'node.created':
      return d.ids?.length ? d.ids[d.ids.length - 1] : Number(e.entityId);
    case 'node.updated':
    case 'node.moved':
      return Number(e.entityId);
    case 'resource.created':
    case 'resource.updated':
    case 'log.created':
    case 'work.updated':
      return typeof d.nodeId === 'number' ? d.nodeId : undefined;
    case 'session.updated':
      return d.changed?.includes('focusNodeId') && typeof d.focusNodeId === 'number' ? d.focusNodeId : undefined;
    default:
      return undefined;
  }
}
