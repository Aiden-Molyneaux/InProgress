import type { Node, NodeProps } from '@xyflow/react';
import type { WorkItem } from '../../../src/core/types';
import { withoutOwnId, workMark } from '../live';

export interface WorkRowData extends Record<string, unknown> {
  item: WorkItem;
  /** In progress while its session works or its subagent runs: the mark pulses. */
  pulse: boolean;
  /** Its session has ended: a trail row, neutral grey, its mark hollow unless it was completed. Never pulses. */
  stale: boolean;
  /** Its subagent's badge colour, or null for the session's own tasks and for trail rows. */
  color: string | null;
  /** Who is on it: the session's title or the subagent's description. */
  owner: string;
  /** The open tasks it waits for. */
  waits: string[];
}

/** One working task in its node's checklist: ○ pending, ◐ in progress, ✓ completed; left open by an ended session, a grey ○. */
export function WorkRow({ data }: NodeProps<Node<WorkRowData, 'ipWork'>>) {
  const { item, pulse, stale, color, owner, waits } = data;
  const subject = withoutOwnId(item.subject, item.nodeId);
  const after = waits.length ? `after ${waits.join(', ')}` : '';
  const left = stale && item.status !== 'completed' ? ' · left unfinished' : '';
  return (
    <div className={`ip-work w-${item.status}${stale ? ' stale' : ''}${pulse ? ' pulse' : ''}`} title={`${subject} — ${owner}${left}${after ? ` · ${after}` : ''}`}>
      <span className="ip-work-mark">{workMark(item.status, stale)}</span>
      {color && <span className="ip-work-agent" style={{ background: color }} />}
      <span className="ip-work-subject">{subject}</span>
      {after && <span className="ip-work-after">{after}</span>}
    </div>
  );
}
