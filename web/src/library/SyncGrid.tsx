import { useEffect, useRef, useState } from 'react';
import { cellState, groupTemplates, rowSummary, type CellState } from '../../../src/core/sync';
import type { LibrarySync, SyncCheck, SyncRow } from '../../../src/core/types';
import { api } from '../api';
import { Button } from '../parts/Button';
import { Eyebrow } from '../parts/Eyebrow';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-18" as "18 Oct"; anything else as it came. */
export function dayMon(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}` : iso;
}

/** A column's short name: the file name, or the folder for a SKILL.md. */
export function shortName(template: string): { name: string; ext: string } {
  const parts = template.split('/');
  const file = parts[parts.length - 1];
  if (file === 'SKILL.md' && parts.length > 1) return { name: parts[parts.length - 2], ext: '' };
  const dot = file.lastIndexOf('.');
  return dot > 0 ? { name: file.slice(0, dot), ext: file.slice(dot) } : { name: file, ext: '' };
}

/** What a cell says in words, for its accessible name and the open cell's eyebrow. */
export function stateWords(state: CellState, behind: number): string {
  if (state === 'behind') return `${behind} ${behind === 1 ? 'commit' : 'commits'} behind`;
  if (state === 'not-adopted') return 'not adopted';
  return state;
}

/** The look a state takes: missing, gone and error share pending's. */
export const CELL_LOOK: Record<CellState, string> = { current: 'cur', behind: 'beh', pending: 'pen', missing: 'pen', gone: 'pen', error: 'pen', skipped: 'skp', 'not-adopted': 'nad' };

/** The templates to draw as columns: Shipwright's list, else (no list readable) whatever the checks mention. */
export function columnsOf(sync: LibrarySync): string[] {
  if (sync.templates.length > 0) return sync.templates;
  const seen = new Set<string>();
  for (const p of sync.projects) if (p.check.ok) for (const f of p.check.result.files) seen.add(f.template);
  return [...seen];
}

const LEGEND: { look: string; text: string; mark?: string }[] = [
  { look: 'cur', text: 'Current' },
  { look: 'beh', text: 'Commits behind', mark: '1' },
  { look: 'pen', text: 'Pending (conflict or new fill)', mark: '!' },
  { look: 'skp', text: 'Skipped by the project' },
  { look: 'nad', text: 'Not adopted, not skipped' },
];

export function SyncLegend() {
  return (
    <ul className="ip-sync-legend" aria-label="Cell states">
      {LEGEND.map((l) => (
        <li key={l.look}>
          <span className="ip-sync-cell ip-sync-sw" data-state={l.look} aria-hidden="true">
            {l.mark}
          </span>
          {l.text}
        </li>
      ))}
    </ul>
  );
}

interface GridProps {
  sync: LibrarySync;
  pick: { slug: string; template: string } | null;
  /** The failed row whose error the open cell shows. */
  errorSlug: string | null;
  onPick: (slug: string, template: string) => void;
  onError: (slug: string) => void;
  onOpenStep: (slug: string, id: number) => void;
  /** Said under the grid; null clears it. */
  onFail: (message: string | null) => void;
  /** A plain load of the sync, so every row and the sentence agree with a step just filed. */
  onReload: () => void;
  setGridRef: (el: HTMLDivElement | null) => void;
}

function Summary({ check }: { check: SyncCheck }) {
  const s = rowSummary(check);
  return (
    <td className="ip-sync-sum">
      <span className="ip-sync-big" data-ok={s.behind === 0 || undefined}>
        {s.behind}
      </span>{' '}
      <span className="ip-sync-of">{`of ${s.adopted}`}</span>
      <span className="ip-sync-sub">{`base ${s.base ?? 'none'} · ${s.lastSync ? `synced ${dayMon(s.lastSync.date)}` : 'never synced'}`}</span>
    </td>
  );
}

/** The grid: a row per project with a manifest, a column per template grouped as Shipwright groups them. */
export function SyncGrid({ sync, pick, errorSlug, onPick, onError, onOpenStep, onFail, onReload, setGridRef }: GridProps) {
  const groups = groupTemplates(columnsOf(sync));
  const columns = groups.flatMap((g) => g.templates);
  const [filing, setFiling] = useState<Set<string>>(new Set());
  const [filed, setFiled] = useState<Record<string, { id: number; title: string }>>({});
  // The step links by project, and the ones whose button just turned into one: the link takes focus where the button was.
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const focusLink = useRef(new Set<string>());
  useEffect(() => {
    for (const slug of [...focusLink.current]) {
      const link = links.current.get(slug);
      if (!link) continue;
      focusLink.current.delete(slug);
      link.focus();
    }
  });
  // A sync that lands is the server's word on every row's step: what the click answered is dropped, so a step done elsewhere shows File sync step again.
  useEffect(() => setFiled({}), [sync]);
  const file = async (row: SyncRow) => {
    setFiling((s) => new Set(s).add(row.slug));
    onFail(null);
    const answer = await api.addSyncStep(row.slug);
    setFiling((s) => {
      const next = new Set(s);
      next.delete(row.slug);
      return next;
    });
    if ('error' in answer) {
      onFail(answer.error);
      return;
    }
    focusLink.current.add(row.slug);
    setFiled((f) => ({ ...f, [row.slug]: answer.step }));
    onReload();
  };
  const first = new Set(groups.map((g) => g.templates[0]));
  return (
    <div className="ip-sync-wrap" ref={setGridRef} tabIndex={-1}>
      <table className="ip-sync" aria-label="Templates by project">
        <thead>
          <tr className="ip-sync-groups">
            <th className="ip-sync-proj" />
            {groups.map((g) => (
              <th key={g.group} colSpan={g.templates.length} className="ip-sync-first">
                <Eyebrow>{g.group}</Eyebrow>
              </th>
            ))}
            <th className="ip-sync-first" />
            <th />
          </tr>
          <tr>
            <th className="ip-sync-proj" scope="col">
              <Eyebrow>Project</Eyebrow>
            </th>
            {columns.map((t) => {
              const n = shortName(t);
              return (
                <th key={t} scope="col" className="ip-sync-tpl" data-first={first.has(t) || undefined} title={t}>
                  <div>
                    {n.name}
                    {n.ext && <i>{n.ext}</i>}
                  </div>
                </th>
              );
            })}
            <th scope="col" className="ip-sync-proj ip-sync-first">
              <Eyebrow>Behind · base · last sync</Eyebrow>
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sync.projects.map((row) => {
            const step = filed[row.slug] ?? row.syncStep;
            const behind = row.check.ok && row.check.result.files.some((f) => f.state === 'behind');
            return (
              <tr key={row.projectId} data-project={row.slug}>
                <th scope="row" className="ip-sync-proj ip-sync-name">
                  {row.check.ok ? (
                    row.name
                  ) : (
                    <button type="button" className="ip-sync-namebtn" data-cell={`${row.slug}|`} aria-pressed={errorSlug === row.slug} onClick={() => onError(row.slug)}>
                      {row.name}
                    </button>
                  )}
                </th>
                {columns.map((t) => {
                  if (!row.check.ok) return <td key={t} data-first={first.has(t) || undefined} />;
                  const { state, file: f } = cellState(row.check.result, t);
                  const n = f?.behind ?? 0;
                  return (
                    <td key={t} data-first={first.has(t) || undefined}>
                      <button
                        type="button"
                        className="ip-sync-cell"
                        data-state={CELL_LOOK[state]}
                        data-cell={`${row.slug}|${t}`}
                        aria-label={`${row.name} × ${t}, ${stateWords(state, n)}`}
                        aria-pressed={pick?.slug === row.slug && pick.template === t}
                        onClick={() => onPick(row.slug, t)}
                      >
                        {state === 'behind' ? n : CELL_LOOK[state] === 'pen' ? '!' : null}
                      </button>
                    </td>
                  );
                })}
                {row.check.ok ? (
                  <Summary check={row.check.result} />
                ) : (
                  <td className="ip-sync-sum">
                    <span className="ip-sync-failed" title={row.check.error}>
                      check failed
                    </span>
                  </td>
                )}
                <td className="ip-sync-act">
                  {step ? (
                    <a
                      ref={(el) => {
                        if (el) links.current.set(row.slug, el);
                        else links.current.delete(row.slug);
                      }}
                      className="p-btn"
                      data-size="sm"
                      href={`#${step.id}`}
                      title={step.title}
                      onClick={(e) => {
                        e.preventDefault();
                        onOpenStep(row.slug, step.id);
                      }}
                    >
                      {`#${step.id} sync step ›`}
                    </a>
                  ) : (
                    behind && (
                      <Button size="sm" busy={filing.has(row.slug)} onClick={() => void file(row)}>
                        File sync step
                      </Button>
                    )
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
