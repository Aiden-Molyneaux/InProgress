import { useEffect, useRef, useState } from 'react';
import type { AdaptRow, LibraryPage, SyncAdaptation } from '../../../src/core/types';
import { api } from '../api';
import { libraryHash } from '../library/route';
import { Hunks } from '../library/SyncCell';
import { Markdown } from '../panels/Markdown';
import { Button } from '../parts/Button';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { TabStrip } from '../parts/TabStrip';
import { adaptationName } from './adaptations';

type Tab = 'side' | 'diff';

/** A row of the table, or a run of untouched sections folded into one line. */
type Line = { kind: 'row'; row: AdaptRow } | { kind: 'fold'; at: number; rows: AdaptRow[] };

/** Untouched sections fold: each run of `same` rows is one line, open once clicked. */
function lines(rows: AdaptRow[], open: ReadonlySet<number>): Line[] {
  const out: Line[] = [];
  rows.forEach((row, i) => {
    const last = out[out.length - 1];
    if (row.tag !== 'same' || open.has(i)) return void out.push({ kind: 'row', row });
    if (last?.kind === 'fold' && last.at + last.rows.length === i) last.rows.push(row);
    else out.push({ kind: 'fold', at: i, rows: [row] });
  });
  return out;
}

/** A section's name as the Section column shows it: the text a lead leaves under its heading reads as the heading, continued. */
const sectionName = (row: AdaptRow): string => (row.level === -2 ? `${row.title} (continued)` : row.title.replace(/\s*\[edit\]\.?$/i, '').replace(/\.$/, ''));

const FENCE = /^\s*(```|~~~)/;

/**
 * Shipwright's text with its placeholders as code, so they read as chips the Markdown renderer already draws. Inside a fence or
 * a code span a placeholder is code already, and is left as it is.
 */
function withChips(text: string): string {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) fenced = !fenced;
      if (fenced || FENCE.test(line)) return line;
      // Odd parts of a split on backticks are code spans.
      return line
        .split('`')
        .map((part, i) => (i % 2 === 1 ? part : part.replace(/\{\{([A-Z0-9_]+)\}\}/g, '`{{$1}}`')))
        .join('`');
    })
    .join('\n');
}

/** A file's front matter as a YAML block, so Markdown does not draw it as a rule and a heading. */
const frontAsCode = (text: string): string => text.replace(/^---\n([\s\S]*?)\n---(?=\n|$)/, '```yaml\n---\n$1\n---\n```');

/** One cell's text: Markdown for a Markdown template, else the file as it is (a script, a settings file). */
function Cell({ text, markdown, chips, opening }: { text: string; markdown: boolean; chips?: boolean; opening: boolean }) {
  if (!markdown) return <pre className="ip-adapt-pre">{text}</pre>;
  // Only the Opening can start with front matter; anywhere else a `---` is a rule.
  const shown = opening ? frontAsCode(text) : text;
  return <Markdown text={chips ? withChips(shown) : shown} />;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One adaptation in a project's Docs view (spec "A project's Docs view"): its sections next to Shipwright's template, tagged
 * by what the project did, untouched ones folded, and the note where the next sync conflicts; Diff shows #515's hunks. Read
 * live each time it opens: an adaptation is derived, so it needs no confirming.
 */
export function AdaptationView({ slug, project, template, pages, onOpenResource, onEdits }: { slug: string; project: string; template: string; pages: LibraryPage[]; onOpenResource: (id: number) => void; onEdits: (template: string, edits: number) => void }) {
  const [answer, setAnswer] = useState<SyncAdaptation | null>(null);
  const [tab, setTab] = useState<Tab>('side');
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  // The section an opened fold hands focus to: the button that had it leaves with the fold.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const table = useRef<HTMLTableSectionElement>(null);
  // The latest callback, so a new one each render does not read the adaptation again.
  const told = useRef(onEdits);
  told.current = onEdits;

  useEffect(() => {
    let live = true;
    void api.syncAdaptation(slug, template).then((a) => {
      if (!live) return;
      setAnswer(a);
      if (a.ok) told.current(template, a.adaptation.length);
    });
    return () => {
      live = false;
    };
  }, [slug, template]);

  useEffect(() => {
    // The Opening's key is '', so only null means nothing to focus.
    if (focusKey === null) return;
    table.current?.querySelector<HTMLElement>(`th[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const markdown = /\.(md|markdown)$/i.test(template);
  const page = pages.find((p) => p.templates.includes(template));
  const sync = libraryHash({ shelf: 'sync', pick: { slug, template } });
  const ok = answer?.ok ? answer : null;
  const conflictAt = ok ? (ok.commits[0]?.sha ?? ok.head).slice(0, 7) : '';

  return (
    <section className="ip-adapt" aria-label={`${adaptationName(template)} in ${project}`}>
      <header className="ip-adapt-head">
        <div className="ip-vtitle-block">
          <Eyebrow>{`Adaptation · ${template}`}</Eyebrow>
          <h2 className="ip-vtitle">{`${adaptationName(template)} in ${project}`}</h2>
        </div>
        <div className="ip-vact">
          <TabStrip
            variant="segmented"
            label="Adaptation view"
            items={[
              { id: 'side', label: 'Side by side' },
              { id: 'diff', label: 'Diff' },
            ]}
            value={tab}
            onChange={(id) => setTab(id as Tab)}
          />
          {page && (
            <Button variant="outline" size="sm" onClick={() => onOpenResource(page.id)}>
              Shipwright page ›
            </Button>
          )}
          {/* A link drawn as the outline button beside it (Button has no link mode); ip-adapt-link is the tests' hook. */}
          <a className="p-btn ip-adapt-link" data-variant="outline" data-size="sm" href={sync}>
            Sync cell ›
          </a>
        </div>
      </header>
      {ok && (
        <div className="ip-adapt-strip">
          <span>{`computed live from ${project}'s copy, its manifest and Shipwright at base ${ok.base.slice(0, 7)}`}</span>
          {ok.state === 'behind' && ok.behind > 0 && (
            <span className="ip-docs-warn">{`Shipwright is ${plural(ok.behind, 'commit')} ahead: ${ok.commits.map((c) => c.sha.slice(0, 7)).join(', ') || ok.head.slice(0, 7)}`}</span>
          )}
        </div>
      )}
      <div className="ip-adapt-body">
        {!answer ? (
          <p className="ip-vmuted">Loading…</p>
        ) : !answer.ok ? (
          <ErrorLine message={answer.error} />
        ) : tab === 'diff' ? (
          answer.adaptation.length === 0 ? <p className="ip-vmuted">No local edits.</p> : <Hunks hunks={answer.adaptation} limit={Infinity} />
        ) : (
          <table className="ip-adapt-table">
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">Shipwright · template</th>
                <th scope="col">{project}</th>
              </tr>
            </thead>
            <tbody ref={table}>
              {lines(answer.rows, open).map((line) =>
                line.kind === 'fold' ? (
                  <tr key={`fold-${line.at}`} className="ip-adapt-fold">
                    <td colSpan={3}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpen((now) => new Set([...now, ...line.rows.map((_, j) => line.at + j)]));
                          setFocusKey(line.rows[0].key);
                        }}
                      >
                        {`${plural(line.rows.length, 'section')} ${project} left alone: ${line.rows.map(sectionName).join(', ')}`}
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={line.row.key} data-tag={line.row.tag}>
                    <th scope="row" tabIndex={-1} data-key={line.row.key} data-continued={line.row.level === -2 || undefined}>
                      {sectionName(line.row)}
                    </th>
                    <td>{line.row.template === null ? <p className="ip-vmuted">Not in the template.</p> : <Cell text={line.row.template} markdown={markdown} chips opening={line.row.level === -1} />}</td>
                    <td>
                      {line.row.tag !== 'same' && <span className="ip-adapt-tag">{line.row.tag}</span>}
                      {line.row.project === null ? <p className="ip-vmuted">{`Removed in ${project}.`}</p> : <Cell text={line.row.project} markdown={markdown} opening={line.row.level === -1} />}
                      {line.row.conflict && <p className="ip-adapt-conflict">{`Shipwright changed this section in ${conflictAt}. The next sync conflicts here.`}</p>}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
