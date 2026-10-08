import { useEffect, useRef } from 'react';

/** A key without a handler is left to the browser, so Home/End can scroll whatever has focus. */
export interface KeyHandlers {
  onFollow?: () => void;
  onNext?: () => void;
  onHome?: () => void;
  onEnd?: () => void;
  /** `[` and `]`: the previous and the next project tab. */
  onPrevTab?: () => void;
  onNextTab?: () => void;
  /** `1` to `9`: the nth project tab. */
  onTab?: (n: number) => void;
  onEscape: () => void;
  /** `/` or Ctrl+K: the Go to field. */
  onGoTo?: () => void;
}

/** Ctrl+K (Cmd+K on a Mac), and nothing else held. */
export const isGoToChord = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K');

export function useKeyboard(handlers: KeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const h = ref.current;
      // The one chord the window takes, before the browser's own Ctrl+K (its address bar search) does.
      if (isGoToChord(e) && h.onGoTo) {
        e.preventDefault();
        h.onGoTo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const { onTab } = h;
      const map: Record<string, (() => void) | undefined> = { f: h.onFollow, F: h.onFollow, n: h.onNext, N: h.onNext, Home: h.onHome, End: h.onEnd, Escape: h.onEscape, '[': h.onPrevTab, ']': h.onNextTab, '/': h.onGoTo };
      const fn = /^[1-9]$/.test(e.key) ? onTab && (() => onTab(Number(e.key))) : map[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
