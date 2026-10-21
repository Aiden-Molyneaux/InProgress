import { buildIndex, dfsOrder } from '../../../src/core/tree';
import type { Backlog } from '../../../src/core/backlog';
import type { TaskBox } from '../../../src/core/taskState';
import type { TreeNode } from '../../../src/core/types';
import { phaseOf } from '../board/backlogOrder';

/** The Board's Backlog preview shows this many entries. */
export const PREVIEW_SIZE = 5;

/** A phase's id, or 'none' for steps with no phase. */
export type PreviewPhase = number | 'none';

export interface PhaseChoice {
  value: PreviewPhase;
  title: string;
}

/** Where the Backlog page's view is kept, per project and per browser (#542 reads it; the preview's Triage › writes it). */
export const backlogViewKey = (projectId: number): string => `ip.backlogView.${projectId}`;

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
 * What the preview shows of Soon: its first PREVIEW_SIZE steps in rank order with deriveBacklog's numbers, kept to the
 * steps in the Board's Backlog cell (`boxes`, which is pending-aware: a step with an ask or an unattended active step
 * sits in another cell). `count` is the kept length, `more` what lies past the rows, and `triage` is true when an
 * unranked step is in the cell.
 */
export function soonPreview(backlog: Pick<Backlog, 'soon' | 'triage'>, boxes: TaskBox[]): { rows: { box: TaskBox; number: number | null }[]; count: number; more: number; triage: boolean } {
  const byId = new Map(boxes.map((b) => [b.row!.node.id, b]));
  const kept = backlog.soon.flatMap((r) => {
    const box = byId.get(r.row.node.id);
    return box ? [{ box, number: r.number }] : [];
  });
  const rows = kept.slice(0, PREVIEW_SIZE);
  return { rows, count: kept.length, more: kept.length - rows.length, triage: backlog.triage.some((r) => byId.has(r.row.node.id)) };
}
