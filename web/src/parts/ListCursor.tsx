import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { clampCursor, cursorStep, type Cursor } from './listCursorLogic';

/** What a list or grid item spreads onto its element. */
export interface CursorItemProps {
  ref: (element: HTMLElement | null) => void;
  tabIndex: number;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  'data-cursor': '';
}

/** What can take focus inside an item. */
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, iframe, [contenteditable]:not([contenteditable="false"]), [tabindex]';

/**
 * Arrow-key movement through a list, or a grid of columns, as one Tab stop. `counts` is the item count of each column
 * (a list passes one); `onOpen` is called on Enter. Spread `itemProps(col, row)` on each item's element. The item's focus
 * look is the item's own: this adds no CSS.
 *
 * One Tab stop (D4): only the cursor item is in the Tab order, and the controls inside every other item are taken out of
 * it (tabindex -1, marked data-cursor-off) after each render. Tab goes into the focused item's own controls, then out of the list.
 */
export function useListCursor(counts: readonly number[], onOpen: (at: Cursor) => void): { itemProps: (col: number, row: number) => CursorItemProps } {
  const [last, setLast] = useState<Cursor | null>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const at = clampCursor(last, counts);

  // After every render: the controls inside a non-cursor item leave the Tab order, and come back when it is the cursor item.
  useLayoutEffect(() => {
    for (const [key, element] of items.current) {
      const here = at !== null && key === `${at.col}:${at.row}`;
      if (here) {
        for (const inner of element.querySelectorAll<HTMLElement>('[data-cursor-off]')) {
          const was = inner.getAttribute('data-cursor-off');
          if (was) inner.setAttribute('tabindex', was);
          else inner.removeAttribute('tabindex');
          inner.removeAttribute('data-cursor-off');
        }
      } else {
        // The marker keeps the control's own tabindex (empty when it had none), so the restore gives back what was there.
        // One already out of the Tab order (tabindex -1, unmarked) is left alone.
        for (const inner of element.querySelectorAll<HTMLElement>(FOCUSABLE)) {
          if (inner === element || inner.hasAttribute('data-cursor-off') || inner.getAttribute('tabindex') === '-1') continue;
          inner.setAttribute('data-cursor-off', inner.getAttribute('tabindex') ?? '');
          inner.setAttribute('tabindex', '-1');
        }
      }
    }
  });

  const itemProps = (col: number, row: number): CursorItemProps => ({
    ref: (element) => {
      if (element) items.current.set(`${col}:${row}`, element);
      else items.current.delete(`${col}:${row}`);
    },
    tabIndex: at && at.col === col && at.row === row ? 0 : -1,
    // Focus anywhere inside the item makes it the cursor item, so Shift+Tab back out of its controls lands on it.
    onFocus: () => setLast((now) => (now && now.col === col && now.row === row ? now : { col, row })),
    onKeyDown: (event) => {
      // Keys inside an item's own fields and buttons are theirs; Alt with an arrow is the Board's reorder.
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const here = { col, row };
      if (event.key === 'Enter') {
        event.preventDefault();
        onOpen(here);
        return;
      }
      const middles = counts.map((n, c) =>
        Array.from({ length: n }, (_, r) => {
          const box = items.current.get(`${c}:${r}`)?.getBoundingClientRect();
          return box ? box.top + box.height / 2 : 0;
        }),
      );
      const next = cursorStep(event.key, here, middles);
      if (!next) return;
      event.preventDefault();
      items.current.get(`${next.col}:${next.row}`)?.focus();
    },
    'data-cursor': '',
  });

  return { itemProps };
}
