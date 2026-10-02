import { NODE_H } from '../../../src/core/layout';

/** Where styles.css turns Details into a bottom sheet over the lower 60 % of the canvas. */
export const SHEET_QUERY = '(max-width: 719px)';
/** The share of the canvas, from the top, that the open sheet leaves uncovered. */
export const SHEET_TOP = 0.4;

/** How far down the canvas, in px, you can see: all the way, or to the top of the open sheet. */
export function visibleHeight(height: number, sheetOpen: boolean): number {
  return sheetOpen ? height * SHEET_TOP : height;
}

/**
 * Whether a row at a flow position is in view: wholly between the top of the canvas and the top of the open sheet
 * (or the bottom of the canvas), with its left end on screen.
 */
export function rowInView(
  row: { x: number; y: number },
  camera: { x: number; y: number; zoom: number },
  canvas: { width: number; height: number },
  sheetOpen: boolean,
): boolean {
  const top = row.y * camera.zoom + camera.y;
  const left = row.x * camera.zoom + camera.x;
  return top >= 0 && top + NODE_H * camera.zoom <= visibleHeight(canvas.height, sheetOpen) && left >= 0 && left < canvas.width;
}
