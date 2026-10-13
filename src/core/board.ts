import { ancestors, buildIndex, dfsOrder, kids } from './tree';
import { ASK_TRAIL_MS, TRAIL_MS, type Ask, type ProjectSnapshot, type ResourceMeta, type Session, type TreeNode } from './types';

export type Column = 'now' | 'next' | 'backlog' | 'done';
export const MARKS = ['ended_open', 'no_outcome', 'stale_ask', 'done_focus', 'deep'] as const;
export type Mark = (typeof MARKS)[number];
export type BoardInput = Pick<ProjectSnapshot, 'project' | 'nodes' | 'sessions' | 'pastSessions' | 'resources' | 'asks'>;

export interface BoardRow {
  node: TreeNode;
  column: Column;
  /** 1-based place among the unowned Next entries; null otherwise. */
  queueNumber: number | null;
  /** The live session whose own queue holds it (Next only); null otherwise. */
  owner: Session | null;
  /** Live sessions focused on it: working, then permission, then idle; ties by slot. */
  sessions: Session[];
  /** Its open asks, oldest first. */
  asks: Ask[];
  marks: Mark[];
  /** In Next with no open ask (spec 1.5). */
  ready: boolean;
  /** Its ancestors below the root, outermost first. */
  crumb: TreeNode[];
  /** Its newest resource with purpose 'handoff', if any. */
  handoff: ResourceMeta | null;
}

export interface Board {
  /** Next rows in rail order: unowned by queue order, then each live owner's entries in stored order. */
  next: BoardRow[];
  /** Now rows in tree order. */
  now: BoardRow[];
  /** Backlog rows in tree order. */
  backlog: BoardRow[];
  /** Done rows, newest completedAt first (ties: higher id first). */
  done: BoardRow[];
  /** Every row by node id (groups and the root have none). */
  byId: Map<number, BoardRow>;
  /** Open nodes with open children that are not rows: shown as crumbs. */
  groups: Set<number>;
  /** Rows with at least one mark, in tree order. */
  marked: BoardRow[];
}

/** A live session: not ended. The snapshot's read already expired stale ones. */
export const isLive = (s: Pick<Session, 'state'>): boolean => s.state !== 'ended';
const OPEN = new Set(['todo', 'active', 'blocked']);
const isOpen = (n: TreeNode) => OPEN.has(n.status);
const STATE_ORDER: Record<string, number> = { working: 0, permission: 1, idle: 2 };

/** Places every step of the snapshot (spec 1.5) and marks the ones that need tidying (spec 1.6). */
export function deriveBoard(input: BoardInput, now: number): Board {
  const index = buildIndex(input.nodes);
  const order = dfsOrder(index);
  const rootId = index.root?.id ?? null;
  const live = input.sessions.filter(isLive);
  const liveIds = new Set(live.map((s) => s.id));
  const focusOf = new Map<number, Session[]>();
  for (const s of live) if (s.focusNodeId !== null) focusOf.set(s.focusNodeId, [...(focusOf.get(s.focusNodeId) ?? []), s]);
  for (const list of focusOf.values()) list.sort((a, b) => (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3) || (a.slot ?? 0) - (b.slot ?? 0));
  const openAsks = new Map<number, Ask[]>();
  for (const a of input.asks) if (a.clearedAt === null) openAsks.set(a.nodeId, [...(openAsks.get(a.nodeId) ?? []), a]);
  for (const list of openAsks.values()) list.sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || a.id - b.id);
  const handoffOf = new Map<number, ResourceMeta>();
  for (const r of input.resources) {
    if (r.purpose !== 'handoff') continue;
    const had = handoffOf.get(r.nodeId);
    if (!had || r.createdAt > had.createdAt) handoffOf.set(r.nodeId, r);
  }
  const lastPast = new Map<number, ProjectSnapshot['pastSessions'][number]>();
  for (const p of input.pastSessions) {
    if (p.focusNodeId === null) continue;
    const had = lastPast.get(p.focusNodeId);
    if (!had || p.endedAt > had.endedAt) lastPast.set(p.focusNodeId, p);
  }
  const unowned = input.project.queue.filter((e) => e.sessionId === null);
  const queueNumber = new Map<number, number>();
  let k = 0;
  const openIds = new Set(input.nodes.filter(isOpen).map((x) => x.id));
  for (const e of unowned) if (openIds.has(e.nodeId)) queueNumber.set(e.nodeId, ++k);
  const ownerOf = new Map<number, Session>();
  for (const e of input.project.queue) {
    if (e.sessionId === null || !liveIds.has(e.sessionId) || queueNumber.has(e.nodeId)) continue;
    ownerOf.set(e.nodeId, live.find((s) => s.id === e.sessionId)!);
  }

  const byId = new Map<number, BoardRow>();
  const groups = new Set<number>();
  for (const node of input.nodes) {
    if (node.id === rootId || node.status === 'dropped') continue;
    const crumb = ancestors(index, node.id).filter((a) => a.id !== rootId);
    const sessions = focusOf.get(node.id) ?? [];
    const asks = openAsks.get(node.id) ?? [];
    let column: Column;
    if (node.status === 'done') column = 'done';
    else if (sessions.length || (node.assignee === 'me' && node.status === 'active')) column = 'now';
    else if (queueNumber.has(node.id) || ownerOf.has(node.id)) column = 'next';
    else if (kids(index, node.id).some(isOpen)) {
      groups.add(node.id);
      continue;
    } else column = 'backlog';
    const marks: Mark[] = [];
    if (column === 'done') {
      if (!node.outcome.trim()) marks.push('no_outcome');
      if (sessions.length) marks.push('done_focus');
    } else {
      if (column !== 'now') {
        const past = lastPast.get(node.id);
        const handoff = handoffOf.get(node.id);
        if (past && now - Date.parse(past.endedAt) <= TRAIL_MS && !(handoff && handoff.createdAt > past.startedAt)) marks.push('ended_open');
      }
      if (asks.some((a) => now - Date.parse(a.raisedAt) > ASK_TRAIL_MS)) marks.push('stale_ask');
    }
    if (crumb.length >= 3) marks.push('deep');
    byId.set(node.id, {
      node, column, crumb, sessions, asks, marks,
      queueNumber: column === 'next' ? (queueNumber.get(node.id) ?? null) : null,
      owner: column === 'next' ? (ownerOf.get(node.id) ?? null) : null,
      ready: column === 'next' && asks.length === 0,
      handoff: handoffOf.get(node.id) ?? null,
    });
  }
  const rows = [...byId.values()];
  const treeOrder = (a: BoardRow, b: BoardRow) => (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0);
  const queueOrder = new Map(input.project.queue.map((e, i) => [e.nodeId, i]));
  const next = rows.filter((r) => r.column === 'next').sort((a, b) =>
    (a.owner ? 1 : 0) - (b.owner ? 1 : 0) || (a.queueNumber ?? 0) - (b.queueNumber ?? 0) || (a.owner?.slot ?? 0) - (b.owner?.slot ?? 0) || (queueOrder.get(a.node.id) ?? 0) - (queueOrder.get(b.node.id) ?? 0));
  return {
    next,
    now: rows.filter((r) => r.column === 'now').sort(treeOrder),
    backlog: rows.filter((r) => r.column === 'backlog').sort(treeOrder),
    done: rows.filter((r) => r.column === 'done').sort((a, b) => (b.node.completedAt ?? '').localeCompare(a.node.completedAt ?? '') || b.node.id - a.node.id),
    byId, groups,
    marked: rows.filter((r) => r.marks.length).sort(treeOrder),
  };
}
