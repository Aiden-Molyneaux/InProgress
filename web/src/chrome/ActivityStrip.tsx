import type { EventRow, ProjectSnapshot } from '../../../src/core/types';
import { actorLabel, describeEvent } from '../describe';
import { relativeTime } from '../time';
import { useNow } from '../useNow';

/** The latest change on one line: `↳ actor · when · what`. Only the event shrinks, cut short with an ellipsis. */
export function ActivityStrip({ event, snapshot }: { event: EventRow | null; snapshot: ProjectSnapshot }) {
  const now = useNow(30_000);
  if (!event) return <div className="ip-activity muted">No activity yet</div>;
  // Flex items: the strip's gap draws the room, and the spaces around each · keep the text as it reads.
  return (
    <div className="ip-activity" title={event.ts}>
      <span aria-hidden="true">↳ </span>
      <span className="ip-act-who">{actorLabel(event, snapshot)}</span>
      {' · '}
      <span className="ip-act-when">{relativeTime(event.ts, now)}</span>
      {' · '}
      <span className="ip-act-what">{describeEvent(event, snapshot)}</span>
    </div>
  );
}
