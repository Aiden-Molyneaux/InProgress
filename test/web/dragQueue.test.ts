import { describe, expect, it } from 'vitest';
import { dropSlot, dropToOp, optimisticNext } from '../../web/src/board/dragQueue';

const row = (id: number, owned = false) => ({ node: { id }, owner: owned ? ({ id: 's' } as never) : null });

describe('dropToOp', () => {
  it('a drop into Next is a move before the step under it, or at the end', () => {
    expect(dropToOp(7, { zone: 'next', before: 3 })).toEqual({ kind: 'move', node: 7, before: 3 });
    expect(dropToOp(7, { zone: 'next', before: null })).toEqual({ kind: 'move', node: 7, before: null });
  });
  it('a drop onto Backlog removes the step from the queue', () => {
    expect(dropToOp(7, { zone: 'backlog' })).toEqual({ kind: 'remove', node: 7 });
  });
});

describe('optimisticNext', () => {
  const rows = [row(1), row(2), row(3), row(9, true)];
  it('moves a step within Next to before another', () => {
    expect(optimisticNext(rows, { kind: 'move', node: 3, before: 1 })).toEqual([3, 1, 2, 9]);
  });
  it('appends to the unowned part, ahead of own-queue entries, when before is null', () => {
    expect(optimisticNext(rows, { kind: 'move', node: 1, before: null })).toEqual([2, 3, 1, 9]);
  });
  it('adds a step from Backlog', () => {
    expect(optimisticNext(rows, { kind: 'move', node: 50, before: 2 })).toEqual([1, 50, 2, 3, 9]);
  });
  it('takes an own-queue entry into the unowned part', () => {
    expect(optimisticNext(rows, { kind: 'move', node: 9, before: 2 })).toEqual([1, 9, 2, 3]);
  });
  it('appends when before is no longer unowned, or is the step itself', () => {
    expect(optimisticNext(rows, { kind: 'move', node: 1, before: 9 })).toEqual([2, 3, 1, 9]);
    expect(optimisticNext(rows, { kind: 'move', node: 1, before: 1 })).toEqual([2, 3, 1, 9]);
    expect(optimisticNext(rows, { kind: 'move', node: 2, before: 404 })).toEqual([1, 3, 2, 9]);
  });
  it('remove drops the step from the order', () => {
    expect(optimisticNext(rows, { kind: 'remove', node: 2 })).toEqual([1, 3, 9]);
    expect(optimisticNext(rows, { kind: 'remove', node: 9 })).toEqual([1, 2, 3]);
  });
});

describe('dropSlot', () => {
  const unowned = [1, 2, 3];
  it('is the row itself over its top half, and the step after it over its bottom half', () => {
    expect(dropSlot(unowned, 2, true, 9)).toBe(2);
    expect(dropSlot(unowned, 2, false, 9)).toBe(3);
    expect(dropSlot(unowned, 3, false, 9)).toBeNull();
  });
  it('never names the dragged step: that would append it, so it reads as the step after it', () => {
    // Top half of the dragged row, and bottom half of the row above it.
    expect(dropSlot(unowned, 2, true, 2)).toBe(3);
    expect(dropSlot(unowned, 1, false, 2)).toBe(3);
    // The last row dragged: the end, where it already is.
    expect(dropSlot(unowned, 3, true, 3)).toBeNull();
    expect(optimisticNext([row(1), row(2), row(3)], dropToOp(2, { zone: 'next', before: dropSlot(unowned, 2, true, 2) }))).toEqual([1, 2, 3]);
  });
  it('is the end over a row that is not unowned', () => {
    expect(dropSlot(unowned, 77, true, 2)).toBeNull();
  });
});
