import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { BoardRow } from '../../../src/core/board';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { PreviewPanel } from '../backlog/PreviewPanel';
import { formatPreview, parsePreview, previewKey, previewState, type PreviewPhase } from '../backlog/backlogPreview';
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import { EmptyState } from '../parts/EmptyState';
import { Eyebrow } from '../parts/Eyebrow';
import type { CursorItemProps } from '../parts/ListCursor';
import { load, save } from '../storage';
import { noteAction } from '../measure';
import type { BandProps } from './bandProps';
import { BoardTile } from './BoardTile';
import { dropSlot, dropToOp, optimisticNext } from './dragQueue';
import { focusTargetAfter } from './focus';
import { endedLine } from './Marks';
import type { NextQueue } from './useNextQueue';

/**
 * Next as tiles in queue order, and the Backlog preview at its foot (spec 2.2, 2.5, 2.8; parked-steps spec). The order and
 * its writes come from `useNextQueue` in the Board; this holds the drag state and the Alt+arrow moves.
 */
export function NextColumn({ snapshot, board, now, selectedNode, onOpenNode, onOpenResource, onOpenBacklog, onStatus, queue, cursor, rise }: BandProps & {
  queue: NextQueue;
  /** The grid cursor's props for the tile at this row of the column (unowned steps first, then own queues). */
  cursor: (row: number) => CursorItemProps;
  /** The stagger place a tile key (`next:<id>`) rises with. */
  rise: (key: string) => number | undefined;
}) {
  const { project } = snapshot;
  const { next, nextIds, shown, unowned, ownedGroups, drawn, inNext, backlog, write, toNext, toBacklog } = queue;
  const [dragging, setDragging] = useState<number | null>(null);
  /** Where a drop would land: the unowned step it goes before, or null for the end of the unowned queue; undefined when over nothing. */
  const [slot, setSlot] = useState<number | null | undefined>(undefined);
  const [overBacklog, setOverBacklog] = useState(false);
  const [adding, setAdding] = useState(false);
  /** The phase Aiden picked for the Backlog preview, kept per project in this browser; null until he picks one. */
  const [stored, setStored] = useState<PreviewPhase | null>(() => parsePreview(load(previewKey(project.id))));
  const [focusTick, setFocusTick] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focusTick > 0) field.current?.focus();
  }, [focusTick]);

  // The preview shows one phase: the picked one while it has entries, else the default chain (a finished or parked phase falls back).
  const { choices, phase } = previewState(backlog, board, snapshot.nodes, stored);
  const pickPhase = (p: PreviewPhase) => {
    noteAction('backlog', 'pick_phase');
    setStored(p);
    save(previewKey(project.id), formatPreview(p));
  };

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
    if (dragging === null) return;
    // Nor the filter field's own drop, which would type the dragged id into it.
    e.preventDefault();
    if (!inNext.has(dragging)) return;
    const id = dragging;
    endDrag();
    noteAction('backlog', 'drop');
    void toBacklog(id);
  };

  const addClick = () => {
    noteAction('backlog', 'add');
    setAdding(true);
    setFocusTick((t) => t + 1);
  };
  const closeAdd = () => {
    setAdding(false);
    addButton.current?.focus();
  };

  /** Alt+Up / Alt+Down on a focused unowned tile moves it one place; own-queue tiles and the ends do nothing. */
  const moveKey = (e: KeyboardEvent<HTMLElement>, id: number) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.target !== e.currentTarget) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    // Key repeat while a move is out would send moves the window has not seen the result of: hold it back.
    if (e.repeat && queue.writing()) {
      e.preventDefault();
      return;
    }
    const at = unowned.findIndex((b) => b.row!.node.id === id);
    if (at < 0) return;
    let before: number | null;
    if (e.key === 'ArrowUp') {
      if (at === 0) return;
      before = unowned[at - 1].row!.node.id;
    } else {
      if (at === unowned.length - 1) return;
      before = unowned[at + 2]?.row!.node.id ?? null;
    }
    e.preventDefault();
    noteAction('next', 'key_move');
    void write(dropToOp(id, { zone: 'next', before }));
  };

  const nextRow = (box: BoxData) => {
    const row = box.row!;
    const id = row.node.id;
    return (
      <BoardTile
        key={id}
        box={box}
        now={now}
        area="next"
        band="next"
        docs={snapshot.resources.filter((r) => r.nodeId === id).length}
        system={endedLine(row, snapshot.pastSessions, now)}
        cursor={cursor(drawn.indexOf(box))}
        rise={rise(`next:${id}`)}
        selected={selectedNode === id}
        dropBefore={slot === id}
        dragging={dragging === id}
        chips={box.state === 'blocked' ? <Chip tone="blocked">BLOCKED</Chip> : <Chip tone="ready">READY</Chip>}
        li={{
          draggable: true,
          onDragStart: (e) => startDrag(e, id),
          onDragEnd: endDrag,
          onDragOver: (e) => overRow(e, row),
          onDrop: dropInNext,
        }}
        onKeyDown={(e) => moveKey(e, id)}
        lead={
          <Button
            variant="ghost"
            size="sm"
            className="ip-hover-act"
            data-act
            onClick={(e) => {
              noteAction('next', 'to_backlog');
              focusTargetAfter(e.currentTarget.closest('li'))?.focus();
              void toBacklog(id);
            }}
          >
            back to Backlog
          </Button>
        }
        onOpenNode={onOpenNode}
        onOpenResource={onOpenResource}
      />
    );
  };

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
      {next.length === 0 && <EmptyState>Nothing is queued</EmptyState>}
      {unowned.length > 0 && (
        <ol className={`ip-list${slot === null ? ' drop-end' : ''}`} aria-label="Next">
          {unowned.map(nextRow)}
        </ol>
      )}
      {ownedGroups.map((g) => (
        <div key={g.key} className="ip-own-queue">
          <Eyebrow glyph="//" className="ip-own-head">{`Queued by ${g.title}`}</Eyebrow>
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
        <PreviewPanel
          entries={backlog}
          choices={choices}
          phase={phase}
          adding={adding}
          field={field}
          addButton={addButton}
          snapshot={snapshot}
          now={now}
          onPick={pickPhase}
          onOpenAll={() => onOpenBacklog?.()}
          onAdd={addClick}
          onCloseAdd={closeAdd}
          onStatus={onStatus}
          onOpenNode={onOpenNode}
          onOpenResource={onOpenResource}
          onDragStart={startDrag}
          onDragEnd={endDrag}
          onToNext={toNext}
        />
      </div>
    </div>
  );
}
