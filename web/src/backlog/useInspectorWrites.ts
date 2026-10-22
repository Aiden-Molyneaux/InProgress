import { useEffect, useRef, useState } from 'react';
import type { UiResult } from '../api';

/** The inspector's selects. */
export type InspSel = 'phase' | 'label' | 'band';

/** One step's selects while a write is out: the value shown meanwhile, which are busy, and the last refusal. */
export interface InspState {
  pending: Partial<Record<InspSel, string>>;
  busy: Partial<Record<InspSel, boolean>>;
  error: string | null;
}

export const NO_INSP: InspState = { pending: {}, busy: {}, error: null };

/**
 * The inspector selects' write state, kept per step above the rows: a Band change in Ranked moves the row to another list
 * and remounts its inspector, which must not lose the busy mark or a refusal. A value is dropped once the snapshot shows it
 * (`shown`), 2 s after the answer, or on a refusal; a refusal is said in the step's inspector while it is open, else by
 * `onRefused`, so it is never silent.
 */
export function useInspectorWrites(shown: (id: number, sel: InspSel) => string | undefined, open: (id: number) => boolean, onRefused: (text: string) => void) {
  const [states, setStates] = useState<ReadonlyMap<number, InspState>>(new Map());
  const latest = useRef(states);
  latest.current = states;
  const timers = useRef(new Map<string, number>());
  const update = (id: number, fn: (s: InspState) => InspState) =>
    setStates((m) => {
      const next = new Map(m);
      next.set(id, fn(m.get(id) ?? NO_INSP));
      return next;
    });
  const drop = (id: number, sel: InspSel) =>
    update(id, (s) => {
      const pending = { ...s.pending };
      delete pending[sel];
      return { ...s, pending };
    });
  useEffect(() => () => {
    for (const t of timers.current.values()) window.clearTimeout(t);
  }, []);
  // The snapshot that shows the new value ends the wait (once the answer is in).
  useEffect(() => {
    const done: [number, InspSel][] = [];
    for (const [id, s] of latest.current) {
      for (const sel of Object.keys(s.pending) as InspSel[]) if (!s.busy[sel] && shown(id, sel) === s.pending[sel]) done.push([id, sel]);
    }
    for (const [id, sel] of done) drop(id, sel);
  });

  const change = (id: number, sel: InspSel, value: string, write: () => Promise<UiResult>) => {
    if (latest.current.get(id)?.busy[sel]) return;
    const key = `${id}:${sel}`;
    window.clearTimeout(timers.current.get(key));
    update(id, (s) => ({ pending: { ...s.pending, [sel]: value }, busy: { ...s.busy, [sel]: true }, error: null }));
    void write().then((result) => {
      update(id, (s) => ({ ...s, busy: { ...s.busy, [sel]: false } }));
      if (result === 'ok') {
        // The snapshot normally brings the value first; a write that changed nothing sends none.
        timers.current.set(key, window.setTimeout(() => drop(id, sel), 2000));
        return;
      }
      drop(id, sel);
      if (result === 'reload') return;
      if (open(id)) update(id, (s) => ({ ...s, error: result }));
      else onRefused(result);
    });
  };
  /** A refusal belongs to the inspector it was said in: opening the step's inspector again starts without it. */
  const forget = (id: number) => {
    if (latest.current.get(id)?.error) update(id, (s) => ({ ...s, error: null }));
  };
  return { stateOf: (id: number): InspState => states.get(id) ?? NO_INSP, change, forget };
}
