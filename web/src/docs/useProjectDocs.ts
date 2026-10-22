import { useEffect, useRef, useState } from 'react';
import type { LibraryPage } from '../../../src/core/types';
import { api } from '../api';

export interface ProjectDocs {
  /** The project's own pages, or null until they have loaded for this slug. */
  pages: LibraryPage[] | null;
  /** The project's first bound folder: where its pages are read live from. */
  root: string | null;
  error: string | null;
}

/**
 * The open project's own pages (purpose page). Loaded when the slug changes and again each time the Docs view opens;
 * nothing polls. A sequence number keeps an older answer from landing over a newer one, and a failed load keeps the last
 * pages of the same project and sets the error.
 */
export function useProjectDocs(slug: string | null, open: boolean): ProjectDocs {
  const [docs, setDocs] = useState<{ slug: string; pages: LibraryPage[]; root: string | null } | null>(null);
  const [failed, setFailed] = useState<{ slug: string; message: string } | null>(null);
  const seq = useRef(0);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!slug) return;
    // After the slug's own load, only the Docs view opening loads again, not its closing.
    if (loaded.current === slug && !open) return;
    loaded.current = slug;
    const at = ++seq.current;
    api.projectPages(slug).then(
      async ({ pages }) => {
        // The folder only decorates the head: a failed read leaves it out rather than hiding the pages.
        const bindings = pages.length > 0 ? await api.bindings().catch(() => []) : [];
        if (at !== seq.current) return;
        setDocs({ slug, pages, root: bindings.find((b) => b.projectId === pages[0].projectId)?.path ?? null });
        setFailed(null);
      },
      (e: Error) => at === seq.current && setFailed({ slug, message: e.message }),
    );
  }, [slug, open]);
  const mine = docs && docs.slug === slug ? docs : null;
  return { pages: mine ? mine.pages : null, root: mine ? mine.root : null, error: failed && failed.slug === slug ? failed.message : null };
}
