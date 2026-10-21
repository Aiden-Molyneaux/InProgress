import type { ProjectSummary } from '../../../src/core/types';
import { PagesShelf } from './PagesShelf';
import { RosterShelf } from './RosterShelf';
import type { LibraryRoute } from './route';
import { SyncShelf } from './SyncShelf';
import type { LibraryData } from './useLibrary';

/** The Library in the main pane: the open shelf's page. The shelves themselves are picked from the rail or the tab strip. */
export function LibraryView({ route, lib, tabs, codes, onOpenResource, onRoute }: { route: LibraryRoute; lib: LibraryData; tabs: ProjectSummary[]; codes: Map<number, string>; onOpenResource: (id: number) => void; onRoute: (route: LibraryRoute) => void }) {
  const shared = { tabs, codes, onOpenResource, onRoute };
  return (
    <div className="ip-library" data-shelf={route.shelf}>
      {route.shelf === 'pages' ? (
        <PagesShelf pages={lib.pages} error={lib.pagesError} {...shared} />
      ) : route.shelf === 'roster' ? (
        <RosterShelf pages={lib.pages} error={lib.pagesError} {...shared} />
      ) : (
        <SyncShelf route={route} sync={lib.sync} error={lib.syncError} />
      )}
    </div>
  );
}
