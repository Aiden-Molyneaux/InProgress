import { useEffect, useRef, useState } from 'react';
import type { LibraryPages, LibrarySync } from '../../../src/core/types';
import { api } from '../api';

export interface LibraryData {
  pages: LibraryPages | null;
  pagesError: string | null;
  sync: LibrarySync | null;
  syncError: string | null;
}

/**
 * The Library's data: its pages and the Sync check. Loaded at mount (the rail's count needs the check) and again each time
 * the Library opens; nothing polls. A sequence number per kind keeps an older answer from landing over a newer one, and a
 * failed load keeps the last data and sets the error.
 */
export function useLibrary(open: boolean): LibraryData {
  const [pages, setPages] = useState<LibraryPages | null>(null);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [sync, setSync] = useState<LibrarySync | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const seq = useRef({ pages: 0, sync: 0 });
  const mounted = useRef(false);
  useEffect(() => {
    // The first run is the mount's; after it only the Library opening loads again, not its closing.
    if (mounted.current && !open) return;
    mounted.current = true;
    const pagesAt = ++seq.current.pages;
    const syncAt = ++seq.current.sync;
    api.libraryPages().then(
      (p) => {
        if (pagesAt !== seq.current.pages) return;
        setPages(p);
        setPagesError(null);
      },
      (e: Error) => pagesAt === seq.current.pages && setPagesError(e.message),
    );
    api.librarySync().then(
      (s) => {
        if (syncAt !== seq.current.sync) return;
        setSync(s);
        setSyncError(null);
      },
      (e: Error) => syncAt === seq.current.sync && setSyncError(e.message),
    );
  }, [open]);
  return { pages, pagesError, sync, syncError };
}
