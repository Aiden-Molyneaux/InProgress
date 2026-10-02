import { sessionDisplayTitle, type Session } from '../../../src/core/types';

const SUFFIX: Record<Session['state'], string> = { working: '', idle: ' · idle', permission: ' · needs permission', ended: ' · ended' };

interface SessionRowProps {
  sessions: Session[];
  onPick: (s: Session) => void;
  /** The current project's count, for the needs-you pill. */
  needsYou: number;
  onNeedsYou: () => void;
  follow: boolean;
  onFollow: () => void;
}

/** The current project's sessions, with the needs-you pill and Follow at the right end. */
export function SessionRow({ sessions, onPick, needsYou, onNeedsYou, follow, onFollow }: SessionRowProps) {
  return (
    <div className="ip-sessions">
      <div className="ip-chips">
        {sessions.map((s) => {
          const label = `${sessionDisplayTitle(s)}${s.subagents.length > 0 ? ` · ${s.subagents.length} subagent${s.subagents.length > 1 ? 's' : ''}` : ''}${SUFFIX[s.state]}`;
          return (
            <button key={s.id} className={`ip-chip-s s-${s.state}`} onClick={() => onPick(s)} title={`${label} · ${s.focusNodeId ? `on #${s.focusNodeId}` : 'no focus set yet'}`}>
              {s.state === 'working' && <span className="ip-pulse" />}
              <span className="ip-chip-label">{label}</span>
            </button>
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
