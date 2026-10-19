import { describe, expect, it } from 'vitest';
import { clampCursor, cursorStep } from '../../web/src/parts/listCursorLogic';

const list = [[10, 30, 50]];
const grid = [[10, 50, 90], [30, 70], [20, 60, 100, 140]];

describe('cursorStep on a list', () => {
  it('moves down and up one row', () => {
    expect(cursorStep('ArrowDown', { col: 0, row: 0 }, list)).toEqual({ col: 0, row: 1 });
    expect(cursorStep('ArrowUp', { col: 0, row: 2 }, list)).toEqual({ col: 0, row: 1 });
  });

  it('stays put at either end', () => {
    expect(cursorStep('ArrowDown', { col: 0, row: 2 }, list)).toEqual({ col: 0, row: 2 });
    expect(cursorStep('ArrowUp', { col: 0, row: 0 }, list)).toEqual({ col: 0, row: 0 });
  });

  it('goes to the first and the last row on Home and End', () => {
    expect(cursorStep('Home', { col: 0, row: 2 }, list)).toEqual({ col: 0, row: 0 });
    expect(cursorStep('End', { col: 0, row: 0 }, list)).toEqual({ col: 0, row: 2 });
  });

  it('leaves Left, Right and other keys alone', () => {
    expect(cursorStep('ArrowLeft', { col: 0, row: 1 }, list)).toBeNull();
    expect(cursorStep('ArrowRight', { col: 0, row: 1 }, list)).toBeNull();
    expect(cursorStep('a', { col: 0, row: 1 }, list)).toBeNull();
  });
});

describe('cursorStep on a grid', () => {
  it('moves across to the row whose middle is nearest', () => {
    expect(cursorStep('ArrowRight', { col: 0, row: 2 }, grid)).toEqual({ col: 1, row: 1 });
    expect(cursorStep('ArrowRight', { col: 1, row: 1 }, grid)).toEqual({ col: 2, row: 1 });
    expect(cursorStep('ArrowLeft', { col: 2, row: 3 }, grid)).toEqual({ col: 1, row: 1 });
  });

  it('takes the upper row on a tie', () => {
    // 50 is 20 from 30 and 20 from 70: the upper one wins.
    expect(cursorStep('ArrowRight', { col: 0, row: 1 }, grid)).toEqual({ col: 1, row: 0 });
  });

  it('skips an empty column', () => {
    const gap = [[10, 50], [], [30, 70]];
    expect(cursorStep('ArrowRight', { col: 0, row: 1 }, gap)).toEqual({ col: 2, row: 0 });
    expect(cursorStep('ArrowLeft', { col: 2, row: 1 }, gap)).toEqual({ col: 0, row: 1 });
  });

  it('stays put at the last column in either direction', () => {
    expect(cursorStep('ArrowRight', { col: 2, row: 1 }, grid)).toEqual({ col: 2, row: 1 });
    expect(cursorStep('ArrowLeft', { col: 0, row: 1 }, grid)).toEqual({ col: 0, row: 1 });
    expect(cursorStep('ArrowRight', { col: 0, row: 1 }, [[10, 50], []])).toEqual({ col: 0, row: 1 });
  });
});

describe('clampCursor', () => {
  it('is null when every column is empty', () => {
    expect(clampCursor({ col: 0, row: 0 }, [0, 0])).toBeNull();
    expect(clampCursor(null, [])).toBeNull();
  });

  it('starts at the first item of the first non-empty column', () => {
    expect(clampCursor(null, [0, 2, 3])).toEqual({ col: 1, row: 0 });
  });

  it('holds a row past the end to the last item', () => {
    expect(clampCursor({ col: 1, row: 9 }, [3, 2])).toEqual({ col: 1, row: 1 });
  });

  it('moves from an empty column to the nearest non-empty one, right first and then left', () => {
    expect(clampCursor({ col: 1, row: 0 }, [2, 0, 3])).toEqual({ col: 2, row: 0 });
    expect(clampCursor({ col: 2, row: 1 }, [2, 3, 0])).toEqual({ col: 1, row: 1 });
    expect(clampCursor({ col: 5, row: 0 }, [2, 3])).toEqual({ col: 1, row: 0 });
  });
});
