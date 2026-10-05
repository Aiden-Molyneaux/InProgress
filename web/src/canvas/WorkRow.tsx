import type { CSSProperties } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { WorkItem } from '../../../src/core/types';
import { familyVar } from '../family';
import { withoutOwnId, workMark } from '../live';

export interface WorkRowData extends Record<string, unknown> {
  item: WorkItem;
  /** In progress while its session works or its subagent runs: the mark pulses. */
  pulse: boolean;
  /** Its session has ended: a trail row, neutral grey, its mark hollow unless it was completed. Never pulses. */
  stale: boolean;
  /**
   * Its live session's family: the slot whose hue its marker wears, and its subagent's tag (`a1`; '' on the session's
   * own list). Null for a trail row, which stays neutral.
   */
  family: { slot: number | null; tag: string } | null;
  /** Who is on it, for the tooltip: the session's title or the subagent's description, led by its letter or tag while live. */
  owner: string;
  /** The open tasks it waits for. */
  waits: string[];
}

/**
 * One working task in its node's checklist: ○ pending, ◐ in progress, ✓ completed, a subagent's led by its tag
 * (`a1 ◐ Write the tests`), with a marker in its session's hue. Left open by an ended session, a grey ○ with no hue.
 */
export function WorkRow({ data }: NodeProps<Node<WorkRowData, 'ipWork'>>) {
  const { item, pulse, stale, family, owner, waits } = data;
  const subject = withoutOwnId(item.subject, item.nodeId);
  const after = waits.length ? `after ${waits.join(', ')}` : '';
  const left = stale && item.status !== 'completed' ? ' · left unfinished' : '';
  return (
    <div
      className={`ip-work w-${item.status}${stale ? ' stale' : ''}${pulse ? ' pulse' : ''}`}
      style={family ? ({ '--fam': familyVar(family.slot) } as CSSProperties) : undefined}
      title={`${subject} — ${owner}${left}${after ? ` · ${after}` : ''}`}
    >
      {family?.tag && <span className="ip-work-tag">{family.tag}</span>}
      <span className="ip-work-mark">{workMark(item.status, stale)}</span>
      {family && <span className="ip-work-agent" />}
      <span className="ip-work-subject">{subject}</span>
      {after && <span className="ip-work-after">{after}</span>}
    </div>
  );
}
