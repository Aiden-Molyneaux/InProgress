import type { CSSProperties } from 'react';
import { agentShown } from '../../../src/core/layout';
import type { Session } from '../../../src/core/types';
import { agentKey } from '../agentColors';
import { agentLine, chipLabel } from '../live';
import { useNow } from '../useNow';

interface SessionRowProps {
  sessions: Session[];
  onPick: (s: Session) => void;
  /** The current project's count, for the needs-you pill. */
  needsYou: number;
  onNeedsYou: () => void;
  follow: boolean;
  onFollow: () => void;
  /** Each subagent's colour, by agentKey. */
  agentColors: ReadonlyMap<string, string>;
}

/**
 * The current project's sessions, with the needs-you pill and Follow at the right end. Hovering a chip, or focusing it
 * from the keyboard, lists its subagents under the row.
 */
export function SessionRow({ sessions, onPick, needsYou, onNeedsYou, follow, onFollow, agentColors }: SessionRowProps) {
  const now = useNow(30_000);
  return (
    <div className="ip-sessions">
      <div className="ip-chips">
        {sessions.map((s) => {
          const label = chipLabel(s);
          const where = s.focusNodeId ? `on #${s.focusNodeId}` : 'no focus set yet';
          const agents = s.subagents.filter((a) => agentShown(a, now));
          const listId = `ip-subagents-${s.id}`;
          return (
            <span key={s.id} className="ip-chip-wrap">
              {/* With subagents the list says it all, so a native tooltip would only cover it. */}
              <button
                className={`ip-chip-s s-${s.state}`}
                onClick={() => onPick(s)}
                title={agents.length ? undefined : `${label} · ${where}`}
                aria-describedby={agents.length ? listId : undefined}
              >
                {s.state === 'working' && <span className="ip-pulse" />}
                <span className="ip-chip-label">{label}</span>
              </button>
              {agents.length > 0 && (
                <div className="ip-chip-pop" id={listId} role="tooltip">
                  <div className="ip-chip-pop-head">
                    {label} · {where}
                  </div>
                  <ul>
                    {agents.map((a) => (
                      <li
                        key={a.agentId}
                        className={a.endedAt ? 'ended' : undefined}
                        style={{ '--agent': agentColors.get(agentKey(s.id, a.agentId)) } as CSSProperties}
                      >
                        <span className="ip-agent-dot">◆</span> {agentLine(a, now)}
                      </li>
                    ))}
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
