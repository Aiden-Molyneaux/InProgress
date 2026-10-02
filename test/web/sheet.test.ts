import { describe, expect, it } from 'vitest';
import { NODE_H } from '../../src/core/layout';
import { rowInView, visibleHeight } from '../../web/src/canvas/sheet';

const pane = { width: 520, height: 800 };
const camera = (x: number, y: number, zoom = 1) => ({ x, y, zoom });

describe('visibleHeight', () => {
  it('is the whole canvas, or only the band above the open sheet', () => {
    expect(visibleHeight(800, false)).toBe(800);
    expect(visibleHeight(800, true)).toBe(320);
  });
});

describe('rowInView', () => {
  it('takes a row in the middle of the canvas as in view, unless the sheet covers it', () => {
    expect(rowInView({ x: 0, y: 400 }, camera(0, 0), pane, false)).toBe(true);
    expect(rowInView({ x: 0, y: 400 }, camera(0, 0), pane, true)).toBe(false);
  });

  it('takes a row wholly above the sheet as in view, and one the sheet cuts as covered', () => {
    expect(rowInView({ x: 0, y: 320 - NODE_H }, camera(0, 0), pane, true)).toBe(true);
    expect(rowInView({ x: 0, y: 321 - NODE_H }, camera(0, 0), pane, true)).toBe(false);
  });

  it('takes a row above the top of the canvas as out of view', () => {
    expect(rowInView({ x: 0, y: 0 }, camera(0, 0), pane, false)).toBe(true);
    expect(rowInView({ x: 0, y: -1 }, camera(0, 0), pane, false)).toBe(false);
  });

  it("places the row with the camera's pan and zoom", () => {
    // Flow y 1000 at zoom 0.5, panned up 300 px: on screen at y 200, clear of the sheet.
    expect(rowInView({ x: 0, y: 1000 }, camera(0, -300, 0.5), pane, true)).toBe(true);
    // At zoom 2 the same pan leaves it far below the canvas.
    expect(rowInView({ x: 0, y: 1000 }, camera(0, -300, 2), pane, false)).toBe(false);
  });

  it('needs the left end of the row on screen', () => {
    expect(rowInView({ x: 100, y: 100 }, camera(-100, 0), pane, false)).toBe(true);
    expect(rowInView({ x: 100, y: 100 }, camera(-101, 0), pane, false)).toBe(false);
    expect(rowInView({ x: 600, y: 100 }, camera(0, 0), pane, false)).toBe(false);
  });
});
