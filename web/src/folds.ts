import type { FoldOverrides } from '../../src/core/tree';

/**
 * The overrides with one set. Folding a node also forgets its opened "+n more" tail (ruling 29) and its opened
 * "✓ n done" runs, so both rows are toggles: fold and unfold the parent to hide them again.
 */
export function withFold(cur: FoldOverrides, key: string, value: 'open' | 'closed'): FoldOverrides {
  const next: FoldOverrides = { ...cur, [key]: value };
  if (key.startsWith('n:') && value === 'closed') {
    delete next[`more:${key.slice(2)}`];
    delete next[`done:${key.slice(2)}`];
  }
  return next;
}
