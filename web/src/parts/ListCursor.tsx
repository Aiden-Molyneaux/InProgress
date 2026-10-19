import { useCallback, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { clampCursor, cursorStep, type Cursor } from './listCursorLogic';

/** What a list or grid item spreads onto its element. */
export interface CursorItemProps {
  ref: (element: HTMLElement | null) => void;
  tabIndex: number;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  'data-cursor': '';
}

/**
 * Arrow-key movement through a list, or a grid of columns, as one Tab stop. `counts` is the item count of each column
 * (a list passes one); `onOpen` is called on Enter. Spread `itemProps(col, row)` on each item's element. The item's focus
 * look is the item's own: this adds no CSS.
 */
export function useListCursor(counts: readonly number[], onOpen: (at: Cursor) => void): { itemProps: (col: number, row: number) => CursorItemProps } {
  const [last, setLast] = useState<Cursor | null>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const at = clampCursor(last, counts);

  const itemProps = useCallback(
    (col: number, row: number): CursorItemProps => ({
      ref: (element) => {
        if (element) items.current.set(`${col}:${row}`, element);
        else items.current.delete(`${col}:${row}`);
      },
      tabIndex: at && at.col === col && at.row === row ? 0 : -1,
      onFocus: (event) => {
        if (event.target === event.currentTarget) setLast({ col, row });
      },
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
    }),
    [at, counts, onOpen],
  );

  return { itemProps };
}
