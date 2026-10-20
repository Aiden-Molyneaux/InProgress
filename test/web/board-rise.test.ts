import { describe, expect, it } from 'vitest';
import { RISE_MS, riseFor, riseOf } from '../../web/src/board/useRise';

describe('riseFor', () => {
  it('gives every tile of the first render its grid place, capped at 11', () => {
    const keys = Array.from({ length: 14 }, (_, i) => `needs:${i}`);
    const map = riseFor(null, keys, 1000);
    expect(riseOf(map, 'needs:0', 1000)).toBe(0);
    expect(riseOf(map, 'needs:5', 1000)).toBe(5);
    expect(riseOf(map, 'needs:13', 1000)).toBe(11);
  });

  it('lets a later arrival rise alone and leaves the rest as they were', () => {
    const first = riseFor(null, ['needs:1', 'needs:2'], 1000);
    const later = riseFor(first, ['needs:3', 'needs:1', 'needs:2'], 5000);
    expect(riseOf(later, 'needs:3', 5000)).toBe(0);
    expect(riseOf(later, 'needs:1', 5000)).toBeUndefined();
    expect(riseOf(later, 'needs:2', 5000)).toBeUndefined();
  });

  it('keeps a rise for 900 ms and then drops it', () => {
    const map = riseFor(null, ['a', 'b'], 1000);
    expect(riseOf(map, 'b', 1000 + RISE_MS - 1)).toBe(1);
    expect(riseOf(map, 'b', 1000 + RISE_MS)).toBeUndefined();
  });

  it('does not make a tile that left and came back rise from its old time', () => {
    const first = riseFor(null, ['a'], 1000);
    const gone = riseFor(first, [], 2000);
    const back = riseFor(gone, ['a'], 3000);
    expect(riseOf(back, 'a', 3000)).toBe(0);
  });

  it('has nothing for a key that is not drawn', () => {
    expect(riseOf(riseFor(null, ['a'], 0), 'z', 0)).toBeUndefined();
  });
});
