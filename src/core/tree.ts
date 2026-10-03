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

export type VisibleItem =
  | { type: 'node'; node: TreeNode; depth: number; folded: boolean; hasChildren: boolean }
  | { type: 'more'; parentId: number; run: number; depth: number; hiddenIds: number[] };

export interface VisibleOptions {
  overrides?: FoldOverrides;
  noFold?: boolean;
  /** More nodes to keep in view, as a session's focus is. The canvas pins where subagents and tasks in progress are. */
  pins?: Iterable<number>;
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

  const hiddenRuns = (parent: TreeNode, list: TreeNode[]): number[][] => {
    if (opts.noFold || overrides[`more:${parent.id}`] === 'open') return [];
    let last = -1;
    list.forEach((k, i) => {
      if (k.status === 'done' || k.status === 'active') last = i;
    });
    // Walk the tail past the frontier. Pinned children show. Until two unpinned todo/blocked children
    // have shown, those and any dropped ones show too; every unpinned child after that hides.
    const hidden = new Set<number>();
    let shown = 0;
    for (const k of list.slice(last + 1)) {
      if (pinned.has(k.id)) continue;
      if (shown >= 2) hidden.add(k.id);
      else if (k.status === 'todo' || k.status === 'blocked') shown++;
    }
    if (hidden.size < 2) return [];
    const runs: number[][] = [];
    let current: number[] = [];
    for (const k of list) {
      if (hidden.has(k.id)) current.push(k.id);
      else if (current.length) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length) runs.push(current);
    return runs;
  };

  const visit = (n: TreeNode, depth: number) => {
    const list = kids(index, n.id);
    const folded = isFolded(n);
    out.push({ type: 'node', node: n, depth, folded, hasChildren: list.length > 0 });
    if (folded) return;
    const runs = hiddenRuns(n, list);
    const runOf = new Map<number, number>();
    runs.forEach((run, i) => run.forEach((id) => runOf.set(id, i)));
    for (const k of list) {
      const run = runOf.get(k.id);
      if (run === undefined) visit(k, depth + 1);
      else if (runs[run][0] === k.id) out.push({ type: 'more', parentId: n.id, run, depth: depth + 1, hiddenIds: runs[run] });
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
