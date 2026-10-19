import { deriveBoard } from '../../../src/core/board';
import { taskBoxes } from '../../../src/core/taskState';
import type { ProjectSnapshot } from '../../../src/core/types';
import { projectCode } from '../page/projectCode';
import { phaseCount, projectSections } from '../project/projectOutline';
import type { View } from '../views/view';
import { menuStep } from './menu';

/** One of the current project's views as the rail lists it. `count` is absent for the Board; `unit` follows it (Project: `phases`). */
export interface RailView {
  view: View;
  label: string;
  /** The three-letter form the narrow rail shows. */
  code: string;
  count?: number;
  unit?: string;
}

/**
 * The three-letter code of every row, by project id: `projectCode` over the names of the rows before it, in rail order,
 * so the second of two clashing names takes the digit.
 */
export function railCodes(rows: readonly { id: number; name: string }[]): Map<number, string> {
  return new Map(rows.map((row, at) => [row.id, projectCode(row.name, rows.slice(0, at).map((r) => r.name))]));
}

/**
 * The views under the current row, with the figures the Board already shows: the Project view's phases, the Backlog
 * preview's "N ›" (parked steps excluded) and the Done column's count. Always the four views: with no snapshot (the next
 * project's has not landed) they carry no counts, so the list never unmounts on a switch.
 */
export function railViews(snapshot: ProjectSnapshot | null, now: number): RailView[] {
  const board = snapshot && deriveBoard(snapshot, now);
  return [
    { view: 'board', label: 'Board', code: 'BRD' },
    { view: 'project', label: 'Project', code: 'PRJ', count: snapshot && board ? phaseCount(projectSections(snapshot, board)) : undefined, unit: 'phases' },
    { view: 'backlog', label: 'Backlog', code: 'BKL', count: snapshot && board ? taskBoxes(board, snapshot, now).backlog.length : undefined },
    { view: 'done', label: 'All done', code: 'DON', count: board?.done.length },
  ];
}

/** A view's title: its label, then its count (`Backlog, 12`). */
export const viewTitle = (v: RailView): string => (v.count === undefined ? v.label : `${v.label}, ${v.count}`);

/**
 * Where focus goes in a rail list of `count` rows on `key`, from row `at`: Down and Right go on, Up and Left go back,
 * wrapping round, and Home and End go to the ends (Left and Right are the strip's, under 720). Null for any other key.
 */
export function railStep(key: string, at: number, count: number): number | null {
  const as = key === 'ArrowRight' ? 'ArrowDown' : key === 'ArrowLeft' ? 'ArrowUp' : key;
  return menuStep(as, at, count);
}

/** A rectangle in window coordinates, as getBoundingClientRect gives it. */
export interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** The gap kept between a menu and the edge of the window, and between a menu and what opened it. */
export const MENU_MARGIN = 8;
export const MENU_GAP = 4;

/**
 * Where a row's menu goes: right of the row when the rail is a column, under it when it is the strip, then moved to lie
 * wholly inside the window.
 */
export function rowMenuAt(row: Box, menu: { width: number; height: number }, win: { width: number; height: number }, layout: 'column' | 'strip'): { top: number; left: number } {
  const left = layout === 'column' ? row.right + MENU_GAP : row.left;
  const top = layout === 'column' ? row.top : row.bottom + MENU_GAP;
  return clampMenu({ top, left }, menu, win);
}

/**
 * Where the foot's menu goes: above the foot button, left aligned, in the column; under the `⋯`, right aligned, in the
 * strip; then moved to lie wholly inside the window.
 */
export function footMenuAt(button: Box, menu: { width: number; height: number }, win: { width: number; height: number }, layout: 'column' | 'strip'): { top: number; left: number } {
  const at = layout === 'column' ? { top: button.top - MENU_GAP - menu.height, left: button.left } : { top: button.bottom + MENU_GAP, left: button.right - menu.width };
  return clampMenu(at, menu, win);
}

function clampMenu(at: { top: number; left: number }, menu: { width: number; height: number }, win: { width: number; height: number }): { top: number; left: number } {
  return {
    top: Math.max(MENU_MARGIN, Math.min(at.top, win.height - menu.height - MENU_MARGIN)),
    left: Math.max(MENU_MARGIN, Math.min(at.left, win.width - menu.width - MENU_MARGIN)),
  };
}
