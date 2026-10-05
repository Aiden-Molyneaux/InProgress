import type { CSSProperties } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { agentTag, ownerTag, type SubagentInfo } from '../../../src/core/types';
import { familyVar } from '../family';
import { agentName, withTag } from '../live';

export interface ReadersRowData extends Record<string, unknown> {
  /** The session's running readers on this row, in its order. */
  readers: SubagentInfo[];
  /** Its session's slot: the row wears that family's hue and its letter. */
  slot: number | null;
  /** The row it sits under: a leading #id that names it is left out of the tooltip. */
  nodeId: number;
}

/**
 * A session's running readers (Explore, Plan, claude-code-guide) on one step, as one small row: `◇ a · 2 reading` in the
 * session's hue, `◇ ? · 2 reading` while its slot is empty. Its tooltip lists what each reads, led by its tag.
 */
export function ReadersRow({ data }: NodeProps<Node<ReadersRowData, 'ipReaders'>>) {
  const { readers, slot, nodeId } = data;
  return (
    <div
      className="ip-readers"
      style={{ '--fam': familyVar(slot) } as CSSProperties}
      title={readers.map((a) => withTag(agentTag(slot, a.ordinal), agentName(a, nodeId))).join('\n')}
    >
      ◇ <span className="ip-tag">{ownerTag(slot).toLowerCase()}</span> · {readers.length} reading
    </div>
  );
}
