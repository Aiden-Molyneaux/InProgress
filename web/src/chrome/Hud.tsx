import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { deriveBoard } from '../../../src/core/board';
import type { StepHit } from '../../../src/core/goto';
import type { ProjectSnapshot, ProjectSummary } from '../../../src/core/types';
import { countRose } from '../parts/countLogic';
import { Readout } from '../parts/Readout';
import { Ruler } from '../parts/Ruler';
import { Tape } from '../parts/Tape';
import { GoTo, type GoToHandle } from './GoTo';
import { boardFigures, clockText, hudFigures } from './hudLogic';
import { useMinute } from './useMinute';

export interface HudProps {
  /** False until the first project list lands: the HUD then shows the wordmark and the link readout alone. */
  loaded: boolean;
  connection: 'open' | 'reconnecting';
  projects: ProjectSummary[];
  /** The tab strip's projects in strip order: ASKS lists and opens them in this order. */
  tabs: ProjectSummary[];
  /** The open project's slug. */
  current: string | null;
  snapshot: ProjectSnapshot | null;
  /** The app's clock (ms), for the Board's figures. */
  now: number;
  goTo: RefObject<GoToHandle>;
  onGoTo: (hit: StepHit) => void;
  onBoard: () => void;
  onAsks: () => void;
}

/** ASKS: what waits on Aiden over every active project. Volt above 0; the figure strobes once when it rises. */
function Asks({ asks, title, onAsks }: { asks: number; title: string; onAsks: () => void }) {
  const previous = useRef<number | undefined>(undefined);
  const [rise, setRise] = useState(0);
  // The ref is written after the check, as parts/Count does, so StrictMode's second run sees no rise.
  useEffect(() => {
    if (countRose(previous.current, asks)) setRise((n) => n + 1);
    previous.current = asks;
  }, [asks]);
  return (
    <button type="button" className="ip-hud-asks" title={title} aria-disabled={asks === 0 || undefined} onClick={() => asks > 0 && onAsks()}>
      <Readout label="Asks" value={<span key={rise} className={rise > 0 ? 'ip-hud-rise' : undefined}>{asks}</span>} tone={asks > 0 ? 'volt' : 'text'} />
    </button>
  );
}

/** The bar across the top: wordmark, the cross-project figures, the link, the date and time, and Find. */
export function Hud({ loaded, connection, projects, tabs, current, snapshot, now, goTo, onGoTo, onBoard, onAsks }: HudProps) {
  const clock = useMinute();
  const { time, date } = clockText(clock);
  const figures = useMemo(() => hudFigures(projects, tabs), [projects, tabs]);
  const board = useMemo(() => (snapshot ? boardFigures(deriveBoard(snapshot, now), snapshot, now) : null), [snapshot, now]);
  return (
    <header className="ip-hud">
      <button type="button" className="ip-hud-mark" onClick={onBoard}>
        InProgress
      </button>
      <div className="ip-hud-figs" role="group" aria-label="Window readout">
        {loaded && (
          <>
            <Asks asks={figures.asks} title={figures.asksTitle} onAsks={onAsks} />
            <Readout label="Live" value={figures.live} title={figures.liveTitle} />
            {board && (
              <span className="ip-hud-wide">
                <Readout label="Ready" value={board.ready} />
                <Readout label="Backlog" value={board.backlog} />
              </span>
            )}
          </>
        )}
      </div>
      <div className="ip-hud-right">
        <Readout
          className="ip-hud-link"
          label="Link"
          value={
            connection === 'open' ? (
              'OK'
            ) : (
              <>
                <span className="ip-hud-sq" aria-hidden="true" />
                RECONNECTING
              </>
            )
          }
          tone={connection === 'open' ? 'text' : 'alarm'}
        />
        {loaded && (
          <>
            <span className="ip-hud-when">
              <span className="ip-hud-date">{date}</span>
              <time className="ip-hud-clock" dateTime={clock.toISOString()}>
                {time}
              </time>
            </span>
            <GoTo ref={goTo} onGo={onGoTo} current={current} />
          </>
        )}
      </div>
    </header>
  );
}

/** The strip under the bar: the ruler, or the alarm tape while the stream reconnects. Same height, so the page never moves. */
export function HudEdge({ connection }: { connection: 'open' | 'reconnecting' }) {
  return <div className="ip-hud-edge">{connection === 'reconnecting' ? <Tape tone="alarm" /> : <Ruler variant="hud" />}</div>;
}
