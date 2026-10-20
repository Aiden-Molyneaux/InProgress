import type { KeyboardEvent, LiHTMLAttributes, ReactNode } from 'react';
import { sessionDisplayTitle } from '../../../src/core/types';
import type { TaskBox } from '../../../src/core/taskState';
import { Chip } from '../parts/Chip';
import type { CursorItemProps } from '../parts/ListCursor';
import { Tile } from '../parts/Tile';
import type { MeasureArea } from '../measure';
import { rowClick } from './Marks';
import { boxSince, hueOf } from './boxState';
import { TileFoot } from './TileFoot';
import { ageShort } from './text';
import type { Band } from './ColumnHead';

/** What a column sets on the tile's `li` itself: drag and drop, and a confirm's press, Escape and busy state. */
export type LiProps = Pick<LiHTMLAttributes<HTMLLIElement>, 'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop' | 'onMouseDown' | 'onKeyDown' | 'aria-busy'>;

const TILE_CLASS: Record<Band, string> = { needs: 'ip-needs-tile', next: 'ip-next-row', now: 'ip-now-row', done: 'ip-done-tile' };

export interface BoardTileProps {
  box: TaskBox;
  now: number;
  area: MeasureArea;
  band: Band;
  /** How many resources the step holds. */
  docs?: number;
  /** The grid cursor's props for this tile. */
  cursor?: CursorItemProps;
  /** The stagger place the tile rises with, or undefined. */
  rise?: number;
  /** The tile whose Details is open. */
  selected?: boolean;
  /** Chips after the id, before YOU and the age. */
  chips?: ReactNode;
  /** The foot's own buttons. */
  actions?: ReactNode;
  /** The body. */
  children?: ReactNode;
  system?: string | null;
  li?: LiProps;
  /** A click does not open Details: a confirm is open in the tile, or it waits on a delete. */
  still?: boolean;
  pending?: boolean;
  dropBefore?: boolean;
  dragging?: boolean;
  /** The tile's own keys (Next's Alt+arrows): run after the grid cursor's. */
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  onOpenNode: (id: number) => void;
  onOpenResource: (id: number) => void;
}

/**
 * The one tile every Board column draws: an `li` holding the Tile part. Top: `#id`, the column's chips, YOU, the age;
 * then the title, the body, the system line and the foot. A click on the tile (not on its own controls) opens Details.
 * A box with no step (a permission wait on no step) has no id and no `data-node`, and is titled with its session.
 */
export function BoardTile({ box, now, area, band, docs = 0, cursor, rise, selected, chips, actions, children, system, li, still = false, pending, dropBefore, dragging, onKeyDown, onOpenNode, onOpenResource }: BoardTileProps) {
  const { row, session, state } = box;
  const node = row?.node;
  const since = boxSince(box);
  const you = node?.assignee === 'me' && node.status !== 'done';
  return (
    <li {...li}>
      <Tile
        {...cursor}
        onKeyDown={onKeyDown ? (e) => {
          cursor?.onKeyDown(e);
          onKeyDown(e);
        } : cursor?.onKeyDown}
        className={`ip-tile ${TILE_CLASS[band]}`}
        tone={band === 'needs' ? 'ask' : band === 'done' ? 'done' : 'default'}
        hue={band === 'done' ? null : hueOf(box)}
        data-node={node?.id}
        data-state={state}
        id={node ? `#${node.id}` : undefined}
        chips={
          <>
            {chips}
            {you && <Chip tone="needs">YOU</Chip>}
            {since && <span className="ip-tile-age">{ageShort(since, now)}</span>}
          </>
        }
        title={node ? node.title : session ? sessionDisplayTitle(session) : ''}
        titleClassName={node ? 'ip-row-title' : undefined}
        body={children || system ? <>{children}{system && <p className="ip-sys">{system}</p>}</> : undefined}
        foot={row ? <TileFoot row={row} now={now} area={area} docs={docs} onOpenResource={onOpenResource} /> : undefined}
        actions={actions}
        selected={selected}
        pending={pending}
        dropBefore={dropBefore}
        dragging={dragging}
        rise={rise}
        onClick={node && !still ? rowClick(area, () => onOpenNode(node.id)) : undefined}
      />
    </li>
  );
}
