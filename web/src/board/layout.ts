/** How many columns the Board lays out: four across, two by two, or one stacked (spec section 7). */
export type BoardLayout = 'four' | 'two' | 'one';

/** The page widths where the layout changes, in CSS px. */
export const FOUR_FROM = 1160;
export const TWO_FROM = 720;

/** The layout for a page width. Width 0, before the first measure, counts as four so the first paint is the wide one. */
export function layoutFor(width: number): BoardLayout {
  if (width <= 0 || width >= FOUR_FROM) return 'four';
  return width >= TWO_FROM ? 'two' : 'one';
}
