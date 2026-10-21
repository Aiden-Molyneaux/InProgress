export type Shelf = 'pages' | 'roster' | 'sync';
export interface LibraryRoute {
  shelf: Shelf;
  /** A Sync pick: the project's slug and the template path, from a page's Adapted in chip. */
  pick: { slug: string; template: string } | null;
}
export const SHELVES: readonly Shelf[] = ['pages', 'roster', 'sync'];

const isShelf = (s: string): s is Shelf => (SHELVES as readonly string[]).includes(s);

/**
 * The Library's route in the hash: `#/lib/<shelf>`, and on sync `#/lib/sync/<slug>/<template>` (both encoded). Null when the
 * hash is not the Library's. `#/lib` and an unknown shelf are Pages; a bad escape drops the pick.
 */
export function parseLibraryHash(hash: string): LibraryRoute | null {
  const m = /^#\/lib(?:\/(.*))?$/.exec(hash);
  if (!m) return null;
  const [shelf = '', slug, template] = (m[1] ?? '').split('/');
  const found: Shelf = isShelf(shelf) ? shelf : 'pages';
  if (found !== 'sync' || !slug || !template) return { shelf: found, pick: null };
  try {
    return { shelf: found, pick: { slug: decodeURIComponent(slug), template: decodeURIComponent(template) } };
  } catch {
    // A malformed escape in a hand-edited address: the shelf opens without the pick.
    return { shelf: found, pick: null };
  }
}

export function libraryHash(route: LibraryRoute): string {
  const base = `#/lib/${route.shelf}`;
  return route.shelf === 'sync' && route.pick ? `${base}/${encodeURIComponent(route.pick.slug)}/${encodeURIComponent(route.pick.template)}` : base;
}
