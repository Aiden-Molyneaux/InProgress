/** Whether a Count went up: true only when it had a value before and the next is larger. The first value never counts as a rise. */
export function countRose(previous: number | undefined, next: number): boolean {
  return typeof previous === 'number' && next > previous;
}
