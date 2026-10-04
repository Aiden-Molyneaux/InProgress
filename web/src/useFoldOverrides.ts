import { useCallback, useState } from 'react';
import type { FoldOverrides } from '../../src/core/tree';
import { withFold } from './folds';
import { loadJson, save } from './storage';

const stored = (projectId: number | undefined): FoldOverrides =>
  projectId === undefined ? {} : loadJson<FoldOverrides>(`ip.folds.${projectId}`, {});

/**
 * Per-project manual fold state, persisted in localStorage. The stored folds are read during the render in
 * which the project changes, not in an effect, so each project's first layout already honours them. (App
 * calls this before the first snapshot has loaded, so a lazy initial state alone would never see the
 * project.) Folding a node also re-collapses its "+n more" tail and its "✓ n done" runs (withFold).
 */
export function useFoldOverrides(projectId: number | undefined): [FoldOverrides, (key: string, value: 'open' | 'closed') => void] {
  const [state, setState] = useState(() => ({ projectId, overrides: stored(projectId) }));
  // React re-runs this render with the new state before rendering any children.
  if (state.projectId !== projectId) setState({ projectId, overrides: stored(projectId) });
  const set = useCallback((key: string, value: 'open' | 'closed') => {
    setState((cur) => {
      const next = withFold(cur.overrides, key, value);
      if (cur.projectId !== undefined) save(`ip.folds.${cur.projectId}`, JSON.stringify(next));
      return { projectId: cur.projectId, overrides: next };
    });
  }, []);
  return [state.overrides, set];
}
