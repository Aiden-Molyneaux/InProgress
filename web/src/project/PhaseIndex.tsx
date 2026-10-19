import { Eyebrow } from '../parts/Eyebrow';
import { PositionMark, type PositionKind } from './PositionMark';

/** A phase in the index: its fold key, its title and its counts. */
export interface PhaseEntry {
  key: string;
  title: string;
  done: number;
  now: number;
  total: number;
}

/** A finished phase: picked from the index to open as a section. */
export interface FinishedEntry {
  key: string;
  id: number;
  title: string;
}

export const FINISHED_KEY = 'done:0';

/** The Finished fold and, open, one row per finished phase. Picking one opens its section and jumps to it. */
export function FinishedPhases({ finished, open, current, onToggle, onJump }: { finished: FinishedEntry[]; open: boolean; current: string | null; onToggle: () => void; onJump: (key: string) => void }) {
  if (finished.length === 0) return null;
  return (
    <div className="ip-finished">
      <button type="button" className="ip-finished-fold" aria-expanded={open} onClick={onToggle}>
        <Eyebrow glyph="//">{`Finished · ${finished.length}`}</Eyebrow>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul>
          {finished.map((f) => (
            <li key={f.key}>
              <button type="button" className="ip-pi-row ip-pi-finished" aria-current={current === f.key ? 'location' : undefined} onClick={() => onJump(f.key)}>
                <span className="ip-pi-title"><span className="ip-id">{`#${f.id}`}</span> {f.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The phase index at the right of a wide page: one row per phase with its bar, and the section in view marked. */
export function PhaseIndex({ phases, finished, current, finishedOpen, onToggleFinished, onJump }: { phases: PhaseEntry[]; finished: FinishedEntry[]; current: string | null; finishedOpen: boolean; onToggleFinished: () => void; onJump: (key: string) => void }) {
  return (
    <nav className="ip-pindex" aria-label="Phases">
      <Eyebrow glyph="//">Phases</Eyebrow>
      <ul>
        {phases.map((p) => {
          const here = current === p.key;
          return (
            <li key={p.key}>
              <button type="button" className="ip-pi-row" aria-current={here ? 'location' : undefined} onClick={() => onJump(p.key)}>
                <span className="ip-pi-cur" aria-hidden="true">{here ? '›' : ''}</span>
                <span className="ip-pi-title">{p.title}</span>
                <span className="ip-pi-count">{`${p.done}/${p.total}`}</span>
                <span className="ip-pi-bar" aria-hidden="true">
                  <i className="seg-done" style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
                  <i className="seg-now" style={{ width: `${p.total ? (p.now / p.total) * 100 : 0}%` }} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <FinishedPhases finished={finished} open={finishedOpen} current={current} onToggle={onToggleFinished} onJump={onJump} />
    </nav>
  );
}

/** The marks in the rail key, with their words. */
export const KEY_MARKS: { kind: PositionKind; number?: number; word: string }[] = [
  { kind: 'live', word: 'now, a session is on it' },
  { kind: 'idle', word: 'now, no session' },
  { kind: 'queue', number: 1, word: 'next, in queue order' },
  { kind: 'own', word: "next, in a session's own queue" },
  { kind: 'backlog', word: 'backlog' },
  { kind: 'parked', word: 'parked, set aside' },
];

/** The key to the position marks, drawn by the component the rows use. */
export function RailKey() {
  return (
    <div className="ip-railkey" role="group" aria-label="Key to the marks">
      {KEY_MARKS.map((m) => (
        <span key={m.word} className="ip-railkey-item">
          <PositionMark kind={m.kind} number={m.number} />
          {m.word}
        </span>
      ))}
    </div>
  );
}
