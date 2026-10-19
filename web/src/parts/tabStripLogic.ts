/**
 * Which tab takes focus on `key`, from tab `at` (-1 when none has it) among `count`: Right and Left wrap round, Home and
 * End go to either end. Null for any other key or no tabs, so the key is left alone.
 */
export function tabStep(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return at < 0 ? 0 : (at + 1) % count;
    case 'ArrowLeft':
      return at < 0 ? count - 1 : (at - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * The scrollLeft that brings an item (at `itemLeft`, `itemWidth` wide, in the strip's own coordinates) fully into a view
 * `viewWidth` wide with the least move. Unchanged when it is already in view; an item wider than the view lines up its left edge.
 */
export function scrollToShow(itemLeft: number, itemWidth: number, scrollLeft: number, viewWidth: number): number {
  if (itemWidth >= viewWidth) return itemLeft;
  if (itemLeft < scrollLeft) return itemLeft;
  if (itemLeft + itemWidth > scrollLeft + viewWidth) return itemLeft + itemWidth - viewWidth;
  return scrollLeft;
}
