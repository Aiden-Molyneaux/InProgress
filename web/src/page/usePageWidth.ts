import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * The width of the element the ref is on, which follows a resize: a page lays itself out by its own width, not the
 * window's. The first value is read before the first paint.
 */
export function usePageWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
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
