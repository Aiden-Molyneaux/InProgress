import { Fragment } from 'react';
import type { Board } from '../../../src/core/board';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import { EmptyState } from '../parts/EmptyState';
import type { CursorItemProps } from '../parts/ListCursor';
import { LABEL_GLYPHS } from '../../../src/core/types';
import { Ruler } from '../parts/Ruler';
import type { BandProps } from './bandProps';
import type { BoardLayout } from './layout';
import { BoardTile } from './BoardTile';
import { hhmm } from './text';

/** The Board shows this many of the newest done steps. */
export const DONE_SHOWN = 5;

/** What Done draws: the full tiles, the ones folded to "✓ N earlier", and the step the since-ruler comes after. */
export interface DoneView {
  shown: BoxData[];
  folded: BoxData[];
  dividerAfter: number | null;
}

/**
 * The newest five done steps. The since-ruler falls after the last one completed since `lastLook`. The one-column layout
 * keeps the full tile only for what is new (with no last look every tile is full) and folds the rest.
 */
export function doneView(boxes: BandProps['boxes'], layout: BoardLayout, lastLook: string | null): DoneView {
  const rows = boxes.done.slice(0, DONE_SHOWN);
  const isNew = (b: BoxData) => lastLook !== null && (b.row!.node.completedAt ?? '') > lastLook;
  const fresh = rows.filter(isNew);
  const folded = layout === 'one' && lastLook !== null ? rows.filter((b) => !isNew(b)) : [];
  return {
    shown: rows.filter((b) => !folded.includes(b)),
    folded,
    dividerAfter: fresh.length > 0 ? fresh[fresh.length - 1].row!.node.id : null,
  };
}

/** The keys of the Done tiles drawn in full, in draw order: the grid's cursor and the rise follow them. */
export function doneKeys(view: DoneView): string[] {
  return view.shown.map((b) => String(b.row!.node.id));
}

/**
 * Done as compact tiles (spec 7): the title, the outcome clamped to two lines, and the label. The violet since-ruler
 * crosses the list where `lastLook` falls. The one-column layout folds the tiles done before it to one line.
 */
export function DoneColumn({ board, view, snapshot, now, selectedNode, lastLook, onOpenNode, onOpenResource, onOpenDone, cursor, rise }: BandProps & {
  board: Board;
  view: DoneView;
  lastLook: string | null;
  /** The grid cursor's props for the tile at this row. */
  cursor: (row: number) => CursorItemProps;
  /** The stagger place a tile key (`done:<id>`) rises with. */
  rise: (key: string) => number | undefined;
}) {
  if (board.done.length === 0) return <EmptyState>Nothing done yet</EmptyState>;
  const { shown, folded, dividerAfter } = view;
  return (
    <>
      <ol className="ip-list">
        {shown.map((box, at) => {
          const node = box.row!.node;
          return (
            <Fragment key={node.id}>
              <BoardTile
                box={box}
                now={now}
                area="done"
                band="done"
                docs={snapshot.resources.filter((r) => r.nodeId === node.id).length}
                cursor={cursor(at)}
                rise={rise(`done:${node.id}`)}
                selected={selectedNode === node.id}
                chips={node.label ? <Chip tone="label" glyph={LABEL_GLYPHS[node.label]} title={node.label}>{node.label}</Chip> : undefined}
                onOpenNode={onOpenNode}
                onOpenResource={onOpenResource}
              >
                {node.outcome.trim() && <p className="ip-done-outcome ip-clamp-2">{node.outcome}</p>}
              </BoardTile>
              {node.id === dividerAfter && lastLook !== null && (
                <li className="ip-since" role="separator">
                  <Ruler variant="since" label={`SINCE YOU LOOKED · ${hhmm(lastLook)}`} />
                </li>
              )}
            </Fragment>
          );
        })}
        {folded.length > 0 && <li className="ip-done-fold">{`✓ ${folded.length} earlier`}</li>}
      </ol>
      {onOpenDone && (
        <Button variant="ghost" size="sm" glyph="›" className="ip-done-all" onClick={onOpenDone}>{`All done · ${board.done.length}`}</Button>
      )}
    </>
  );
}
