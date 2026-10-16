import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { BoardRow } from '../../../src/core/board';
import { sessionTag, type QueueOp } from '../../../src/core/types';
import { postEvent, queueOp } from '../api';
import { Backlog } from './Backlog';
import { dropSlot, dropToOp, optimisticNext } from './dragQueue';
import { focusTargetAfter } from './focus';
import { endedLine, LabelChip, rowClick, StepMarks } from './Marks';
import { noteAction } from '../measure';
import { QuickAdd } from './QuickAdd';
import type { BandProps } from './bandProps';

const hue = (slot: number | null) => `var(--family-${(slot ?? 0) % 6})`;
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
/** ①②③ for the first twenty places, the plain number after. */
export const numeral = (n: number) => (n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1]! : String(n));

/** The order the window shows until the next snapshot lands, and the step it moved (which is no longer in anyone's own queue). */
interface Pending {
  ids: number[];
  moved: number;
}

/** Next as a numbered rail, and the Backlog fold at its foot (spec 2.2, 2.5, 2.8). */
export function NextColumn({ snapshot, board, now, wide, onOpenNode, onOpenResource, onStatus }: BandProps) {
  const { project } = snapshot;
  const [pending, setPending] = useState<Pending | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  /** Where a drop would land: the unowned step it goes before, or null for the end of the unowned queue; undefined when over nothing. */
  const [slot, setSlot] = useState<number | null | undefined>(undefined);
  const [overBacklog, setOverBacklog] = useState(false);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const clearTimer = useRef(0);

  // The server's event brings a new snapshot; it replaces what the window guessed once it shows the order the guess was of.
  // Until then (an event for something else, say) the guess stays; the timer after a write is the fallback.
  useEffect(() => {
    const order = board.next.map((r) => r.node.id).join();
    setPending((p) => (p && p.ids.join() === order ? null : p));
  }, [snapshot]);
  useEffect(() => () => window.clearTimeout(clearTimer.current), []);
  useEffect(() => {
    if (focusTick > 0) field.current?.focus();
  }, [focusTick]);

  const rowsOf = (ids: number[]): BoardRow[] => ids.flatMap((id) => board.byId.get(id) ?? []);
  const nextIds = pending ? pending.ids : board.next.map((r) => r.node.id);
  const next = rowsOf(nextIds);
  const ownerOf = (row: BoardRow) => (pending?.moved === row.node.id ? null : row.owner);
  const shown = next.map((r) => ({ node: r.node, owner: ownerOf(r) }));
  const unowned = next.filter((r) => !ownerOf(r));
  const owned = next.filter((r) => ownerOf(r));
  const inNext = new Set(nextIds);
  // A step sent back shows in Backlog at once; one pulled into Next leaves it.
  const backlog = pending ? [...board.backlog.filter((r) => !inNext.has(r.node.id)), ...board.next.filter((r) => !inNext.has(r.node.id))] : board.backlog;
  const slotOf = (id: string) => snapshot.sessions.find((s) => s.id === id)?.slot ?? null;

  const write = async (op: QueueOp) => {
    window.clearTimeout(clearTimer.current);
    setPending({ ids: optimisticNext(shown, op), moved: op.node });
    const result = await queueOp(project.id, project.slug, op);
    if (result === 'ok') {
      // Normally the snapshot clears this first; a move that changed nothing sends none.
      clearTimer.current = window.setTimeout(() => setPending(null), 2000);
      return;
    }
    setPending(null);
    if (result === 'reload') window.location.reload();
    else onStatus?.(result);
  };
  const toNext = (id: number) => write(dropToOp(id, { zone: 'next', before: null }));
  const toBacklog = (id: number) => write(dropToOp(id, { zone: 'backlog' }));
  const endDrag = () => {
    setDragging(null);
    setSlot(undefined);
    setOverBacklog(false);
  };
  const startDrag = (e: DragEvent, id: number) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
    setDragging(id);
  };

  /** Over a row: the top half drops before it, the bottom half before the next unowned step. An own-queue row drops at the end. */
  const overRow = (e: DragEvent, row: BoardRow) => {
    if (dragging === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (!unowned.some((r) => r.node.id === row.node.id)) return setSlot(null);
    const box = e.currentTarget.getBoundingClientRect();
    setSlot(dropSlot(unowned.map((r) => r.node.id), row.node.id, e.clientY < box.top + box.height / 2, dragging));
  };
  const dropInNext = (e: DragEvent) => {
    if (dragging === null) return;
    e.preventDefault();
    e.stopPropagation();
    const op = dropToOp(dragging, { zone: 'next', before: slot ?? null });
    // A drop that leaves the order as it is writes nothing.
    const same = optimisticNext(shown, op).join() === nextIds.join();
    endDrag();
    noteAction('next', 'drop');
    if (!same) void write(op);
  };
  const dropOnBacklog = (e: DragEvent) => {
    // Never also a drop into the column around it.
    e.stopPropagation();
    if (dragging === null || !inNext.has(dragging)) return;
    e.preventDefault();
    const id = dragging;
    endDrag();
    noteAction('backlog', 'drop');
    void toBacklog(id);
  };

  const openFold = () => {
    setOpen(true);
    postEvent('backlog_open', project.id);
  };
  const toggleFold = () => {
    noteAction('backlog', 'fold');
    if (open) {
      setOpen(false);
      setAdding(false);
    } else {
      openFold();
      setAdding(true);
    }
  };
  const addClick = () => {
    noteAction('backlog', 'add');
    if (!open) openFold();
    setAdding(true);
    setFocusTick((t) => t + 1);
  };
  const closeAdd = () => {
    setAdding(false);
    addButton.current?.focus();
  };

  const nextRow = (row: BoardRow, number: number | null) => {
    const owner = ownerOf(row);
    const ended = endedLine(row, snapshot.pastSessions, slotOf, now);
    return (
      <li
        key={row.node.id}
        className={`ip-row ip-next-row${slot === row.node.id ? ' drop-before' : ''}${dragging === row.node.id ? ' dragging' : ''}`}
        data-node={row.node.id}
        draggable
        onDragStart={(e) => startDrag(e, row.node.id)}
        onDragEnd={endDrag}
        onDragOver={(e) => overRow(e, row)}
        onDrop={dropInNext}
        onClick={rowClick('next', () => onOpenNode(row.node.id))}
      >
        <span className={`ip-num${owner ? ' ip-letter' : ''}`} style={owner ? { color: hue(owner.slot) } : undefined} aria-label={owner ? `${sessionTag(owner.slot)} own queue` : `number ${number}`}>
          {owner ? sessionTag(owner.slot) || '?' : numeral(number ?? 0)}
        </span>
        <div className="ip-next-body">
          <div className="ip-line">
            <span className="ip-title-line">
              <span className="ip-step-id">#{row.node.id}</span>
              <button type="button" className="ip-row-title">{row.node.title}</button>
            </span>
            <button type="button" className="ip-hover-act" data-act onClick={(e) => {
                noteAction('next', 'to_backlog');
                focusTargetAfter(e.currentTarget.closest('li'))?.focus();
                void toBacklog(row.node.id);
              }}>back to Backlog</button>
          </div>
          <div className="ip-next-meta">
            <LabelChip label={row.node.label} />
            {!row.ready && <span className="ip-mark ask">not ready</span>}
            <StepMarks row={row} now={now} onOpenResource={onOpenResource} />
            {wide && row.crumb.length > 0 && <span className="ip-crumb">{row.crumb.map((c) => c.title).join(' › ')}</span>}
          </div>
          {ended && <div className="ip-system-line">{ended}</div>}
        </div>
      </li>
    );
  };

  // Own-queue entries run together per session: one line for each.
  const ownedGroups: { key: string; slot: number | null; rows: BoardRow[] }[] = [];
  for (const row of owned) {
    const o = ownerOf(row)!;
    const last = ownedGroups[ownedGroups.length - 1];
    if (last && last.key === o.id) last.rows.push(row);
    else ownedGroups.push({ key: o.id, slot: o.slot, rows: [row] });
  }

  return (
    <div
      className="ip-next"
      onDragOver={(e) => {
        if (dragging === null) return;
        e.preventDefault();
        setSlot(null);
      }}
      onDrop={dropInNext}
    >
      {next.length === 0 && <p className="ip-quiet ip-empty-line">Nothing is queued</p>}
      {unowned.length > 0 && (
        <ol className={`ip-rail${slot === null ? ' drop-end' : ''}`} aria-label="Next">
          {unowned.map((row, i) => nextRow(row, i + 1))}
        </ol>
      )}
      {ownedGroups.map((g) => (
        <div key={g.key} className="ip-own-queue">
          <div className="ip-own-head">{`${sessionTag(g.slot) || '?'}'s own queue`}</div>
          <ol className="ip-rail">{g.rows.map((row) => nextRow(row, null))}</ol>
        </div>
      ))}
      <div
        className={`ip-backlog${overBacklog ? ' drop-here' : ''}`}
        onDragOver={(e) => {
          if (dragging === null) return;
          // Backlog is not a drop target for what is already in it, and the column above must not take the drop instead.
          e.stopPropagation();
          if (!inNext.has(dragging)) return;
          e.preventDefault();
          setSlot(undefined);
          setOverBacklog(true);
        }}
        onDragLeave={() => setOverBacklog(false)}
        onDrop={dropOnBacklog}
      >
        <div className="ip-rail-foot">
          <button type="button" className="ip-fold" aria-expanded={open} onClick={toggleFold}>
            {`Backlog · ${backlog.length} ${open ? '▾' : '▸'}`}
          </button>
          <button type="button" ref={addButton} className="ip-link-btn ip-add" onClick={addClick}>+ add</button>
        </div>
        {open && (
          <>
            <Backlog rows={backlog} snapshot={snapshot} now={now} projectId={project.id} slug={project.slug} onStatus={onStatus} onOpenNode={onOpenNode} onOpenResource={onOpenResource} onDragStart={setDragging} onDragEnd={endDrag} onToNext={toNext} />
            {adding && <QuickAdd projectId={project.id} slug={project.slug} inputRef={field} onStatus={onStatus} onClose={closeAdd} />}
          </>
        )}
      </div>
    </div>
  );
}
