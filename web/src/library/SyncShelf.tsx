import { useEffect, useRef, useState } from 'react';
import { syncSentence } from '../../../src/core/sync';
import { PageHead } from '../page/PageHead';
import { CommsSlab } from '../page/CommsSlab';
import { Button } from '../parts/Button';
import { EmptyState } from '../parts/EmptyState';
import { ErrorLine } from '../parts/ErrorLine';
import type { LibraryRoute } from './route';
import { SyncCell } from './SyncCell';
import { dayMon, SyncGrid, SyncLegend } from './SyncGrid';
import type { LibraryData } from './useLibrary';

interface Props {
  route: LibraryRoute;
  lib: LibraryData;
  /** Opens a cell (or, with null, closes it): the route changes, focus stays where it is. */
  onPick: (pick: { slug: string; template: string } | null) => void;
  /** A project's step, the way the Go to field opens one. */
  onOpenStep: (slug: string, id: number) => void;
  onOpenResource: (id: number) => void;
  /** A message for the status line. */
  onStatus: (message: string) => void;
}

/** Sync: Shipwright's templates against every project with a manifest, one cell each, and the open cell below. */
export function SyncShelf({ route, lib, onPick, onOpenStep, onOpenResource, onStatus }: Props) {
  const { sync, syncError: error } = lib;
  const [errorSlug, setErrorSlug] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  // The cell that was open when Escape closed it: focus goes back to its button once the route has changed.
  const returnTo = useRef<string | null>(null);
  const pick = route.pick;
  useEffect(() => {
    if (pick || errorSlug || !returnTo.current) return;
    const key = returnTo.current;
    returnTo.current = null;
    const buttons = [...(grid.current?.querySelectorAll<HTMLElement>('[data-cell]') ?? [])];
    // The cell's button; else its row's name button (a failed row has no cells); else the grid itself.
    (buttons.find((el) => el.dataset.cell === key) ?? buttons.find((el) => el.dataset.cell === `${key.split('|')[0]}|`) ?? grid.current)?.focus();
  }, [pick, errorSlug]);

  const head = sync?.projects.map((p) => (p.check.ok ? p.check.result : null)).find((c) => c !== null);
  const behind = sync ? sync.projects.filter((p) => p.check.ok && p.check.result.files.some((f) => f.state === 'behind')).length : 0;
  const row = sync && (pick ? sync.projects.find((p) => p.slug === pick.slug) : errorSlug ? sync.projects.find((p) => p.slug === errorSlug && !p.check.ok) : undefined);

  const close = () => {
    if (pick) returnTo.current = `${pick.slug}|${pick.template}`;
    else if (errorSlug) returnTo.current = `${errorSlug}|`;
    setErrorSlug(null);
    onPick(null);
  };

  return (
    <div className="ip-page ip-lib-page">
      <PageHead code="SYN" name="SYNC" decodeKey={-3} meta={sync && sync.projects.length > 0 ? [{ value: behind, label: `OF ${sync.projects.length} BEHIND` }] : undefined}>
        {head && (
          <span className="ip-lib-sha" title={head.shipwright.subject}>
            {`SHIPWRIGHT · ${dayMon(head.shipwright.date)}`}
          </span>
        )}
      </PageHead>
      {error && <ErrorLine message={error} />}
      {!sync ? (
        !error && <EmptyState>Loading…</EmptyState>
      ) : sync.projects.length === 0 ? (
        <EmptyState>No project has a .claude/shipwright.json yet.</EmptyState>
      ) : (
        <>
          <CommsSlab
            age={null}
            source={{ word: 'SYNC', label: 'Sync status' }}
            actions={
              <Button size="sm" busy={lib.checking} onClick={lib.checkNow}>
                Check now
              </Button>
            }
          >
            {syncSentence(sync.projects)}
          </CommsSlab>
          <SyncLegend />
          <SyncGrid
            sync={sync}
            pick={pick}
            errorSlug={errorSlug}
            setGridRef={(el) => {
              grid.current = el;
            }}
            onPick={(slug, template) => {
              setErrorSlug(null);
              onPick({ slug, template });
            }}
            onError={(slug) => {
              onPick(null);
              setErrorSlug(slug);
            }}
            onOpenStep={onOpenStep}
            onFail={setStepError}
            onReload={lib.reload}
          />
          {stepError && <ErrorLine message={stepError} />}
          {row ? (
            <SyncCell sync={sync} pages={lib.pages} row={row} template={row.check.ok && pick ? pick.template : null} onClose={close} onOpenResource={onOpenResource} onStatus={onStatus} />
          ) : (
            pick && <EmptyState>{`${pick.slug} has no sync manifest.`}</EmptyState>
          )}
        </>
      )}
    </div>
  );
}
