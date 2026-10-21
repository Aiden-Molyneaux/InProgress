import { Fragment, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { LABEL_GLYPHS, NODE_LABELS, type NodeLabel, type ResourceMeta, type TreeNode } from '../../../src/core/types';
import type { BacklogBand } from '../../../src/core/backlog';
import { ageShort } from '../board/text';
import { shortDate } from '../done/doneGroups';
import { noteAction } from '../measure';
import { Markdown } from '../panels/Markdown';
import { Button } from '../parts/Button';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { DocsMenu } from '../project/DocsMenu';
import type { InspSel as Sel, InspState } from './useInspectorWrites';

/**
 * A Backlog row's inspector, drawn under the row in `ViewRow`'s `children`: the step's body, a facts line, the Phase, Label
 * and Band selects (each saves on change) and a column of buttons. The caller decides which buttons show (`can`) and what
 * each does; a Park form or a Delete confirm it passes as `panel` takes the button column's place.
 */
export function Inspector({ id, node, inside, band, parked, handoff, docs, lastSession, phases, phase, can, panel, now, state, deleting, onChange, onToNext, onBackToBacklog, onMoveTop, onKeep, onPark, onDelete, onOpenDetails, onUnpark, onOpenResource }: {
  id: number;
  node: TreeNode;
  /** Open steps under it (openInsideIndex). */
  inside: number;
  /** The row's band as drawn: 'next' for a queued row, a band, or null (Needs Triage). */
  band: BacklogBand | null;
  /** A parked row: its reason and where stand in place of the selects. `at` is when it was parked. */
  parked?: { reason: string; where: string | null; at: string | null };
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
  /** The selects' write state, kept above the rows so it outlives a remount. */
  state: InspState;
  /** A delete is on its way: neither the buttons nor a panel are drawn. */
  deleting?: boolean;
  /** A select changed to this option value; the caller does the write. */
  onChange: (sel: Sel, value: string) => void;
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
}) {
  const { pending, busy, error } = state;
  const body = useRef<HTMLDivElement>(null);
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
  const current: Record<Sel, string> = {
    phase: String(phase ?? 'none'),
    label: node.label ?? 'none',
    band: band ?? '',
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

  const select = (sel: Sel, label: string, options: ReactNode) => (
    <label className="ip-insp-sel p-field" data-size="sm">
      <Eyebrow>{label}</Eyebrow>
      <span className="p-field-box">
        <select
          className={`p-field-input${busy[sel] ? ' busy' : ''}`}
          aria-label={label}
          aria-busy={busy[sel] || undefined}
          data-insp={sel}
          value={value(sel)}
          onChange={(e) => onChange(sel, e.target.value)}
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
        {parked ? (
          <>
            <p className="ip-insp-why">{`Parked ${parked.at ? `${shortDate(parked.at, now)}: ` : ': '}${parked.reason}`}</p>
            {parked.where && <p className="ip-insp-where">{`where ${parked.where}`}</p>}
          </>
        ) : (
          <>
            <div className="ip-insp-selects">
              {select('phase', 'Phase', phases.map((p) => <option key={String(p.value ?? 'none')} value={String(p.value ?? 'none')}>{p.label}</option>))}
              {select(
                'label',
                'Label',
                <>
                  {NODE_LABELS.map((l) => <option key={l} value={l}>{`${LABEL_GLYPHS[l]} ${l}`}</option>)}
                  <option value="none">Unlabelled</option>
                </>,
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
              )}
            </div>
            {error && <ErrorLine role="alert" message={error} />}
          </>
        )}
      </div>
      {deleting ? null : panel ?? (
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
