import type { Node, NodeProps } from '@xyflow/react';
import type { WorkItem } from '../../../src/core/types';
import { TASK_MARK, withoutOwnId } from '../live';

export interface WorkRowData extends Record<string, unknown> {
  item: WorkItem;
  /** In progress while its session works or its subagent runs: the mark pulses. */
  pulse: boolean;
  /** Its subagent's badge colour, or null for the session's own tasks. */
  color: string | null;
  /** Who is on it: the session's title or the subagent's description. */
  owner: string;
  /** The open tasks it waits for. */
  waits: string[];
}

/** One working task in its node's checklist: ○ pending, ◐ in progress, ✓ completed. */
export function WorkRow({ data }: NodeProps<Node<WorkRowData, 'ipWork'>>) {
  const { item, pulse, color, owner, waits } = data;
  const subject = withoutOwnId(item.subject, item.nodeId);
  const after = waits.length ? `after ${waits.join(', ')}` : '';
  return (
    <div className={`ip-work w-${item.status}${pulse ? ' pulse' : ''}`} title={`${subject} — ${owner}${after ? ` · ${after}` : ''}`}>
      <span className="ip-work-mark">{TASK_MARK[item.status]}</span>
      {color && <span className="ip-work-agent" style={{ background: color }} />}
      <span className="ip-work-subject">{subject}</span>
      {after && <span className="ip-work-after">{after}</span>}
    </div>
  );
}
