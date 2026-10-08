import type { LayoutResult } from '../../src/core/layout';
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

/** What revealKeys reads of a layout: the rows it shows and its fold rows. */
type Shown = Pick<LayoutResult, 'nodeItems' | 'items'>;

/**
 * The overrides to open, outermost first, so the step `id` gets a row of its own: each folded ancestor's `n:`, and the
 * `more:` or `done:` of a run that hides a step on the way down. `path` is the step's ancestors from the root, then the
 * step. `layoutWith` lays the project out under the given overrides. Empty when the step already shows, or when nothing
 * opened would show it.
 */
export function revealKeys(path: readonly number[], overrides: FoldOverrides, layoutWith: (overrides: FoldOverrides) => Shown): string[] {
  const id = path[path.length - 1];
  const keys: string[] = [];
  let cur = overrides;
  // Each pass opens one override, and a step can be hidden at most three ways under each ancestor.
  for (let pass = 0; pass <= path.length * 3; pass++) {
    const shown = layoutWith(cur);
    if (id === undefined || shown.nodeItems.has(id)) return keys;
    const at = path.findIndex((p) => !shown.nodeItems.has(p));
    if (at <= 0) return keys;
    const parent = path[at - 1];
    const child = path[at];
    let key: string | undefined;
    if (shown.nodeItems.get(parent)?.folded) key = `n:${parent}`;
    else {
      const run = shown.items.find((it) => it.kind === 'more' && it.parentId === parent && it.hiddenIds.includes(child));
      if (run?.kind === 'more') key = `${run.variant === 'done' ? 'done' : 'more'}:${parent}`;
    }
    if (key === undefined || cur[key] === 'open') return keys;
    cur = withFold(cur, key, 'open');
    keys.push(key);
  }
  return keys;
}
