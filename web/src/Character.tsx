import type { CSSProperties } from 'react';
import { phaseDelay, type CharacterSize, type CharacterState } from './characterState';
import { familyVar } from './family';
import './character.css';

export interface CharacterProps {
  size: CharacterSize;
  state: CharacterState;
  /** The family it wears: the root span sets `--fam: familyVar(slot)`. `ended` wears `--gone` whatever the slot. */
  slot: number | null;
  /** Stable per character: phaseDelay hashes it. A session's id for a chip or a lead; `${sessionId}:${agentId}` for a kin. */
  seed: string;
  /** A tooltip on the root span (the lead's: leadTitle). The SVG stays aria-hidden. */
  title?: string;
}

// Simple, as Quiet-kin-together.dc.html draws it on a 32 x 32 grid.
const BODY = 'M13 5Q16 2 19 5Q24 8 27 13Q30 16 27 19Q24 24 19 27Q16 30 13 27Q8 24 5 19Q2 16 5 13Q8 8 13 5Z';
/** A 24 px worker's shade, over the lower body. */
const SHADE = 'M5 19Q8 24 13 27Q16 30 19 27Q24 24 27 19Q16 25.5 5 19Z';
/** A 24 px worker's sheen, at the upper left. */
const SHEEN = 'M8 11.8Q9.4 9.4 11.8 8';
/** An ended character's eyes: two short lines. */
const ENDED_EYES = 'M9.4 15.8H13.6M18.4 15.8H22.6';

// Motion periods in ms. Each animated element gets its period as animation-duration and a phaseDelay as
// animation-delay, so the period lives here once; character.css names the keyframes.
const BOB_MS = 2400;
const RING_MS = 1800;
const BREATHE_MS = 3600;

/** The eyes that blink, in g.ip-char-eyes: round, with their centres, radius and blink period. Idle and ended have none. */
function blinkingEyes(state: CharacterState, size: CharacterSize) {
  if (state === 'wait') return { xs: [11.5, 20.5], cy: 14.8, r: 2.7, blinkMs: 3600 };
  if (state !== 'work' && state !== 'busy') return null;
  return size === 24 ? { xs: [12.5, 19.5], cy: 15, r: 2.1, blinkMs: 5200 } : { xs: [11.5, 20.5], cy: 15.5, r: 2.4, blinkMs: 5200 };
}

/** One animation's period, and where in it this character starts. */
const timing = (seed: string, periodMs: number): CSSProperties => ({
  animationDuration: `${periodMs}ms`,
  animationDelay: `${phaseDelay(seed, periodMs)}ms`,
});

/**
 * A session or a subagent as a small creature in its family's hue: working, busy (idle with work still running: it
 * wears the working eyes and breathes instead of bobbing, with no glow), idle, waiting for permission, or ended.
 */
export function Character({ size, state, slot, seed, title }: CharacterProps) {
  const eyes = blinkingEyes(state, size);
  return (
    <span
      className={`ip-char c-${state}`}
      data-state={state}
      data-size={size}
      title={title}
      style={{ width: size, height: size, '--fam': familyVar(slot) } as CSSProperties}
    >
      {state === 'wait' && (
        <>
          <span className="ip-char-ring" />
          <span className="ip-char-ring2" style={timing(seed, RING_MS)} />
        </>
      )}
      <span className="ip-char-body" style={state === 'work' ? timing(seed, BOB_MS) : state === 'busy' ? timing(seed, BREATHE_MS) : undefined}>
        <svg viewBox="0 0 32 32" aria-hidden="true">
          {state === 'ended' ? (
            <>
              <path d={BODY} fill="currentColor" fillOpacity={0.1} stroke="currentColor" strokeWidth={2.6} strokeLinejoin="round" />
              <path d={ENDED_EYES} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
            </>
          ) : (
            <path d={BODY} fill="currentColor" />
          )}
          {state === 'work' && size === 24 && (
            <>
              <path d={SHADE} fill="#000" fillOpacity={0.14} />
              <path d={SHEEN} fill="none" stroke="#fff" strokeOpacity={0.45} strokeWidth={1.4} strokeLinecap="round" />
            </>
          )}
          {state === 'idle' && (
            <>
              <rect x={9.2} y={15.4} width={4.6} height={2.2} rx={1.1} />
              <rect x={18.2} y={15.4} width={4.6} height={2.2} rx={1.1} />
            </>
          )}
          {eyes && (
            <g className="ip-char-eyes" style={{ transformOrigin: `16px ${eyes.cy}px`, ...timing(seed, eyes.blinkMs) }}>
              {eyes.xs.map((cx) => (
                <circle key={cx} cx={cx} cy={eyes.cy} r={eyes.r} />
              ))}
            </g>
          )}
        </svg>
      </span>
    </span>
  );
}
