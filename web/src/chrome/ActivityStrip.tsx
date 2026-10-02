import type { EventRow, ProjectSnapshot } from '../../../src/core/types';
import { actorLabel, describeEvent } from '../describe';
import { relativeTime } from '../time';
import { useNow } from '../useNow';

export function ActivityStrip({ event, snapshot }: { event: EventRow | null; snapshot: ProjectSnapshot }) {
  const now = useNow(30_000);
  if (!event) return <div className="ip-activity muted">No activity yet</div>;
  return (
    <div className="ip-activity" title={event.ts}>
      ↳ {actorLabel(event, snapshot)} · {relativeTime(event.ts, now)} · {describeEvent(event, snapshot)}
    </div>
  );
}
