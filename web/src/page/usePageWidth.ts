import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * The width of the element the ref is on, which follows a resize: a page lays itself out by its own width, not the
 * window's. The first value is read before the first paint.
 */
export function usePageWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  return usePageMeasure<T, number>((width) => width);
}

/**
 * `usePageWidth` for a page that only needs something read from the width (its layout): the state holds `read(width)`, so a
 * resize that leaves it as it was renders nothing. `read` must be a pure function of the width.
 */
export function usePageMeasure<T extends HTMLElement, V>(read: (width: number) => V): [RefObject<T>, V] {
  const ref = useRef<T>(null);
  const [width, setValue] = useState<V>(() => read(0));
  const setWidth = (w: number) => setValue(read(w));
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // clientWidth leaves out a scrollbar, as contentRect does; the page's own root carries no padding, so the two agree.
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const watcher = new ResizeObserver((entries) => setWidth(entries[entries.length - 1].contentRect.width));
    watcher.observe(element);
    return () => watcher.disconnect();
  }, []);
  return [ref, width];
}
