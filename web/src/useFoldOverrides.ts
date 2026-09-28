import { useCallback, useEffect, useState } from 'react';
import type { FoldOverrides } from '../../src/core/tree';
import { loadJson, save } from './storage';

const stored = (projectId: number | undefined): FoldOverrides =>
  projectId === undefined ? {} : loadJson<FoldOverrides>(`ip.folds.${projectId}`, {});

/**
 * Per-project manual fold state, persisted in localStorage. Loaded synchronously so the first
 * layout already honours it. Folding a node also re-collapses its "+n more" tail, which makes
 * "+n more" a toggle: fold and unfold the parent to hide the tail again.
 */
export function useFoldOverrides(projectId: number | undefined): [FoldOverrides, (key: string, value: 'open' | 'closed') => void] {
  const [overrides, setOverrides] = useState<FoldOverrides>(() => stored(projectId));
  useEffect(() => {
    setOverrides(stored(projectId));
  }, [projectId]);
  const set = useCallback(
    (key: string, value: 'open' | 'closed') => {
      setOverrides((cur) => {
        const next: FoldOverrides = { ...cur, [key]: value };
        if (key.startsWith('n:') && value === 'closed') delete next[`more:${key.slice(2)}`];
        if (projectId !== undefined) save(`ip.folds.${projectId}`, JSON.stringify(next));
        return next;
      });
    },
    [projectId],
  );
  return [overrides, set];
}
