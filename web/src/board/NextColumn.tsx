import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { BoardRow } from '../../../src/core/board';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { sessionDisplayTitle, type QueueOp } from '../../../src/core/types';
import { postEvent, queueOp } from '../api';
import { Backlog } from './Backlog';
import { dropSlot, dropToOp, optimisticNext } from './dragQueue';
import { focusTargetAfter } from './focus';
import { endedLine } from './Marks';
import { noteAction } from '../measure';
import { QuickAdd } from './QuickAdd';
import type { BandProps } from './bandProps';
import { TaskBox } from './TaskBox';

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
/** ①②③ for the first twenty places, the plain number after. */
export const numeral = (n: number) => (n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1]! : String(n));

/** The order the window shows until the next snapshot lands, and the step it moved (which is no longer in anyone's own queue). */
interface Pending {
  ids: number[];
  moved: number;
}

/** Next as boxes in queue order, and the Backlog fold at its foot (spec 2.2, 2.5, 2.8). */
export function NextColumn({ snapshot, board, boxes, now, onOpenNode, onOpenResource, onStatus }: BandProps) {
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
    const order = boxes.next.map((b) => b.row!.node.id).join();
    setPending((p) => (p && p.ids.join() === order ? null : p));
  }, [snapshot]);
  useEffect(() => () => window.clearTimeout(clearTimer.current), []);
  useEffect(() => {
    if (focusTick > 0) field.current?.focus();
  }, [focusTick]);

  // Every task shows once: Next holds the boxes in the next cell, Backlog the ones in the backlog cell. A step in any other
  // cell (it has a session, an ask, ...) shows there, and neither list names it.
  const boxOf = new Map<number, BoxData>();
  for (const cell of ['next', 'backlog'] as const) for (const b of boxes[cell]) boxOf.set(b.row!.node.id, b);
  /** Dragged into Next and not yet confirmed, a backlog box reads as Ready. */
  const asNext = (b: BoxData): BoxData => (b.state === 'backlog' ? { ...b, cell: 'next', state: 'ready' } : b);
  const nextIds = pending ? pending.ids.filter((id) => boxOf.has(id)) : boxes.next.map((b) => b.row!.node.id);
  const next = nextIds.map((id) => asNext(boxOf.get(id)!));
  const ownerOf = (row: BoardRow) => (pending?.moved === row.node.id ? null : row.owner);
  const shown = next.map((b) => ({ node: b.row!.node, owner: ownerOf(b.row!) }));
  const unowned = next.filter((b) => !ownerOf(b.row!));
  const owned = next.filter((b) => ownerOf(b.row!));
  const inNext = new Set(nextIds);
  // A step sent back shows in Backlog at once; one pulled into Next leaves it.
  const backlogIds = pending ? [...board.backlog, ...board.next].map((r) => r.node.id).filter((id) => !inNext.has(id) && boxOf.has(id)) : boxes.backlog.map((b) => b.row!.node.id);
  /** Sent back from Next and not yet confirmed, a ready box reads as Backlog. */
  const asBacklog = (b: BoxData): BoxData => (b.state === 'ready' ? { ...b, cell: 'backlog', state: 'backlog' } : b);
  const backlog = backlogIds.map((id) => asBacklog(boxOf.get(id)!));

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
    if (!unowned.some((b) => b.row!.node.id === row.node.id)) return setSlot(null);
    const box = e.currentTarget.getBoundingClientRect();
    setSlot(dropSlot(unowned.map((b) => b.row!.node.id), row.node.id, e.clientY < box.top + box.height / 2, dragging));
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

  const nextRow = (box: BoxData) => {
    const row = box.row!;
    return (
      <TaskBox
        key={row.node.id}
        box={box}
        now={now}
        area="next"
        docs={snapshot.resources.filter((r) => r.nodeId === row.node.id).length}
        system={endedLine(row, snapshot.pastSessions, now)}
        className={`ip-next-row${slot === row.node.id ? ' drop-before' : ''}${dragging === row.node.id ? ' dragging' : ''}`}
        li={{
          draggable: true,
          onDragStart: (e) => startDrag(e, row.node.id),
          onDragEnd: endDrag,
          onDragOver: (e) => overRow(e, row),
          onDrop: dropInNext,
        }}
        extra={
          <button type="button" className="ip-hover-act" data-act onClick={(e) => {
            noteAction('next', 'to_backlog');
            focusTargetAfter(e.currentTarget.closest('li'))?.focus();
            void toBacklog(row.node.id);
          }}>back to Backlog</button>
        }
        onOpenNode={onOpenNode}
        onOpenResource={onOpenResource}
      />
    );
  };

  // Own-queue entries run together per session: one line for each.
  const ownedGroups: { key: string; title: string; boxes: BoxData[] }[] = [];
  for (const b of owned) {
    const o = ownerOf(b.row!)!;
    const last = ownedGroups[ownedGroups.length - 1];
    if (last && last.key === o.id) last.boxes.push(b);
    else ownedGroups.push({ key: o.id, title: sessionDisplayTitle(o), boxes: [b] });
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
        <ol className={`ip-list${slot === null ? ' drop-end' : ''}`} aria-label="Next">
          {unowned.map(nextRow)}
        </ol>
      )}
      {ownedGroups.map((g) => (
        <div key={g.key} className="ip-own-queue">
          <div className="ip-own-head">{`Queued by ${g.title}`}</div>
          <ol className="ip-list">{g.boxes.map(nextRow)}</ol>
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
            <Backlog boxes={backlog} snapshot={snapshot} now={now} projectId={project.id} slug={project.slug} onStatus={onStatus} onOpenNode={onOpenNode} onOpenResource={onOpenResource} onDragStart={setDragging} onDragEnd={endDrag} onToNext={toNext} />
            {adding && <QuickAdd projectId={project.id} slug={project.slug} inputRef={field} onStatus={onStatus} onClose={closeAdd} />}
          </>
        )}
      </div>
    </div>
  );
}
