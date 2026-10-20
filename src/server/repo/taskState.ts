import { deriveBoard } from '../../core/board';
import { COLOURED, HUES, sinceFallback, taskStateOf, type TaskState } from '../../core/taskState';
import type { Ctx } from '../db/tx';
import { readBoardInput } from './snapshot';

const isColoured = (s: string | null): boolean => s !== null && COLOURED.has(s as TaskState);

/**
 * Stores each step's Board state, when it last changed and its task hue (migration 11), for the given projects. Runs
 * inside the write that changed them (write() calls it through ctx.reconcile), so it never calls write(), records no
 * event (the triggering write already did) and never touches updated_at. Every read here is a plain read.
 */
export function reconcileProjects(ctx: Ctx, projectIds: number[]): void {
  // One clock for the whole pass: the cutoffs inside the reads and the stored times all use it.
  const now = ctx.now();
  const at: Ctx = { ...ctx, now: () => now };
  const nowMs = Date.parse(now);
  const update = ctx.db.prepare('UPDATE nodes SET board_state = ?, state_since = ?, hue = ? WHERE id = ?');
  for (const projectId of projectIds) {
    const input = readBoardInput(at, projectId);
    if (!input) continue;
    const { nodes } = input;
    const board = deriveBoard(input, nowMs);
    const holders: number[] = Array.from({ length: HUES }, () => 0);
    const hold = (hue: number | null, by: number) => {
      if (hue !== null && Number.isInteger(hue) && hue >= 0 && hue < HUES) holders[hue] += by;
    };
    for (const n of nodes) if (isColoured(n.boardState)) hold(n.hue, 1);
    const fewest = (): number => holders.reduce((best, count, i) => (count < holders[best] ? i : best), 0);

    for (const node of [...nodes].sort((a, b) => a.id - b.id)) {
      const row = board.byId.get(node.id);
      if (!row) {
        // Off the board (the root, a group, a dropped step). One that was on it records when it left, so a step that
        // comes back (a group whose last open child finished) dates its new state from then, not from its updated_at.
        // One never on it stays all null and costs no write.
        if (node.boardState !== null) {
          if (isColoured(node.boardState)) hold(node.hue, -1);
          update.run(null, now, null, node.id);
        } else if (node.hue !== null) {
          update.run(null, node.stateSince, null, node.id);
        }
        continue;
      }
      const state = taskStateOf(row, input, nowMs);
      const wasColoured = isColoured(node.boardState);
      const coloured = COLOURED.has(state);
      if (state === node.boardState) {
        // Unchanged: nothing to write, unless a coloured step has no hue. A reconcile is never cut short (it runs in a
        // SAVEPOINT, all or nothing), so only a hand edit of the database reaches this: give it one.
        if (coloured && node.hue === null) {
          const hue = fewest();
          hold(hue, 1);
          update.run(state, node.stateSince, hue, node.id);
        }
        continue;
      }
      // A first set (never reconciled: both null) dates the state from the step's own fields. Otherwise it changed now,
      // including a step coming back on the board (board_state null, state_since when it left).
      const since = node.boardState === null && node.stateSince === null ? sinceFallback(node, state, row.waiting) : now;
      let hue: number | null;
      if (!coloured) {
        if (wasColoured) hold(node.hue, -1);
        hue = null;
      } else if (node.hue === null) {
        hue = fewest();
        hold(hue, 1);
      } else {
        // Coloured to coloured keeps the hue it holds. A hue stored beside an uncoloured state (never written by this
        // code) is kept too, and counted from here on.
        hue = node.hue;
        if (!wasColoured) hold(hue, 1);
      }
      update.run(state, since, hue, node.id);
    }
  }
}
