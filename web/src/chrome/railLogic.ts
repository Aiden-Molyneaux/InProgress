import { deriveBoard } from '../../../src/core/board';
import { taskBoxes } from '../../../src/core/taskState';
import { projectBehind, type LibraryPage, type LibraryPages, type LibrarySync, type ProjectSnapshot } from '../../../src/core/types';
import type { Shelf } from '../library/route';
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
  /** A figure that is not a single count (Docs: "3 · 1 stale"). It takes the count's place. */
  text?: string;
  /** Paints `text` in the behind colour. */
  warn?: boolean;
}

/** What the Docs entry counts: the project's pages, those stale, and its adaptations (null: it keeps no manifest). */
export interface DocsCount {
  pages: number;
  stale: number;
  adaptations: number | null;
}

/** A page is stale when commits touched its covers since it was confirmed, or the confirmation left history; no covers is not. */
export const pageStale = (p: Pick<LibraryPage, 'fresh'>): boolean => p.fresh === null || (p.fresh !== undefined && p.fresh > 0);

/** The Docs figure of `slug`: its pages and adaptations (its row in the sync check), null before its pages have loaded. */
export function docsCount(pages: readonly LibraryPage[] | null, sync: LibrarySync | null, slug: string | null): DocsCount | null {
  if (!pages) return null;
  const row = sync?.projects.find((r) => r.slug === slug);
  return { pages: pages.length, stale: pages.filter(pageStale).length, adaptations: row && row.check.ok ? row.check.result.files.length : null };
}

/** The Docs entry's figure: "3 · 1 stale" in the behind colour, else "3 · 2" with a manifest, else the page count; nothing with no data. */
export function docsFigure(docs: DocsCount | null | undefined): Pick<RailView, 'count' | 'text' | 'warn'> {
  if (!docs) return {};
  if (docs.stale > 0) return { text: `${docs.pages} · ${docs.stale} stale`, warn: true };
  if (docs.adaptations !== null) return { text: `${docs.pages} · ${docs.adaptations}` };
  return { count: docs.pages };
}

/** One of the Library's shelves as the rail lists it under the Library row. `warn` paints the count in the behind colour. */
export interface LibraryRailView {
  shelf: Shelf;
  label: string;
  code: string;
  count?: string;
  warn?: boolean;
}

/** How many projects have a file behind Shipwright, or null before the first check has landed. */
export const libraryBehind = (sync: LibrarySync | null): number | null => (sync ? sync.projects.filter(projectBehind).length : null);

/** The Library's three shelves: Pages with its page count, Roster with none, Sync with "N behind" while any are. */
export function libraryViews(pages: LibraryPages | null, sync: LibrarySync | null): LibraryRailView[] {
  const behind = libraryBehind(sync);
  const shelved = pages ? pages.pages.filter((p) => p.shelf === 'pages').length : undefined;
  return [
    { shelf: 'pages', label: 'Pages', code: 'PGS', count: shelved === undefined ? undefined : String(shelved) },
    { shelf: 'roster', label: 'Roster', code: 'RST' },
    { shelf: 'sync', label: 'Sync', code: 'SYN', ...(behind ? { count: `${behind} behind`, warn: true } : {}) },
  ];
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
 * preview's "N ›" (parked steps excluded) and the Done column's count, then Docs with its pages. Always the five views: with
 * no snapshot (the next project's has not landed) they carry no counts, so the list never unmounts on a switch.
 */
export function railViews(snapshot: ProjectSnapshot | null, now: number, docs?: DocsCount | null): RailView[] {
  const board = snapshot && deriveBoard(snapshot, now);
  return [
    { view: 'board', label: 'Board', code: 'BRD' },
    { view: 'project', label: 'Project', code: 'PRJ', count: snapshot && board ? phaseCount(projectSections(snapshot, board)) : undefined, unit: 'phases' },
    { view: 'backlog', label: 'Backlog', code: 'BKL', count: snapshot && board ? taskBoxes(board, snapshot, now).backlog.length : undefined },
    { view: 'done', label: 'All done', code: 'DON', count: board?.done.length },
    { view: 'docs', label: 'Docs', code: 'DOC', ...docsFigure(docs) },
  ];
}

/** A view's title: its label, then its figure (`Backlog, 12`, `Docs, 3 · 1 stale`). */
export const viewTitle = (v: RailView): string => {
  const figure = v.text ?? v.count;
  return figure === undefined ? v.label : `${v.label}, ${figure}`;
};

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
