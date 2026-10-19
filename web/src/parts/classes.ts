/** Joins class names, dropping the empty ones: a part's own class first, then the caller's `className`. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
