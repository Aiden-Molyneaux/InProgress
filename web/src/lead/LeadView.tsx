import type { Project } from '../../../src/core/types';
import { PageHead } from '../page/PageHead';
import { EmptyState } from '../parts/EmptyState';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { LEAD_MANDATE } from '../../../src/core/lead-mandate';
import { NO_LEAD, deskDecided, deskGroups, deskHead, logLines, type DeskRow } from './leadDesk';
import type { LeadDesk } from './useLeadDesk';

interface Props {
  project: Pick<Project, 'id' | 'name' | 'slug'>;
  /** The project's code, as the rail shows it: the head reads `<code>-LED`. */
  code: string;
  desk: LeadDesk;
  now: number;
  onOpenNode: (id: number) => void;
}

/** A row's text, detail and meta: a button when it names a step. */
function Row({ row, onOpenNode }: { row: DeskRow; onOpenNode: (id: number) => void }) {
  const inner = (
    <>
      <span className="ip-lead-text">{row.text}</span>
      {row.detail && <span className="ip-lead-detail">{row.detail}</span>}
      {(row.meta || row.overdue) && (
        <span className="ip-lead-meta" data-overdue={row.overdue || undefined}>
          {[row.meta, row.overdue ? 'overdue' : null].filter(Boolean).join(' · ')}
        </span>
      )}
    </>
  );
  return (
    <li className="ip-lead-row">
      {row.nodeId !== undefined ? (
        <button type="button" className="ip-lead-open" data-node={row.nodeId} data-cursor="" onClick={() => onOpenNode(row.nodeId!)}>
          {inner}
        </button>
      ) : (
        <div className="ip-lead-open">{inner}</div>
      )}
    </li>
  );
}

/**
 * A project's Lead view (#728): the lead's brief regrouped for a human, needs you first, at the left, and the lead's log at
 * the right. Every word and grouping rule is in leadDesk.ts; this only lays out what it returns.
 */
export function LeadView({ project, code, desk, now, onOpenNode }: Props) {
  const { brief, events, error } = desk;
  const head = brief ? deskHead(brief, now) : null;
  const groups = brief ? deskGroups(brief, now) : [];
  const decided = brief ? deskDecided(brief, now) : [];
  const lines = events ? logLines(events) : null;
  return (
    <div className="ip-page ip-lead-page">
      <PageHead code={`${code}-LED`} name="LEAD" decodeKey={project.id} />
      {error && <ErrorLine message={error} />}
      {!brief || !head ? (
        !error && <EmptyState>Loading…</EmptyState>
      ) : (
        <>
          <div className="ip-lead-head">
            <p className="ip-lead-who">{head.lead === null ? NO_LEAD : `${head.lead} · instructions v${head.instructions}`}</p>
            <p className="ip-lead-line">{`Goal: ${head.goal}`}</p>
            <p className="ip-lead-line">{`Phase: ${head.phase}`}</p>
            {head.intentLine !== null && <p className="ip-lead-line">{head.intentLine}</p>}
            {head.intentText !== '' && (
              <details className="ip-lead-intent">
                <summary>The whole intent record</summary>
                <pre>{head.intentText}</pre>
              </details>
            )}
            <details className="ip-lead-intent">
              <summary>The mandate, as the lead reads it</summary>
              <pre>{LEAD_MANDATE.join('\n')}</pre>
            </details>
            {head.warning &&<p className="ip-lead-warn">{head.warning}</p>}
          </div>
          <div className="ip-lead-cols">
            <div className="ip-lead-desk">
              {groups.map((g) => (
                <section key={g.id} className="ip-lead-sec" aria-label={g.title} data-group={g.id}>
                  <div className="ip-lead-sechead">
                    <Eyebrow as="h2">{g.title}</Eyebrow>
                    <span className="ip-lead-count">{g.count}</span>
                  </div>
                  {g.note && <p className="ip-lead-note">{g.note}</p>}
                  {g.rows.length === 0 ? (
                    <p className="ip-lead-none">none</p>
                  ) : (
                    <ul className="ip-lead-list">
                      {g.rows.map((r) => (
                        <Row key={r.key} row={r} onOpenNode={onOpenNode} />
                      ))}
                    </ul>
                  )}
                </section>
              ))}
              <section className="ip-lead-sec" aria-label="Decided for you">
                <div className="ip-lead-sechead">
                  <Eyebrow as="h2">Decided for you</Eyebrow>
                  <span className="ip-lead-count">{decided.length}</span>
                </div>
                {decided.length === 0 ? (
                  <p className="ip-lead-none">Nothing decided for you in the last 7 days.</p>
                ) : (
                  <ul className="ip-lead-list">
                    {decided.map((d) => (
                      <li key={d.key} className="ip-lead-row">
                        <div className="ip-lead-open">
                          <span className="ip-lead-text">{d.line}</span>
                          {d.why && <span className="ip-lead-detail">{`Why: ${d.why}`}</span>}
                          <span className="ip-lead-meta">{d.age}</span>
                          {d.undo && <span className="ip-lead-meta">{d.undo}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <p className="ip-lead-links">{`Links: ${head.links}`}</p>
            </div>
            <section className="ip-lead-sec ip-lead-log" aria-label="Log">
              <div className="ip-lead-sechead">
                <Eyebrow as="h2">Log</Eyebrow>
              </div>
              {!lines || lines.length === 0 ? (
                <p className="ip-lead-none">none</p>
              ) : (
                <ul className="ip-lead-list">
                  {lines.map((l) => (
                    <li key={l.key} className="ip-lead-row">
                      <div className="ip-lead-open">
                        <span className="ip-lead-meta">{`${l.at} · ${l.kind}${l.ref ? ` ${l.ref}` : ''}`}</span>
                        {l.text && <span className="ip-lead-text">{l.text}</span>}
                        {l.words && <span className="ip-lead-detail">{`"${l.words}"`}</span>}
                        <span className="ip-lead-meta">{l.by}</span>
                        {l.nodeId !== undefined && (
                          <button type="button" className="ip-lead-step" data-node={l.nodeId} data-cursor="" onClick={() => onOpenNode(l.nodeId!)}>
                            {`Open #${l.nodeId}`}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
