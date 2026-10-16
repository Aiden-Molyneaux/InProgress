/** The rows a band or a panel lists, as a focus walk sees them. A pending row (a Backlog delete waiting for its answer) is about to leave too, so it is passed over. */
const ROWS = 'li.ip-row:not(.pending), li.ip-card, li.ip-dask:not(.cleared)';

/**
 * Where focus goes when `row` is about to leave (spec 2.2): the title button of the next row in its band or panel, else
 * the previous one, else the band's heading (or the panel's title). Null when the row has no band. Call it before the
 * row goes; focus the answer at once when the row leaves in this event, or once the request is done.
 */
export function focusTargetAfter(row: Element | null): HTMLElement | null {
  const home = row?.closest<HTMLElement>('.ip-band, aside');
  if (!row || !home) return null;
  const others = [...home.querySelectorAll(ROWS)].filter((li) => li !== row && !row.contains(li) && !li.contains(row));
  const pick = (li: Element) => li.querySelector<HTMLElement>('.ip-row-title');
  // The nearest row each way that has a title button to focus: a row without one (a permission wait on no step) is passed over, and a row's own buttons (data-act) never take focus from a walk.
  const after = others.filter((li) => row.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING).map(pick).find(Boolean);
  const before = others.filter((li) => row.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_PRECEDING).reverse().map(pick).find(Boolean);
  return after ?? before ?? home.querySelector<HTMLElement>('h3, header b');
}
