import { Fragment } from 'react';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import type { BandProps } from './bandProps';
import { TaskBox } from './TaskBox';

/** The Board shows this many of the newest done steps. */
export const DONE_SHOWN = 5;

/**
 * Done as a list of boxes (spec 2.2): the title, the outcome clamped to two lines and the marks. "New since you looked"
 * crosses the list where `lastLook` falls. Narrow folds the boxes done before it to one line.
 */
export function DoneColumn({ board, boxes, snapshot, now, wide, lastLook, onOpenNode, onOpenResource, onOpenDone }: BandProps & { lastLook: string | null }) {
  const rows = boxes.done.slice(0, DONE_SHOWN);
  if (board.done.length === 0) return <p className="ip-quiet ip-empty-line">Nothing done yet</p>;
  const completedAt = (b: BoxData) => b.row!.node.completedAt;
  const isNew = (b: BoxData) => lastLook !== null && (completedAt(b) ?? '') > lastLook;
  const fresh = rows.filter(isNew);
  // Narrow keeps the full box only for what is new; with no last look every box is full.
  const folded = !wide && lastLook !== null ? rows.filter((b) => !isNew(b)) : [];
  const shown = rows.filter((b) => !folded.includes(b));
  const dividerAfter = fresh.length > 0 ? fresh[fresh.length - 1].row!.node.id : null;
  return (
    <>
      <ol className="ip-list">
        {shown.map((box) => {
          const node = box.row!.node;
          return (
            <Fragment key={node.id}>
              <TaskBox
                box={box}
                now={now}
                area="done"
                docs={snapshot.resources.filter((r) => r.nodeId === node.id).length}
                onOpenNode={onOpenNode}
                onOpenResource={onOpenResource}
              >
                {node.outcome.trim() && <p className="ip-card-outcome ip-clamp-2">{node.outcome}</p>}
              </TaskBox>
              {node.id === dividerAfter && (
                <li className="ip-divider" role="separator">
                  <span>New since you looked</span>
                </li>
              )}
            </Fragment>
          );
        })}
        {folded.length > 0 && <li className="ip-done-fold">{`✓ ${folded.length} earlier`}</li>}
      </ol>
      {onOpenDone && (
        <button type="button" className="ip-done-all" onClick={onOpenDone}>{`All done · ${board.done.length} ›`}</button>
      )}
    </>
  );
}
