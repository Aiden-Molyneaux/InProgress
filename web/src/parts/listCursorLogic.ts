/** A position in a list or a grid of columns: which column, which item down it. */
export interface Cursor {
  col: number;
  row: number;
}

/** Where the cursor was last, and the key of the item it was on when the list gave keys. */
export interface StoredCursor extends Cursor {
  key?: string;
}

/**
 * Where the cursor can rest given each column's item count. Null when every column is empty; null `at` gives the first
 * item of the first non-empty column; an empty column (or one past the end) moves to the nearest non-empty one, looking
 * right first and then left; the row is held to the column's last item.
 */
export function clampCursor(at: Cursor | null, counts: readonly number[]): Cursor | null {
  const first = counts.findIndex((n) => n > 0);
  if (first < 0) return null;
  if (!at) return { col: first, row: 0 };
  let col = Math.min(Math.max(at.col, 0), counts.length - 1);
  if (counts[col] <= 0) {
    let found = -1;
    for (let c = col + 1; c < counts.length && found < 0; c++) if (counts[c] > 0) found = c;
    for (let c = col - 1; c >= 0 && found < 0; c--) if (counts[c] > 0) found = c;
    col = found;
  }
  return { col, row: Math.min(Math.max(at.row, 0), counts[col] - 1) };
}

/**
 * Where the cursor goes on `key` from `at`. `middles[c][r]` is item r's vertical middle in column c (a list passes one
 * column). Up and Down move one row and stay put at the ends; Home and End go to the column's ends; Left and Right
 * (with more than one column) go to the nearest non-empty column that way, at the row whose middle is nearest this
 * item's (the upper row on a tie), and stay put when there is none. Null for any other key, and for Left and Right in a list.
 */
export function cursorStep(key: string, at: Cursor, middles: readonly (readonly number[])[]): Cursor | null {
  const last = (middles[at.col]?.length ?? 0) - 1;
  switch (key) {
    case 'ArrowDown':
      return { col: at.col, row: Math.min(at.row + 1, last) };
    case 'ArrowUp':
      return { col: at.col, row: Math.max(at.row - 1, 0) };
    case 'Home':
      return { col: at.col, row: 0 };
    case 'End':
      return { col: at.col, row: Math.max(last, 0) };
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (middles.length < 2) return null;
      const dir = key === 'ArrowRight' ? 1 : -1;
      let col = at.col + dir;
      while (col >= 0 && col < middles.length && middles[col].length === 0) col += dir;
      if (col < 0 || col >= middles.length) return at;
      const from = middles[at.col][at.row];
      let row = 0;
      for (let r = 1; r < middles[col].length; r++) if (Math.abs(middles[col][r] - from) < Math.abs(middles[col][row] - from)) row = r;
      return { col, row };
    }
    default:
      return null;
  }
}

/**
 * Where the cursor is now. With `keys` (one array per column) and a remembered key still in them, the cursor is on that
 * item wherever it has moved to, so a row added above it does not carry the cursor to another item; otherwise it is
 * `clampCursor` of the remembered position.
 */
export function resolveCursor(last: StoredCursor | null, counts: readonly number[], keys?: readonly (readonly string[])[]): Cursor | null {
  if (keys && last?.key !== undefined) {
    for (let col = 0; col < keys.length; col++) {
      const row = keys[col].indexOf(last.key);
      if (row >= 0 && row < (counts[col] ?? 0)) return { col, row };
    }
  }
  return clampCursor(last, counts);
}
