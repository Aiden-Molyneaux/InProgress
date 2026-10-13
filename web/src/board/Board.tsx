import type { ReactNode } from 'react';
import { deriveBoard } from '../../../src/core/board';
import type { ViewProps } from '../views/props';
import type { BandProps } from './bandProps';
import { DoneColumn } from './DoneColumn';
import { HeaderLines } from './HeaderLines';
import { NeedsMe } from './NeedsMe';
import { NextColumn } from './NextColumn';
import { NowColumn } from './NowColumn';
import { useWide } from './useWide';

/** The narrow layout's bands, top to bottom (spec 2.3): one constant, to revisit after the week. */
export const NARROW_ORDER = ['needs', 'now', 'next', 'done'] as const;
/** The wide layout's columns, left to right (spec 2.2). */
export const WIDE_ORDER = ['needs', 'next', 'now', 'done'] as const;
type Band = (typeof NARROW_ORDER)[number];

const BAND_LABEL: Record<Band, string> = { needs: 'Needs me', now: 'Now', next: 'Next', done: 'Done' };

/** The Board (spec 2.2 and 2.3): header lines on top, then the bands side by side or stacked. */
export function Board(props: ViewProps) {
  const { snapshot, now } = props;
  const wide = useWide();
  const board = deriveBoard(snapshot, now);
  const band: BandProps = { ...props, board, wide };
  const body: Record<Band, ReactNode> = {
    needs: <NeedsMe {...band} />,
    now: <NowColumn {...band} />,
    next: <NextColumn {...band} />,
    done: <DoneColumn {...band} lastLook={props.lastLook ?? null} />,
  };
  const order = wide ? WIDE_ORDER : NARROW_ORDER;
  return (
    <div className={`ip-board ${wide ? 'wide' : 'narrow'}`}>
      <h2 className="ip-view-name">{snapshot.project.name}</h2>
      <HeaderLines {...band} />
      <div className="ip-bands">
        {order.map((b) => (
          <section key={b} className={`ip-band ip-band-${b}`} aria-label={BAND_LABEL[b]}>
            <h3>{BAND_LABEL[b]}</h3>
            {body[b]}
          </section>
        ))}
      </div>
    </div>
  );
}
