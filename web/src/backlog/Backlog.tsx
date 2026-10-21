import { bandOrder, deriveBacklog, keepBefore, type BacklogRow, type BacklogView } from '../../../src/core/backlog';
import { deriveBoard, type ParkedRow } from '../../../src/core/board';
import { buildIndex, dfsOrder } from '../../../src/core/tree';
import { sessionDisplayTitle, type NodeLabel, type RankOp } from '../../../src/core/types';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { deleteStep, labelStep, moveStep, queueOp, unparkStep } from '../api';
import { groupByParent, parentTitle } from '../board/backlogOrder';
import type { BandProps } from '../board/bandProps';
import { dropSlot } from '../board/dragQueue';
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
import { altMove, backlogMatch, backlogMeta, cursorAfter, moveTopBefore, nextTopBefore, openInsideIndex, optimisticRank, parseView, phaseOptions, phaseValue, viewKey, viewTabs } from './backlogView';
import { Inspector } from './Inspector';
import { useInspectorWrites } from './useInspectorWrites';
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
/** A row's first line in px: `.ip-bl-row`'s min-height in backlog.css. A drop's half is measured on it. */
const ROW_LINE = 36;

/**
 * The full Backlog (the view behind "N ›"): the page head, the views strip and the filter, then the open view. Ranked is the
 * default: Next up (the queue), Soon and a folded Someday, ranked by drag or Alt+arrows; By Phase groups every open step
 * under its parent; Needs Triage lists the steps nobody has ranked; Stale the ones left alone; Parked the ones set aside.
 * A row shows "to Next" (not in Next up) and "Keep" (Stale) on hover and on focus; a parked row shows "to Next" and "Unpark".
 * A click, Enter or Space on a row opens its inspector under it (one at a time, in every view): the body, the Phase, Label and
 * Band selects, and the buttons, among them "Park…" and "Delete…", whose form and confirm replace the button column. Escape
 * closes the inspector and puts focus on its row. The filter, the view and the picked row are this component's state (the view
 * is kept per project). Every row of the page is one Tab stop.
 */
export function Backlog({ snapshot, now, projectId, slug, code, titleRef, onStatus, onOpenNode, onOpenResource }: Pick<BandProps, 'snapshot' | 'now' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
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
  /** The row whose inspector is open: one at a time, in every view. */
  const [picked, setPicked] = useState<number | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  /** The control to focus once its step is drawn again after an inspector write that moved the row (that control's `data-insp`). */
  const want = useRef<{ id: number; ctl: string } | null>(null);
  const wantTimer = useRef(0);
  const confirming = panel?.kind === 'delete' ? panel.id : null;
  /** A view switch or a new filter closes an open Delete confirm: its row may move away from where the user was looking. An open Park form stays (and keeps what was typed) while its row is still shown. */
  const closePanel = () => setPanel((p) => (p?.kind === 'delete' ? null : p));
  const pickView = (v: BacklogView) => {
    setPanel(null);
    setPicked(null);
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
  const ranked = useRankedOrder({ backlog, snapshot, projectId, slug, query, onStatus });
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
  /** Opens the row's inspector, or closes it; another row's open panel closes with the move. */
  const toggle = (id: number) => {
    noteAction('backlog', 'inspect');
    const open = pickedRef.current !== id;
    if (open) insp.forget(id);
    setPicked(open ? id : null);
    setPanel((p) => (p !== null && (p.id !== id || !open) ? null : p));
  };
  const { itemProps } = useListCursor(
    [rowIds.length],
    (at) => {
      const id = rowIds[at.row];
      // A row asking or parking is busy with its own panel: Enter on it opens nothing.
      if (id === undefined || panelRef.current?.id === id) return;
      toggle(id);
    },
    [rowIds.map(String)],
  );

  useEffect(() => () => window.clearTimeout(wantTimer.current), []);
  // After a Band or Phase change that redraws the row elsewhere: if focus fell to the page, it goes back to the select. A layout
  // effect declared before useKeepRowFocus's, so it runs first and the row's `li` has not taken the focus. It holds while focus
  // stays in the step's row: the row may be redrawn more than once (the guess, then the snapshot, or a refusal's restore).
  useLayoutEffect(() => {
    const w = want.current;
    if (!w) return;
    const active = document.activeElement;
    const target = root.current?.querySelector<HTMLElement>(`li[data-node="${w.id}"]`);
    const lost = active === null || active === document.body;
    // Gone from the view, or focus moved on out of the row: nothing to give back.
    if (!rowIds.includes(w.id) || (!lost && !target?.contains(active))) {
      want.current = null;
      return;
    }
    if (target && lost) (target.querySelector<HTMLElement>(`[data-insp="${w.ctl}"]`) ?? target).focus();
  });
  /** Notes the control a Band or Phase change was made from, for the effect above; given up after 3 s. */
  const follow = (id: number, ctl: string) => {
    want.current = { id, ctl };
    window.clearTimeout(wantTimer.current);
    wantTimer.current = window.setTimeout(() => {
      want.current = null;
    }, 3000);
  };
  /** The value each inspector select shows in the snapshot, for the writes to settle on. */
  const shownValue = (id: number, sel: 'phase' | 'label' | 'band'): string | undefined => {
    const node = snapshot.nodes.find((n) => n.id === id);
    if (!node) return undefined;
    if (sel === 'phase') return String(phaseValue(snapshot.project.rootNodeId, node.parentId) ?? 'none');
    if (sel === 'label') return node.label ?? 'none';
    return drawn.find((d) => d.id === id)?.row?.band ?? '';
  };
  const insp = useInspectorWrites(shownValue, (id) => pickedRef.current === id, (text) => onStatus?.(text));

  // A row that leaves through a write from elsewhere hands its focus to a neighbour (or the page title).
  useKeepRowFocus(root, rowIds, titleRef);
  const insideOf = useMemo(() => openInsideIndex(snapshot.nodes), [snapshot.nodes]);
  const ids = rowIds.join(',');
  // The unfiltered board: a row the filter hides is still here, so a delete in flight keeps waiting.
  const openIds = [...board.next, ...board.backlog].map((r) => r.node.id).join(',');
  // A row that left (deleted here or elsewhere) no longer waits. An open row no longer shown (it left, or a change elsewhere
  // took it out of the filter) no longer has its panel open; if it took focus with it, useKeepRowFocus has moved it.
  useEffect(() => {
    const here = new Set(openIds ? openIds.split(',').map(Number) : []);
    const seen = new Set(ids ? ids.split(',').map(Number) : []);
    if (panel !== null && !seen.has(panel.id)) {
      setPanel(null);
    }
    // The inspector follows its step while the step is drawn; once it leaves the view, it closes.
    if (picked !== null && !seen.has(picked)) setPicked(null);
    setPending((p) => (p.some((id) => !here.has(id)) ? p.filter((id) => here.has(id)) : p));
  }, [ids, openIds, panel, picked]);
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
  // A row remounted mid-drag sends its dragend from a detached node, which reaches no listener. The browser sends no mouse
  // events while a native drag runs, so the first mousemove after one means it has ended, however it ended.
  useEffect(() => {
    if (dragging === null) return;
    for (const type of ['dragend', 'drop', 'mousemove']) document.addEventListener(type, endDrag);
    return () => {
      for (const type of ['dragend', 'drop', 'mousemove']) document.removeEventListener(type, endDrag);
    };
  }, [dragging]);
  /** Over a row of a band: the top half drops before it, the bottom half before the step after it. */
  const overRow = (e: DragEvent, band: RankedBand, id: number) => {
    if (dragging === null) return;
    e.preventDefault();
    e.stopPropagation();
    setOverFold(false);
    // The half is of the row's first line: an open inspector under a picked row is not part of it.
    const box = e.currentTarget.getBoundingClientRect();
    const before = dropSlot(lists[band], id, e.clientY < box.top + Math.min(box.height, ROW_LINE) / 2, dragging);
    setOver((p) => (p?.band === band && p.before === before ? p : { band, before }));
  };
  /** Over a band's empty area or below its last row: the end of the band. */
  const overBand = (e: DragEvent, band: RankedBand) => {
    if (dragging === null) return;
    e.preventDefault();
    setOverFold(false);
    setOver((p) => (p?.band === band && p.before === null ? p : { band, before: null }));
  };
  const drop = (e: DragEvent) => {
    if (dragging === null) return;
    e.preventDefault();
    e.stopPropagation();
    const node = dragging;
    let target = over;
    // The folded head drops at the top of Someday. A queued step keeps its band, so the first member may be the dragged step itself.
    let guess: RankOp | undefined;
    if (overFold) {
      target = { band: 'someday', before: bandOrder(snapshot.nodes, 'someday').find((n) => n.id !== node)?.id ?? null };
      // The window may hold only the rows the filter keeps: its guess puts the step first among those.
      guess = { node, to: 'someday', before: lists.someday.find((id) => id !== node) ?? null };
    }
    endDrag();
    if (!target) return;
    const op: RankOp = { node, to: target.band, before: target.before };
    // A drop that leaves the lists as they are writes nothing.
    const after = optimisticRank(lists, guess ?? op);
    if (after.next.join() === lists.next.join() && after.soon.join() === lists.soon.join() && after.someday.join() === lists.someday.join()) return;
    noteAction('backlog', 'drop');
    void ranked.write(op, guess ?? true);
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
  /** The row actions, by the element pressed (focus moves to the neighbour first, as the row leaves). */
  const toNext = (id: number, from: HTMLElement | null) => {
    noteAction('backlog', 'to_next');
    cursorAfter(from?.closest('li') ?? null)?.focus();
    void ranked.write({ node: id, to: 'next', before: null });
  };
  const keep = (id: number, from: HTMLElement | null) => {
    noteAction('backlog', 'keep');
    const band = snapshot.nodes.find((n) => n.id === id)?.rankBand;
    if (!band) return;
    cursorAfter(from?.closest('li') ?? null)?.focus();
    // A no-op move: it only stamps the step as touched, so it leaves Stale.
    void ranked.write({ node: id, to: band, before: keepBefore(snapshot.nodes, id) }, false);
  };
  const openPark = (id: number, from: HTMLElement | null) => {
    draft.current = { reason: '', where: '', focused: false };
    const target = cursorAfter(from?.closest('li') ?? null);
    afterPark.current = target?.matches('li[data-node]') ? (target.dataset.node ?? null) : null;
    setPanel({ kind: 'park', id });
  };
  const askDelete = (id: number) => setPanel({ kind: 'delete', id });
  const drawnBy = new Map(drawn.map((d) => [d.id, d]));
  /** The unfiltered Next up queue's unowned steps, and every backlog step: what Move to top reads. */
  const unownedNext = board.next.filter((r) => r.owner === null).map((r) => r.node.id);
  const backlogIds = new Set(board.backlog.map((r) => r.node.id));
  /** A click on a row (not on a button or field of its own) opens or closes its inspector. */
  const clickRow = (id: number) => (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-act], input, textarea')) return;
    toggle(id);
  };
  /** Space on the focused row opens or closes its inspector, as Enter does. */
  const spaceKey = (e: KeyboardEvent<HTMLElement>, id: number) => {
    if (e.key !== ' ' || e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    if (panelRef.current?.id !== id) toggle(id);
  };
  /** Escape on the row or in its inspector closes the inspector and puts focus on its row; false when none is open there. */
  const escapeKey = (e: KeyboardEvent<HTMLElement>, id: number): boolean => {
    if (e.key !== 'Escape' || pickedRef.current !== id) return false;
    e.preventDefault();
    e.stopPropagation();
    setPicked(null);
    setPanel((p) => (p?.id === id ? null : p));
    e.currentTarget.focus();
    return true;
  };
  /** A step's last session: the newer of the one `stepTouches` lists and the newest sign of a session that has it as focus. */
  const lastSessionOf = (id: number): string | null => {
    let best = snapshot.stepTouches.find((t) => t.nodeId === id)?.sessionAt ?? null;
    for (const s of snapshot.sessions) if (s.focusNodeId === id && (best === null || s.lastSeenAt > best)) best = s.lastSeenAt;
    return best;
  };
  /** The Phase and Label selects' writes: `'reload'` reloads the window; a refusal goes back to the select, which says it. */
  const selectWrite = async (write: Promise<string>): Promise<string> => {
    const result = await write;
    if (result === 'reload') window.location.reload();
    return result;
  };
  /** Back to Backlog: the step leaves the queue and returns to its band. */
  const backToBacklog = async (id: number) => {
    noteAction('backlog', 'back_to_backlog');
    const result = await queueOp(projectId, slug, { kind: 'remove', node: id });
    if (result === 'reload') window.location.reload();
    else if (result !== 'ok') onStatus?.(result);
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
          picked={picked === node.id}
          onOpen={clickRow(node.id)}
          onKeyDown={(e) => {
            if (!escapeKey(e, node.id)) spaceKey(e, node.id);
          }}
          acts={
            <>
              <Button variant="ghost" size="sm" data-act disabled={busy} onClick={(e) => void unpark(node.id, true, e.currentTarget.closest('li'), e.currentTarget)}>to Next</Button>
              <Button variant="ghost" size="sm" data-act disabled={busy} onClick={(e) => void unpark(node.id, false, e.currentTarget.closest('li'), e.currentTarget)}>Unpark</Button>
            </>
          }
        >
          <p className="ip-bl-why">{`Parked ${node.parkedAt ? `${shortDate(node.parkedAt, now)}: ` : ': '}${node.parkedReason}`}</p>
          {node.parkedWhere && <p className="ip-bl-where">{`where ${node.parkedWhere}`}</p>}
          {picked === node.id && (
            <Inspector
              id={node.id}
              node={node}
              inside={d.parked.openInside}
              band={null}
              parked={{ reason: node.parkedReason ?? '', where: node.parkedWhere ?? null, at: node.parkedAt ?? null }}
              handoff={null}
              docs={snapshot.resources.filter((r) => r.nodeId === node.id)}
              lastSession={lastSessionOf(node.id)}
              phases={[]}
              phase={null}
              can={{ toNext: false, backToBacklog: false, moveTop: false, keep: false, park: false, remove: false, unpark: true }}
              panel={null}
              now={now}
              state={insp.stateOf(node.id)}
              onChange={() => undefined}
              onToNext={() => undefined}
              onBackToBacklog={() => undefined}
              onMoveTop={() => undefined}
              onKeep={() => undefined}
              onPark={() => undefined}
              onDelete={() => undefined}
              onOpenDetails={() => {
                noteAction('backlog', 'open');
                onOpenNode(node.id);
              }}
              onUnpark={(toNext, from) => {
                if (!busy) void unpark(node.id, toNext, from.closest('li'), from);
              }}
              onOpenResource={onOpenResource}
            />
          )}
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
    const open = picked === id;
    /** The band as drawn: Ranked's lists show a write at once, before the snapshot says it. */
    const band = rank ?? r.band;
    const owned = row.owner !== null;
    const panelNode = parking ? (
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
          // The row's neighbours as they are now, while it is still drawn. Once the snapshot has dropped it (the answer
          // and the snapshot land in either order), the neighbour worked out when the form opened takes focus.
          const live = here instanceof HTMLElement ? cursorAfter(here) : null;
          const opened = afterPark.current ? root.current?.querySelector<HTMLElement>(`li[data-node="${afterPark.current}"]`) : null;
          (live ?? opened ?? titleRef.current)?.focus();
        }}
        onCancel={() => cancel(id)}
      />
    ) : asking ? (
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
    ) : null;
    // Move to top: where the step goes before, or undefined when it is already first (or its order is a session's).
    const top: { to: 'next' | 'soon' | 'someday'; before: number | null } | undefined = (() => {
      if (band === 'next') {
        const before = owned ? undefined : nextTopBefore(unownedNext, id);
        return before === undefined ? undefined : { to: 'next', before };
      }
      if (band !== 'soon' && band !== 'someday') return undefined;
      const before = moveTopBefore(snapshot.nodes, backlogIds, id, band);
      return before === undefined ? undefined : { to: band, before };
    })();
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
        picked={open}
        number={look.number}
        band={look.chip}
        handle={rank ? { onDragStart: (e) => startDrag(e, id), onDragEnd: endDrag } : undefined}
        dragging={dragging === id}
        dropBefore={rank !== undefined && over?.band === rank && over.before === id}
        // Over a row of a band that takes drops: the drop line. An own-queue row is no target.
        onDragOver={rank ? (e) => overRow(e, rank, id) : look.queued ? (e) => {
          if (dragging === null) return;
          e.stopPropagation();
          setOver(undefined);
          setOverFold(false);
        } : undefined}
        onDrop={rank ? drop : undefined}
        // An open confirm or form is the row's own: a click on the row around it opens nothing.
        onOpen={asking || parking ? () => undefined : clickRow(id)}
        // A press on the confirming row outside the confirm keeps focus in it (so Escape still closes it). A press
        // on the parking row outside its form puts focus in the form's reason field the same way.
        onMouseDown={asking ? (e) => {
          if ((e.target as HTMLElement).closest('.p-confirm button, .ip-insp-main')) return;
          e.preventDefault();
          const confirm = e.currentTarget.querySelector<HTMLElement>('.p-confirm');
          if (confirm && !confirm.contains(document.activeElement)) confirm.querySelector<HTMLElement>('.p-confirm-acts button:last-child')?.focus();
        } : parking ? (e) => {
          if ((e.target as HTMLElement).closest('.ip-park input, .ip-park button, .ip-insp-main')) return;
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
          if (escapeKey(e, id)) return;
          spaceKey(e, id);
          if (rank) moveKey(e, rank, id);
        }}
        acts={
          <>
            {!look.queued && (
              // A double-click's second press lands on whatever slid under the pointer: it does nothing.
              <Button variant="ghost" size="sm" data-act onClick={(e) => e.detail <= 1 && toNext(id, e.currentTarget)}>to Next</Button>
            )}
            {look.stale && (
              <Button variant="ghost" size="sm" data-act onClick={(e) => e.detail <= 1 && keep(id, e.currentTarget)}>Keep</Button>
            )}
          </>
        }
      >
        {open && (
          <Inspector
            id={id}
            node={row.node}
            inside={insideOf(id)}
            band={band}
            handoff={row.handoff}
            docs={snapshot.resources.filter((x) => x.nodeId === id)}
            lastSession={lastSessionOf(id)}
            phases={phaseOptions(snapshot.nodes, snapshot.project.rootNodeId, row.node.parentId)}
            phase={phaseValue(snapshot.project.rootNodeId, row.node.parentId)}
            can={{ toNext: band !== 'next', backToBacklog: band === 'next', moveTop: top !== undefined, keep: look.stale === true, park: true, remove: !hasKids(id), unpark: false }}
            panel={panelNode}
            now={now}
            state={insp.stateOf(id)}
            deleting={pending.includes(id)}
            onChange={(sel, v) => {
              if (sel === 'band') {
                // An own-queue step is drawn under its session, never in a band's list: no guess for it.
                insp.change(id, sel, v, () => {
                  follow(id, 'band');
                  return ranked.write({ node: id, to: v as 'next' | 'soon' | 'someday', before: null }, !owned, true);
                });
              } else if (sel === 'phase') {
                insp.change(id, sel, v, () => {
                  // By Phase regroups the row under its new parent once the snapshot lands.
                  follow(id, 'phase');
                  return selectWrite(moveStep(projectId, slug, id, v === 'none' ? null : Number(v)));
                });
              } else {
                insp.change(id, sel, v, () => selectWrite(labelStep(projectId, slug, id, v === 'none' ? null : (v as NodeLabel))));
              }
            }}
            onToNext={() => {
              noteAction('backlog', 'to_next');
              void ranked.write({ node: id, to: 'next', before: null });
            }}
            onBackToBacklog={() => void backToBacklog(id)}
            onMoveTop={() => {
              if (!top) return;
              noteAction('backlog', 'move_top');
              void ranked.write({ node: id, to: top.to, before: top.before });
            }}
            onKeep={(from) => keep(id, from)}
            onPark={(from) => openPark(id, from)}
            onDelete={() => askDelete(id)}
            onOpenDetails={() => {
              noteAction('backlog', 'open');
              onOpenNode(id);
            }}
            onUnpark={() => undefined}
            onOpenResource={onOpenResource}
          />
        )}
      </ViewRow>
    );
  };
  const rowsOf = (list: BacklogRow[]) => list.map((r) => drawnBy.get(r.row.node.id)).map((d) => (d ? drawRow(d) : null));
  const triageLink = (
    <Button variant="ghost" size="sm" onClick={() => {
      pickView('triage');
      // The button leaves with the view: focus goes to the tab of the view it opened.
      window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.ip-bl-tools .p-tab[aria-pressed="true"]')?.focus());
    }}>Triage ›</Button>
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
    const empty = rows.length === 0;
    return (
      <section
        key={band}
        className={`ip-bl-band${here && over.before === null && empty ? ' drop-empty' : ''}`}
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
            {board.next.length === 0 && <p className="ip-bl-none-line">Nothing is queued. Drag a step here, or open one and press To Next.</p>}
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
          className={`ip-bl-band${someday ? '' : ' ip-bl-fold'}${!someday && overFold ? ' drop-fold' : ''}${someday && somedayRows.length === 0 && over?.band === 'someday' && over.before === null ? ' drop-empty' : ''}`}
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
              {(someday || somedayRows.length > 0) && <Button variant="ghost" size="sm" aria-expanded={someday} onClick={toggleSomeday}>{someday ? 'Hide' : `Show ${somedayRows.length}`}</Button>}
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
