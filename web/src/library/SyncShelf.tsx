import type { LibrarySync } from '../../../src/core/types';
import { PageHead } from '../page/PageHead';
import { EmptyState } from '../parts/EmptyState';
import { ErrorLine } from '../parts/ErrorLine';
import type { LibraryRoute } from './route';

/**
 * Sync, until the grid (#515): one line per project with a manifest, how many of its files are behind, and the pick a page's
 * Adapted in chip made.
 */
export function SyncShelf({ route, sync, error }: { route: LibraryRoute; sync: LibrarySync | null; error: string | null }) {
  const head = sync?.projects.find((p) => p.check.ok)?.check;
  const picked = route.pick ? sync?.projects.find((p) => p.slug === route.pick!.slug) : undefined;
  return (
    <div className="ip-page ip-lib-page">
      <PageHead code="SYN" name="SYNC" decodeKey={-3}>
        {head?.ok && <span className="ip-lib-sha" title={head.result.shipwright.subject}>{`SHIPWRIGHT ${head.result.shipwright.head.slice(0, 7)}`}</span>}
      </PageHead>
      {error && <ErrorLine message={error} />}
      {!sync ? (
        !error && <EmptyState>Loading…</EmptyState>
      ) : sync.projects.length === 0 ? (
        <EmptyState>No project has a .claude/shipwright.json yet.</EmptyState>
      ) : (
        <>
          {route.pick && (
            <p className="ip-lib-pick">{`Picked ${picked?.name ?? route.pick.slug} × ${route.pick.template}: its adaptation opens here with the Sync grid (#515).`}</p>
          )}
          {sync.projects.map((p) => (
            <p key={p.projectId} className="ip-lib-sync">
              <span className="ip-lib-sync-name">{p.name}</span>
              {p.check.ok ? (
                <span className="ip-lib-sync-state">{`${p.check.result.files.filter((f) => f.state === 'behind').length} of ${p.check.result.files.length} files behind`}</span>
              ) : (
                <span className="ip-lib-sync-state" data-alarm title={p.check.error}>
                  check failed
                </span>
              )}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
