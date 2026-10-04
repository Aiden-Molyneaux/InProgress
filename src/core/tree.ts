import { glyphTitle, type Session, type TreeNode } from './types';

export type FoldOverrides = Record<string, 'open' | 'closed'>;
type SessionLike = Pick<Session, 'focusNodeId' | 'state'>;

export interface TreeIndex {
  byId: Map<number, TreeNode>;
  children: Map<number, TreeNode[]>;
  root: TreeNode | undefined;
}

export function buildIndex(nodes: TreeNode[]): TreeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const children = new Map<number, TreeNode[]>();
  let root: TreeNode | undefined;
  for (const n of nodes) {
    if (n.parentId === null) {
      root = n;
      continue;
    }
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position || a.id - b.id);
  return { byId, children, root };
}

export const kids = (index: TreeIndex, id: number): TreeNode[] => index.children.get(id) ?? [];

export function isNeedsYou(n: Pick<TreeNode, 'assignee' | 'status'>): boolean {
  return n.assignee === 'me' && (n.status === 'todo' || n.status === 'active' || n.status === 'blocked');
}

export function ancestors(index: TreeIndex, id: number): TreeNode[] {
  const out: TreeNode[] = [];
  let cur = index.byId.get(id);
  while (cur && cur.parentId !== null) {
    const parent = index.byId.get(cur.parentId);
    if (!parent) break;
    out.unshift(parent);
    cur = parent;
  }
  return out;
}

export function progress(index: TreeIndex, id: number): { done: number; total: number } | null {
  const list = kids(index, id).filter((c) => c.status !== 'dropped');
  if (list.length === 0) return null;
  return { done: list.filter((c) => c.status === 'done').length, total: list.length };
}

export function countDone(index: TreeIndex, id: number): number {
  let count = 0;
  const walk = (nid: number) => {
    for (const k of kids(index, nid)) {
      if (k.status === 'done') count++;
      walk(k.id);
    }
  };
  walk(id);
  return count;
}

/** Nodes the fold rules never hide, with their ancestors: active and needs-you nodes, live sessions' focus, and `extra`. */
export function pinnedIds(index: TreeIndex, sessions: SessionLike[], extra: Iterable<number> = []): Set<number> {
  const pinned = new Set<number>();
  const pin = (id: number) => {
    let cur = index.byId.get(id);
    while (cur && !pinned.has(cur.id)) {
      pinned.add(cur.id);
      cur = cur.parentId === null ? undefined : index.byId.get(cur.parentId);
    }
  };
  for (const n of index.byId.values()) {
    if (n.parentId !== null && (n.status === 'active' || isNeedsYou(n))) pin(n.id);
  }
  for (const s of sessions) if (s.state !== 'ended' && s.focusNodeId !== null) pin(s.focusNodeId);
  for (const id of extra) pin(id);
  return pinned;
}

export function dfsOrder(index: TreeIndex): Map<number, number> {
  const order = new Map<number, number>();
  const visit = (n: TreeNode) => {
    order.set(n.id, order.size);
    for (const k of kids(index, n.id)) visit(k);
  };
  if (index.root) visit(index.root);
  return order;
}

/** The fewest finished siblings in a row that fold into one "✓ n done" row. */
export const DONE_RUN_MIN = 3;
/** How long ago a step must have finished before it can fold into a "✓ n done" row. */
export const DONE_RUN_AGE_MS = 24 * 60 * 60 * 1000;

export type VisibleItem =
  | { type: 'node'; node: TreeNode; depth: number; folded: boolean; hasChildren: boolean }
  /** Hidden siblings shown as one row: the far todo tail ("+n more") or a run of old finished steps ("✓ n done"). */
  | { type: 'more'; parentId: number; run: number; depth: number; hiddenIds: number[]; variant: 'tail' | 'done' };

export interface VisibleOptions {
  overrides?: FoldOverrides;
  noFold?: boolean;
  /** More nodes to keep in view, as a session's focus is. The canvas pins where subagents and tasks in progress are. */
  pins?: Iterable<number>;
  /** Fold runs of finished siblings. The canvas passes it; the text outline never does. */
  doneRuns?: { now: number };
}

/** Whether a step finished more than DONE_RUN_AGE_MS before `now`. A done step with no completion time counts as recent. */
function finishedLongAgo(n: TreeNode, now: number): boolean {
  const at = n.status === 'done' ? n.completedAt : n.status === 'dropped' ? n.updatedAt : null;
  // An unparseable time is NaN, and a NaN age is never old.
  return at !== null && now - Date.parse(at) > DONE_RUN_AGE_MS;
}

/** The runs of consecutive children that `hides` picks, as id lists, keeping only runs of at least `min`. */
function runsOf(list: TreeNode[], hides: (n: TreeNode) => boolean, min: number): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  const close = () => {
    if (current.length >= min) runs.push(current);
    current = [];
  };
  for (const k of list) {
    if (hides(k)) current.push(k.id);
    else close();
  }
  close();
  return runs;
}

export function computeVisible(index: TreeIndex, sessions: SessionLike[], opts: VisibleOptions = {}): VisibleItem[] {
  const out: VisibleItem[] = [];
  if (!index.root) return out;
  const overrides = opts.overrides ?? {};
  const pinned = pinnedIds(index, sessions, opts.pins);

  const isFolded = (n: TreeNode): boolean => {
    if (opts.noFold || kids(index, n.id).length === 0) return false;
    const manual = overrides[`n:${n.id}`];
    if (manual) return manual === 'closed';
    return (n.status === 'done' || n.status === 'dropped') && !pinned.has(n.id);
  };

  /** The children the far todo tail hides, whether or not its "+n more" is open. */
  const tailIds = (list: TreeNode[]): Set<number> => {
    const hidden = new Set<number>();
    if (opts.noFold) return hidden;
    let last = -1;
    list.forEach((k, i) => {
      if (k.status === 'done' || k.status === 'active') last = i;
    });
    // Walk the tail past the frontier. Pinned children show. Until two unpinned todo/blocked children
    // have shown, those and any dropped ones show too; every unpinned child after that hides.
    let shown = 0;
    for (const k of list.slice(last + 1)) {
      if (pinned.has(k.id)) continue;
      if (shown >= 2) hidden.add(k.id);
      else if (k.status === 'todo' || k.status === 'blocked') shown++;
    }
    return hidden.size < 2 ? new Set() : hidden;
  };

  const hiddenRuns = (parent: TreeNode, list: TreeNode[], tail: Set<number>): number[][] =>
    overrides[`more:${parent.id}`] === 'open' ? [] : runsOf(list, (k) => tail.has(k.id), 1);

  // Runs of DONE_RUN_MIN or more old finished children, outside the tail: steps an opened "+n more" shows never fold
  // again. A pinned child splits a run. Only the parent's done: override opens them: a parent unfolded by its chevron
  // still folds its old runs.
  const doneRuns = (parent: TreeNode, list: TreeNode[], tail: Set<number>): number[][] => {
    const when = opts.doneRuns;
    if (!when || opts.noFold || overrides[`done:${parent.id}`] === 'open') return [];
    return runsOf(list, (k) => !tail.has(k.id) && !pinned.has(k.id) && finishedLongAgo(k, when.now), DONE_RUN_MIN);
  };

  type Run = { hiddenIds: number[]; run: number; variant: 'tail' | 'done' };
  const visit = (n: TreeNode, depth: number) => {
    const list = kids(index, n.id);
    const folded = isFolded(n);
    out.push({ type: 'node', node: n, depth, folded, hasChildren: list.length > 0 });
    if (folded) return;
    // The tail first, then the finished runs among the other children.
    const tail = tailIds(list);
    const runs: Run[] = [
      ...hiddenRuns(n, list, tail).map((hiddenIds, run) => ({ hiddenIds, run, variant: 'tail' as const })),
      ...doneRuns(n, list, tail).map((hiddenIds, run) => ({ hiddenIds, run, variant: 'done' as const })),
    ];
    const runOf = new Map<number, Run>();
    for (const r of runs) for (const id of r.hiddenIds) runOf.set(id, r);
    for (const k of list) {
      const r = runOf.get(k.id);
      if (r === undefined) visit(k, depth + 1);
      else if (r.hiddenIds[0] === k.id) out.push({ type: 'more', parentId: n.id, run: r.run, depth: depth + 1, hiddenIds: r.hiddenIds, variant: r.variant });
    }
  };
  visit(index.root, 0);
  return out;
}

export function statusLabel(n: TreeNode): string {
  if (!isNeedsYou(n)) return n.status;
  return n.status === 'todo' ? 'NEEDS YOU' : `NEEDS YOU (${n.status})`;
}

export function nodeLine(index: TreeIndex, n: TreeNode, resourcesByNode?: Map<number, number[]>): string {
  const kind = n.parentId === null || n.kind === 'task' ? '' : ` (${n.kind})`;
  const prog = progress(index, n.id);
  const res = resourcesByNode?.get(n.id);
  return `#${n.id} ${glyphTitle(n)}${kind} — ${statusLabel(n)}${prog ? ` (${prog.done}/${prog.total})` : ''}${res?.length ? ` [${res.map((r) => `r${r}`).join(', ')}]` : ''}`;
}

export interface OutlineOptions {
  full?: boolean;
  overrides?: FoldOverrides;
  resourcesByNode?: Map<number, number[]>;
}

export function renderOutline(index: TreeIndex, sessions: SessionLike[], opts: OutlineOptions = {}): string {
  return computeVisible(index, sessions, { overrides: opts.overrides, noFold: opts.full })
    .map((item) => {
      const pad = '  '.repeat(item.depth);
      if (item.type === 'more') return `${pad}+${item.hiddenIds.length} more: ${item.hiddenIds.map((id) => `#${id}`).join(', ')}`;
      const line = nodeLine(index, item.node, opts.resourcesByNode);
      return item.folded ? `${pad}${line} · ${countDone(index, item.node.id)} done inside (folded)` : `${pad}${line}`;
    })
    .join('\n');
}
