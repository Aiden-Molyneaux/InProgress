import type { LibraryPages, ProjectSummary } from '../../../src/core/types';
import { ResourceViewer } from '../panels/ResourceViewer';
import { PageHead } from '../page/PageHead';
import { EmptyState } from '../parts/EmptyState';
import { ErrorLine } from '../parts/ErrorLine';
import { PageList } from './PagesShelf';
import type { LibraryRoute } from './route';

/** Roster: the `shelf: roster` pages. Exactly one opens in place; none says how to add it; more list as Pages does. */
export function RosterShelf({ pages, error, tabs, codes, onOpenResource, onRoute }: { pages: LibraryPages | null; error: string | null; tabs: ProjectSummary[]; codes: Map<number, string>; onOpenResource: (id: number) => void; onRoute: (route: LibraryRoute) => void }) {
  const shown = pages ? pages.pages.filter((p) => p.shelf === 'roster') : [];
  const one = shown.length === 1 ? shown[0] : null;
  return (
    <div className="ip-page ip-lib-page" data-inline={one ? true : undefined}>
      <PageHead code="RST" name="ROSTER" decodeKey={-2} />
      {error && <ErrorLine message={error} />}
      {!pages ? (
        !error && <EmptyState>Loading…</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState>No roster page yet. A library page with shelf: roster lands here.</EmptyState>
      ) : one ? (
        <ResourceViewer key={one.id} resourceId={one.id} inline />
      ) : (
        <PageList pages={pages} shown={shown} tabs={tabs} codes={codes} onOpenResource={onOpenResource} onRoute={onRoute} />
      )}
    </div>
  );
}
