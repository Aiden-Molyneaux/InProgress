import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Keeps focus in a row list when the row that had it leaves through a write nobody here pressed (another session's, or a
 * step reopened elsewhere). It remembers the row ids in order from the last render and which row had focus inside it; when
 * that row is gone and focus fell to the page, the row that followed it in the old order and is still drawn takes focus,
 * else the one before it, else the page title. `list` is the element holding the `li[data-node]` rows.
 */
export function useKeepRowFocus(list: RefObject<HTMLElement>, rowIds: readonly number[], title: RefObject<HTMLElement>): void {
  const before = useRef<readonly number[]>(rowIds);
  const held = useRef<number | null>(null);
  useEffect(() => {
    const watch = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const row = target && list.current?.contains(target) ? target.closest<HTMLElement>('li[data-node]') : null;
      held.current = row ? Number(row.dataset.node) : null;
    };
    // Focus that leaves for nowhere (a press on blank page) while its element stays drawn was let go on purpose: forget the
    // row. Checked a microtask later: the browser fires focusout on a row being removed while it is still in the page, and by
    // then the layout effect below has handed its focus on.
    const leave = (event: FocusEvent) => {
      const target = event.target;
      if (event.relatedTarget !== null || !(target instanceof Node)) return;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (target.isConnected && (active === null || active === document.body)) held.current = null;
      });
    };
    document.addEventListener('focusin', watch);
    document.addEventListener('focusout', leave);
    return () => {
      document.removeEventListener('focusin', watch);
      document.removeEventListener('focusout', leave);
    };
  }, [list]);
  // Runs after every render, before paint: the row's element is already out of the page when this reads where focus is.
  useLayoutEffect(() => {
    const old = before.current;
    before.current = rowIds;
    const id = held.current;
    if (id === null) return;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    // A row still listed but drawn anew (moved to another group by a write elsewhere) takes focus back itself.
    if (rowIds.includes(id)) {
      if (lost) list.current?.querySelector<HTMLElement>(`li[data-node="${id}"]`)?.focus();
      return;
    }
    held.current = null;
    if (!lost) return;
    const at = old.indexOf(id);
    const drawn = new Set(rowIds);
    const near = at < 0 ? [] : [...old.slice(at + 1).filter((x) => drawn.has(x)), ...old.slice(0, at).reverse().filter((x) => drawn.has(x))];
    const row = near.length > 0 ? list.current?.querySelector<HTMLElement>(`li[data-node="${near[0]}"]`) : null;
    (row ?? title.current)?.focus();
  });
}
