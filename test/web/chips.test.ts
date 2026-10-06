import { describe, expect, it } from 'vitest';
import { chipOrder } from '../../web/src/chrome/chips';

const session = (id: string, slot: number | null) => ({ id, slot });
const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe('chipOrder', () => {
  it('puts the chips in letter order, whatever order the server lists them in', () => {
    // The server lists the session seen last first.
    expect(ids(chipOrder([session('c', 2), session('a', 0), session('b', 1)]))).toEqual(['a', 'b', 'c']);
  });

  it('puts a session with no slot yet after the lettered ones, in the order it was given', () => {
    expect(ids(chipOrder([session('x', null), session('b', 1), session('y', null), session('a', 0)]))).toEqual(['a', 'b', 'x', 'y']);
  });

  it('leaves the list it was given as it was', () => {
    const given = [session('b', 1), session('a', 0)];
    chipOrder(given);
    expect(ids(given)).toEqual(['b', 'a']);
  });
});
