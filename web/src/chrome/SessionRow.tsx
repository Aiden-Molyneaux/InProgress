import type { CSSProperties } from 'react';
import { agentVisible } from '../../../src/core/layout';
import { agentTag, isReader, sessionTag, type Session } from '../../../src/core/types';
import { familyVar } from '../family';
import { agentLine, chipLabel, withTag } from '../live';
import { useNow } from '../useNow';

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
 * The current project's sessions, with the needs-you pill and Follow at the right end. Each chip leads with its letter in
 * its family's hue (`A · Review actions controller`). Hovering a chip, or focusing it from the keyboard, lists its
 * subagents under the row, each led by its tag, a reader marked `◇` in front (`◇ a2 · …`). An ended reader is not listed.
 */
export function SessionRow({ sessions, onPick, needsYou, onNeedsYou, follow, onFollow }: SessionRowProps) {
  const now = useNow(30_000);
  return (
    <div className="ip-sessions">
      <div className="ip-chips">
        {sessions.map((s) => {
          const label = chipLabel(s);
          const where = s.focusNodeId ? `on #${s.focusNodeId}` : 'no focus set yet';
          const agents = s.subagents.filter((a) => agentVisible(a, now));
          const listId = `ip-subagents-${s.id}`;
          const letter = sessionTag(s.slot);
          return (
            <span key={s.id} className="ip-chip-wrap" style={{ '--fam': familyVar(s.slot) } as CSSProperties}>
              {/* With subagents the list says it all, so a native tooltip would only cover it. */}
              <button
                className={`ip-chip-s s-${s.state}`}
                onClick={() => onPick(s)}
                title={agents.length ? undefined : `${label} · ${where}`}
                aria-describedby={agents.length ? listId : undefined}
              >
                {s.state === 'working' && <span className="ip-pulse" />}
                {/* Its own span, before the label: the label still starts with the title and is the part cut short. */}
                {letter && (
                  <span className="ip-chip-lead">
                    <span className="ip-tag">{letter}</span>
                    {' · '}
                  </span>
                )}
                <span className="ip-chip-label">{label}</span>
              </button>
              {agents.length > 0 && (
                <div className="ip-chip-pop" id={listId} role="tooltip">
                  <div className="ip-chip-pop-head">{withTag(letter, `${label} · ${where}`)}</div>
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
                </div>
              )}
            </span>
          );
        })}
      </div>
      {needsYou > 0 && (
        <button className="ip-need" onClick={onNeedsYou} title="Jump to the next item waiting on you (N)">
          ● {needsYou} need you
        </button>
      )}
      <button className={`ip-follow${follow ? ' on' : ''}`} onClick={onFollow} aria-pressed={follow} title="Follow Claude's changes (F)">
        ⌖ Follow
      </button>
    </div>
  );
}
