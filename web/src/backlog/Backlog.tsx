import type { TaskBox as BoxData } from '../../../src/core/taskState';
import type { ParkedRow } from '../../../src/core/board';
import { LABEL_GLYPHS, NODE_LABELS } from '../../../src/core/types';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { deleteStep, unparkStep } from '../api';
import { backlogSections, filterEntries, type BacklogOrder, ORDER_KEY, orderKey, parentTitle, parseOrder, sortFlat, UNLABELLED } from '../board/backlogOrder';
import type { BandProps } from '../board/bandProps';
import { focusTargetAfter } from '../board/focus';
import { endedLine, LabelChip, rowClick } from '../board/Marks';
import { ageShort } from '../board/text';
import { TaskBox } from '../board/TaskBox';
import { shortDate } from '../done/doneGroups';
import { noteAction } from '../measure';
import { load, save } from '../storage';
import { backlogPhases, type PreviewPhase } from './backlogPreview';
import { ParkForm, type ParkDraft } from './ParkForm';

/**
 * The full Backlog (the view behind "N ›"): every open entry as task boxes with no hue, under their parent's title (the
 * top level reads "No phase"), with "to Next", "Park…" and "Delete…" shown on hover and on focus, and a Parked group at the
 * bottom. "Delete…" and "Park…" open their form inside the box. Controls on top filter by text (#453), phase and label
 * and order the rows by phase, id or age, forward or reverse (#452). The filter is this component's state: it ends with
 * the view. No drag: Next is not on screen.
 */
export function Backlog({ boxes, parked, snapshot, now, projectId, slug, onStatus, onOpenNode, onOpenResource, onToNext }: Pick<BandProps, 'snapshot' | 'now' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
  /** Every open Backlog box; the filter picks the ones drawn. */
  boxes: BoxData[];
  /** Every parked step (top level only); the filter picks the ones drawn. */
  parked: ParkedRow[];
  projectId: number;
  slug: string;
  onToNext: (id: number) => void;
}) {
  /** The row whose Delete confirm or Park form is open: one at a time. */
  const [panel, setPanel] = useState<{ kind: 'delete' | 'park'; id: number } | null>(null);
  /** Rows deleted and waiting for the answer, or for the snapshot that drops them. */
  const [pending, setPending] = useState<number[]>([]);
  /** Parked rows whose Unpark or to Next is in flight. */
  const [unparking, setUnparking] = useState<number[]>([]);
  const [order, setOrder] = useState<BacklogOrder>(() => parseOrder(load(ORDER_KEY)));
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<PreviewPhase | null>(null);
  const [labels, setLabels] = useState<ReadonlySet<string>>(new Set());
  const confirming = panel?.kind === 'delete' ? panel.id : null;
  /** A reorder or a new filter closes an open Delete confirm: its row may move away from where the user was looking. An open Park form stays (and keeps what was typed) while its row is still shown. */
  const closePanel = () => setPanel((p) => (p?.kind === 'delete' ? null : p));
  const pick = (o: BacklogOrder) => {
    closePanel();
    setOrder(o);
    save(ORDER_KEY, orderKey(o));
  };
  const narrow = (f: { query?: string; phase?: PreviewPhase | null; labels?: ReadonlySet<string> }) => {
    closePanel();
    if (f.query !== undefined) setQuery(f.query);
    if (f.phase !== undefined) setPhase(f.phase);
    if (f.labels !== undefined) setLabels(f.labels);
  };
  /** What is typed in the open Park form: it outlives the form's remount when a reorder moves the row to another group. */
  const draft = useRef<ParkDraft>({ reason: '', where: '', focused: false });
  /** The row whose title takes focus when the Park form's row leaves (null: the view's heading), worked out when the form opens; a reorder may remount the element, so it is found again by its step. */
  const afterPark = useRef<string | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const root = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  /** The view's heading, for when the form's row leaves and takes focus with it. */
  const heading = useRef<HTMLElement | null>(null);

  const openEntries = boxes;
  const parkedEntries = parked.map((p) => ({ row: p }));
  const filter = { query, phase, labels };
  const filtering = query.trim() !== '' || phase !== null || labels.size > 0;
  const shown = filterEntries(openEntries, filter);
  const shownParked = sortFlat(filterEntries(parkedEntries, filter), order);
  const ids = openEntries.map((b) => b.row!.node.id).join(',');
  const shownIds = shown.map((b) => b.row!.node.id).join(',');
  // The phase and label chips: what the entries (open and parked) have.
  const allEntries = [...openEntries, ...parkedEntries];
  const phases = backlogPhases({ backlog: allEntries.map((e) => e.row!) }, snapshot.nodes).filter((c) => c.value !== 'none' || allEntries.some((e) => !e.row!.crumb.some((a) => a.kind === 'phase')));
  const labelsHere = NODE_LABELS.filter((l) => allEntries.some((e) => e.row!.node.label === l));
  const anyUnlabelled = allEntries.some((e) => e.row!.node.label === null);

  // The form's first field (or Cancel) takes focus when a panel opens.
  useEffect(() => {
    if (panel === null) return;
    heading.current = root.current?.closest<HTMLElement>('.ip-backlogview')?.querySelector<HTMLElement>('h2') ?? null;
    if (panel.kind === 'delete') root.current?.querySelector<HTMLElement>('.ip-confirm [data-cancel]')?.focus();
  }, [panel]);
  // A row that left (deleted here or elsewhere) no longer waits. An open row no longer shown (it left, or a change elsewhere
  // took it out of the filter) no longer has its panel open; if it took focus with it, the heading has it.
  useEffect(() => {
    const here = new Set(ids ? ids.split(',').map(Number) : []);
    const seen = new Set(shownIds ? shownIds.split(',').map(Number) : []);
    if (panel !== null && !seen.has(panel.id)) {
      setPanel(null);
      if (document.activeElement === document.body) heading.current?.focus();
    }
    setPending((p) => (p.some((id) => !here.has(id)) ? p.filter((id) => here.has(id)) : p));
  }, [ids, shownIds, panel]);
  /** A parked row that is unparked leaves the Parked group: its in-flight mark ends with it. */
  const parkedIds = parked.map((p) => p.node.id).join(',');
  useEffect(() => {
    const here = new Set(parkedIds ? parkedIds.split(',').map(Number) : []);
    setUnparking((u) => (u.some((id) => !here.has(id)) ? u.filter((id) => here.has(id)) : u));
  }, [parkedIds]);
  /** Puts focus back on that row's button, once it is drawn again. */
  const refocus = (id: number, attr: 'data-delete' | 'data-park') => window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`li[data-node="${id}"] [${attr}]`)?.focus());
  const cancel = (id: number) => {
    const kind = panel?.kind;
    setPanel(null);
    refocus(id, kind === 'park' ? 'data-park' : 'data-delete');
  };
  const remove = async (id: number, li: HTMLElement | null) => {
    noteAction('backlog', 'delete');
    const after = focusTargetAfter(li);
    setPanel(null);
    setPending((p) => [...p, id]);
    after?.focus();
    const result = await deleteStep(projectId, slug, id);
    if (result === 'ok') return;
    // Drawn at once, so the row's Delete button is there to focus; and only when focus has not moved on meanwhile.
    flushSync(() => setPending((p) => p.filter((x) => x !== id)));
    if (!after || document.activeElement === after) root.current?.querySelector<HTMLElement>(`li[data-node="${id}"] [data-delete]`)?.focus();
    if (result === 'reload') window.location.reload();
    else onStatus?.(result);
  };
  const unpark = async (id: number, toNext: boolean, li: HTMLElement | null) => {
    noteAction('backlog', toNext ? 'unpark_to_next' : 'unpark');
    const after = focusTargetAfter(li);
    setUnparking((u) => [...u, id]);
    const result = await unparkStep(projectId, slug, id, toNext);
    if (result === 'ok') {
      // Only when focus is still in the row, or nowhere: a click or a form the user moved on to keeps it.
      const active = document.activeElement;
      if (active === null || active === document.body || li?.contains(active)) after?.focus();
      return;
    }
    setUnparking((u) => u.filter((x) => x !== id));
    if (result === 'reload') window.location.reload();
    else onStatus?.(result);
  };
  const toggleLabel = (l: string) => {
    const next = new Set(labels);
    if (next.has(l)) next.delete(l);
    else next.add(l);
    narrow({ labels: next });
  };
  const clearAll = () => {
    narrow({ query: '', phase: null, labels: new Set() });
    filterField.current?.focus();
  };

  if (openEntries.length === 0 && parked.length === 0) return <p className="ip-quiet ip-empty-line">Backlog is empty</p>;
  /** The server refuses a step with any step under it, done or dropped ones too. */
  const parents = new Set(snapshot.nodes.map((n) => n.parentId));
  const hasKids = (id: number) => parents.has(id);
  return (
    <div className="ip-backlog-groups" ref={root}>
      <div className="ip-backlog-tools">
        <input
          ref={filterField}
          className="ip-backlog-filter"
          type="text"
          aria-label="Filter the backlog"
          placeholder="Filter…"
          value={query}
          onChange={(e) => narrow({ query: e.target.value })}
          onKeyDown={(e) => {
            // Escape clears a filter; in an empty field it does nothing here.
            if (e.key !== 'Escape' || !query) return;
            e.preventDefault();
            e.stopPropagation();
            narrow({ query: '' });
          }}
        />
        {filtering && <span className="ip-quiet ip-backlog-count">{`${shown.length} of ${openEntries.length}`}</span>}
        <div className="ip-backlog-order" role="group" aria-label="Backlog order">
          <button type="button" aria-pressed={order.by === 'phase'} onClick={() => pick({ ...order, by: 'phase' })}>Phase</button>
          <button type="button" aria-pressed={order.by === 'id'} onClick={() => pick({ ...order, by: 'id' })}>ID</button>
          <button type="button" aria-pressed={order.by === 'age'} onClick={() => pick({ ...order, by: 'age' })}>Age</button>
          <button type="button" aria-label="Reverse" title={order.reverse ? 'Reverse order' : 'Forward order'} aria-pressed={order.reverse} onClick={() => pick({ ...order, reverse: !order.reverse })}>
            {order.reverse ? '↓' : '↑'}
          </button>
        </div>
      </div>
      <div className="ip-chips" role="group" aria-label="Phase">
        <span className="ip-chips-name">Phase</span>
        <button type="button" className="ip-chip" aria-pressed={phase === null} onClick={() => narrow({ phase: null })}>All</button>
        {phases.map((c) => (
          <button key={String(c.value)} type="button" className="ip-chip" aria-pressed={phase === c.value} title={c.title} onClick={() => narrow({ phase: c.value })}>{c.title}</button>
        ))}
      </div>
      {(labelsHere.length > 0 || anyUnlabelled) && (
        <div className="ip-chips" role="group" aria-label="Label">
          <span className="ip-chips-name">Label</span>
          {labelsHere.map((l) => (
            <button key={l} type="button" className="ip-chip" aria-pressed={labels.has(l)} onClick={() => toggleLabel(l)}>{`${LABEL_GLYPHS[l]} ${l}`}</button>
          ))}
          {anyUnlabelled && <button type="button" className="ip-chip" aria-pressed={labels.has(UNLABELLED)} onClick={() => toggleLabel(UNLABELLED)}>{UNLABELLED}</button>}
        </div>
      )}
      {shown.length === 0 && shownParked.length === 0 && (
        <p className="ip-quiet ip-empty-line ip-backlog-none">
          {query.trim() ? `Nothing matches “${query.trim()}” ` : 'Nothing matches this filter '}
          <button type="button" className="ip-link-btn" onClick={clearAll}>Clear filter</button>
        </p>
      )}
      {backlogSections(shown, order).map((g) => (
        <section
          key={g.flat ? order.by : (g.parent?.id ?? 0)}
          className="ip-backlog-group"
          aria-label={g.flat ? `Backlog by ${order.by}` : g.parent ? `Backlog under ${g.parent.title}` : 'Backlog with no phase'}
        >
          {!g.flat && <div className="ip-group-line" title={g.parent?.title ?? 'No phase'}>{g.parent ? g.parent.title : 'No phase'}</div>}
          <ul className="ip-list">
            {g.boxes.map((box) => {
              const row = box.row!;
              const asking = confirming === row.node.id;
              const parking = panel?.kind === 'park' && panel.id === row.node.id;
              const waiting = pending.includes(row.node.id);
              return (
                <TaskBox
                  key={row.node.id}
                  box={box}
                  now={now}
                  area="backlog"
                  docs={snapshot.resources.filter((r) => r.nodeId === row.node.id).length}
                  system={endedLine(row, snapshot.pastSessions, now)}
                  className={`ip-backlog-row${waiting ? ' pending' : ''}${asking || parking ? ' confirming' : ''}`}
                  noHue
                  still={asking || parking || waiting}
                  li={{
                    'aria-busy': waiting || undefined,
                    // A press on the confirming box outside the confirm's buttons puts focus in the confirm (or keeps it
                    // there), so Escape still closes it. A press on the parking box outside its form puts focus in the
                    // form's reason field the same way.
                    onMouseDown: asking ? (e) => {
                      if ((e.target as HTMLElement).closest('.ip-confirm button')) return;
                      e.preventDefault();
                      const confirm = e.currentTarget.querySelector<HTMLElement>('.ip-confirm');
                      if (confirm && !confirm.contains(document.activeElement)) confirm.focus();
                    } : parking ? (e) => {
                      if ((e.target as HTMLElement).closest('.ip-park')) return;
                      e.preventDefault();
                      const form = e.currentTarget.querySelector<HTMLElement>('.ip-park');
                      if (form && !form.contains(document.activeElement)) form.querySelector<HTMLElement>('input')?.focus();
                    } : undefined,
                    // Escape anywhere in the confirming box closes the confirm.
                    onKeyDown: asking ? (e) => {
                      if (e.key !== 'Escape') return;
                      e.stopPropagation();
                      cancel(row.node.id);
                    } : undefined,
                  }}
                  extra={asking || parking ? undefined : (
                    <>
                      <button type="button" className="ip-hover-act" data-act onClick={(e) => {
                        noteAction('backlog', 'to_next');
                        focusTargetAfter(e.currentTarget.closest('li'))?.focus();
                        onToNext(row.node.id);
                      }}>to Next</button>
                      <button type="button" className="ip-hover-act" data-act data-park aria-haspopup="dialog" onClick={(e) => {
                        draft.current = { reason: '', where: '', focused: false };
                        const target = focusTargetAfter(e.currentTarget.closest('li'));
                        afterPark.current = target?.closest('li')?.dataset.node ?? null;
                        setPanel({ kind: 'park', id: row.node.id });
                      }}>Park…</button>
                      {!hasKids(row.node.id) && (
                        <button type="button" className="ip-hover-act" data-act data-delete aria-haspopup="dialog" onClick={() => setPanel({ kind: 'delete', id: row.node.id })}>Delete…</button>
                      )}
                    </>
                  )}
                  onOpenNode={onOpenNode}
                  onOpenResource={onOpenResource}
                >
                  {g.flat && parentTitle(box) && <div className="ip-group-line ip-box-parent" title={parentTitle(box)!}>{parentTitle(box)}</div>}
                  {parking && (
                    <ParkForm
                      projectId={projectId}
                      slug={slug}
                      nodeId={row.node.id}
                      title={row.node.title}
                      onStatus={onStatus}
                      draft={draft.current}
                      onDone={() => {
                        // Closes only its own form: a click on another row's Park… meanwhile opened that one. Focus moves on
                        // only while this form still owns the panel and focus is in its row or nowhere.
                        // (A panel already null closed because its row left, which may have parked focus on the heading.)
                        const owns = panelRef.current === null || (panelRef.current.kind === 'park' && panelRef.current.id === row.node.id);
                        const active = document.activeElement;
                        const here = root.current?.querySelector(`li[data-node="${row.node.id}"]`);
                        const free = active === null || active === document.body || here?.contains(active) === true || active.classList.contains('ip-backlogview-title');
                        setPanel((p) => (p?.id === row.node.id ? null : p));
                        if (!owns || !free) return;
                        const next = afterPark.current && root.current?.querySelector<HTMLElement>(`li[data-node="${afterPark.current}"] .ip-row-title`);
                        (next || root.current?.closest<HTMLElement>('.ip-backlogview')?.querySelector<HTMLElement>('.ip-backlogview-title'))?.focus();
                      }}
                      onCancel={() => cancel(row.node.id)}
                    />
                  )}
                  {asking && (
                    <div
                      className="ip-confirm"
                      role="dialog"
                      aria-modal={false}
                      aria-labelledby={`bl${row.node.id}q`}
                      aria-describedby={`bl${row.node.id}d`}
                      tabIndex={-1}
                      data-act
                    >
                      <b id={`bl${row.node.id}q`}>Delete #{row.node.id} {row.node.title}?</b>
                      <p id={`bl${row.node.id}d`}>It can't be undone.</p>
                      <div>
                        <button type="button" className="ip-btn go" onClick={(e) => void remove(row.node.id, e.currentTarget.closest('li'))}>
                          Delete
                        </button>
                        <button type="button" className="ip-btn" data-cancel onClick={() => cancel(row.node.id)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </TaskBox>
              );
            })}
          </ul>
        </section>
      ))}
      {shownParked.length > 0 && (
        <section className="ip-backlog-group ip-parked-group" aria-label="Parked">
          <div className="ip-group-line">{`Parked · ${shownParked.length}`}</div>
          <ul className="ip-list">
            {shownParked.map(({ row }) => {
              const { node } = row;
              const busy = unparking.includes(node.id);
              return (
                <li
                  key={node.id}
                  className={`ip-card ip-parked-row${busy ? ' pending' : ''}`}
                  data-node={node.id}
                  aria-busy={busy || undefined}
                  onClick={rowClick('backlog', () => onOpenNode(node.id))}
                >
                  <div className="ip-card-top">
                    <span className="ip-sid">#{node.id}</span>
                    <span className="ip-card-right">
                      <button type="button" className="ip-hover-act" data-act disabled={busy} onClick={(e) => void unpark(node.id, true, e.currentTarget.closest('li'))}>to Next</button>
                      <button type="button" className="ip-hover-act" data-act disabled={busy} onClick={(e) => void unpark(node.id, false, e.currentTarget.closest('li'))}>Unpark</button>
                      <span className="ip-st parked">Parked</span>
                      {node.parkedAt && <span className="ip-time">{ageShort(node.parkedAt, now)}</span>}
                    </span>
                  </div>
                  <button type="button" className="ip-row-title ip-card-title">{node.title}</button>
                  <div className="ip-group-line ip-box-parent" title={parentTitle({ row }) ?? 'No phase'}>{parentTitle({ row }) ?? 'No phase'}</div>
                  <p className="ip-sys ip-parked-why">{`Parked ${node.parkedAt ? `${shortDate(node.parkedAt, now)}: ` : ': '}${node.parkedReason}`}</p>
                  {node.parkedWhere && <p className="ip-sys ip-parked-where">{`where ${node.parkedWhere}`}</p>}
                  <div className="ip-foot">
                    {row.openInside > 0 && <span className="ip-mark hygiene">{`${row.openInside} open inside`}</span>}
                    <LabelChip label={node.label} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
