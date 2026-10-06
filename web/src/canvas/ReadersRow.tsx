import type { CSSProperties } from 'react';
import { agentTag, ownerTag, type SubagentInfo } from '../../../src/core/types';
import { familyVar } from '../family';
import { agentName, withTag } from '../live';
import { WorkDoneRow, type WorkDoneRowProps } from './WorkDoneRow';

export interface ReadersRowProps {
  /** The session's running readers on this step, in its order. */
  readers: SubagentInfo[];
  /** Its session's slot: the letter wears that family's hue. */
  slot: number | null;
  /** The step it sits in: a leading #id that names it is left out of the tooltip. */
  nodeId: number;
  /** The card's done row, when this is the card's last line: it sits at the line's right end. */
  done: WorkDoneRowProps | null;
}

/**
 * A session's running readers (Explore, Plan, claude-code-guide) on one step, as one muted line: `◇ a · 2 reading`,
 * only the letter in the session's hue (`◇ ? · 2 reading` while its slot is empty). Its tooltip lists what each reads.
 */
export function ReadersRow({ readers, slot, nodeId, done }: ReadersRowProps) {
  return (
    <div
      className="ip-readers"
      style={{ '--fam': familyVar(slot) } as CSSProperties}
      title={readers.map((a) => withTag(agentTag(slot, a.ordinal), agentName(a, nodeId))).join('\n')}
    >
      <span className="ip-readers-text">
        ◇ <span className="ip-tag">{ownerTag(slot).toLowerCase()}</span> · {readers.length} reading
      </span>
      {done && <WorkDoneRow {...done} />}
    </div>
  );
}
