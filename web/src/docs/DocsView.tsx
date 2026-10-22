import { useState } from 'react';
import type { LibraryPage, SyncRow } from '../../../src/core/types';
import { pageStale } from '../chrome/railLogic';
import { PageRow } from '../library/PagesShelf';
import { PageHead } from '../page/PageHead';
import { ResourceViewer } from '../panels/ResourceViewer';
import { EmptyState } from '../parts/EmptyState';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { adaptationName, adaptationRow } from './adaptations';
import type { ProjectDocs } from './useProjectDocs';

/** What the index has picked: a page (a resource id) or an adaptation (a template path). */
type Picked = { kind: 'page'; id: number } | { kind: 'adaptation'; template: string };

interface Props {
  project: { id: number; name: string };
  /** The project's code, as the rail shows it: the head reads `<code>-DOC`. */
  code: string;
  docs: ProjectDocs;
  /** The project's row in the Library's sync check; null with no manifest or before the check has landed. */
  sync: SyncRow | null;
  /** Whether the Library's sync check has landed: before it, no row does not yet mean no manifest. */
  syncLoaded: boolean;
  syncError: string | null;
}

/**
 * A project's Docs view (#530): the index of its own pages and of its adaptations of Shipwright's templates on the left, the
 * pick on the right. The pick is the view's own state: the window mounts it per project, so a switch starts with none.
 */
export function DocsView({ project, code, docs, sync, syncLoaded, syncError }: Props) {
  const [pick, setPick] = useState<Picked | null>(null);
  const pages: LibraryPage[] = docs.pages ?? [];
  const stale = pages.filter(pageStale).length;
  const check = sync && sync.check.ok ? sync.check.result : null;
  const behind = check ? check.files.filter((f) => f.state === 'behind').length : 0;
  const picked = pick?.kind === 'adaptation' ? pick.template : null;
  return (
    <div className="ip-page ip-docs-page">
      <PageHead code={`${code}-DOC`} name="DOCS" decodeKey={project.id}>
        {docs.pages && (
          <p className="ip-page-meta ip-docs-meta">
            <span>{`${pages.length} ${pages.length === 1 ? 'PAGE' : 'PAGES'}`}</span>
            {stale > 0 ? (
              <>
                <span className="ip-page-sep"> · </span>
                <span className="ip-docs-warn">{`${stale} STALE`}</span>
              </>
            ) : check ? (
              <>
                <span className="ip-page-sep"> · </span>
                <span>{`${check.files.length} ${check.files.length === 1 ? 'ADAPTATION' : 'ADAPTATIONS'}`}</span>
                {behind > 0 && (
                  <>
                    <span className="ip-page-sep"> · </span>
                    <span className="ip-docs-warn">{`${behind} BEHIND`}</span>
                  </>
                )}
              </>
            ) : null}
            {pages.length > 0 && docs.root && (
              <>
                <span className="ip-page-sep"> · </span>
                <span>READ LIVE FROM <span className="ip-docs-root">{docs.root}</span></span>
              </>
            )}
          </p>
        )}
      </PageHead>
      {docs.error && <ErrorLine message={docs.error} />}
      <div className="ip-docs-cols">
        <div className="ip-docs-index">
          <section className="ip-docs-sec" aria-label="Pages">
            <div className="ip-docs-sechead">
              <Eyebrow as="h2">Pages</Eyebrow>
              <span className="ip-docs-note">{`${project.name}'s repo`}</span>
            </div>
            {!docs.pages ? (
              !docs.error && <EmptyState>Loading…</EmptyState>
            ) : pages.length === 0 ? (
              <EmptyState>No pages yet.</EmptyState>
            ) : (
              <ul className="ip-lib-list">
                {pages.map((p) => (
                  <PageRow key={p.id} page={p} picked={pick?.kind === 'page' && pick.id === p.id} onOpen={() => setPick({ kind: 'page', id: p.id })} />
                ))}
              </ul>
            )}
          </section>
          <section className="ip-docs-sec" aria-label="Adaptations">
            <div className="ip-docs-sechead">
              <Eyebrow as="h2">Adaptations</Eyebrow>
              <span className="ip-docs-note">from its manifest</span>
            </div>
            {/* A later check that failed keeps the last rows: they show under its error. */}
            {syncLoaded && syncError && <ErrorLine message={syncError} />}
            {!syncLoaded ? (
              syncError ? <ErrorLine message={syncError} /> : <EmptyState>Checking…</EmptyState>
            ) : sync && !sync.check.ok ? (
              <ErrorLine message={sync.check.error} />
            ) : check ? (
              <ul className="ip-lib-list">
                {check.files.map((f) => {
                  const row = adaptationRow(f);
                  return (
                    <li key={f.template} className="ip-lib-row" data-picked={picked === f.template || undefined}>
                      <div className="ip-lib-line">
                        <span className="ip-docs-kind">{row.kind}</span>
                        <button type="button" className="ip-lib-open" aria-current={picked === f.template || undefined} title={f.template} onClick={() => setPick({ kind: 'adaptation', template: f.template })}>
                          {row.name}
                        </button>
                        <span className="ip-lib-path">{row.fills}</span>
                        <span className="ip-docs-state" data-tone={row.state.tone}>
                          {row.state.text}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="ip-docs-none">
                {`${project.name} keeps no .claude/shipwright.json yet. Once it adopts Shipwright's templates, each one is listed here with ${project.name}'s changes to it. `}
                <a href="#/lib/sync">Library · Sync ›</a>
              </p>
            )}
          </section>
        </div>
        <div className="ip-docs-pane">
          {pick === null ? (
            <p className="ip-docs-pick">Pick a page or an adaptation.</p>
          ) : pick.kind === 'page' ? (
            <ResourceViewer key={pick.id} resourceId={pick.id} inline onConfirmed={docs.reload} />
          ) : (
            // Part B (the side by side, from the sync diff) takes this place.
            <p className="ip-docs-pick">{`The side by side for ${adaptationName(pick.template)} (${pick.template}) is not built yet.`}</p>
          )}
        </div>
      </div>
    </div>
  );
}
