import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryPage } from '../../../src/core/types';
import { api } from '../api';

export interface ProjectDocs {
  /** The project's own pages, or null until they have loaded for this slug. */
  pages: LibraryPage[] | null;
  /** The project's first bound folder: where its pages are read live from. */
  root: string | null;
  error: string | null;
  /** Reads the pages again: after the viewer's Still accurate, so the index and the rail stop counting the page stale. */
  reload: () => void;
}

/**
 * The open project's own pages (purpose page). Loaded when the slug changes, again each time the Docs view opens, and on
 * `reload`; nothing polls. A sequence number keeps an older answer from landing over a newer one, and a failed load keeps
 * the last pages of the same project and sets the error.
 */
export function useProjectDocs(slug: string | null, open: boolean): ProjectDocs {
  const [docs, setDocs] = useState<{ slug: string; pages: LibraryPage[]; root: string | null } | null>(null);
  const [failed, setFailed] = useState<{ slug: string; message: string } | null>(null);
  const [asked, setAsked] = useState(0);
  const seq = useRef(0);
  const loaded = useRef<{ slug: string; asked: number } | null>(null);
  useEffect(() => {
    if (!slug) return;
    // After the slug's own load, only the Docs view opening or a reload loads again, not the view closing.
    if (loaded.current && loaded.current.slug === slug && loaded.current.asked === asked && !open) return;
    loaded.current = { slug, asked };
    const at = ++seq.current;
    api.projectPages(slug).then(
      ({ pages }) => {
        if (at !== seq.current) return;
        setDocs((before) => ({ slug, pages, root: before && before.slug === slug ? before.root : null }));
        setFailed(null);
        // The folder only decorates the head, so the pages show without waiting for it, and a failed read leaves it out.
        if (pages.length === 0) return;
        api.bindings().then(
          (bindings) => {
            if (at !== seq.current) return;
            const root = bindings.find((b) => b.projectId === pages[0].projectId)?.path ?? null;
            setDocs((now) => (now && now.slug === slug ? { ...now, root } : now));
          },
          () => undefined,
        );
      },
      (e: Error) => at === seq.current && setFailed({ slug, message: e.message }),
    );
  }, [slug, open, asked]);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const mine = docs && docs.slug === slug ? docs : null;
  return { pages: mine ? mine.pages : null, root: mine ? mine.root : null, error: failed && failed.slug === slug ? failed.message : null, reload };
}
