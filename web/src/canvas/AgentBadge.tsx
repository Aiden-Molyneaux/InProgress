import type { CSSProperties } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { agentTag, type SubagentInfo } from '../../../src/core/types';
import { familyVar } from '../family';
import { agentLine, withTag } from '../live';

export interface AgentBadgeData extends Record<string, unknown> {
  agent: SubagentInfo;
  /** The row it sits under: a leading #id that names it is left out. */
  nodeId: number;
  /** Its session's slot: the badge wears that family's hue, which its working tasks carry too, and leads with its tag. */
  slot: number | null;
  now: number;
}

/**
 * A subagent's badge: `a1 · description · model · 12 min` in its session's hue, greyed with `done 2 min ago` once it has
 * ended. It keeps its tag then: its session is live, so the letter is still its own. Its tooltip says what it was asked
 * to do (its purpose), or names it and its type while that is unknown.
 */
export function AgentBadge({ data }: NodeProps<Node<AgentBadgeData, 'ipAgent'>>) {
  const { agent, nodeId, slot, now } = data;
  const tag = agentTag(slot, agent.ordinal);
  return (
    <div
      className={`ip-agent${agent.endedAt ? ' ended' : ''}`}
      style={{ '--fam': familyVar(slot) } as CSSProperties}
      title={agent.purpose ?? `${withTag(tag, agentLine(agent, now))} (${agent.agentType})`}
    >
      {tag && (
        <>
          <span className="ip-tag">{tag}</span>
          {' · '}
        </>
      )}
      {agentLine(agent, now, nodeId)}
    </div>
  );
}
