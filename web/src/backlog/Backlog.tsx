import type { TaskBox as BoxData } from '../../../src/core/taskState';
import type { ParkedRow } from '../../../src/core/board';
import { LABEL_GLYPHS, NODE_LABELS } from '../../../src/core/types';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { deleteStep, unparkStep } from '../api';
import { backlogSections, filterEntries, type BacklogOrder, ORDER_KEY, orderKey, parentTitle, parseOrder, sortFlat, UNLABELLED } from '../board/backlogOrder';
import type { BandProps } from '../board/bandProps';
import { boxSince } from '../board/boxState';
import { rowClick } from '../board/Marks';
import { ageShort } from '../board/text';
import { shortDate } from '../done/doneGroups';
import { noteAction } from '../measure';
import { PageHead } from '../page/PageHead';
import { Button } from '../parts/Button';
import { Confirm } from '../parts/Confirm';
import { EmptyState } from '../parts/EmptyState';
import { Eyebrow } from '../parts/Eyebrow';
import { Field } from '../parts/Field';
import { useListCursor } from '../parts/ListCursor';
import { TabStrip } from '../parts/TabStrip';
import { load, save } from '../storage';
import { backlogPhases, type PreviewPhase } from './backlogPreview';
import { backlogMeta, cursorAfter, openInside, phaseTabs } from './backlogView';
import { ParkForm, type ParkDraft } from './ParkForm';
import { ViewRow } from './ViewRow';

/**
 * The full Backlog (the view behind "N ›"): the page head, then every open entry as a one-line row under its parent's
 * title (the top level reads "No phase"), with "to Next", "Park…" and "Delete…" shown on hover and on focus, and a
 * Parked group at the bottom. "Delete…" and "Park…" open their form inside the row. Controls on top filter by text
 * (#453), phase and label and order the rows by phase, id or age, forward or reverse (#452). The filter is this
 * component's state: it ends with the view. No drag: Next is not on screen. Every row of the page is one Tab stop.
 */
export function Backlog({ boxes, parked, snapshot, now, projectId, slug, code, titleRef, onStatus, onOpenNode, onToNext }: Pick<BandProps, 'snapshot' | 'now' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
  /** Every open Backlog box; the filter picks the ones drawn. */
  boxes: BoxData[];
  /** Every parked step (top level only); the filter picks the ones drawn. */
  parked: ParkedRow[];
  projectId: number;
  slug: string;
  /** The page head's code block. */
  code: string;
  /** The page title: where focus lands when the last row leaves. */
  titleRef: RefObject<HTMLHeadingElement>;
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
  /** The step whose row takes focus when the Park form's row leaves (null: the page title), worked out when the form opens; a reorder may remount the element, so it is found again by its step. */
  const afterPark = useRef<string | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const root = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const openEntries = boxes;
  const parkedEntries = parked.map((p) => ({ row: p }));
  const filter = { query, phase, labels };
  const filtering = query.trim() !== '' || phase !== null || labels.size > 0;
  const shown = filterEntries(openEntries, filter);
  const shownParked = sortFlat(filterEntries(parkedEntries, filter), order);
  const sections = backlogSections(shown, order);
  const ids = openEntries.map((b) => b.row!.node.id).join(',');
  const shownIds = shown.map((b) => b.row!.node.id).join(',');
  // The phase tabs and label buttons: what the entries (open and parked) have.
  const allEntries = [...openEntries, ...parkedEntries];
  const phases = backlogPhases({ backlog: allEntries.map((e) => e.row!) }, snapshot.nodes).filter((c) => c.value !== 'none' || allEntries.some((e) => !e.row!.crumb.some((a) => a.kind === 'phase')));
  const labelsHere = NODE_LABELS.filter((l) => allEntries.some((e) => e.row!.node.label === l));
  const anyUnlabelled = allEntries.some((e) => e.row!.node.label === null);

  // Every drawn row, open groups then Parked, is one list: one Tab stop, Up and Down through all of them.
  const rowIds = [...sections.flatMap((g) => g.boxes.map((b) => b.row!.node.id)), ...shownParked.map(({ row }) => row.node.id)];
  const rowAt = new Map(rowIds.map((id, i) => [id, i]));
  const { itemProps } = useListCursor(
    [rowIds.length],
    (at) => {
      const id = rowIds[at.row];
      if (id === undefined) return;
      noteAction('backlog', 'open');
      onOpenNode(id);
    },
    [rowIds.map(String)],
  );

  // A row that left (deleted here or elsewhere) no longer waits. An open row no longer shown (it left, or a change elsewhere
  // took it out of the filter) no longer has its panel open; if it took focus with it, the page title has it.
  useEffect(() => {
    const here = new Set(ids ? ids.split(',').map(Number) : []);
    const seen = new Set(shownIds ? shownIds.split(',').map(Number) : []);
    if (panel !== null && !seen.has(panel.id)) {
      setPanel(null);
      if (document.activeElement === document.body) titleRef.current?.focus();
    }
    setPending((p) => (p.some((id) => !here.has(id)) ? p.filter((id) => here.has(id)) : p));
  }, [ids, shownIds, panel, titleRef]);
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
    const after = cursorAfter(li);
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
    const after = cursorAfter(li);
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

  const head = (
    <PageHead code={code} name="BACKLOG" meta={backlogMeta(openEntries.length, shown.length, parked.length, filtering)} decodeKey={projectId} titleRef={titleRef} />
  );
  if (openEntries.length === 0 && parked.length === 0) {
    return (
      <>
        {head}
        <EmptyState>Backlog is empty</EmptyState>
      </>
    );
  }
  /** The server refuses a step with any step under it, done or dropped ones too. */
  const parents = new Set(snapshot.nodes.map((n) => n.parentId));
  const hasKids = (id: number) => parents.has(id);
  const nothing = shown.length === 0 && shownParked.length === 0;
  return (
    <>
      {head}
      <div className="ip-bl" ref={root}>
        <div className="ip-bl-tools">
          <Field
            ref={filterField}
            size="sm"
            className="ip-bl-filter"
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
          <div className="ip-bl-order" role="group" aria-label="Backlog order">
            <TabStrip
              variant="segmented"
              label="Sort"
              items={[{ id: 'phase', label: 'Phase' }, { id: 'id', label: 'ID' }, { id: 'age', label: 'Age' }]}
              value={order.by}
              onChange={(id) => pick({ ...order, by: id === 'id' ? 'id' : id === 'age' ? 'age' : 'phase' })}
            />
            <Button variant="ghost" size="sm" aria-label="Reverse" title={order.reverse ? 'Reverse order' : 'Forward order'} aria-pressed={order.reverse} onClick={() => pick({ ...order, reverse: !order.reverse })}>
              {order.reverse ? '↓' : '↑'}
            </Button>
          </div>
        </div>
        <div className="ip-bl-filters">
          <TabStrip
            variant="segmented"
            label="Phase"
            items={phaseTabs(phases, openEntries)}
            value={phase === null ? 'all' : String(phase)}
            onChange={(id) => narrow({ phase: id === 'all' ? null : id === 'none' ? 'none' : Number(id) })}
          />
          {(labelsHere.length > 0 || anyUnlabelled) && (
            <div className="ip-bl-labels" role="group" aria-label="Label">
              {labelsHere.map((l) => (
                <button key={l} type="button" className="p-chip ip-bl-labelbtn" data-tone="quiet" aria-pressed={labels.has(l)} onClick={() => toggleLabel(l)}>
                  <span className="p-chip-glyph" aria-hidden="true">{LABEL_GLYPHS[l]}</span>
                  {l}
                </button>
              ))}
              {anyUnlabelled && (
                <button type="button" className="p-chip ip-bl-labelbtn" data-tone="quiet" aria-pressed={labels.has(UNLABELLED)} onClick={() => toggleLabel(UNLABELLED)}>{UNLABELLED}</button>
              )}
            </div>
          )}
        </div>
        {nothing && (
          <EmptyState
            className="ip-bl-none"
            action={<Button variant="ghost" size="sm" onClick={clearAll}>Clear filter</Button>}
          >
            {query.trim() ? `Nothing matches “${query.trim()}”` : 'Nothing matches this filter'}
          </EmptyState>
        )}
        {sections.map((g) => (
          <section
            key={g.flat ? order.by : (g.parent?.id ?? 0)}
            className="ip-bl-group"
            aria-label={g.flat ? `Backlog by ${order.by}` : g.parent ? `Backlog under ${g.parent.title}` : 'Backlog with no phase'}
          >
            {!g.flat && (
              <header className="ip-bl-ghead">
                <Eyebrow glyph="[+]">{g.parent ? `#${g.parent.id} · ${g.boxes.length}` : `TOP LEVEL · ${g.boxes.length}`}</Eyebrow>
                <h3 className="ip-bl-gtitle" title={g.parent?.title ?? 'No phase'}>{g.parent ? g.parent.title : 'No phase'}</h3>
              </header>
            )}
            <ul className="ip-bl-list">
              {g.boxes.map((box) => {
                const row = box.row!;
                const id = row.node.id;
                const asking = confirming === id;
                const parking = panel?.kind === 'park' && panel.id === id;
                const waiting = pending.includes(id);
                const since = boxSince(box);
                return (
                  <ViewRow
                    key={id}
                    id={id}
                    title={row.node.title}
                    cursor={itemProps(0, rowAt.get(id)!)}
                    phase={g.flat ? parentTitle(box) : undefined}
                    blocked={row.node.status === 'blocked'}
                    inside={openInside(snapshot.nodes, id)}
                    label={row.node.label}
                    age={since ? ageShort(since, now) : null}
                    pending={waiting}
                    confirming={asking || parking}
                    onOpen={rowClick('backlog', () => onOpenNode(id))}
                    // A press on the confirming row outside the confirm keeps focus in it (so Escape still closes it). A press
                    // on the parking row outside its form puts focus in the form's reason field the same way.
                    onMouseDown={asking ? (e) => {
                      if ((e.target as HTMLElement).closest('.p-confirm')) return;
                      e.preventDefault();
                      const confirm = e.currentTarget.querySelector<HTMLElement>('.p-confirm');
                      if (confirm && !confirm.contains(document.activeElement)) confirm.querySelector<HTMLElement>('.p-confirm-acts button:last-child')?.focus();
                    } : parking ? (e) => {
                      if ((e.target as HTMLElement).closest('.ip-park')) return;
                      e.preventDefault();
                      const form = e.currentTarget.querySelector<HTMLElement>('.ip-park');
                      if (form && !form.contains(document.activeElement)) form.querySelector<HTMLElement>('input')?.focus();
                    } : undefined}
                    // Escape anywhere in the confirming row closes the confirm.
                    onKeyDown={asking ? (e) => {
                      if (e.key !== 'Escape') return;
                      e.stopPropagation();
                      cancel(id);
                    } : undefined}
                    acts={
                      <>
                        <Button variant="ghost" size="sm" data-act onClick={(e) => {
                          noteAction('backlog', 'to_next');
                          cursorAfter(e.currentTarget.closest('li'))?.focus();
                          onToNext(id);
                        }}>to Next</Button>
                        <Button variant="ghost" size="sm" data-act data-park aria-haspopup="dialog" onClick={(e) => {
                          draft.current = { reason: '', where: '', focused: false };
                          const target = cursorAfter(e.currentTarget.closest('li'));
                          afterPark.current = target?.dataset.node ?? null;
                          setPanel({ kind: 'park', id });
                        }}>Park…</Button>
                        {!hasKids(id) && (
                          <Button variant="ghost" size="sm" data-act data-delete aria-haspopup="dialog" onClick={() => setPanel({ kind: 'delete', id })}>Delete…</Button>
                        )}
                      </>
                    }
                  >
                    {parking && (
                      <ParkForm
                        projectId={projectId}
                        slug={slug}
                        nodeId={id}
                        title={row.node.title}
                        onStatus={onStatus}
                        draft={draft.current}
                        onDone={() => {
                          // Closes only its own form: a click on another row's Park… meanwhile opened that one. Focus moves on
                          // only while this form still owns the panel and focus is in its row or nowhere.
                          // (A panel already null closed because its row left, which may have parked focus on the page title.)
                          const owns = panelRef.current === null || (panelRef.current.kind === 'park' && panelRef.current.id === id);
                          const active = document.activeElement;
                          const here = root.current?.querySelector(`li[data-node="${id}"]`);
                          const free = active === null || active === document.body || here?.contains(active) === true || active.classList.contains('ip-page-title');
                          setPanel((p) => (p?.id === id ? null : p));
                          if (!owns || !free) return;
                          const next = afterPark.current && root.current?.querySelector<HTMLElement>(`li[data-node="${afterPark.current}"]`);
                          (next || titleRef.current)?.focus();
                        }}
                        onCancel={() => cancel(id)}
                      />
                    )}
                    {asking && (
                      <Confirm
                        question={`Delete #${id} ${row.node.title}?`}
                        detail="It can't be undone."
                        action="Delete"
                        danger
                        onConfirm={() => void remove(id, root.current?.querySelector<HTMLElement>(`li[data-node="${id}"]`) ?? null)}
                        onCancel={() => cancel(id)}
                      />
                    )}
                  </ViewRow>
                );
              })}
            </ul>
          </section>
        ))}
        {shownParked.length > 0 && (
          <section className="ip-bl-group ip-bl-parked" aria-label="Parked">
            <header className="ip-bl-ghead">
              <Eyebrow>{`PARKED · ${shownParked.length}`}</Eyebrow>
            </header>
            <ul className="ip-bl-list">
              {shownParked.map(({ row }) => {
                const { node } = row;
                const busy = unparking.includes(node.id);
                return (
                  <ViewRow
                    key={node.id}
                    id={node.id}
                    parked
                    title={node.title}
                    cursor={itemProps(0, rowAt.get(node.id)!)}
                    phase={parentTitle({ row }) ?? 'No phase'}
                    inside={row.openInside}
                    label={node.label}
                    age={node.parkedAt ? ageShort(node.parkedAt, now) : null}
                    pending={busy}
                    onOpen={rowClick('backlog', () => onOpenNode(node.id))}
                    acts={
                      <>
                        <Button variant="ghost" size="sm" data-act disabled={busy} onClick={(e) => void unpark(node.id, true, e.currentTarget.closest('li'))}>to Next</Button>
                        <Button variant="ghost" size="sm" data-act disabled={busy} onClick={(e) => void unpark(node.id, false, e.currentTarget.closest('li'))}>Unpark</Button>
                      </>
                    }
                  >
                    <p className="ip-bl-why">{`Parked ${node.parkedAt ? `${shortDate(node.parkedAt, now)}: ` : ': '}${node.parkedReason}`}</p>
                    {node.parkedWhere && <p className="ip-bl-where">{`where ${node.parkedWhere}`}</p>}
                  </ViewRow>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
