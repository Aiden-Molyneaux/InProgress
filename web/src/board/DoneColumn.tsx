import { Fragment } from 'react';
import { LabelChip, rowClick, StepMarks } from './Marks';
import type { BandProps } from './bandProps';
import { ageShort } from './text';

/** The Board shows this many of the newest done steps. */
export const DONE_SHOWN = 5;

/**
 * Done as a timeline (spec 2.2): ages at the left, ✓ dots on a rule, the title, label, outcome clamped to two lines and
 * marks. "New since you looked" crosses the rule where `lastLook` falls. Narrow folds the rows done before it to one line.
 */
export function DoneColumn({ board, now, wide, lastLook, onOpenNode, onOpenResource }: BandProps & { lastLook: string | null }) {
  const rows = board.done.slice(0, DONE_SHOWN);
  if (rows.length === 0) return <p className="ip-quiet ip-empty-line">Nothing done yet</p>;
  const isNew = (completedAt: string | null) => lastLook !== null && (completedAt ?? '') > lastLook;
  const fresh = rows.filter((r) => isNew(r.node.completedAt));
  // Narrow keeps the full row only for what is new; with no last look every row is full.
  const folded = !wide && lastLook !== null ? rows.filter((r) => !isNew(r.node.completedAt)) : [];
  const shown = rows.filter((r) => !folded.includes(r));
  const dividerAfter = fresh.length > 0 ? fresh[fresh.length - 1].node.id : null;
  return (
    <ol className="ip-timeline">
      {shown.map((row) => (
        <Fragment key={row.node.id}>
          <li className="ip-row ip-done-row" data-node={row.node.id} onClick={rowClick('done', () => onOpenNode(row.node.id))}>
            <span className="ip-done-age">{row.node.completedAt ? ageShort(row.node.completedAt, now) : ''}</span>
            <span className="ip-done-dot" aria-hidden="true">✓</span>
            <div className="ip-done-body">
              <div className="ip-quote">
                <button type="button" className="ip-row-title">{row.node.title}</button>
                <LabelChip label={row.node.label} />
                <StepMarks row={row} now={now} onOpenResource={onOpenResource} />
              </div>
              {row.node.outcome.trim() && <p className="ip-clamp-2 ip-outcome-line">{row.node.outcome}</p>}
            </div>
          </li>
          {row.node.id === dividerAfter && (
            <li className="ip-divider" role="separator">
              <span>New since you looked</span>
            </li>
          )}
        </Fragment>
      ))}
      {folded.length > 0 && <li className="ip-done-fold">{`✓ ${folded.length} earlier`}</li>}
    </ol>
  );
}
