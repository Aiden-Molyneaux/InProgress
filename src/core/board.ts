import { sessionActivity } from './activity';
import { ancestors, buildIndex, dfsOrder, kids } from './tree';
import { ASK_TRAIL_MS, STALE_SESSION_MS, STALL_MS, TRAIL_MS, ownerTag, type Ask, type ProjectSnapshot, type ResourceMeta, type Session, type TreeNode } from './types';

export type Column = 'now' | 'next' | 'backlog' | 'done';
export const MARKS = ['ended_open', 'no_outcome', 'stale_ask', 'done_focus', 'deep', 'stalled', 'answer_waiting'] as const;
export type Mark = (typeof MARKS)[number];
export type BoardInput = Pick<ProjectSnapshot, 'project' | 'nodes' | 'sessions' | 'pastSessions' | 'resources' | 'asks'>;

export interface BoardRow {
  node: TreeNode;
  column: Column;
  /** 1-based place among the unowned Next entries; null otherwise. */
  queueNumber: number | null;
  /** The live session whose own queue holds it (Next only); null otherwise. */
  owner: Session | null;
  /** Live sessions focused on it: the driver first, then working, then permission, then idle; ties by slot. */
  sessions: Session[];
  /** The live session that drives it (spec 1.5); null when its driver is ended, stale, elsewhere or none. */
  driver: Session | null;
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

/** A live session (spec 1.5): not ended and heard from within STALE_SESSION_MS. The snapshot's read expires stale ones only lazily. */
export const isLive = (s: Pick<Session, 'state' | 'lastSeenAt'>, now: number): boolean =>
  s.state !== 'ended' && now - Date.parse(s.lastSeenAt) <= STALE_SESSION_MS;
const OPEN = new Set(['todo', 'active', 'blocked']);
const isOpen = (n: TreeNode) => OPEN.has(n.status);
const STATE_ORDER: Record<string, number> = { working: 0, permission: 1, idle: 2 };

/**
 * Spec 3.1: (a) the live driver is idle (nothing running, not waiting on a permission) for STALL_MS with no open ask on
 * the step, or (b) live sessions are on the step but none of them drives it.
 */
function isStalled(driver: Session | null, sessions: Session[], asks: Ask[], now: number): boolean {
  if (driver === null) return sessions.length > 0;
  return sessionActivity(driver, now) === 'idle' && now - Date.parse(driver.lastSeenAt) >= STALL_MS && asks.length === 0;
}

/** Whole minutes under two hours (`45m`), else whole hours (`2h`). */
function idleSpan(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  return minutes < 120 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

/**
 * One line of `orchestrate --status`'s Reconcile list (spec 3.2), without its indent: the facts Mip needs for a stalled
 * row (the idle driver's tag, idle time, branch and cwd, then each live helper's; or that no live session drives it,
 * and each session on it with its branch and cwd), else the mark's name.
 */
export function reconcileLine(row: Pick<BoardRow, 'node' | 'driver' | 'sessions'>, mark: Mark, now: number): string {
  const head = `#${row.node.id} ${mark}`;
  if (mark !== 'stalled') return head;
  const where = (s: Session) => `branch ${s.branch ?? '?'} · cwd ${s.cwd ?? '?'}`;
  const entry = (s: Session) => `${ownerTag(s.slot)} ${where(s)}`;
  const d = row.driver;
  if (d === null) return `${head}: no live driver · on it: ${row.sessions.map(entry).join('; ')}`;
  const helpers = row.sessions.filter((s) => s.id !== d.id);
  return `${head}: ${ownerTag(d.slot)} idle ${idleSpan(d.lastSeenAt, now)} · ${where(d)}${helpers.length ? `; helping: ${helpers.map(entry).join('; ')}` : ''}`;
}

/** Places every step of the snapshot (spec 1.5) and marks the ones that need tidying (spec 1.6). */
export function deriveBoard(input: BoardInput, now: number): Board {
  const index = buildIndex(input.nodes);
  const order = dfsOrder(index);
  const rootId = index.root?.id ?? null;
  const live = input.sessions.filter((s) => isLive(s, now));
  const liveIds = new Set(live.map((s) => s.id));
  const focusOf = new Map<number, Session[]>();
  for (const s of live) if (s.focusNodeId !== null) focusOf.set(s.focusNodeId, [...(focusOf.get(s.focusNodeId) ?? []), s]);
  for (const list of focusOf.values()) list.sort((a, b) => (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3) || (a.slot ?? 0) - (b.slot ?? 0));
  const openAsks = new Map<number, Ask[]>();
  for (const a of input.asks) if (a.clearedAt === null) openAsks.set(a.nodeId, [...(openAsks.get(a.nodeId) ?? []), a]);
  for (const list of openAsks.values()) list.sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || a.id - b.id);
  // Steps with an answer no session has been handed yet (spec 2.4); the snapshot keeps cleared asks for ASK_TRAIL_MS.
  const answerWaiting = new Set<number>();
  for (const a of input.asks) if (a.clearedAt !== null && a.answer.trim() && a.answerDeliveredAt === null) answerWaiting.add(a.nodeId);
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
    const focused = focusOf.get(node.id) ?? [];
    // The focused sessions are already live, so a driver found among them is the live driver.
    const driver = focused.find((x) => x.id === node.driverSessionId) ?? null;
    const sessions = driver ? [driver, ...focused.filter((x) => x !== driver)] : focused;
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
    } else if (column !== 'now') {
      const past = lastPast.get(node.id);
      const handoff = handoffOf.get(node.id);
      if (past && now - Date.parse(past.endedAt) <= TRAIL_MS && !(handoff && handoff.createdAt > past.startedAt)) marks.push('ended_open');
    }
    // Any row: a review ask may sit on a done step (spec 1.2).
    if (asks.some((a) => now - Date.parse(a.raisedAt) > ASK_TRAIL_MS)) marks.push('stale_ask');
    if (crumb.length >= 3) marks.push('deep');
    if (node.status === 'active' && node.assignee !== 'me' && isStalled(driver, sessions, asks, now)) marks.push('stalled');
    // A question's answer is its outcome, not owed work (Review Focus 5). A done step has no driver to deliver to.
    if (node.kind !== 'question' && node.status !== 'done' && answerWaiting.has(node.id)) marks.push('answer_waiting');
    byId.set(node.id, {
      node, column, crumb, sessions, driver, asks, marks,
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
