import { countsAsWork } from '../../../src/core/activity';
import { isLive, type Board } from '../../../src/core/board';
import type { TaskBox } from '../../../src/core/taskState';
import { isReader, type ProjectSnapshot, type Session } from '../../../src/core/types';

/** The server's busy_sessions rule on a snapshot's session: live, and working or still running work (a subagent that is not a reader, a command that counts as work). */
export const isBusy = (s: Pick<Session, 'state' | 'lastSeenAt' | 'subagents' | 'commands'>, now: number): boolean =>
  isLive(s, now) && (s.state === 'working' || s.subagents.some((a) => a.endedAt === null && !isReader(a.agentType)) || s.commands.some((c) => countsAsWork(c, now)));

/**
 * The figures on the Board's page head. ASKS counts what the Needs me column draws as panels: each ask still waiting on the
 * user on a row of the column, each session of that row in `permission`, and a focusless permission wait as one. LIVE is
 * what the HUD's LIVE counts (the server's `busySessions`): the live sessions that are busy. READY is the Next rows with no
 * open ask, DONE the done rows.
 */
export function boardHeadFigures(
  board: Pick<Board, 'next' | 'done'>,
  boxes: { needs: readonly TaskBox[] },
  snapshot: Pick<ProjectSnapshot, 'sessions'>,
  now: number,
): { label: string; value: number }[] {
  const asks = boxes.needs.reduce((n, box) => n + (box.row ? box.row.waiting.length + box.row.sessions.filter((s) => s.state === 'permission').length : 1), 0);
  return [
    { label: 'ASKS', value: asks },
    { label: 'LIVE', value: snapshot.sessions.filter((s) => isBusy(s, now)).length },
    { label: 'READY', value: board.next.filter((r) => r.ready).length },
    { label: 'DONE', value: board.done.length },
  ];
}
