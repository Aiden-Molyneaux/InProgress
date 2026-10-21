import { useEffect, useRef, useState } from 'react';
import type { Backlog, BacklogRow } from '../../../src/core/backlog';
import type { ProjectSnapshot, RankOp } from '../../../src/core/types';
import { rankOp } from '../api';
import { optimisticRank, type RankLists } from './backlogView';

export type RankedBand = keyof RankLists;

/** Ranked's three lists and the writes that change them. */
export interface RankedOrder {
  /** A band's rows in the order drawn (the optimistic one while a write is on its way). */
  order: (band: RankedBand) => BacklogRow[];
  /** The ids of each band as drawn. */
  lists: RankLists;
  /** Each row's number while a guess is shown (Next up's unowned rows, then Soon, then Someday); null once the snapshot has settled. */
  numbers: Map<number, number> | null;
  /** `guess` false sends the write without showing a result first (a no-op move such as Keep). */
  write: (op: RankOp, guess?: boolean) => Promise<void>;
  /** A write is on its way (its answer has not come back). */
  writing: () => boolean;
  /** The step is in a write whose answer has not come back. */
  isPending: (id: number) => boolean;
}

/**
 * Ranked's order, the way `useNextQueue` keeps Next's: a drag or Alt+arrow shows its result at once (`pending`), and the
 * snapshot that brings the same lists replaces the guess. A refusal puts the server's lists back and says why.
 */
export function useRankedOrder({ backlog, snapshot, projectId, slug, onStatus }: {
  backlog: Backlog;
  snapshot: ProjectSnapshot;
  projectId: number;
  slug: string;
  onStatus?: (text: string) => void;
}): RankedOrder {
  const [pending, setPending] = useState<RankLists | null>(null);
  const [flying, setFlying] = useState<ReadonlySet<number>>(new Set());
  const clearTimer = useRef(0);
  const inFlight = useRef(0);

  const rows = new Map<number, BacklogRow>();
  for (const r of [...backlog.next, ...backlog.soon, ...backlog.someday]) rows.set(r.row.node.id, r);
  const server: RankLists = {
    next: backlog.next.filter((r) => r.row.owner === null).map((r) => r.row.node.id),
    soon: backlog.soon.map((r) => r.row.node.id),
    someday: backlog.someday.map((r) => r.row.node.id),
  };
  const key = (l: RankLists) => `${l.next.join()}|${l.soon.join()}|${l.someday.join()}`;
  const lists = pending ?? server;

  // The server's event brings a new snapshot; it replaces the guess once it shows the lists the guess was of. Until then
  // (an event for something else, say) the guess stays; the timer after a write is the fallback.
  useEffect(() => {
    setPending((p) => (p && key(p) === key(server) ? null : p));
  }, [snapshot]);
  useEffect(() => () => window.clearTimeout(clearTimer.current), []);

  const write = async (op: RankOp, guess = true) => {
    window.clearTimeout(clearTimer.current);
    if (guess) setPending(optimisticRank(lists, op));
    inFlight.current += 1;
    setFlying((f) => new Set(f).add(op.node));
    const result = await rankOp(projectId, slug, op).finally(() => {
      inFlight.current -= 1;
      setFlying((f) => {
        const next = new Set(f);
        next.delete(op.node);
        return next;
      });
    });
    if (result === 'ok') {
      // Normally the snapshot clears this first; a move that changed nothing sends none. A write that came back meanwhile left its timer: this one replaces it.
      window.clearTimeout(clearTimer.current);
      clearTimer.current = window.setTimeout(() => setPending(null), 2000);
      return;
    }
    setPending(null);
    if (result === 'reload') window.location.reload();
    else onStatus?.(result);
  };

  let numbers: Map<number, number> | null = null;
  if (pending) {
    numbers = new Map();
    for (const id of [...pending.next, ...pending.soon, ...pending.someday]) numbers.set(id, numbers.size + 1);
  }
  const order = (band: RankedBand): BacklogRow[] => lists[band].flatMap((id) => rows.get(id) ?? []);
  return { order, lists, numbers, write, writing: () => inFlight.current > 0, isPending: (id) => flying.has(id) };
}
