import { useMemo, type ReactNode } from 'react';
import { deriveBoard } from '../../../src/core/board';
import { taskBoxes, type TaskBox as BoxData } from '../../../src/core/taskState';
import { PageHead } from '../page/PageHead';
import { projectCode } from '../page/projectCode';
import { usePageMeasure } from '../page/usePageWidth';
import { useListCursor } from '../parts/ListCursor';
import type { ViewProps } from '../views/props';
import type { BandProps } from './bandProps';
import { BAND_LABEL, ColumnHead, type Band } from './ColumnHead';
import { DoneColumn, doneKeys, doneView } from './DoneColumn';
import { layoutFor, type BoardLayout } from './layout';
import { BoardSlab } from './BoardSlab';
import { LeadBehind } from './LeadBehind';
import { NeedsMe, needsKeys } from './NeedsMe';
import { needsTiles } from './needsTiles';
import { NextColumn } from './NextColumn';
import { NowColumn, nowKeys } from './NowColumn';
import { useNextQueue } from './useNextQueue';
import { useRise } from './useRise';

/** The narrow layouts' columns, top to bottom (and two by two): one constant, to revisit after the week. */
export const NARROW_ORDER = ['needs', 'now', 'next', 'done'] as const;
/** The wide layout's columns, left to right (spec section 7). */
export const WIDE_ORDER = ['needs', 'next', 'now', 'done'] as const;

/** The cursor columns of each layout, each the bands it stacks top to bottom: the grid follows what the eye sees. */
const GRID: Record<BoardLayout, readonly (readonly Band[])[]> = {
  four: [['needs'], ['next'], ['now'], ['done']],
  two: [['needs', 'next'], ['now', 'done']],
  one: [['needs', 'now', 'next', 'done']],
};

/** The Board (spec section 7): the page head and the slab on top, then four columns, two by two, or one stack by the page's width. */
export function Board(props: ViewProps) {
  const { snapshot, now } = props;
  const [root, layout] = usePageMeasure<HTMLDivElement, BoardLayout>(layoutFor);
  const board = useMemo(() => deriveBoard(snapshot, now), [snapshot, now]);
  const boxes = useMemo(() => taskBoxes(board, snapshot, now), [board, snapshot, now]);
  // Needs me draws the tasks that wait on Aiden and the commands held for him (lead stage 1, task D).
  const needs = useMemo(() => needsTiles(boxes, snapshot.held), [boxes, snapshot.held]);
  const band: BandProps = { ...props, board, boxes, wide: layout === 'four', layout };
  const order = layout === 'four' ? WIDE_ORDER : NARROW_ORDER;
  const queue = useNextQueue(band);
  const lastLook = props.lastLook ?? null;
  const done = doneView(boxes, layout, lastLook);
  // What each band draws, in draw order: its keys, and the boxes Enter opens.
  const keys: Record<Band, string[]> = { needs: needsKeys(needs), next: queue.drawn.map((b) => String(b.row!.node.id)), now: nowKeys(boxes), done: doneKeys(done) };
  /** The step Enter opens on each drawn row, or null for a row on no step. */
  const stepOf = (b: BoxData): number | null => b.row?.node.id ?? null;
  const drawn: Record<Band, readonly (number | null)[]> = {
    needs: needs.map((t) => (t.kind === 'box' ? stepOf(t.box) : t.stepId)),
    next: queue.drawn.map(stepOf),
    now: boxes.now.map(stepOf),
    done: done.shown.map(stepOf),
  };
  // The keyboard grid: one structure per layout. A cursor column stacks bands, each at an offset into it.
  const columns = GRID[layout].map((bands) => {
    let offset = 0;
    const parts = bands.map((b) => {
      const part = { band: b, offset };
      offset += keys[b].length;
      return part;
    });
    return { parts, count: offset, keys: parts.flatMap((p) => keys[p.band]) };
  });
  const place = (b: Band) => {
    const col = columns.findIndex((c) => c.parts.some((p) => p.band === b));
    return { col, offset: columns[col].parts.find((p) => p.band === b)!.offset };
  };
  const { itemProps } = useListCursor(
    columns.map((c) => c.count),
    ({ col, row }) => {
      const part = [...columns[col].parts].reverse().find((p) => row >= p.offset);
      const step = part ? drawn[part.band][row - part.offset] : undefined;
      if (step != null) props.onOpenNode(step);
    },
    columns.map((c) => c.keys),
  );
  const cursorOf = (b: Band) => {
    const at = place(b);
    return (row: number) => itemProps(at.col, at.offset + row);
  };
  const rise = useRise(order.flatMap((b) => keys[b].map((k) => `${b}:${k}`)));
  const body: Record<Band, ReactNode> = {
    needs: (
      <>
        <NeedsMe {...band} tiles={needs} cursor={cursorOf('needs')} rise={rise} />
        <LeadBehind snapshot={snapshot} now={now} />
      </>
    ),
    now: <NowColumn {...band} cursor={cursorOf('now')} rise={rise} />,
    next: <NextColumn {...band} queue={queue} cursor={cursorOf('next')} rise={rise} />,
    done: <DoneColumn {...band} view={done} lastLook={lastLook} cursor={cursorOf('done')} rise={rise} />,
  };
  // Needs me counts its tiles, and the held commands past the cap the snapshot sends (heldTotal).
  const heldUnsent = Math.max(0, (snapshot.heldTotal ?? 0) - (snapshot.held?.length ?? 0));
  const counts: Record<Band, number> = { needs: needs.length + heldUnsent, next: queue.next.length, now: boxes.now.length, done: board.done.length };
  const hints: Record<Band, string> = {
    needs: 'Oldest wait first',
    next: 'Queue order, drag or Alt+arrows',
    now: 'Live sessions, working first',
    done: `Latest of ${board.done.length}`,
  };
  return (
    <div ref={root} className="ip-board" data-layout={layout}>
      <div className="ip-board-page">
        <PageHead
          code={projectCode(snapshot.project.name)}
          name={snapshot.project.name}
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
