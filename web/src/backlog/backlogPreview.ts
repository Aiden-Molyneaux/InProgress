import type { Backlog } from '../../../src/core/backlog';
import type { TaskBox } from '../../../src/core/taskState';

/** The Board's Backlog preview shows this many entries. */
export const PREVIEW_SIZE = 5;

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
