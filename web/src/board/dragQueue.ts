import type { BoardRow } from '../../../src/core/board';
import type { QueueOp } from '../../../src/core/types';

/** Where a step was dropped: into Next before a step (null: at the end of the unowned queue), or back onto Backlog. */
export type DropTarget = { zone: 'next'; before: number | null } | { zone: 'backlog' };

/** What a drop means, as a queue operation (spec 2.5). */
export function dropToOp(nodeId: number, target: DropTarget): QueueOp {
  return target.zone === 'next' ? { kind: 'move', node: nodeId, before: target.before } : { kind: 'remove', node: nodeId };
}

/** The part of a Next row the order needs: its id, and whether a session's own queue holds it. */
type NextRow = Pick<BoardRow, 'owner'> & { node: Pick<BoardRow['node'], 'id'> };

/**
 * The Next order the window shows at once, before the server's event: the op applied to the rows, as the server applies
 * it. A move takes the step out wherever it sits and places it in the unowned part before `before`; a `before` that is
 * not unowned, or is the step itself, appends. Own-queue entries stay after the unowned ones.
 */
export function optimisticNext(rows: NextRow[], op: QueueOp): number[] {
  const unowned = rows.filter((r) => !r.owner && r.node.id !== op.node).map((r) => r.node.id);
  const owned = rows.filter((r) => r.owner && r.node.id !== op.node).map((r) => r.node.id);
  if (op.kind === 'remove') return [...unowned, ...owned];
  const at = op.before === null ? -1 : unowned.indexOf(op.before);
  if (at < 0) unowned.push(op.node);
  else unowned.splice(at, 0, op.node);
  return [...unowned, ...owned];
}
