import { characterState } from '../characterState';
import { Character } from '../Character';
import { leadTitle, WORDS } from '../live';
import { sessionActivity } from '../../../src/core/activity';
import { sessionTag } from '../../../src/core/types';
import type { BandProps } from './bandProps';
import { headerSessions } from './headerSessions';
import { noteAction } from '../measure';
import { ageShort, firstSentence, hygieneTitle } from './text';

export { headerSessions };

/** The Board's top: the state note as the Orchestrator's message, the sessions on no step, and the hygiene count. */
export function HeaderLines({ snapshot, board, now, wide, onOpenProject }: BandProps) {
  const note = snapshot.stateNote;
  const orchestrator = snapshot.sessions.find((s) => s.role === 'orchestrator' && s.state !== 'ended');
  const idle = headerSessions(board, snapshot.sessions, now);
  return (
    <header className={`ip-hdr ${wide ? 'wide' : 'narrow'}`}>
      <div className="ip-hdr-note">
        {note ? (
          <div className="ip-msg">
            <Character size={24} state="idle" slot={orchestrator?.slot ?? null} seed={`orchestrator:${snapshot.project.id}`} />
            <div className="ip-msg-body">
              <div className="ip-msg-head">
                <b>Orchestrator</b> · <span className="ip-time">{ageShort(note.updatedAt, now)}</span>
              </div>
              <p className="ip-clamp-2">{firstSentence(note.content)}</p>
              <button type="button" className="ip-link-btn" onClick={() => {
                  noteAction('header', 'project_view');
                  onOpenProject?.();
                }}>
                Project view ›
              </button>
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
              <Character size={18} state={characterState(s, now)} slot={s.slot} seed={s.id} />
              <span className="ip-tag" style={{ color: `var(--family-${(s.slot ?? 0) % 6})` }}>
                {sessionTag(s.slot) || '?'}
              </span>
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
