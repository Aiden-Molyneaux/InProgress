import type { TaskBox, TaskCell } from '../../../src/core/taskState';
import type { HeldCard } from '../../../src/core/types';

/**
 * One Needs me tile (lead stage 1, task D). A task's box that waits on Aiden, with the held commands on its step after its
 * asks; or the held commands alone, on a step with no Needs me box (`step` is that step's box elsewhere on the Board, null
 * when the step is not drawn or the commands are on no step).
 */
export type NeedsTile =
  | { kind: 'box'; key: string; box: TaskBox; held: HeldCard[] }
  | { kind: 'held'; key: string; step: TaskBox | null; stepId: number | null; held: HeldCard[] };

/** The key of a task's tile: its step, or its session when the wait is on no step. The grid's cursor and the rise follow it. */
export const boxKey = (box: TaskBox): string => (box.row ? `n${box.row.node.id}` : `s${box.session!.id}`);

/** When a box began to wait on Aiden: its oldest open ask or permission wait (as taskBoxes orders Needs me). */
function needTime(box: TaskBox): number {
  if (!box.row) return Date.parse(box.session!.lastSeenAt);
  const times = box.row.waiting.map((a) => Date.parse(a.raisedAt));
  for (const s of box.row.sessions) if (s.state === 'permission') times.push(Date.parse(s.lastSeenAt));
  return times.length ? Math.min(...times) : Infinity;
}

const oldest = (held: readonly HeldCard[]): number => Math.min(...held.map((h) => Date.parse(h.createdAt)));
const byTime = (a: HeldCard, b: HeldCard): number => a.createdAt.localeCompare(b.createdAt) || a.id - b.id;

/**
 * The Needs me tiles, oldest wait first: every box of the needs cell, each with the held commands on its step, and one
 * tile for the held commands of each other step (and one per held command on no step). A tile's time is its oldest wait,
 * held commands included; ties keep the boxes' own order, boxes before held tiles.
 */
export function needsTiles(boxes: Record<TaskCell, TaskBox[]>, held: readonly HeldCard[] = []): NeedsTile[] {
  const sorted = [...held].sort(byTime);
  const onStep = new Map<number, HeldCard[]>();
  const loose: HeldCard[] = [];
  for (const h of sorted) {
    if (h.stepId === null) loose.push(h);
    else onStep.set(h.stepId, [...(onStep.get(h.stepId) ?? []), h]);
  }
  const timed: { tile: NeedsTile; time: number }[] = [];
  for (const box of boxes.needs) {
    const mine = box.row ? (onStep.get(box.row.node.id) ?? []) : [];
    if (box.row) onStep.delete(box.row.node.id);
    timed.push({ tile: { kind: 'box', key: boxKey(box), box, held: mine }, time: mine.length ? Math.min(needTime(box), oldest(mine)) : needTime(box) });
  }
  const elsewhere = new Map<number, TaskBox>();
  for (const cell of ['now', 'next', 'done', 'backlog'] as const) for (const b of boxes[cell]) if (b.row) elsewhere.set(b.row.node.id, b);
  for (const [stepId, mine] of onStep) {
    timed.push({ tile: { kind: 'held', key: `h${stepId}`, step: elsewhere.get(stepId) ?? null, stepId, held: mine }, time: oldest(mine) });
  }
  for (const h of loose) timed.push({ tile: { kind: 'held', key: `hi${h.id}`, step: null, stepId: null, held: [h] }, time: oldest([h]) });
  // A stable sort: equal times keep the order above.
  return timed.sort((a, b) => a.time - b.time || 0).map((t) => t.tile);
}

/** The text of a held card: `#<step> wants <what>.`, as the Voice says it. */
export const heldText = (h: Pick<HeldCard, 'stepId' | 'what'>): string => `${h.stepId === null ? 'A session' : `#${h.stepId}`} wants ${h.what.replace(/[.\s]+$/, '')}.`;
