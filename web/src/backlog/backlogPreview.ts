import type { Board } from '../../../src/core/board';
import { buildIndex, dfsOrder } from '../../../src/core/tree';
import type { TaskBox } from '../../../src/core/taskState';
import type { TreeNode } from '../../../src/core/types';
import { phaseOf, type Entry } from '../board/backlogOrder';

/** The Board's Backlog preview shows this many entries. */
export const PREVIEW_SIZE = 5;

/** A phase's id, or 'none' for steps with no phase. */
export type PreviewPhase = number | 'none';

export interface PhaseChoice {
  value: PreviewPhase;
  title: string;
}

/** Where the picked phase is kept, per project and per browser. */
export const previewKey = (projectId: number): string => `ip.backlogPreview.${projectId}`;

export const formatPreview = (v: PreviewPhase): string => String(v);

/** Reads a stored choice; anything but 'none' or a positive whole number is no choice. */
export function parsePreview(raw: string | null): PreviewPhase | null {
  if (raw === 'none') return 'none';
  return raw !== null && /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

/** The phase value of an entry: its nearest phase ancestor's id, else 'none'. */
export const phaseValue = (row: { crumb: TreeNode[] }): PreviewPhase => phaseOf(row)?.id ?? 'none';

/** Every phase that has Backlog entries, in tree order, then No phase (always listed). */
export function backlogPhases(board: { backlog: { crumb: TreeNode[] }[] }, nodes: TreeNode[]): PhaseChoice[] {
  const order = dfsOrder(buildIndex(nodes));
  const phases = new Map<number, TreeNode>();
  for (const r of board.backlog) {
    const p = phaseOf(r);
    if (p) phases.set(p.id, p);
  }
  const sorted = [...phases.values()].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return [...sorted.map((p): PhaseChoice => ({ value: p.id, title: p.title })), { value: 'none', title: 'No phase' }];
}

/**
 * The phase the preview shows. The stored choice, if it still has Backlog entries; else the phase of the most recently
 * completed step, if it has entries; else the first phase in tree order with entries; else No phase.
 */
export function previewPhase(board: Pick<Board, 'backlog' | 'done'>, nodes: TreeNode[], stored: PreviewPhase | null): PreviewPhase {
  const has = (v: PreviewPhase) => board.backlog.some((r) => phaseValue(r) === v);
  if (stored !== null && has(stored)) return stored;
  const latest = board.done[0];
  if (latest) {
    const v = phaseValue(latest);
    if (has(v)) return v;
  }
  const first = backlogPhases(board, nodes).find((c) => c.value !== 'none' && has(c.value));
  return first ? first.value : 'none';
}

/**
 * The picker's choices and the phase shown, from the Backlog cell's boxes: the same list the rows and the count read. The
 * board's own backlog also holds a step with an open ask or an unattended active step, which sit in other cells.
 */
export function previewState(backlog: TaskBox[], board: Pick<Board, 'done'>, nodes: TreeNode[], stored: PreviewPhase | null): { choices: PhaseChoice[]; phase: PreviewPhase } {
  const own = { backlog: backlog.map((b) => b.row!), done: board.done };
  return { choices: backlogPhases(own, nodes), phase: previewPhase(own, nodes, stored) };
}

/** The entries of the picked phase, in the order given, at most PREVIEW_SIZE. */
export function previewRows<T extends Entry>(entries: T[], phase: PreviewPhase): T[] {
  return entries.filter((e) => phaseValue(e.row!) === phase).slice(0, PREVIEW_SIZE);
}

/** How many entries each phase holds (a phase with none is absent), for the tab strip's counts. */
export function phaseCounts<T extends Entry>(entries: T[]): Map<PreviewPhase, number> {
  const counts = new Map<PreviewPhase, number>();
  for (const e of entries) {
    const v = phaseValue(e.row!);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}
