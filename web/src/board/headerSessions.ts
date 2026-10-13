import { isLive, type Board } from '../../../src/core/board';
import type { Session } from '../../../src/core/types';

/**
 * The sessions the header lists under "No claimed step" (spec 2.2): the orchestrator while it is live, and working
 * sessions that are on no Now row (no focus, or a focus on a step that is done or gone). An idle worker with no step
 * is left out. With `now` a session must be live (heard from within the stale limit); without it, any that has not ended.
 * In slot order.
 */
export function headerSessions(board: Pick<Board, 'byId'>, sessions: Session[], now?: number): Session[] {
  const live = (s: Session) => (now === undefined ? s.state !== 'ended' : isLive(s, now));
  const onNow = (s: Session) => s.focusNodeId !== null && board.byId.get(s.focusNodeId)?.column === 'now';
  return sessions
    .filter((s) => live(s) && !onNow(s) && (s.role === 'orchestrator' || s.state === 'working'))
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99) || a.id.localeCompare(b.id));
}
