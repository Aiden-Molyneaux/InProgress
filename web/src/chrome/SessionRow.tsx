import type { CSSProperties } from 'react';
import { agentVisible } from '../../../src/core/layout';
import { agentTag, isReader, sessionTag, type Session } from '../../../src/core/types';
import { Character } from '../Character';
import { characterState } from '../characterState';
import { familyVar } from '../family';
import { agentLine, chipLabel, chipName, withTag, WORDS } from '../live';
import { useNow } from '../useNow';
import { chipOrder } from './chips';

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
 * line. A chip is the session's character and its letter in its family's hue; one waiting for permission adds
 * `· needs permission`. Its name leads with the letter and carries the title (`B · Review actions controller · idle`).
 * Hovering a chip, or focusing it from the keyboard, opens its popover under the row: that line and where the session
 * is, then its subagents, each led by its tag, a reader marked `◇` in front (`◇ a2 · …`). An ended reader is not
 * listed.
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
          return (
            <span key={s.id} className="ip-chip-wrap" style={{ '--fam': familyVar(s.slot) } as CSSProperties}>
              {/* No native title: it never shows on keyboard focus, and the popover is the one place the row shows the title. */}
              <button className={`ip-chip-s s-${s.state}`} onClick={() => onPick(s)} aria-label={chipName(s)} aria-describedby={popId}>
                <Character size={18} state={characterState(s)} slot={s.slot} seed={s.id} />
                {letter && <span className="ip-tag">{letter}</span>}
                {s.state === 'permission' && (
                  <>
                    {' · '}
                    <span className="ip-chip-word">{WORDS.permission}</span>
                  </>
                )}
              </button>
              <div className="ip-chip-pop" id={popId} role="tooltip">
                <div className="ip-chip-pop-head">{withTag(letter, `${chipLabel(s)} · ${where}`)}</div>
                {agents.length > 0 && (
                  <ul>
                    {agents.map((a) => {
                      const tag = agentTag(s.slot, a.ordinal);
                      return (
                        <li key={a.agentId} className={a.endedAt ? 'ended' : undefined}>
                          {isReader(a.agentType) && <span className="ip-reader-mark">◇ </span>}
                          {tag && (
                            <>
                              <span className="ip-agent-tag">{tag}</span>
                              {' · '}
                            </>
                          )}
                          {agentLine(a, now)}
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
