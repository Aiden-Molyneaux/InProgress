import { sessionDisplayTitle } from '../../../src/core/types';
import { OpenFailure, OpenButton, type SessionRef } from './TaskBox';

/** A session's role on a step with a driver (spec 1.4): the driver drives, every other session on it is helping. */
export type SessionRole = 'drives' | 'helping';

/**
 * The Board's session line: a diamond in the step's hue, the session's display title, its state word (or its role on Now),
 * and Open ↗; when the server could not open it, the command to run by hand shows under the line. Inside an OpenScope.
 * `nameless` leaves the title out where the tile's own title already is the session's.
 */
export function SessionLine({ session, word, role, nameless }: { session: SessionRef | null; word?: string; role?: SessionRole; nameless?: boolean }) {
  if (!session) {
    return (
      <div className="ip-sessline">
        <span className="ip-sessline-none">No session: raised before sessions were tracked</span>
      </div>
    );
  }
  const title = sessionDisplayTitle(session);
  return (
    <>
      <div className="ip-sessline">
        <span className="ip-sessline-dot" aria-hidden="true">◆</span>
        {!nameless && <span className="ip-sessline-title" title={title}>{title}</span>}
        {(role ?? word) && <span className="ip-sessline-word">{role ?? word}</span>}
        <OpenButton sessionId={session.id} className="ip-sessline-open" variant="ghost" glyph="↗">Open</OpenButton>
      </div>
      <OpenFailure sessionId={session.id} />
    </>
  );
}
