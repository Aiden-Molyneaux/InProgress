import type { Board, BoardRow } from '../../../src/core/board';
import { buildIndex, kids, type TreeIndex } from '../../../src/core/tree';
import type { ProjectSnapshot, ResourceMeta, TreeNode } from '../../../src/core/types';

export interface Section {
  /** The group node; null for "Top level". */
  group: TreeNode | null;
  title: string;
  /** Steps below it, at all depths. */
  done: number;
  total: number;
  counts: { now: number; next: number; backlog: number; done: number };
  /** Resources on the group and on every node below it. */
  docs: ResourceMeta[];
  /** Open steps, indented. */
  lines: OutlineLine[];
  /** A step in Now or Next, or an open ask. */
  startsOpen: boolean;
  allDone: boolean;
}

export type OutlineLine =
  /** `row` is null for a group line (an open step whose children are the rows). */
  | { kind: 'step'; row: BoardRow | null; node: TreeNode; depth: number }
  /** A parent's done children folded to one line; `nodes` are the folded steps, newest first. */
  | { kind: 'done'; parentId: number; count: number; latest: TreeNode; depth: number; nodes: TreeNode[] };

const OPEN = new Set(['todo', 'active', 'blocked']);
const isOpen = (n: TreeNode) => OPEN.has(n.status);
/** A step that is open work or set aside: a done step holding one is not finished, so its line is not folded away. */
const unfinished = (n: TreeNode) => isOpen(n) || n.status === 'parked';
/** The steps shown under `id`: dropped ones are left out, and a parked step's whole subtree is shelved, so it holds none. */
const live = (index: TreeIndex, id: number) => (index.byId.get(id)?.status === 'parked' ? [] : kids(index, id).filter((c) => c.status !== 'dropped'));

/** Every step below `id`, at all depths, dropped ones and what is under them left out. */
function below(index: TreeIndex, id: number): TreeNode[] {
  return live(index, id).flatMap((c) => [c, ...below(index, c.id)]);
}

const newestFirst = (a: TreeNode, b: TreeNode) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || b.id - a.id;

function foldLine(parentId: number, folded: TreeNode[], depth: number): OutlineLine {
  const nodes = [...folded].sort(newestFirst);
  return { kind: 'done', parentId, count: nodes.length, latest: nodes[0]!, depth, nodes };
}

/** The open steps under `parentId`, one line each, and its done children (the ones with nothing open below) folded to one line. */
function linesUnder(index: TreeIndex, board: Board, parentId: number, depth: number, out: OutlineLine[]): void {
  const folded: TreeNode[] = [];
  for (const child of live(index, parentId)) {
    if (child.status === 'done' && !below(index, child.id).some(unfinished)) {
      folded.push(child);
      continue;
    }
    out.push({ kind: 'step', row: board.byId.get(child.id) ?? null, node: child, depth });
    linesUnder(index, board, child.id, depth + 1, out);
  }
  if (folded.length) out.push(foldLine(parentId, folded, depth));
}

/** Sections (spec 2.4): top-level groups in tree order, then "Top level", then the fully done groups. */
export function projectSections(snapshot: ProjectSnapshot, board: Board): Section[] {
  const index = buildIndex(snapshot.nodes);
  const root = index.root;
  if (!root) return [];
  const openAsk = new Set(snapshot.asks.filter((a) => a.clearedAt === null).map((a) => a.nodeId));
  const make = (group: TreeNode | null, title: string, allMembers: TreeNode[], lines: OutlineLine[]): Section => {
    const ids = new Set(allMembers.map((n) => n.id));
    if (group) ids.add(group.id);
    // Parked steps are neither open nor finished: out of the counts, as dropped ones are, though they still show as lines.
    const parked = allMembers.some((n) => n.status === 'parked');
    const members = allMembers.filter((n) => n.status !== 'parked');
    const counts = { now: 0, next: 0, backlog: 0, done: members.filter((n) => n.status === 'done').length };
    for (const n of members) {
      const column = board.byId.get(n.id)?.column;
      if (column === 'now' || column === 'next' || column === 'backlog') counts[column]++;
    }
    return {
      group, title, done: counts.done, total: members.length, counts,
      docs: snapshot.resources.filter((r) => ids.has(r.nodeId)),
      lines,
      startsOpen: counts.now + counts.next > 0 || [...ids].some((id) => openAsk.has(id)),
      allDone: !parked && members.length > 0 && counts.done === members.length,
    };
  };
  const groups: Section[] = [];
  const loose: TreeNode[] = [];
  for (const child of live(index, root.id)) {
    if (live(index, child.id).length === 0) {
      loose.push(child);
      continue;
    }
    const lines: OutlineLine[] = [];
    linesUnder(index, board, child.id, 0, lines);
    groups.push(make(child, child.title, below(index, child.id), lines));
  }
  const sections = groups.filter((s) => !s.allDone);
  if (loose.length) {
    const lines: OutlineLine[] = loose.filter((n) => !(n.status === 'done')).map((node) => ({ kind: 'step', row: board.byId.get(node.id) ?? null, node, depth: 0 }));
    const done = loose.filter((n) => n.status === 'done');
    if (done.length) lines.push(foldLine(root.id, done, 0));
    const top = make(null, 'Top level', loose, lines);
    // Nothing open at the top level: there is no section to show.
    if (!top.allDone) sections.push(top);
  }
  return [...sections, ...groups.filter((s) => s.allDone)];
}

/** The page head's figures: the phases (sections that are a group, finished ones too), and the steps now, next and done. */
export function headMeta(board: Board, sections: Section[]): { label: string; value: number }[] {
  return [
    { label: 'PHASES', value: sections.filter((s) => s.group).length },
    { label: 'NOW', value: board.now.length },
    { label: 'NEXT', value: board.next.length },
    { label: 'DONE', value: board.done.length },
  ];
}
