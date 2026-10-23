import type { BoardRow } from '../../../src/core/board';
import { LABEL_GLYPHS } from '../../../src/core/types';
import { Chip } from '../parts/Chip';
import { noteAction, type MeasureArea } from '../measure';
import { MARK_WORDS } from './Marks';
import { ageShort } from './text';

/**
 * The hygiene words a tile shows. ended_open has its own line; no_why is Mip's to fill from Reconcile (#536), and on every
 * new session step's tile it would be noise.
 */
const tileMarks = (row: BoardRow) => row.marks.filter((m) => m !== 'ended_open' && m !== 'no_why');

/** Whether the foot has anything to show: a tile with none draws no foot row at all. */
export function tileFootHas(row: BoardRow, docs: number, noLabel?: boolean): boolean {
  return Boolean(row.handoff) || docs > 0 || Boolean(row.node.label && !noLabel) || row.node.origin === 'proposed' || tileMarks(row).length > 0;
}

/** A tile's foot: the handoff (opens the viewer), the documents, the label, and the hygiene words, all as parts. */
export function TileFoot({ row, now, area, docs, noLabel, onOpenResource }: { row: BoardRow; now: number; area: MeasureArea; docs: number; /** The label is already in the tile's top (Done). */ noLabel?: boolean; onOpenResource: (id: number) => void }) {
  const label = row.node.label;
  const hygiene = tileMarks(row);
  return (
    <>
      {row.handoff && (
        <button
          type="button"
          className="ip-tile-handoff"
          data-act
          onClick={(e) => {
            e.stopPropagation();
            noteAction(area, 'open_handoff');
            onOpenResource(row.handoff!.id);
          }}
        >
          <Chip tone="quiet">{`handoff · ${ageShort(row.handoff.createdAt, now)}`}</Chip>
        </button>
      )}
      {docs > 0 && <span className="ip-docs" title={`${docs} resource${docs > 1 ? 's' : ''}`}>{`▤ ${docs}`}</span>}
      {label && !noLabel && <Chip tone="label" glyph={LABEL_GLYPHS[label]} title={label}>{label}</Chip>}
      {row.node.origin === 'proposed' && <Chip tone="quiet" dashed>proposed</Chip>}
      {hygiene.map((m) => <Chip key={m} tone="quiet">{MARK_WORDS[m]}</Chip>)}
    </>
  );
}
