/** Longer patterns never match. Stored branch patterns are at most 200 characters (the binding schema). */
const MAX_PATTERN = 200;

/**
 * Case-insensitive glob over a whole string: `*` = any run of characters, `?` = one character.
 * A two-pointer scan that only ever backtracks to the latest `*`, so the worst case is
 * pattern length × value length. A regex with one `.*` per star can backtrack exponentially
 * on patterns like `*a*a*a*b`, which would stall the server on every hook.
 */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern.length > MAX_PATTERN) return false;
  const p = pattern.replace(/\*+/g, '*').toLowerCase();
  const v = value.toLowerCase();
  let pi = 0;
  let vi = 0;
  let star = -1;
  let resume = 0;
  while (vi < v.length) {
    if (pi < p.length && p[pi] !== '*' && (p[pi] === '?' || p[pi] === v[vi])) {
      pi++;
      vi++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      resume = vi;
    } else if (star >= 0) {
      // Let the latest * absorb one more character and retry from there.
      pi = star + 1;
      vi = ++resume;
    } else {
      return false;
    }
  }
  while (p[pi] === '*') pi++;
  return pi === p.length;
}
