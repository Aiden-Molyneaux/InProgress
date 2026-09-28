import { sessionDisplayTitle, type Session } from '../../../src/core/types';

const SUFFIX: Record<Session['state'], string> = { working: '', idle: ' · idle', permission: ' · needs permission', ended: ' · ended' };

export function SessionRow({ sessions, onPick }: { sessions: Session[]; onPick: (s: Session) => void }) {
  if (!sessions.length) return null;
  return (
    <div className="ip-sessions">
      {sessions.map((s) => (
        <button key={s.id} className={`ip-chip-s s-${s.state}`} onClick={() => onPick(s)} title={s.focusNodeId ? `On #${s.focusNodeId}` : 'No focus set yet'}>
          {s.state === 'working' && <span className="ip-pulse" />}
          {sessionDisplayTitle(s)}
          {s.subagents.length > 0 ? ` · ${s.subagents.length} subagent${s.subagents.length > 1 ? 's' : ''}` : ''}
          {SUFFIX[s.state]}
        </button>
      ))}
    </div>
  );
}
