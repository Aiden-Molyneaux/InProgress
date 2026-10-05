import { buildIndex, computeVisible, countDone, isNeedsYou, progress, type FoldOverrides } from './tree';
import type { EventRow, PastSession, QueueEntry, ResourceMeta, Session, SubagentInfo, TrailAgent, TreeNode, WorkItem } from './types';

export const ROW = 32;
export const INDENT = 28;
export const NODE_H = 24;
export const BADGE_ROW = 26;
/** One working task's row: compact, in its node's checklist. */
export const WORK_ROW = 20;
/** Room after a node's working tasks, so the next card doesn't sit right on them. */
export const WORK_GAP = 6;
/** How long a live session's ended subagent keeps its badge, greyed; after that it shows in the trail. */
export const ENDED_AGENT_MS = 5 * 60 * 1000;

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

export interface LayoutBadgeItem {
  kind: 'badge';
  id: string;
  sessionId: string;
  nodeId: number;
  x: number;
  y: number;
}

/** A subagent's badge: under the node it works on, else under its session's focus, or their nearest visible ancestor. */
export interface LayoutAgentItem {
  kind: 'agent';
  id: string;
  sessionId: string;
  agentId: string;
  /** The row it sits under. */
  nodeId: number;
  x: number;
  y: number;
  /** It stopped less than ENDED_AGENT_MS ago: drawn greyed. */
  ended: boolean;
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

export type LayoutItem = LayoutNodeItem | LayoutMoreItem | LayoutBadgeItem | LayoutAgentItem | LayoutWorkItem | LayoutWorkDoneItem | LayoutTrailAgentItem;

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface LayoutResult {
  items: LayoutItem[];
  edges: LayoutEdge[];
  nodeItems: Map<number, LayoutNodeItem>;
  height: number;
}

export interface LayoutInput {
  nodes: TreeNode[];
  resources: ResourceMeta[];
  sessions: Session[];
  overrides?: FoldOverrides;
  /** The snapshot's working tasks, live and trail. */
  workItems?: WorkItem[];
  /** The snapshot's stopped subagents. Those a live session still shows as greyed badges are left out of the trail. */
  trailAgents?: TrailAgent[];
  /** The ended sessions the trail names, for the focus of a trail agent that has no node. */
  pastSessions?: PastSession[];
  /** The project's Up next queue, as stored: owned entries first, next first. */
  queue?: readonly QueueEntry[];
  /** When it is (ms), to tell which ended subagents still show. Defaults to now. */
  now?: number;
}

/** Whether a subagent still shows: running, or stopped less than ENDED_AGENT_MS ago. */
export function agentShown(a: Pick<SubagentInfo, 'endedAt'>, now: number): boolean {
  return a.endedAt === null || now - Date.parse(a.endedAt) < ENDED_AGENT_MS;
}

/** The node a subagent works on: the one its dispatch named, while that is still in the tree, else its session's focus. */
export function agentHome(s: Pick<Session, 'focusNodeId'>, a: Pick<SubagentInfo, 'nodeId'>, inTree: (id: number) => boolean): number | null {
  return a.nodeId !== null && inTree(a.nodeId) ? a.nodeId : s.focusNodeId;
}

/**
 * The trail's subagents, each with the node it shows under. A live session's stopped subagent stays out while it still
 * shows as a greyed badge (agentShown), so none is both. Its node is the one it worked on, while that is in this tree;
 * one whose node is set but not in the tree (its session moved to another project, say) is left out. Only one with no
 * node falls back to its session's focus, live or past; with neither it is left out. A deleted step's agents fall back
 * too: its `node_id` is ON DELETE SET NULL, which can't tell a deleted step from none.
 */
export function homedTrailAgents(
  input: { sessions: Session[]; trailAgents?: TrailAgent[]; pastSessions?: PastSession[]; now: number },
  inTree: (id: number) => boolean,
): { agent: TrailAgent; nodeId: number }[] {
  const live = input.sessions.filter((s) => s.state !== 'ended');
  const key = (sessionId: string, agentId: string) => `${sessionId}\u0000${agentId}`;
  const badged = new Set(live.flatMap((s) => s.subagents.filter((a) => agentShown(a, input.now)).map((a) => key(s.id, a.agentId))));
  const focusOf = new Map<string, number | null>([...(input.pastSessions ?? []), ...live].map((s) => [s.id, s.focusNodeId]));
  return (input.trailAgents ?? []).flatMap((agent) => {
    if (badged.has(key(agent.sessionId, agent.agentId))) return [];
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

export function layoutOutline(input: LayoutInput): LayoutResult {
  const now = input.now ?? Date.now();
  const index = buildIndex(input.nodes);
  const live = input.sessions.filter((s) => s.state !== 'ended');
  const work = [...(input.workItems ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  const shownAgents = (s: Session) => s.subagents.filter((a) => agentShown(a, now));
  const homeOf = (s: Session, a: SubagentInfo) => agentHome(s, a, (id) => index.byId.has(id));
  const queue = queueView(input.queue ?? [], input.nodes, input.sessions);
  // Where Claude works or plans to go next shows past the fold rules, as a session's focus does: a subagent's node,
  // a live session's task in progress, and every queued step, whoever owns it (so an Up next entry never points into a
  // "+n more" run). The trail never pins.
  const pins = [
    ...live.flatMap((s) => shownAgents(s).flatMap((a) => homeOf(s, a) ?? [])),
    ...work.filter((w) => w.status === 'in_progress' && w.endedAt === null).map((w) => w.nodeId),
    ...viewedSteps(queue),
  ];
  // Old finished steps fold into "✓ n done" rows on the canvas only; the text outline shows them all.
  const visible = computeVisible(index, live, { overrides: input.overrides, pins, doneRuns: { now } });

  const resourcesByNode = new Map<number, number[]>();
  for (const r of [...input.resources].sort((a, b) => a.id - b.id)) resourcesByNode.set(r.nodeId, [...(resourcesByNode.get(r.nodeId) ?? []), r.id]);
  // A manual fold can hide a live session's focus or a subagent's node: badge the nearest visible ancestor, so a fold
  // never hides a badge.
  const visibleIds = new Set(visible.flatMap((v) => (v.type === 'node' ? [v.node.id] : [])));
  const anchorOf = (id: number | null): number | undefined => {
    let cur = id === null ? undefined : index.byId.get(id);
    while (cur && !visibleIds.has(cur.id)) cur = cur.parentId === null ? undefined : index.byId.get(cur.parentId);
    return cur?.id;
  };
  /** Under each row: its sessions' badges, each followed by that session's subagents there. */
  const badgesByNode = new Map<number, { session: Session; agent?: SubagentInfo }[]>();
  const addBadge = (id: number | null, badge: { session: Session; agent?: SubagentInfo }) => {
    const at = anchorOf(id);
    if (at !== undefined) badgesByNode.set(at, [...(badgesByNode.get(at) ?? []), badge]);
  };
  for (const s of live) {
    addBadge(s.focusNodeId, { session: s });
    for (const agent of shownAgents(s)) addBadge(homeOf(s, agent), { session: s, agent });
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
  let y = 0;
  for (const v of visible) {
    const x = v.depth * INDENT;
    if (v.type === 'more') {
      const id = `${v.variant === 'done' ? 'done' : 'more'}${v.parentId}-${v.run}`;
      items.push({ kind: 'more', id, parentId: v.parentId, run: v.run, x, y, depth: v.depth, hiddenIds: v.hiddenIds, variant: v.variant });
      edges.push({ id: `e-${id}`, source: `n${v.parentId}`, target: id });
      y += ROW;
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
    };
    items.push(item);
    nodeItems.set(node.id, item);
    if (node.parentId !== null) edges.push({ id: `e-${item.id}`, source: `n${node.parentId}`, target: item.id });
    y += ROW;
    const inner = x + INDENT;
    for (const { session, agent } of badgesByNode.get(node.id) ?? []) {
      items.push(
        agent
          ? { kind: 'agent', id: `a${session.id}:${agent.agentId}`, sessionId: session.id, agentId: agent.agentId, nodeId: node.id, x: inner, y, ended: agent.endedAt !== null }
          : { kind: 'badge', id: `b${session.id}`, sessionId: session.id, nodeId: node.id, x: inner, y },
      );
      y += BADGE_ROW;
    }
    // The node's checklist: completed tasks and the trail folded into one row first, then the live open tasks in the
    // order Claude made them. Opened, the row shows every task in that order, then the trail's agents. It folds with
    // its node.
    const tasks = v.folded ? [] : (workByNode.get(node.id) ?? []);
    const trail = v.folded ? [] : (trailByNode.get(node.id) ?? []);
    if (!tasks.length && !trail.length) continue;
    const done = tasks.filter((w) => w.status === 'completed').length;
    const unfinished = tasks.filter((w) => w.endedAt !== null && w.status !== 'completed').length;
    const open = input.overrides?.[`work:${node.id}`] === 'open';
    if (done || unfinished || trail.length) {
      items.push({ kind: 'workDone', id: `wd${node.id}`, nodeId: node.id, count: done, unfinished, agents: trail.length, open, x: inner, y });
      y += WORK_ROW;
    }
    for (const w of tasks) {
      const stale = w.endedAt !== null;
      if ((w.status === 'completed' || stale) && !open) continue;
      items.push({ kind: 'work', id: `w${w.id}`, workId: w.id, nodeId: node.id, x: inner, y, pulse: pulses(w), stale });
      y += WORK_ROW;
    }
    if (open) {
      for (const a of trail) {
        items.push({ kind: 'trailAgent', id: `t${a.sessionId}:${a.agentId}`, sessionId: a.sessionId, agentId: a.agentId, nodeId: node.id, x: inner, y });
        y += WORK_ROW;
      }
    }
    y += WORK_GAP;
  }
  return { items, edges, nodeItems, height: y };
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
