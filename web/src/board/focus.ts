/** The rows a band or a panel lists, as a focus walk sees them. A pending box (a Backlog delete waiting for its answer) is about to leave too, and a confirming one keeps its title out of the Tab order (a walk's script focus would still reach it), so both are passed over. */
const ROWS = 'li.ip-card:not(.pending):not(.confirming), article.ip-tile:not([data-pending]), .ip-backlog-row:not(.pending):not(.confirming), li.ip-dask:not(.cleared)';

/** A tile whose every ask has gone out (data-sent) is about to leave too: a walk passes it over. */
const allSent = (li: Element) => {
  const asks = li.querySelectorAll('[data-ask]');
  return asks.length > 0 && [...asks].every((a) => a.hasAttribute('data-sent'));
};

/**
 * Where focus goes when `row` is about to leave (spec 2.2): the title button of the next row in its band or panel, else
 * the previous one, else the band's heading (or the panel's or the full Backlog's title). Null when the row has no band. Call it before the
 * row goes; focus the answer at once when the row leaves in this event, or once the request is done.
 */
export function focusTargetAfter(row: Element | null): HTMLElement | null {
  const home = row?.closest<HTMLElement>('.ip-band, aside, .ip-backlogview');
  if (!row || !home) return null;
  const others = [...home.querySelectorAll(ROWS)].filter((li) => li !== row && !row.contains(li) && !li.contains(row) && !allSent(li));
  // A cursor item (a Board tile, a preview row) takes focus itself; the older rows take their title button.
  const pick = (li: Element) => (li.matches('[data-cursor]') ? (li as HTMLElement) : li.querySelector<HTMLElement>('.ip-row-title'));
  // The nearest row each way that has a title button to focus: a row without one (a permission wait on no step) is passed over, and a row's own buttons (data-act) never take focus from a walk.
  const after = others.filter((li) => row.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING).map(pick).find(Boolean);
  const before = others.filter((li) => row.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_PRECEDING).reverse().map(pick).find(Boolean);
  return after ?? before ?? (home.querySelector<HTMLElement>('h2') ?? home.querySelector<HTMLElement>('h3, header b, .ip-backlogview-title'));
}
