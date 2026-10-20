import { isLive, type Board } from '../../../src/core/board';
import type { TaskBox } from '../../../src/core/taskState';
import type { ProjectSnapshot } from '../../../src/core/types';

/**
 * The figures on the Board's page head. ASKS counts what the Needs me column draws as panels: each open ask on a row of
 * the column, each session of that row in `permission`, and a focusless permission wait as one. LIVE is the project's live
 * sessions that are working, READY the Next rows with no open ask, DONE the done rows.
 */
export function boardHeadFigures(
  board: Pick<Board, 'next' | 'done'>,
  boxes: { needs: readonly TaskBox[] },
  snapshot: Pick<ProjectSnapshot, 'sessions'>,
  now: number,
): { label: string; value: number }[] {
  const asks = boxes.needs.reduce((n, box) => n + (box.row ? box.row.asks.length + box.row.sessions.filter((s) => s.state === 'permission').length : 1), 0);
  return [
    { label: 'ASKS', value: asks },
    { label: 'LIVE', value: snapshot.sessions.filter((s) => isLive(s, now) && s.state === 'working').length },
    { label: 'READY', value: board.next.filter((r) => r.ready).length },
    { label: 'DONE', value: board.done.length },
  ];
}
