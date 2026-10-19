import { useEffect, useRef, type RefObject } from 'react';

/**
 * While `open`, calls `onPress` when a mouse press lands outside every one of `refs` (a popover and its opener, say).
 * The handler is read at press time, so it may change between renders without re-attaching the listener.
 */
export function usePressOutside(open: boolean, refs: readonly RefObject<HTMLElement>[], onPress: () => void): void {
  const latest = useRef({ refs, onPress });
  latest.current = { refs, onPress };
  useEffect(() => {
    if (!open) return;
    const press = (event: MouseEvent) => {
      const target = event.target as Node;
      if (latest.current.refs.some((ref) => ref.current?.contains(target))) return;
      latest.current.onPress();
    };
    window.addEventListener('mousedown', press);
    return () => window.removeEventListener('mousedown', press);
  }, [open]);
}
