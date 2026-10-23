import type { ReactNode } from 'react';
import type { LibraryPage, LibraryPages, ProjectSummary } from '../../../src/core/types';
import { PageHead } from '../page/PageHead';
import { Chip } from '../parts/Chip';
import { EmptyState } from '../parts/EmptyState';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { freshText, groupPages } from './pageGroups';
import { libraryHash, type LibraryRoute } from './route';

interface ListProps {
  pages: LibraryPages;
  /** The pages to list; the list groups them by project. */
  shown: LibraryPage[];
  tabs: ProjectSummary[];
  codes: Map<number, string>;
  onOpenResource: (id: number) => void;
  onRoute: (route: LibraryRoute) => void;
}

/** One page's row: format, title, path and freshness, its error when it cannot be read, and `children` under them. */
export function PageRow({ page: p, onOpen, picked, children }: { page: LibraryPage; onOpen: () => void; picked?: boolean; children?: ReactNode }) {
  const fresh = freshText(p.fresh);
  return (
    <li className="ip-lib-row" data-page={p.id} data-picked={picked || undefined}>
      <div className="ip-lib-line">
        {p.format && <Chip tone="label">{p.format === 'html' ? 'HTML' : 'MD'}</Chip>}
        <button type="button" className="ip-lib-open" aria-current={picked || undefined} onClick={onOpen}>
          {p.title}
        </button>
        <span className="ip-lib-path" title={p.path}>
          {p.path}
        </span>
        {fresh && (
          <span className="ip-lib-fresh" data-alarm={fresh.alarm || undefined}>
            {fresh.text}
          </span>
        )}
      </div>
      {p.error && <p className="ip-lib-error">{p.error}</p>}
      {children}
    </li>
  );
}

/** The pages as sections per project, each row a page: format, title, path, freshness and where it is adapted. */
export function PageList({ pages, shown, tabs, codes, onOpenResource, onRoute }: ListProps) {
  const groups = groupPages(shown, pages.sourceProjectId, tabs.map((t) => t.id));
  return (
    <>
      {groups.map((g) => (
        <section key={g.projectId} className="ip-lib-sec" aria-label={g.projectName}>
          <Eyebrow as="h3">{`${codes.get(g.projectId) ?? g.projectName.slice(0, 3).toUpperCase()} · ${g.projectName}`}</Eyebrow>
          <ul className="ip-lib-list">
            {g.pages.map((p) => (
              <PageRow key={p.id} page={p} onOpen={() => onOpenResource(p.id)}>
                {p.adaptedIn.length > 0 && (
                  <div className="ip-lib-adapted">
                    <Eyebrow>Adapted in</Eyebrow>
                    {p.adaptedIn.map((a) => {
                      const route: LibraryRoute = { shelf: 'sync', pick: { slug: a.slug, template: a.template } };
                      const project = tabs.find((t) => t.slug === a.slug);
                      return (
                        <a
                          key={`${a.slug}:${a.template}`}
                          className="ip-lib-adapt"
                          href={libraryHash(route)}
                          title={`${a.name}'s adaptation of ${a.template}`}
                          onClick={(e) => {
                            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
                            e.preventDefault();
                            onRoute(route);
                          }}
                        >
                          <Chip>{project ? (codes.get(project.id) ?? a.name) : a.name}</Chip>
                        </a>
                      );
                    })}
                  </div>
                )}
              </PageRow>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** Pages: the library pages on the `pages` shelf, by owning project. */
export function PagesShelf({ pages, error, ...rest }: Omit<ListProps, 'pages' | 'shown'> & { pages: LibraryPages | null; error: string | null }) {
  const shown = pages ? pages.pages.filter((p) => p.shelf === 'pages') : [];
  return (
    <div className="ip-page ip-lib-page">
      <PageHead code="PGS" name="PAGES" meta={pages ? [{ value: shown.length, label: shown.length === 1 ? 'PAGE' : 'PAGES' }] : undefined} decodeKey={-1} />
      {error && <ErrorLine message={error} />}
      {!pages ? (
        !error && <EmptyState>Loading…</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState>No library pages yet. Register one with purpose library.</EmptyState>
      ) : (
        <PageList pages={pages} shown={shown} {...rest} />
      )}
    </div>
  );
}
