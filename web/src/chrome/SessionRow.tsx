import type { CSSProperties } from 'react';
import { commandShown, orderCommands, sessionActivity } from '../../../src/core/activity';
import { agentVisible, atLimit } from '../../../src/core/layout';
import { agentTag, isReader, sessionTag, type Session } from '../../../src/core/types';
import { AgentWords } from '../AgentWords';
import { Character } from '../Character';
import { characterState } from '../characterState';
import { familyVar } from '../family';
import { agentLineParts, chipLabel, chipName, commandLabel, commandMark, commandTag, commandWhen, withTag, workingCommands, WORDS } from '../live';
import { useNow } from '../useNow';
import { chipKin, chipOrder } from './chips';

interface SessionRowProps {
  sessions: Session[];
  onPick: (s: Session) => void;
  /** The current project's count, for the needs-you pill. */
  needsYou: number;
  onNeedsYou: () => void;
  follow: boolean;
  onFollow: () => void;
}

/**
 * The current project's sessions in letter order, with the needs-you pill and Follow at the right end of the first
 * line. A chip is the session's character and its letter in its family's hue, then a small working kin per worker that
 * still runs (chipKin: at most three, then a muted `+n`; no tags or times, which stay in the popover and on the cards);
 * one waiting for permission adds `· needs permission`. Its name leads with the letter and carries the title
 * (`B · Review actions controller · idle`); the kin add nothing to it, as it already counts them.
 * Hovering a chip, or focusing it from the keyboard, opens its popover under the row: that line and where the session
 * is, then its subagents, each led by its tag, a reader marked `◇` in front (`◇ a2 · …`). An ended reader is not
 * listed. A session whose commands count as work adds a muted `▸n` after its kin; the popover lists its shown commands
 * after the subagents (`▸ a3 · npm run test:e2e · 12m`, an ended one grey, a serving one faint).
 */
export function SessionRow({ sessions, onPick, needsYou, onNeedsYou, follow, onFollow }: SessionRowProps) {
  const now = useNow(30_000);
  return (
    <div className="ip-sessions">
      <div className="ip-chips">
        {chipOrder(sessions).map((s) => {
          const where = s.focusNodeId ? `on #${s.focusNodeId}` : 'no focus set yet';
          const agents = s.subagents.filter((a) => agentVisible(a, now));
          const popId = `ip-chip-pop-${s.id}`;
          const letter = sessionTag(s.slot);
          const kin = chipKin(s.subagents);
          const working = workingCommands(s, now);
          const commands = orderCommands(s.commands.filter((c) => commandShown(c, now)));
          return (
            <span key={s.id} className="ip-chip-wrap" style={{ '--fam': familyVar(s.slot) } as CSSProperties}>
              {/* No native title: it never shows on keyboard focus, and the popover is the one place the row shows the title. */}
              <button className={`ip-chip-s s-${sessionActivity(s, now)}`} onClick={() => onPick(s)} aria-label={chipName(s, now)} aria-describedby={popId}>
                <Character size={18} state={characterState(s, now)} slot={s.slot} seed={s.id} />
                {letter && <span className="ip-tag">{letter}</span>}
                {kin.shown.length > 0 && (
                  <span className="ip-chip-kin" aria-hidden="true">
                    {kin.shown.map((a) => (
                      <Character key={a.agentId} size={14} state={characterState(a, now)} slot={s.slot} seed={`${s.id}:${a.agentId}`} />
                    ))}
                    {kin.more > 0 && <span className="ip-chip-more">+{kin.more}</span>}
                  </span>
                )}
                {working > 0 && (
                  <span className="ip-chip-count" aria-hidden="true">
                    ▸{working}
                  </span>
                )}
                {s.state === 'permission' && (
                  <>
                    {' · '}
                    <span className="ip-chip-word">{WORDS.permission}</span>
                  </>
                )}
              </button>
              <div className="ip-chip-pop" id={popId} role="tooltip">
                <div className="ip-chip-pop-head">{withTag(letter, `${chipLabel(s, now)} · ${where}`)}</div>
                {agents.length > 0 && (
                  <ul>
                    {agents.map((a) => {
                      const tag = agentTag(s.slot, a.ordinal);
                      return (
                        <li key={a.agentId} className={[a.endedAt && 'ended', atLimit(a) && 'limit'].filter(Boolean).join(' ') || undefined}>
                          {isReader(a.agentType) && <span className="ip-reader-mark">◇ </span>}
                          {tag && (
                            <>
                              <span className="ip-agent-tag">{tag}</span>
                              {' · '}
                            </>
                          )}
                          <AgentWords parts={agentLineParts(a, now)} limit={atLimit(a)} />
                        </li>
                      );
                    })}
                  </ul>
                )}
                {commands.length > 0 && (
                  <ul>
                    {commands.map((c) => {
                      const tag = commandTag(s, c);
                      const serving = c.endedAt === null && commandMark(c, now) === '◦';
                      return (
                        <li key={c.taskId} className={[c.endedAt && 'ended', serving && 'serving'].filter(Boolean).join(' ') || undefined}>
                          <span className="ip-cmd-mark">{commandMark(c, now)}</span>{' '}
                          {tag && (
                            <>
                              <span className="ip-agent-tag">{tag}</span>
                              {' · '}
                            </>
                          )}
                          {commandLabel(c)} · {commandWhen(c, now)}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </span>
          );
        })}
      </div>
      {needsYou > 0 && (
        <button className="ip-need" onClick={onNeedsYou} title="Jump to the next item waiting on you (N)">
          <span aria-hidden="true" className="ip-need-dot" />
          {needsYou} need you
        </button>
      )}
      <button className={`ip-follow${follow ? ' on' : ''}`} onClick={onFollow} aria-pressed={follow} title="Follow Claude's changes (F)">
        <span aria-hidden="true">⌖</span> Follow
      </button>
    </div>
  );
}
