import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { LABEL_GLYPHS, NODE_LABELS, type NodeLabel, type ResourceMeta, type TreeNode } from '../../../src/core/types';
import type { BacklogBand } from '../../../src/core/backlog';
import type { UiResult } from '../api';
import { ageShort } from '../board/text';
import { shortDate } from '../done/doneGroups';
import { noteAction } from '../measure';
import { Markdown } from '../panels/Markdown';
import { Button } from '../parts/Button';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { DocsMenu } from '../project/DocsMenu';

type Sel = 'phase' | 'label' | 'band';

/**
 * A Backlog row's inspector, drawn under the row in `ViewRow`'s `children`: the step's body, a facts line, the Phase, Label
 * and Band selects (each saves on change) and a column of buttons. The caller decides which buttons show (`can`) and what
 * each does; a Park form or a Delete confirm it passes as `panel` takes the button column's place.
 */
export function Inspector({ id, node, inside, band, parked, handoff, docs, lastSession, phases, phase, can, panel, now, onBand, onPhase, onLabel, onToNext, onBackToBacklog, onMoveTop, onKeep, onPark, onDelete, onOpenDetails, onUnpark, onOpenResource, focusBand }: {
  id: number;
  node: TreeNode;
  /** Open steps under it (openInsideIndex). */
  inside: number;
  /** The row's band as drawn: 'next' for a queued row, a band, or null (Needs Triage). */
  band: BacklogBand | null;
  /** A parked row: no selects. */
  parked?: boolean;
  /** From the Board row: its handoff resource, or null. */
  handoff: ResourceMeta | null;
  /** The step's resources (snapshot.resources with nodeId === id). */
  docs: ResourceMeta[];
  /** When a session last had it as focus, or null. */
  lastSession: string | null;
  phases: { value: number | null; label: string }[];
  /** The current parent as phaseValue maps it (null: No phase). */
  phase: number | null;
  /** Which buttons show (the caller works these out). */
  can: { toNext: boolean; backToBacklog: boolean; moveTop: boolean; keep: boolean; park: boolean; remove: boolean; unpark: boolean };
  /** The Park form or the Delete confirm, when one is open: drawn in place of the button column. */
  panel: ReactNode;
  now: number;
  /** The select writes; each resolves to the UiResult. */
  onBand: (band: 'next' | 'soon' | 'someday') => Promise<UiResult>;
  onPhase: (parent: number | null) => Promise<UiResult>;
  onLabel: (label: NodeLabel | null) => Promise<UiResult>;
  /** The buttons; each gets the element pressed. */
  onToNext: (from: HTMLElement) => void;
  onBackToBacklog: (from: HTMLElement) => void;
  onMoveTop: (from: HTMLElement) => void;
  onKeep: (from: HTMLElement) => void;
  onPark: (from: HTMLElement) => void;
  onDelete: (from: HTMLElement) => void;
  onOpenDetails: (from: HTMLElement) => void;
  onUnpark: (toNext: boolean, from: HTMLElement) => void;
  onOpenResource: (id: number) => void;
  /** Focus the Band select on mount (Needs Triage). */
  focusBand?: boolean;
}) {
  const [pending, setPending] = useState<Partial<Record<Sel, string>>>({});
  const [busy, setBusy] = useState<Partial<Record<Sel, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const bandSelect = useRef<HTMLSelectElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const timers = useRef<Partial<Record<Sel, number>>>({});
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = node.body.trim();

  // The body is cut at six lines by CSS; the button shows only when the cut hides something. Measured clamped, so an
  // expanded body keeps its button (as "Show less").
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || expanded) return;
    setOverflows(el.scrollHeight > el.clientHeight);
  }, [node.body, expanded]);
  useEffect(() => {
    if (focusBand) bandSelect.current?.focus();
  }, []);
  useEffect(() => () => {
    for (const t of Object.values(timers.current)) window.clearTimeout(t);
  }, []);

  const current: Record<Sel, string> = {
    phase: String(phase ?? 'none'),
    label: node.label ?? 'none',
    band: band ?? '',
  };
  // The snapshot that shows the new value ends the wait.
  useEffect(() => {
    setPending((p) => {
      const settled = (Object.keys(p) as Sel[]).filter((k) => p[k] === current[k] && !busy[k]);
      if (settled.length === 0) return p;
      const next = { ...p };
      for (const k of settled) delete next[k];
      return next;
    });
  }, [current.phase, current.label, current.band, busy]);

  const change = (sel: Sel, value: string, write: () => Promise<UiResult>) => {
    if (busy[sel]) return;
    window.clearTimeout(timers.current[sel]);
    setPending((p) => ({ ...p, [sel]: value }));
    setBusy((b) => ({ ...b, [sel]: true }));
    setError(null);
    void write().then((result) => {
      setBusy((b) => ({ ...b, [sel]: false }));
      if (result === 'ok') {
        // The snapshot normally brings the value first; a write that changed nothing sends none.
        timers.current[sel] = window.setTimeout(() => setPending((p) => {
          const next = { ...p };
          delete next[sel];
          return next;
        }), 2000);
        return;
      }
      setPending((p) => {
        const next = { ...p };
        delete next[sel];
        return next;
      });
      if (result !== 'reload') setError(result);
    });
  };
  const value = (sel: Sel) => pending[sel] ?? current[sel];

  const facts: ReactNode[] = [
    <span key="created">{`CREATED ${shortDate(node.createdAt, now).toUpperCase()}`}</span>,
    <span key="session">{lastSession ? `LAST SESSION ${ageShort(lastSession, now).toUpperCase()} AGO` : 'NO SESSION YET'}</span>,
  ];
  if (docs.length > 0) facts.push(<DocsMenu key="docs" docs={docs} label={`#${id}`} onOpenResource={onOpenResource} />);
  if (handoff) {
    facts.push(
      <button
        key="handoff"
        type="button"
        className="ip-chip-handoff"
        data-act
        onClick={(e) => {
          e.stopPropagation();
          noteAction('backlog', 'open_handoff');
          onOpenResource(handoff.id);
        }}
      >
        {`handoff · ${ageShort(handoff.createdAt, now)}`}
      </button>,
    );
  }
  if (inside > 0) facts.push(<span key="inside">{`${inside} OPEN INSIDE`}</span>);

  const select = (sel: Sel, label: string, options: ReactNode, onChange: (v: string) => void) => (
    <label className="ip-insp-sel p-field" data-size="sm">
      <Eyebrow>{label}</Eyebrow>
      <span className="p-field-box">
        <select
          ref={sel === 'band' ? bandSelect : undefined}
          className={`p-field-input${busy[sel] ? ' busy' : ''}`}
          aria-label={label}
          aria-busy={busy[sel] || undefined}
          data-insp={sel}
          value={value(sel)}
          onChange={(e) => onChange(e.target.value)}
        >
          {options}
        </select>
      </span>
    </label>
  );
  // A double click's second press lands on whatever slid under the pointer: it does nothing.
  const press = (fn: (from: HTMLElement) => void) => (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail <= 1) fn(e.currentTarget);
  };

  return (
    <div className="ip-insp" data-act role="group" aria-label={`Inspector for #${id}`}>
      <div className="ip-insp-main">
        {text ? (
          <>
            <div ref={body} className={`ip-insp-body${expanded ? '' : ' clamped'}`}>
              <Markdown text={node.body} />
            </div>
            {overflows && (
              <Button variant="ghost" size="sm" className="ip-insp-more" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
                {expanded ? 'Show less' : 'Show all'}
              </Button>
            )}
          </>
        ) : (
          <p className="ip-insp-nobody">No description</p>
        )}
        <p className="ip-insp-facts">
          {facts.map((f, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="sep" aria-hidden="true"> · </span>}
              {f}
            </Fragment>
          ))}
        </p>
        {!parked && (
          <>
            <div className="ip-insp-selects">
              {select('phase', 'Phase', phases.map((p) => <option key={String(p.value ?? 'none')} value={String(p.value ?? 'none')}>{p.label}</option>), (v) =>
                change('phase', v, () => onPhase(v === 'none' ? null : Number(v))))}
              {select(
                'label',
                'Label',
                <>
                  {NODE_LABELS.map((l) => <option key={l} value={l}>{`${LABEL_GLYPHS[l]} ${l}`}</option>)}
                  <option value="none">Unlabelled</option>
                </>,
                (v) => change('label', v, () => onLabel(v === 'none' ? null : (v as NodeLabel))),
              )}
              {select(
                'band',
                'Band',
                <>
                  {band === null && <option value="" disabled>Choose a band</option>}
                  <option value="next">Next up</option>
                  <option value="soon">Soon</option>
                  <option value="someday">Someday</option>
                </>,
                (v) => change('band', v, () => onBand(v as 'next' | 'soon' | 'someday')),
              )}
            </div>
            {error && <ErrorLine message={error} />}
          </>
        )}
      </div>
      {panel ?? (
        <div className="ip-insp-acts">
          {can.toNext && <Button variant="primary" data-insp="tonext" onClick={press(onToNext)}>To Next</Button>}
          {can.unpark && <Button variant="primary" data-insp="unpark" onClick={press((el) => onUnpark(false, el))}>Unpark</Button>}
          {can.unpark && <Button variant="outline" data-insp="unpark-next" onClick={press((el) => onUnpark(true, el))}>to Next</Button>}
          {can.backToBacklog && <Button variant="outline" data-insp="back" onClick={press(onBackToBacklog)}>Back to Backlog</Button>}
          {can.moveTop && <Button variant="outline" data-insp="top" onClick={press(onMoveTop)}>Move to top</Button>}
          {can.keep && <Button variant="outline" data-insp="keep" onClick={press(onKeep)}>Keep</Button>}
          {can.park && <Button variant="outline" data-park aria-haspopup="dialog" onClick={press(onPark)}>Park…</Button>}
          <Button variant="ghost" data-insp="details" onClick={press(onOpenDetails)}>Open Details ›</Button>
          {can.remove && <Button variant="danger" size="sm" data-delete aria-haspopup="dialog" onClick={press(onDelete)}>Delete…</Button>}
        </div>
      )}
    </div>
  );
}
