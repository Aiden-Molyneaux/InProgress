import { bandOrder, deriveBacklog, keepBefore, type BacklogRow, type BacklogView } from '../../../src/core/backlog';
import { deriveBoard, type ParkedRow } from '../../../src/core/board';
import { buildIndex, dfsOrder } from '../../../src/core/tree';
import { sessionDisplayTitle, type RankOp } from '../../../src/core/types';
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { deleteStep, unparkStep } from '../api';
import { groupByParent, parentTitle } from '../board/backlogOrder';
import type { BandProps } from '../board/bandProps';
import { dropSlot } from '../board/dragQueue';
import { rowClick } from '../board/Marks';
import { QuickAdd } from '../board/QuickAdd';
import { ageShort } from '../board/text';
import { shortDate } from '../done/doneGroups';
import { noteAction } from '../measure';
import { PageHead } from '../page/PageHead';
import { Button } from '../parts/Button';
import { Confirm } from '../parts/Confirm';
import { Count } from '../parts/Count';
import { EmptyState } from '../parts/EmptyState';
import { Eyebrow } from '../parts/Eyebrow';
import { Field } from '../parts/Field';
import { useListCursor } from '../parts/ListCursor';
import { TabStrip } from '../parts/TabStrip';
import { loadFolds, saveFolds } from '../project/projectFolds';
import { load, save } from '../storage';
import { altMove, backlogMatch, backlogMeta, cursorAfter, openInsideIndex, optimisticRank, parseView, viewKey, viewTabs } from './backlogView';
import { ParkForm, type ParkDraft } from './ParkForm';
import { useKeepRowFocus } from './useKeepRowFocus';
import { useRankedOrder, type RankedBand } from './useRankedOrder';
import { ViewRow } from './ViewRow';

/** How a row is drawn in the view it is in. */
interface RowLook {
  /** Ranked's number, volt for Next up's unowned rows. */
  number?: { value: number; volt?: boolean };
  /** Ranked's band when the row can be dragged and moved with Alt+arrows (unowned Next up, Soon, Someday). */
  rank?: RankedBand;
  /** By Phase's chip. */
  chip?: string;
  /** Stale: the age reads "untouched …" and Keep is among the actions. */
  stale?: boolean;
  /** In Next up (queued): no to Next. */
  queued?: boolean;
  /** The phase column is drawn (every view but By Phase). */
  phase: boolean;
}

interface Drawn {
  id: number;
  look: RowLook;
  row?: BacklogRow;
  parked?: ParkedRow;
}

const BAND_CHIP = { next: 'NEXT', soon: 'SOON', someday: 'SOMEDAY' } as const;

/**
 * The full Backlog (the view behind "N ›"): the page head, the views strip and the filter, then the open view. Ranked is the
 * default: Next up (the queue), Soon and a folded Someday, ranked by drag or Alt+arrows; By Phase groups every open step
 * under its parent; Needs Triage lists the steps nobody has ranked; Stale the ones left alone; Parked the ones set aside.
 * Every row has "to Next", "Park…" and "Delete…" on hover and on focus; "Delete…" and "Park…" open their form inside the
 * row. The filter and the view are this component's state (the view is kept per project). Every row of the page is one Tab stop.
 */
export function Backlog({ snapshot, now, projectId, slug, code, titleRef, onStatus, onOpenNode }: Pick<BandProps, 'snapshot' | 'now' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
  projectId: number;
  slug: string;
  /** The page head's code block. */
  code: string;
  /** The page title: where focus lands when the last row leaves. */
  titleRef: RefObject<HTMLHeadingElement>;
}) {
  /** The row whose Delete confirm or Park form is open: one at a time. */
  const [panel, setPanel] = useState<{ kind: 'delete' | 'park'; id: number } | null>(null);
  /** Rows deleted and waiting for the answer, or for the snapshot that drops them. */
  const [pending, setPending] = useState<number[]>([]);
  /** Parked rows whose Unpark or to Next is in flight. */
  const [unparking, setUnparking] = useState<number[]>([]);
  const [view, setView] = useState<BacklogView>(() => parseView(load(viewKey(projectId))));
  const [query, setQuery] = useState('');
  /** Where the quick-add field is open: at the foot of Soon, or in a By Phase group (the parent's id, 0 for No phase). */
  const [adding, setAdding] = useState<'soon' | number | null>(null);
  const [someday, setSomeday] = useState(() => loadFolds(projectId).someday === true);
  const [dragging, setDragging] = useState<number | null>(null);
  /** Where a drop would land: the band and the step it goes before (null: the end); undefined when over nothing. */
  const [over, setOver] = useState<{ band: RankedBand; before: number | null } | undefined>(undefined);
  const [overFold, setOverFold] = useState(false);
  const confirming = panel?.kind === 'delete' ? panel.id : null;
  /** A view switch or a new filter closes an open Delete confirm: its row may move away from where the user was looking. An open Park form stays (and keeps what was typed) while its row is still shown. */
  const closePanel = () => setPanel((p) => (p?.kind === 'delete' ? null : p));
  const pickView = (v: BacklogView) => {
    setPanel(null);
    setAdding(null);
    setView(v);
    save(viewKey(projectId), v);
  };
  const narrow = (q: string) => {
    closePanel();
    setQuery(q);
  };
  /** What is typed in the open Park form: it outlives the form's remount when a reorder moves the row to another group. */
  const draft = useRef<ParkDraft>({ reason: '', where: '', focused: false });
  /** The step whose row takes focus when the Park form's row leaves (null: the page title), worked out when the form opens; a reorder may remount the element, so it is found again by its step. */
  const afterPark = useRef<string | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const root = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const addField = useRef<HTMLInputElement>(null);

  const board = useMemo(() => deriveBoard(snapshot, now), [snapshot, now]);
  const backlog = useMemo(() => deriveBacklog(board, snapshot, now, backlogMatch(query)), [board, snapshot, now, query]);
  const { counts } = backlog;
  const filtering = query.trim() !== '';
  const ranked = useRankedOrder({ backlog, snapshot, projectId, slug, onStatus });
  const { lists } = ranked;
  const nextRows = ranked.order('next');
  const soonRows = ranked.order('soon');
  const somedayRows = ranked.order('someday');
  /** Each session's own queue under the unowned part of Next up, in the Board's order. */
  const owned = useMemo(() => {
    const groups: { key: string; title: string; rows: BacklogRow[] }[] = [];
    for (const r of backlog.next) {
      const owner = r.row.owner;
      if (!owner) continue;
      let g = groups.find((x) => x.key === owner.id);
      if (!g) {
        g = { key: owner.id, title: sessionDisplayTitle(owner), rows: [] };
        groups.push(g);
      }
      g.rows.push(r);
    }
    return groups;
  }, [backlog.next]);
  const ownedRows = owned.flatMap((g) => g.rows);
  /** By Phase: the parents in tree order, No phase last; inside a group the rows stay in rank order. */
  const phases = useMemo(() => {
    const tree = dfsOrder(buildIndex(snapshot.nodes));
    const at = (id: number | undefined) => (id === undefined ? Number.MAX_SAFE_INTEGER : (tree.get(id) ?? Number.MAX_SAFE_INTEGER - 1));
    return groupByParent(backlog.phase).sort((a, b) => at(a.parent?.id) - at(b.parent?.id));
  }, [backlog.phase, snapshot.nodes]);

  /** The rows of the open view in the order drawn, with how each looks. */
  const drawn: Drawn[] = [];
  const numberOf = (r: BacklogRow) => ranked.numbers?.get(r.row.node.id) ?? r.number ?? 0;
  if (view === 'ranked') {
    for (const r of nextRows) drawn.push({ id: r.row.node.id, row: r, look: { number: { value: numberOf(r), volt: true }, rank: 'next', queued: true, phase: true } });
    for (const r of ownedRows) drawn.push({ id: r.row.node.id, row: r, look: { queued: true, phase: true } });
    for (const r of soonRows) drawn.push({ id: r.row.node.id, row: r, look: { number: { value: numberOf(r) }, rank: 'soon', phase: true } });
    if (someday) for (const r of somedayRows) drawn.push({ id: r.row.node.id, row: r, look: { number: { value: numberOf(r) }, rank: 'someday', phase: true } });
  } else if (view === 'phase') {
    for (const g of phases) for (const r of g.boxes) drawn.push({ id: r.row.node.id, row: r, look: { chip: r.band ? BAND_CHIP[r.band] : 'UNRANKED', queued: r.band === 'next', phase: false } });
  } else if (view === 'triage') {
    for (const r of backlog.triage) drawn.push({ id: r.row.node.id, row: r, look: { phase: true } });
  } else if (view === 'stale') {
    for (const r of backlog.stale) drawn.push({ id: r.row.node.id, row: r, look: { stale: true, phase: true } });
  } else {
    for (const p of backlog.parked) drawn.push({ id: p.node.id, parked: p, look: { phase: true } });
  }
  const rowIds = drawn.map((d) => d.id);
  const rowAt = new Map(rowIds.map((id, i) => [id, i]));
  const { itemProps } = useListCursor(
    [rowIds.length],
    (at) => {
      const id = rowIds[at.row];
      // A row asking or parking is busy with its own panel: Enter on it opens nothing.
      if (id === undefined || panelRef.current?.id === id) return;
      noteAction('backlog', 'open');
      onOpenNode(id);
    },
    [rowIds.map(String)],
  );

  // A row that leaves through a write from elsewhere hands its focus to a neighbour (or the page title).
  useKeepRowFocus(root, rowIds, titleRef);
  const insideOf = useMemo(() => openInsideIndex(snapshot.nodes), [snapshot.nodes]);
  const ids = rowIds.join(',');
  const openIds = [...backlog.next, ...backlog.soon, ...backlog.someday, ...backlog.triage].map((r) => r.row.node.id).join(',');
  // A row that left (deleted here or elsewhere) no longer waits. An open row no longer shown (it left, or a change elsewhere
  // took it out of the filter) no longer has its panel open; if it took focus with it, useKeepRowFocus has moved it.
  useEffect(() => {
    const here = new Set(openIds ? openIds.split(',').map(Number) : []);
    const seen = new Set(ids ? ids.split(',').map(Number) : []);
    if (panel !== null && !seen.has(panel.id)) {
      setPanel(null);
    }
    setPending((p) => (p.some((id) => !here.has(id)) ? p.filter((id) => here.has(id)) : p));
  }, [ids, openIds, panel]);
  /** A parked row that is unparked leaves the Parked view: its in-flight mark ends with it. */
  const parkedIds = backlog.parked.map((p) => p.node.id).join(',');
  useEffect(() => {
    const here = new Set(parkedIds ? parkedIds.split(',').map(Number) : []);
    setUnparking((u) => (u.some((id) => !here.has(id)) ? u.filter((id) => here.has(id)) : u));
  }, [parkedIds]);
  useEffect(() => {
    if (adding !== null) addField.current?.focus();
  }, [adding]);

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
  const unpark = async (id: number, toNext: boolean, li: HTMLElement | null, pressed: HTMLElement) => {
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
    // Drawn at once so the pressed button is enabled to take focus back, if the press left it nowhere.
    flushSync(() => setUnparking((u) => u.filter((x) => x !== id)));
    const now = document.activeElement;
    if (now === null || now === document.body || li?.contains(now)) pressed.focus();
    if (result === 'reload') window.location.reload();
    else onStatus?.(result);
  };
  const clearAll = () => {
    narrow('');
    filterField.current?.focus();
  };
  const toggleSomeday = () => {
    const open = !someday;
    setSomeday(open);
    saveFolds(projectId, { ...loadFolds(projectId), someday: open });
  };

  // ---- Drag (Ranked, from the handle only) ----
  const endDrag = () => {
    setDragging(null);
    setOver(undefined);
    setOverFold(false);
  };
  const startDrag = (e: DragEvent, id: number) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
    setDragging(id);
  };
  /** Over a row of a band: the top half drops before it, the bottom half before the step after it. */
  const overRow = (e: DragEvent, band: RankedBand, id: number) => {
    if (dragging === null) return;
    e.preventDefault();
    e.stopPropagation();
    setOverFold(false);
    const box = e.currentTarget.getBoundingClientRect();
    setOver({ band, before: dropSlot(lists[band], id, e.clientY < box.top + box.height / 2, dragging) });
  };
  /** Over a band's empty area or below its last row: the end of the band. */
  const overBand = (e: DragEvent, band: RankedBand) => {
    if (dragging === null) return;
    e.preventDefault();
    setOverFold(false);
    setOver({ band, before: null });
  };
  const drop = (e: DragEvent) => {
    if (dragging === null) return;
    e.preventDefault();
    e.stopPropagation();
    const target = overFold ? { band: 'someday' as const, before: bandOrder(snapshot.nodes, 'someday')[0]?.id ?? null } : over;
    const node = dragging;
    endDrag();
    if (!target) return;
    const op: RankOp = { node, to: target.band, before: target.before };
    // A drop that leaves the lists as they are writes nothing.
    const after = optimisticRank(lists, op);
    if (after.next.join() === lists.next.join() && after.soon.join() === lists.soon.join() && after.someday.join() === lists.someday.join()) return;
    noteAction('backlog', 'drop');
    void ranked.write(op);
  };
  /** Alt+Up / Alt+Down on a focused unowned Ranked row moves it one place within its band; the ends do nothing. */
  const moveKey = (e: KeyboardEvent<HTMLElement>, band: RankedBand, id: number) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.target !== e.currentTarget) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    // Key repeat while a move is out would send moves the window has not seen the result of: hold it back.
    if (e.repeat && ranked.writing()) {
      e.preventDefault();
      return;
    }
    const before = altMove(lists[band], id, e.key === 'ArrowUp' ? 'up' : 'down');
    if (before === undefined) return;
    e.preventDefault();
    noteAction('backlog', 'key_move');
    void ranked.write({ node: id, to: band, before });
  };

  const parents = new Set(snapshot.nodes.map((n) => n.parentId));
  /** The server refuses a step with any step under it, done or dropped ones too. */
  const hasKids = (id: number) => parents.has(id);
  const toNext = (id: number) => {
    noteAction('backlog', 'to_next');
    void ranked.write({ node: id, to: 'next', before: null });
  };

  const drawRow = (d: Drawn): ReactNode => {
    const { look } = d;
    if (d.parked) {
      const { node } = d.parked;
      const busy = unparking.includes(node.id);
      return (
        <ViewRow
          key={node.id}
          id={node.id}
          parked
          title={node.title}
          cursor={itemProps(0, rowAt.get(node.id)!)}
          phase={parentTitle({ row: d.parked }) ?? 'No phase'}
          inside={d.parked.openInside}
          label={node.label}
          age={node.parkedAt ? ageShort(node.parkedAt, now) : null}
          pending={busy}
          keepActs
          onOpen={rowClick('backlog', () => onOpenNode(node.id))}
          acts={
            <>
              <Button variant="ghost" size="sm" data-act disabled={busy} onClick={(e) => void unpark(node.id, true, e.currentTarget.closest('li'), e.currentTarget)}>to Next</Button>
              <Button variant="ghost" size="sm" data-act disabled={busy} onClick={(e) => void unpark(node.id, false, e.currentTarget.closest('li'), e.currentTarget)}>Unpark</Button>
            </>
          }
        >
          <p className="ip-bl-why">{`Parked ${node.parkedAt ? `${shortDate(node.parkedAt, now)}: ` : ': '}${node.parkedReason}`}</p>
          {node.parkedWhere && <p className="ip-bl-where">{`where ${node.parkedWhere}`}</p>}
        </ViewRow>
      );
    }
    const r = d.row!;
    const { row } = r;
    const id = row.node.id;
    const asking = confirming === id;
    const parking = panel?.kind === 'park' && panel.id === id;
    const waiting = pending.includes(id) || ranked.isPending(id);
    const rank = look.rank;
    return (
      <ViewRow
        key={id}
        id={id}
        title={row.node.title}
        cursor={itemProps(0, rowAt.get(id)!)}
        phase={look.phase ? parentTitle({ row }) : undefined}
        blocked={row.node.status === 'blocked'}
        inside={insideOf(id)}
        label={row.node.label}
        age={look.stale ? `untouched ${ageShort(r.touchedAt, now)}` : ageShort(row.node.createdAt, now)}
        pending={waiting}
        confirming={asking || parking}
        number={look.number}
        band={look.chip}
        handle={rank ? { onDragStart: (e) => startDrag(e, id), onDragEnd: endDrag } : undefined}
        dragging={dragging === id}
        dropBefore={rank !== undefined && over?.band === rank && over.before === id}
        // Over a row of a band that takes drops: the drop line. An own-queue row is no target.
        onDragOver={rank ? (e) => overRow(e, rank, id) : look.queued ? (e) => dragging !== null && e.stopPropagation() : undefined}
        onDrop={rank ? drop : undefined}
        // An open confirm or form is the row's own: a click on the row around it opens nothing.
        onOpen={asking || parking ? () => undefined : rowClick('backlog', () => onOpenNode(id))}
        // A press on the confirming row outside the confirm keeps focus in it (so Escape still closes it). A press
        // on the parking row outside its form puts focus in the form's reason field the same way.
        onMouseDown={asking ? (e) => {
          if ((e.target as HTMLElement).closest('.p-confirm button')) return;
          e.preventDefault();
          const confirm = e.currentTarget.querySelector<HTMLElement>('.p-confirm');
          if (confirm && !confirm.contains(document.activeElement)) confirm.querySelector<HTMLElement>('.p-confirm-acts button:last-child')?.focus();
        } : parking ? (e) => {
          if ((e.target as HTMLElement).closest('.ip-park input, .ip-park button')) return;
          e.preventDefault();
          const form = e.currentTarget.querySelector<HTMLElement>('.ip-park');
          if (form && !form.contains(document.activeElement)) form.querySelector<HTMLElement>('input')?.focus();
        } : undefined}
        onKeyDown={(e) => {
          // Escape anywhere in the confirming row closes the confirm.
          if (asking && e.key === 'Escape') {
            e.stopPropagation();
            cancel(id);
            return;
          }
          if (rank) moveKey(e, rank, id);
        }}
        acts={
          <>
            {!look.queued && (
              <Button variant="ghost" size="sm" data-act onClick={(e) => {
                cursorAfter(e.currentTarget.closest('li'))?.focus();
                toNext(id);
              }}>to Next</Button>
            )}
            {look.stale && (
              <Button variant="ghost" size="sm" data-act onClick={(e) => {
                noteAction('backlog', 'keep');
                const band = row.node.rankBand;
                if (!band) return;
                cursorAfter(e.currentTarget.closest('li'))?.focus();
                // A no-op move: it only stamps the step as touched, so it leaves Stale.
                void ranked.write({ node: id, to: band, before: keepBefore(snapshot.nodes, id) }, false);
              }}>Keep</Button>
            )}
            <Button variant="ghost" size="sm" data-act data-park aria-haspopup="dialog" onClick={(e) => {
              draft.current = { reason: '', where: '', focused: false };
              const target = cursorAfter(e.currentTarget.closest('li'));
              afterPark.current = target?.matches('li[data-node]') ? (target.dataset.node ?? null) : null;
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
              // The row's neighbours as they are now, while it is still among the open rows. Once the snapshot has
              // moved it into Parked (the answer and the snapshot land in either order), the neighbour worked out
              // when the form opened comes first, so focus stays where the row was.
              const stillOpen = here instanceof HTMLElement && here.closest('.ip-bl-parked') === null;
              const live = here instanceof HTMLElement ? cursorAfter(here) : null;
              const opened = afterPark.current ? root.current?.querySelector<HTMLElement>(`li[data-node="${afterPark.current}"]`) : null;
              ((stillOpen ? live ?? opened : opened ?? live) ?? titleRef.current)?.focus();
            }}
            onCancel={() => cancel(id)}
          />
        )}
        {asking && (
          <div className="ip-bl-panel" data-act>
            <Confirm
              question={`Delete #${id} ${row.node.title}?`}
              detail="It can't be undone."
              action="Delete"
              danger
              onConfirm={() => void remove(id, root.current?.querySelector<HTMLElement>(`li[data-node="${id}"]`) ?? null)}
              onCancel={() => cancel(id)}
            />
          </div>
        )}
      </ViewRow>
    );
  };
  const rowsOf = (list: BacklogRow[]) => list.map((r) => drawn.find((d) => d.id === r.row.node.id)).map((d) => (d ? drawRow(d) : null));
  const triageLink = (
    <Button variant="ghost" size="sm" onClick={() => pickView('triage')}>Triage ›</Button>
  );

  /** The "+ Add a step…" box at a foot, which swaps for the quick-add field. */
  const foot = (where: 'soon' | number, text: string, parent: number | null, aria: string) =>
    adding === where ? (
      <QuickAdd
        projectId={projectId}
        slug={slug}
        inputRef={addField}
        label={aria}
        parent={parent}
        band="soon"
        onStatus={onStatus}
        onClose={() => {
          setAdding(null);
          window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-add="${where}"]`)?.focus());
        }}
      />
    ) : (
      <button type="button" className="ip-bl-foot" data-add={where} onClick={() => { noteAction('backlog', 'add'); setAdding(where); }}>{text}</button>
    );

  /** One Ranked band: its head (glyph, name, count, hint), then its rows. */
  const bandSection = (name: string, band: RankedBand, glyph: '[!]' | '>>', rows: BacklogRow[], hint: string, extra?: ReactNode) => {
    const volt = band === 'next';
    const here = over?.band === band;
    const empty = rows.length === 0 && (!volt || ownedRows.length === 0);
    return (
      <section
        key={band}
        className={`ip-bl-band${here && empty ? ' drop-empty' : ''}`}
        aria-label={name}
        onDragOver={(e) => overBand(e, band)}
        onDrop={drop}
      >
        <header className="ip-bl-bhead">
          <Eyebrow glyph={glyph} glyphTone={volt ? 'volt' : 'dim'} />
          <h3 className="ip-bl-bname">{name}</h3>
          <span className="ip-bl-bright">
            <Count size="h3" tone={volt ? 'volt' : 'muted'} value={rows.length + (volt ? ownedRows.length : 0)} />
          </span>
          <p className="ip-bl-hint">{hint}</p>
        </header>
        {rows.length > 0 && <ul className={`ip-bl-list ranked${over?.band === band && over.before === null ? ' drop-end' : ''}`}>{rowsOf(rows)}</ul>}
        {extra}
      </section>
    );
  };

  const head = <PageHead code={code} name="BACKLOG" meta={backlogMeta(counts.phase.all, counts.phase.shown, counts.parked.all, filtering)} decodeKey={projectId} titleRef={titleRef} />;
  const emptyLine: Record<BacklogView, string> = {
    ranked: 'Nothing is ranked yet',
    phase: 'Backlog is empty',
    triage: 'Nothing to triage',
    stale: 'Nothing has gone quiet',
    parked: 'Nothing is parked',
  };
  const noMatch = filtering && counts[view].shown === 0 && counts[view].all > 0;

  let body: ReactNode;
  if (noMatch) {
    body = (
      <EmptyState className="ip-bl-none" action={<Button variant="ghost" size="sm" onClick={clearAll}>Clear filter</Button>}>
        {`Nothing matches “${query.trim()}”`}
      </EmptyState>
    );
  } else if (view === 'ranked') {
    body = counts.ranked.all === 0 ? (
      <EmptyState action={counts.triage.all > 0 ? triageLink : undefined}>{emptyLine.ranked}</EmptyState>
    ) : (
      <>
        {bandSection(
          'Next up',
          'next',
          '[!]',
          nextRows,
          'The next free session pulls #1',
          <>
            {nextRows.length === 0 && ownedRows.length === 0 && <p className="ip-bl-none-line">Nothing is queued. Drag a step here, or open one and press To Next.</p>}
            {owned.map((g) => (
              <div key={g.key} className="ip-bl-own">
                <Eyebrow glyph="//" className="ip-bl-ownhead">{`QUEUED BY ${g.title}`}</Eyebrow>
                <ul className="ip-bl-list ranked">{rowsOf(g.rows)}</ul>
              </div>
            ))}
          </>,
        )}
        {bandSection('Soon', 'soon', '>>', soonRows, 'Drag to rank')}
        <section
          className={`ip-bl-band${someday ? '' : ' ip-bl-fold'}${!someday && overFold ? ' drop-fold' : ''}`}
          aria-label="Someday"
          onDragOver={someday ? (e) => overBand(e, 'someday') : (e) => {
            if (dragging === null) return;
            e.preventDefault();
            setOver(undefined);
            setOverFold(true);
          }}
          onDrop={drop}
        >
          <header className="ip-bl-bhead">
            <Eyebrow glyph="//" glyphTone="dim" />
            <h3 className="ip-bl-bname">Someday</h3>
            <span className="ip-bl-bright">
              <Button variant="ghost" size="sm" aria-expanded={someday} onClick={toggleSomeday}>{someday ? 'Hide' : `Show ${somedayRows.length}`}</Button>
              <Count size="h3" tone="muted" value={somedayRows.length} />
            </span>
            <p className="ip-bl-hint">{someday ? 'Drag to rank' : 'Folded'}</p>
          </header>
          {someday && somedayRows.length > 0 && <ul className={`ip-bl-list ranked${over?.band === 'someday' && over.before === null ? ' drop-end' : ''}`}>{rowsOf(somedayRows)}</ul>}
        </section>
      </>
    );
  } else if (view === 'phase') {
    body = phases.length === 0 ? <EmptyState>{emptyLine.phase}</EmptyState> : (
      <>
        {phases.map((g) => (
          <section
            key={g.parent?.id ?? 0}
            className="ip-bl-group"
            aria-label={g.parent ? `Backlog under ${g.parent.title}` : 'Backlog with no phase'}
          >
            <header className="ip-bl-ghead">
              <Eyebrow glyph="[+]">{g.parent ? `#${g.parent.id} · ${g.boxes.length}` : `TOP LEVEL · ${g.boxes.length}`}</Eyebrow>
              <h3 className="ip-bl-gtitle" title={g.parent?.title ?? 'No phase'}>{g.parent ? g.parent.title : 'No phase'}</h3>
            </header>
            <ul className="ip-bl-list">{rowsOf(g.boxes)}</ul>
            {foot(g.parent?.id ?? 0, '+ Add a step', g.parent?.id ?? null, g.parent ? `Add a step under ${g.parent.title}` : 'Add a step with no phase')}
          </section>
        ))}
      </>
    );
  } else {
    const label = view === 'triage' ? 'Needs Triage' : view === 'stale' ? 'Stale' : 'Parked';
    body = drawn.length === 0 ? <EmptyState>{emptyLine[view]}</EmptyState> : (
      <section className={`ip-bl-group${view === 'parked' ? ' ip-bl-parked' : ''}`} aria-label={label}>
        {view === 'parked' && (
          <header className="ip-bl-ghead">
            <Eyebrow>{`PARKED · ${drawn.length}`}</Eyebrow>
          </header>
        )}
        <ul className="ip-bl-list">{drawn.map((d) => drawRow(d))}</ul>
      </section>
    );
  }

  return (
    <>
      {head}
      <div className="ip-bl" ref={root}>
        <div className="ip-bl-tools">
          <TabStrip variant="segmented" label="Backlog view" items={viewTabs(counts)} value={view} onChange={(id) => pickView(parseView(id))} />
          <Field
            ref={filterField}
            size="sm"
            className="ip-bl-filter"
            type="text"
            aria-label="Filter the backlog"
            placeholder="Filter…"
            value={query}
            onChange={(e) => narrow(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears a filter; in an empty field it does nothing here.
              if (e.key !== 'Escape' || !query) return;
              e.preventDefault();
              e.stopPropagation();
              narrow('');
            }}
          />
        </div>
        {view === 'ranked' && counts.triage.all > 0 && (
          <div className="ip-bl-notice" role="status">
            <span>{counts.triage.all === 1 ? '1 new step to rank' : `${counts.triage.all} new steps to rank`}</span>
            {triageLink}
          </div>
        )}
        {body}
        {view === 'ranked' && <div className="ip-bl-footwrap">{foot('soon', '+ Add a step to Soon…', null, 'Add a step to Soon')}</div>}
      </div>
    </>
  );
}
