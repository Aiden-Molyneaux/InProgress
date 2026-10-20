import type { ReactNode } from 'react';
import { deriveBoard } from '../../../src/core/board';
import { taskBoxes } from '../../../src/core/taskState';
import { PageHead } from '../page/PageHead';
import { projectCode } from '../page/projectCode';
import { usePageWidth } from '../page/usePageWidth';
import type { ViewProps } from '../views/props';
import type { BandProps } from './bandProps';
import { BAND_LABEL, ColumnHead, type Band } from './ColumnHead';
import { DoneColumn } from './DoneColumn';
import { boardHeadFigures } from './headFigures';
import { layoutFor } from './layout';
import { BoardSlab } from './BoardSlab';
import { NeedsMe } from './NeedsMe';
import { NextColumn } from './NextColumn';
import { NowColumn } from './NowColumn';

/** The narrow layouts' columns, top to bottom (and two by two): one constant, to revisit after the week. */
export const NARROW_ORDER = ['needs', 'now', 'next', 'done'] as const;
/** The wide layout's columns, left to right (spec section 7). */
export const WIDE_ORDER = ['needs', 'next', 'now', 'done'] as const;

/** The Board (spec section 7): the page head and the slab on top, then four columns, two by two, or one stack by the page's width. */
export function Board(props: ViewProps) {
  const { snapshot, now } = props;
  const [root, width] = usePageWidth<HTMLDivElement>();
  const layout = layoutFor(width);
  const board = deriveBoard(snapshot, now);
  const boxes = taskBoxes(board, snapshot, now);
  const band: BandProps = { ...props, board, boxes, wide: layout === 'four', layout };
  const body: Record<Band, ReactNode> = {
    needs: <NeedsMe {...band} />,
    now: <NowColumn {...band} />,
    next: <NextColumn {...band} />,
    done: <DoneColumn {...band} lastLook={props.lastLook ?? null} />,
  };
  const counts: Record<Band, number> = { needs: boxes.needs.length, next: boxes.next.length, now: boxes.now.length, done: board.done.length };
  const hints: Record<Band, string> = {
    needs: 'Oldest wait first',
    next: 'Queue order, drag or Alt+arrows',
    now: 'Live sessions, working first',
    done: `Latest of ${board.done.length}`,
  };
  const order = layout === 'four' ? WIDE_ORDER : NARROW_ORDER;
  return (
    <div ref={root} className="ip-board" data-layout={layout}>
      <div className="ip-board-page">
        <PageHead
          code={projectCode(snapshot.project.name)}
          name={snapshot.project.name}
          meta={boardHeadFigures(board, boxes, snapshot, now)}
          decodeKey={snapshot.project.id}
        />
        <BoardSlab {...band} />
        <div className="ip-bands">
          {order.map((b) => (
            <section key={b} className={`ip-band ip-band-${b}`} aria-label={BAND_LABEL[b]}>
              <ColumnHead band={b} count={counts[b]} hint={hints[b]} />
              {body[b]}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
