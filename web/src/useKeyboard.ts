import { useEffect, useRef } from 'react';

export interface KeyHandlers {
  onFollow: () => void;
  onNext: () => void;
  onHome: () => void;
  onEnd: () => void;
  onEscape: () => void;
}

export function useKeyboard(handlers: KeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const h = ref.current;
      const map: Record<string, () => void> = { f: h.onFollow, F: h.onFollow, n: h.onNext, N: h.onNext, Home: h.onHome, End: h.onEnd, Escape: h.onEscape };
      const fn = map[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
