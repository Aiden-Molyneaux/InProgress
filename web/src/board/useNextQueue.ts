import { useEffect, useRef, useState } from 'react';
import type { BoardRow } from '../../../src/core/board';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { sessionDisplayTitle, type QueueOp } from '../../../src/core/types';
import { queueOp } from '../api';
import { dropToOp, optimisticNext } from './dragQueue';
import type { BandProps } from './bandProps';

/** The order the window shows until the next snapshot lands, and the step it moved (which is no longer in anyone's own queue). */
interface Pending {
  ids: number[];
  moved: number;
}

/** One session's own queue: its entries run together under one line. */
export interface OwnedGroup {
  key: string;
  title: string;
  boxes: BoxData[];
}

/** What Next draws and what the Backlog preview lists, with the writes that change them. */
export interface NextQueue {
  /** Next in queue order (the optimistic order while a write is on its way). */
  next: BoxData[];
  /** The ids of `next`, in order. */
  nextIds: number[];
  /** `next` as the drag arithmetic sees it: the step and its owner. */
  shown: { node: BoardRow['node']; owner: BoardRow['owner'] }[];
  unowned: BoxData[];
  owned: BoxData[];
  ownedGroups: OwnedGroup[];
  /** Next as drawn, top to bottom: the unowned steps, then each own queue. The grid's Next column follows it. */
  drawn: BoxData[];
  inNext: Set<number>;
  backlog: BoxData[];
  write: (op: QueueOp) => Promise<void>;
  toNext: (id: number) => Promise<void>;
  toBacklog: (id: number) => Promise<void>;
}

/**
 * Next's order and the Backlog beside it, lifted out of the column so the Board's keyboard grid can count Next's tiles.
 * A drag or Alt+arrow shows its result at once (`pending`); the snapshot that brings the same order replaces the guess.
 */
export function useNextQueue({ snapshot, board, boxes, onStatus }: Pick<BandProps, 'snapshot' | 'board' | 'boxes' | 'onStatus'>): NextQueue {
  const { project } = snapshot;
  const [pending, setPending] = useState<Pending | null>(null);
  const clearTimer = useRef(0);

  // The server's event brings a new snapshot; it replaces what the window guessed once it shows the order the guess was of.
  // Until then (an event for something else, say) the guess stays; the timer after a write is the fallback.
  useEffect(() => {
    const order = boxes.next.map((b) => b.row!.node.id).join();
    setPending((p) => (p && p.ids.join() === order ? null : p));
  }, [snapshot]);
  useEffect(() => () => window.clearTimeout(clearTimer.current), []);

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

  // Own-queue entries run together per session: one line for each.
  const ownedGroups: OwnedGroup[] = [];
  for (const b of owned) {
    const o = ownerOf(b.row!)!;
    const last = ownedGroups[ownedGroups.length - 1];
    if (last && last.key === o.id) last.boxes.push(b);
    else ownedGroups.push({ key: o.id, title: sessionDisplayTitle(o), boxes: [b] });
  }

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

  return { next, nextIds, shown, unowned, owned, ownedGroups, drawn: [...unowned, ...owned], inNext, backlog, write, toNext, toBacklog };
}
