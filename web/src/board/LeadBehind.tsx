import type { ProjectSnapshot } from '../../../src/core/types';
import { deskBehind } from '../lead/leadDesk';
import { Eyebrow } from '../parts/Eyebrow';
import { AskActions } from './AskActions';
import { OpenButton, OpenScope } from './TaskBox';

/**
 * "The lead is behind", under the project's asks: every desk item past its limit that is not done or waiting on Aiden, and
 * every item the lead gave up on, oldest first. Each row says what it is and how late, and offers what Aiden can do himself:
 * a question or permission ask opens as the asks above do, a stopped session opens; anything else has no action. Absent when
 * empty. The window's own clock decides what is late, so a row appears within a minute of its limit.
 */
export function LeadBehind({ snapshot, now }: { snapshot: ProjectSnapshot; now: number }) {
  const rows = deskBehind(snapshot.leadBehind ?? [], now);
  if (rows.length === 0) return null;
  return (
    <section className="ip-lead-behind" aria-label="The lead is behind" data-group="lead-behind">
      <Eyebrow as="h2">The lead is behind</Eyebrow>
      <ul className="ip-list">
        {rows.map((r) => (
          <li key={r.key} className="ip-lead-behind-row" data-behind={r.key}>
            <div className="ip-ask-panel" data-ask={r.askId ?? undefined}>
              <p className="ip-ask-text">{r.text}</p>
              <span className="ip-tile-age">{r.late}</span>
              {r.askId !== null && <AskActions ask={{ id: r.askId, text: r.askText }} area="needs_me" />}
              {r.sessionId !== null && (
                <OpenScope area="needs_me">
                  <div className="ip-ask-actions">
                    <OpenButton sessionId={r.sessionId} className="ip-perm-open" variant="primary" glyph="↗">Open the session</OpenButton>
                  </div>
                </OpenScope>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
