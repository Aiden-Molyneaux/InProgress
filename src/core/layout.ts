import { buildIndex, computeVisible, countDone, isNeedsYou, progress, type FoldOverrides } from './tree';
import type { EventRow, ResourceMeta, Session, SubagentInfo, TreeNode, WorkItem } from './types';

export const ROW = 32;
export const INDENT = 28;
export const NODE_H = 24;
export const BADGE_ROW = 26;
/** One working task's row: compact, in its node's checklist. */
export const WORK_ROW = 20;
/** Room after a node's working tasks, so the next card doesn't sit right on them. */
export const WORK_GAP = 6;
/** How long an ended subagent's badge stays, greyed. The snapshot keeps an ended subagent as long. */
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
  /** Its place in the project's Up next queue (1 is next), or null when it isn't queued. */
  queuePos: number | null;
}

export interface LayoutMoreItem {
  kind: 'more';
  id: string;
  parentId: number;
  run: number;
  x: number;
  y: number;
  depth: number;
  hiddenIds: number[];
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
}

/** "✓ n done": a node's completed working tasks folded into one row. A `work:<nodeId>` override opens it. */
export interface LayoutWorkDoneItem {
  kind: 'workDone';
  id: string;
  nodeId: number;
  count: number;
  open: boolean;
  x: number;
  y: number;
}

export type LayoutItem = LayoutNodeItem | LayoutMoreItem | LayoutBadgeItem | LayoutAgentItem | LayoutWorkItem | LayoutWorkDoneItem;

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
  /** The snapshot's working tasks. */
  workItems?: WorkItem[];
  /** The project's Up next queue, next first. */
  queue?: number[];
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

/** The queue as the UI shows it: each node once, in order, without ids that are gone or steps already finished. */
export function upNext(queue: readonly number[], nodes: Pick<TreeNode, 'id' | 'status'>[]): number[] {
  const open = new Set(nodes.filter((n) => n.status !== 'done' && n.status !== 'dropped').map((n) => n.id));
  return [...new Set(queue)].filter((id) => open.has(id));
}

export function layoutOutline(input: LayoutInput): LayoutResult {
  const now = input.now ?? Date.now();
  const index = buildIndex(input.nodes);
  const live = input.sessions.filter((s) => s.state !== 'ended');
  const work = [...(input.workItems ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  const shownAgents = (s: Session) => s.subagents.filter((a) => agentShown(a, now));
  const homeOf = (s: Session, a: SubagentInfo) => agentHome(s, a, (id) => index.byId.has(id));
  // Where Claude works shows past the fold rules, as a session's focus does: a subagent's node, and a task in progress.
  const pins = [
    ...live.flatMap((s) => shownAgents(s).flatMap((a) => homeOf(s, a) ?? [])),
    ...work.filter((w) => w.status === 'in_progress').map((w) => w.nodeId),
  ];
  const visible = computeVisible(index, live, { overrides: input.overrides, pins });

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
  const queuePos = new Map(upNext(input.queue ?? [], input.nodes).map((id, i) => [id, i + 1]));

  const items: LayoutItem[] = [];
  const edges: LayoutEdge[] = [];
  const nodeItems = new Map<number, LayoutNodeItem>();
  let y = 0;
  for (const v of visible) {
    const x = v.depth * INDENT;
    if (v.type === 'more') {
      const id = `more${v.parentId}-${v.run}`;
      items.push({ kind: 'more', id, parentId: v.parentId, run: v.run, x, y, depth: v.depth, hiddenIds: v.hiddenIds });
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
      queuePos: queuePos.get(node.id) ?? null,
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
    // The node's checklist: completed tasks folded into one row first, then the rest in the order Claude made them.
    // It folds with its node.
    const tasks = v.folded ? [] : (workByNode.get(node.id) ?? []);
    if (!tasks.length) continue;
    const done = tasks.filter((w) => w.status === 'completed').length;
    const open = input.overrides?.[`work:${node.id}`] === 'open';
    if (done) {
      items.push({ kind: 'workDone', id: `wd${node.id}`, nodeId: node.id, count: done, open, x: inner, y });
      y += WORK_ROW;
    }
    for (const w of tasks) {
      if (w.status === 'completed' && !open) continue;
      items.push({ kind: 'work', id: `w${w.id}`, workId: w.id, nodeId: node.id, x: inner, y, pulse: pulses(w) });
      y += WORK_ROW;
    }
    y += WORK_GAP;
  }
  return { items, edges, nodeItems, height: y };
}

/**
 * Where the camera opens: the focus of the session that worked last; with no session working, the head of the Up next
 * queue; else the most recently updated active node; else the last row.
 */
export function findFrontier(nodes: TreeNode[], sessions: Session[], layout: LayoutResult, queue: readonly number[] = []): number | undefined {
  const workingFocus = sessions
    .filter((s) => s.state === 'working' && s.focusNodeId !== null)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  if (workingFocus.length) return workingFocus[0].focusNodeId!;
  const head = upNext(queue, nodes)[0];
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
