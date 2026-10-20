import { useEffect, useRef } from 'react';

/** How long a tile keeps its rise, in ms: the animation is done well before, and a later render no longer carries it. */
export const RISE_MS = 900;
/** The stagger's last place: the Tile part caps it too (parts.css), so later tiles share it. */
export const RISE_CAP = 11;

/** A key seen in some render: its stagger place and when it first appeared. */
export type RiseMap = ReadonlyMap<string, { place: number; since: number }>;

/**
 * Which tiles rise in this render. `prev` is the previous render's map (null on the Board's first render), `keys` are the
 * tiles drawn now in grid order, `at` is the clock. On the first render every key takes its grid place (capped); later a
 * key not in `prev` is new and rises alone (place 0); a key already there keeps what it had.
 */
export function riseFor(prev: RiseMap | null, keys: readonly string[], at: number): RiseMap {
  const next = new Map<string, { place: number; since: number }>();
  keys.forEach((key, index) => {
    const held = prev?.get(key);
    next.set(key, held ?? { place: prev ? 0 : Math.min(index, RISE_CAP), since: at });
  });
  return next;
}

/** The stagger place a key wears at `at`, or undefined once its 900 ms are up (or when it is not drawn). */
export function riseOf(map: RiseMap, key: string, at: number): number | undefined {
  const held = map.get(key);
  return held && at - held.since < RISE_MS ? held.place : undefined;
}

/**
 * The Board's rise: `rise(key)` is the stagger place for a tile key (`<band>:<id>`), or undefined. The first render rises
 * every tile in grid order; a tile that arrives later rises alone; an ordinary snapshot animates nothing. The previous map
 * is kept after commit, so a render React throws away (strict mode's second pass) does not eat the first paint's stagger.
 */
export function useRise(keys: readonly string[]): (key: string) => number | undefined {
  const committed = useRef<RiseMap | null>(null);
  const at = Date.now();
  const map = riseFor(committed.current, keys, at);
  useEffect(() => {
    committed.current = map;
  });
  return (key) => riseOf(map, key, at);
}
