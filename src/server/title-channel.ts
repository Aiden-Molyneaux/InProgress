import { expectedPrefix, prefixReason, splitPrefix, withPrefix, type TitleDemand } from '../core/title';
import type { Session, TitleChannel } from '../core/types';
import { write, type Ctx } from './db/tx';
import { openAsksBy } from './repo/asks';
import { findNode } from './repo/nodes';
import { findSession, saveSession } from './repo/sessions';
import { parkedAncestor } from './repo/shelved';

/** Records the last title a block demanded (null clears it); no event, since the window never shows it. */
function setTitleAsked(ctx: Ctx, sessionId: string, titleAsked: string | null): void {
  write(ctx, 'title-channel', () => {
    // Read fresh inside the write, so nothing the hook flow saved since is overwritten.
    const s = findSession(ctx, sessionId);
    if (s) saveSession(ctx, { ...s, titleAsked });
  });
}

/**
 * What a hook reply says about the session's title: a nudge line (only a prompt shows it) and, at a stop under
 * `enforce`, a demand the hook turns into a block. A demand is made once per expected title (`titleAsked`), so a
 * declined rename never loops, and never in the extra pass a block caused. `session` is as the hook event left it.
 */
export function titleAdvice(
  ctx: Ctx,
  session: Session,
  event: 'prompt' | 'stop',
  o: { stopHookActive: boolean; titleChannel: TitleChannel },
): { line?: string; demand?: TitleDemand } {
  const title = session.title?.trim();
  if (!title) return {};
  // Only the focus step and the asks this session raised on it count: no full snapshot on the hook's budget.
  const node = session.focusNodeId === null ? undefined : findNode(ctx, session.focusNodeId);
  // A step under a parked step is parked too, as the briefing reads it.
  const focus = node && node.status !== 'parked' && node.status !== 'done' && parkedAncestor(ctx, node.id) !== null ? { ...node, status: 'parked' as const } : node;
  const snapshot = { nodes: focus ? [focus] : [], asks: focus ? openAsksBy(ctx, session.id, focus.id) : [] };
  // A prompt is judged as at the turn's end, so work still running keeps RUNNING expected: else the prompt would ask to
  // drop a RUNNING the next stop puts back, and clear the memory of a declined demand.
  const prefix = expectedPrefix(event === 'prompt' ? { ...session, state: 'idle' } : session, snapshot, Date.parse(ctx.now()));
  const expected = withPrefix(splitPrefix(title).rest, prefix);
  // A title that is only a prefix word would be asked to become empty: leave it alone.
  if (!expected) return {};
  if (expected === session.title) {
    if (session.titleAsked !== null) setTitleAsked(ctx, session.id, null);
    return {};
  }
  const reason = prefixReason(prefix, session.focusNodeId);
  const line = `Title: set it to "${expected}" (mcp__ccd_session_mgmt__set_session_title on "self"); InProgress sees ${reason}.`;
  if (event !== 'stop' || o.titleChannel !== 'enforce' || o.stopHookActive || session.titleAsked === expected) return { line };
  // Recorded before the hook prints it: a reply that misses the hook's timeout spends this demand unprinted. Accepted;
  // the next prompt's line still names the title.
  setTitleAsked(ctx, session.id, expected);
  return { line, demand: { title: expected, reason } };
}
