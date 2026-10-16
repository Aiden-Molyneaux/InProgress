import { leadTitle, WORDS } from '../live';
import { sessionActivity } from '../../../src/core/activity';
import { sessionDisplayTitle } from '../../../src/core/types';
import type { BandProps } from './bandProps';
import { headerSessions } from './headerSessions';
import { ageShort, firstSentence, hygieneTitle } from './text';

export { headerSessions };

/** The Board's top: the state note as the Orchestrator's message, the sessions on no step, and the hygiene count. */
export function HeaderLines({ snapshot, board, now, wide }: BandProps) {
  const note = snapshot.stateNote;
  const idle = headerSessions(board, snapshot.sessions, now);
  return (
    <header className={`ip-hdr ${wide ? 'wide' : 'narrow'}`}>
      <div className="ip-hdr-note">
        {note ? (
          <div className="ip-msg">
            <div className="ip-msg-body">
              <div className="ip-msg-head">
                <b>Orchestrator</b> · <span className="ip-time">{ageShort(note.updatedAt, now)}</span>
              </div>
              <p className="ip-clamp-2">{firstSentence(note.content)}</p>
            </div>
          </div>
        ) : (
          <p className="ip-quiet">No state note yet</p>
        )}
      </div>
      {idle.length > 0 && (
        <div className="ip-hdr-sessions" role="group" aria-label="No claimed step">
          <div className="ip-label">No claimed step</div>
          {idle.map((s) => (
            <span key={s.id} className="ip-hdr-session" title={leadTitle(s, now)}>
              <b className="ip-hdr-title">{sessionDisplayTitle(s)}</b>
              {s.role === 'orchestrator' && <span className="ip-quiet"> orchestrator</span>}
              <span className="ip-quiet"> · {WORDS[sessionActivity(s, now)]}</span>
            </span>
          ))}
        </div>
      )}
      {board.marked.length > 0 && (
        <span className="ip-hygiene" title={hygieneTitle(board)}>
          {`${board.marked.length} to tidy`}
        </span>
      )}
    </header>
  );
}
