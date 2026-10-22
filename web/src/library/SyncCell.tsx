import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cellState, rowSummary } from '../../../src/core/sync';
import type { DiffHunk, LibraryPages, LibrarySync, SyncCheck, SyncDiff, SyncFile, SyncRow } from '../../../src/core/types';
import { api } from '../api';
import { Button } from '../parts/Button';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { TabStrip } from '../parts/TabStrip';
import { dayMon, stateWords } from './SyncGrid';

const GROUP_LINES = 12;
const FILLS_SHOWN = 5;

type Tab = 'adaptation' | 'fills' | 'upstream';

interface Section {
  title: string | null;
  hunks: DiffHunk[];
}

/** Hunks under the heading they sit in: neighbours with one heading share a group. */
function bySection(hunks: DiffHunk[]): Section[] {
  const out: Section[] = [];
  for (const h of hunks) {
    const last = out[out.length - 1];
    if (last && last.title === h.section) last.hunks.push(h);
    else out.push({ title: h.section, hunks: [h] });
  }
  return out;
}

/** A section's lines, cut at 12 with the rest counted. */
function Hunks({ hunks, mark }: { hunks: DiffHunk[]; mark?: boolean }) {
  const sections = bySection(hunks);
  return (
    <div className="ip-sync-diff">
      {sections.map((s, i) => {
        const lines = s.hunks.flatMap((h) => h.lines);
        const hidden = Math.max(0, lines.length - GROUP_LINES);
        return (
          <div key={i} className="ip-sync-hunk" data-conflict={(mark && s.hunks.some((h) => h.conflict)) || undefined}>
            <div className="ip-sync-hh">
              <span>{s.title ?? 'Before the first heading'}</span>
              {mark && s.hunks.some((h) => h.conflict) && <span className="ip-sync-expect">expect a conflict</span>}
            </div>
            {lines.slice(0, GROUP_LINES).map((l, j) => (
              <div key={j} className="ip-sync-dl" data-kind={l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx'}>
                <span aria-hidden="true">{l.kind === '-' ? '−' : l.kind === '+' ? '+' : ' '}</span>
                <span>{l.text}</span>
              </div>
            ))}
            {hidden > 0 && <div className="ip-sync-dl" data-kind="gap">{`⋯ ${hidden} more lines`}</div>}
          </div>
        );
      })}
    </div>
  );
}

function FillsTable({ check, file }: { check: SyncCheck; file: SyncFile }) {
  const [all, setAll] = useState(false);
  const own = Object.entries(file.fills);
  const project = Object.entries(check.fills).filter(([k]) => !(k in file.fills));
  const shown = all ? project : project.slice(0, FILLS_SHOWN);
  if (own.length + project.length === 0) return <p className="ip-sync-lede">No fills recorded.</p>;
  const row = (k: string, scope: string, v: string) => (
    <tr key={`${scope}:${k}`}>
      <td className="ip-sync-fk">{k}</td>
      <td className="ip-sync-fs" data-file={scope === 'this file' || undefined}>
        {scope}
      </td>
      <td className="ip-sync-fv" title={v}>
        {v}
      </td>
    </tr>
  );
  return (
    <table className="ip-sync-fills">
      <thead>
        <tr>
          <th>Placeholder</th>
          <th>Scope</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {own.map(([k, v]) => row(k, 'this file', v))}
        {shown.map(([k, v]) => row(k, 'project', v))}
        {project.length > shown.length && (
          <tr>
            <td colSpan={3}>
              <button type="button" className="ip-sync-more" onClick={() => setAll(true)}>
                {`⋯ ${project.length - shown.length} more project fills`}
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

interface CellProps {
  sync: LibrarySync;
  pages: LibraryPages | null;
  row: SyncRow;
  /** Null: the open cell shows the failed row's error. */
  template: string | null;
  onClose: () => void;
  onOpenResource: (id: number) => void;
  onStatus: (message: string) => void;
}

/** The open cell, below the grid: the cell's state, then Adaptation, Fills and Upstream with the side panel's facts and links. */
export function SyncCell({ sync, pages, row, template, onClose, onOpenResource, onStatus }: CellProps) {
  const root = useRef<HTMLElement>(null);
  const panel = useId();
  const [tab, setTab] = useState<Tab>('adaptation');
  const [diff, setDiff] = useState<SyncDiff | null>(null);
  const check = row.check.ok ? row.check.result : null;
  const { state, file } = check && template ? cellState(check, template) : { state: 'error' as const, file: null };
  const diffable = !!check && !!template && file !== null;

  // The diff loads when the cell opens, and again each time the check does (Check now).
  useEffect(() => {
    setDiff(null);
    if (!diffable || !template) return;
    let live = true;
    void api.syncDiff(row.slug, template).then((d) => live && setDiff(d));
    return () => {
      live = false;
    };
  }, [row.slug, template, diffable, sync]);
  useEffect(() => {
    setTab('adaptation');
  }, [row.slug, template]);
  useEffect(() => {
    root.current?.scrollIntoView({ block: 'nearest' });
  }, [row.slug, template]);

  const keys = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // The window's own Escape (closing a sheet) must not also run.
    e.stopPropagation();
    onClose();
  };

  if (!check || !template) {
    return (
      <section ref={root} className="ip-sync-open" aria-label="Open cell" onKeyDown={keys} tabIndex={-1}>
        <div className="ip-sync-main">
          <Eyebrow glyph="[◈]">check failed</Eyebrow>
          <h2 className="ip-sync-title">{row.name}</h2>
          <ErrorLine message={<span className="ip-sync-stderr">{row.check.ok ? '' : row.check.error}</span>} />
        </div>
      </section>
    );
  }

  const summary = rowSummary(check);
  const adaptation = diff?.ok ? diff.adaptation : [];
  const added = adaptation.reduce((n, h) => n + h.added, 0);
  const removed = adaptation.reduce((n, h) => n + h.removed, 0);
  const commits = diff?.ok ? diff.commits : (file?.commits ?? []);
  const fillCount = file ? Object.keys(file.fills).length + Object.keys(check.fills).filter((k) => !(k in file.fills)).length : 0;
  const tabs: { id: Tab; label: string; count?: number }[] =
    state === 'skipped' || state === 'not-adopted'
      ? []
      : [
          { id: 'adaptation', label: diff?.ok ? `Adaptation +${added} −${removed}` : 'Adaptation' },
          { id: 'fills', label: 'Fills', count: fillCount },
          ...(state === 'current' ? [] : [{ id: 'upstream' as const, label: 'Upstream', count: commits.length }]),
        ];
  const shown = tabs.some((t) => t.id === tab) ? tab : 'adaptation';
  const page = pages?.pages.find((p) => p.templates.includes(template));
  const local = file?.local ?? '';
  const failed = diff && !diff.ok ? diff.error : null;

  return (
    <section ref={root} className="ip-sync-open" aria-label="Open cell" data-state={state} onKeyDown={keys} tabIndex={-1}>
      <div className="ip-sync-main">
        <div className="ip-sync-head">
          <Eyebrow glyph="[◈]">{state === 'skipped' ? `Skipped by ${row.name}` : stateWords(state, file?.behind ?? 0)}</Eyebrow>
          <h2 className="ip-sync-title">
            {row.name}
            <span className="ip-sync-x"> × </span>
            {template}
          </h2>
          <span className="ip-sync-path">
            {state === 'skipped'
              ? `in ${row.name}'s skip list: never synced`
              : state === 'not-adopted'
                ? `${row.name} has not adopted ${template}`
                : `template ${template} → ${row.name}/${local}`}
          </span>
        </div>
        {state === 'skipped' && <p className="ip-sync-lede">In the skip list: never synced.</p>}
        {state === 'not-adopted' && <p className="ip-sync-lede">Not adopted.</p>}
        {tabs.length > 0 && (
          <>
            <TabStrip label="Open cell" items={tabs.map((t) => ({ ...t, controls: panel }))} value={shown} onChange={(id) => setTab(id as Tab)} />
            <div id={panel} role="tabpanel" className="ip-sync-pane">
              {file?.detail && <p className="ip-sync-lede">{file.detail}</p>}
              {!diff && shown !== 'fills' && <p className="ip-sync-lede">Loading…</p>}
              {failed && shown !== 'fills' && <ErrorLine message={failed} />}
              {shown === 'adaptation' && diff?.ok && (
                <>
                  <p className="ip-sync-lede">{`${row.name}'s copy against the template at its base ${file?.base ?? 'none'}, filled with its fills. What is left is its own adaptation, grouped by the section it sits in.`}</p>
                  {adaptation.length === 0 ? <p className="ip-sync-lede">No local edits.</p> : <Hunks hunks={adaptation} />}
                </>
              )}
              {shown === 'fills' && file && <FillsTable check={check} file={file} />}
              {shown === 'upstream' && diff?.ok && (
                <>
                  {diff.commits.map((c) => (
                    <div key={c.sha} className="ip-sync-commit">
                      <span className="ip-sync-sha">{c.sha}</span>
                      <span className="ip-sync-subject">{c.subject}</span>
                      <span className="ip-sync-when">{dayMon(c.date)}</span>
                    </div>
                  ))}
                  {diff.upstream.length === 0 ? <p className="ip-sync-lede">Nothing upstream to merge.</p> : <Hunks hunks={diff.upstream} mark />}
                </>
              )}
            </div>
          </>
        )}
      </div>
      <aside className="ip-sync-side" aria-label="About this cell">
        <dl className="ip-sync-facts">
          <dt>Base</dt>
          <dd>{file?.base ?? 'none'}</dd>
          <dt>Shipwright</dt>
          <dd>{`${check.shipwright.head.slice(0, 7)} · ${dayMon(check.shipwright.date)}`}</dd>
          <dt>Behind</dt>
          <dd data-warn={(file?.behind ?? 0) > 0 || undefined}>{`${file?.behind ?? 0} ${file?.behind === 1 ? 'commit' : 'commits'}`}</dd>
          <dt>Synced in</dt>
          <dd>{summary.lastSync ? `${summary.lastSync.sha} · ${dayMon(summary.lastSync.date)}` : 'never'}</dd>
          <dt>Local edits</dt>
          <dd>{diff?.ok ? `${diff.adaptation.length} ${diff.adaptation.length === 1 ? 'hunk' : 'hunks'}` : diffable ? '…' : 'none'}</dd>
        </dl>
        <div className="ip-sync-links">
          <Eyebrow>Read more</Eyebrow>
          {page ? (
            <Button size="sm" glyph="›" onClick={() => onOpenResource(page.id)}>
              {page.title}
            </Button>
          ) : (
            <span className="ip-sync-none">No library page for this template.</span>
          )}
          {file && (
            <Button
              size="sm"
              variant="ghost"
              glyph="↗"
              onClick={() =>
                void api.openSyncCopy(row.slug, template).then((r) => {
                  if (r !== 'ok') onStatus(r === 'reload' ? "The window's key is out of date. Reload the page." : r);
                })
              }
            >
              {`Open ${row.name}'s copy`}
            </Button>
          )}
        </div>
      </aside>
    </section>
  );
}
