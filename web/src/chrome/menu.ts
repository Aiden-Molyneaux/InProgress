/**
 * Where focus goes in a menu of `count` items on `key`, from item `at` (-1 when none has focus): Down and Up wrap round,
 * Home and End go to either end. Null for any other key, so it is left to the menu's own handling.
 */
export function menuStep(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return at < 0 ? 0 : (at + 1) % count;
    case 'ArrowUp':
      return at < 0 ? count - 1 : (at - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
