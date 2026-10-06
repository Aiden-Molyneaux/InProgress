import type { CSSProperties } from 'react';
import type { WorkItem } from '../../../src/core/types';
import { familyVar } from '../family';
import { withoutOwnId, workMark } from '../live';

export interface WorkRowProps {
  item: WorkItem;
  /** In progress while its session works or its subagent runs: the mark pulses. */
  pulse: boolean;
  /** Its session has ended: a trail row, neutral grey, its mark hollow unless it was completed. Never pulses. */
  stale: boolean;
  /**
   * Its live session's family: the slot whose hue its tag and bar wear, and its subagent's tag (`a1`; '' on the
   * session's own list). Null for a trail row, which stays neutral.
   */
  family: { slot: number | null; tag: string } | null;
  /** Who is on it, for the tooltip: the session's title or the subagent's description, led by its letter or tag while live. */
  owner: string;
  /** The open tasks it waits for. */
  waits: string[];
}

/**
 * One working task in its card: ○ pending, ◐ in progress, ✓ completed. A subagent's carries its tag in the card's left
 * column (`a1 ◐ Write the tests`) and no bar; the session's own carries the hue bar. Left open by an ended session, a
 * hollow ○ with no hue.
 */
export function WorkRow({ item, pulse, stale, family, owner, waits }: WorkRowProps) {
  const subject = withoutOwnId(item.subject, item.nodeId);
  const after = waits.length ? `after ${waits.join(', ')}` : '';
  const left = stale && item.status !== 'completed' ? ' · left unfinished' : '';
  return (
    <div
      className={`ip-work w-${item.status}${stale ? ' stale' : ''}${pulse ? ' pulse' : ''}`}
      style={family ? ({ '--fam': familyVar(family.slot) } as CSSProperties) : undefined}
      title={`${subject} · ${owner}${left}${after ? ` · ${after}` : ''}`}
    >
      <span className="ip-work-col">{family?.tag && <span className="ip-work-tag">{family.tag}</span>}</span>
      <span className="ip-work-mark">{workMark(item.status, stale)}</span>
      {family && item.agentId === '' && <span className="ip-work-agent" />}
      <span className="ip-work-subject">{subject}</span>
      {after && <span className="ip-work-after">{after}</span>}
    </div>
  );
}
