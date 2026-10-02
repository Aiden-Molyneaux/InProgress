import type { CSSProperties } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { SubagentInfo } from '../../../src/core/types';
import { agentLine } from '../live';

export interface AgentBadgeData extends Record<string, unknown> {
  agent: SubagentInfo;
  /** The row it sits under: a leading #id that names it is left out. */
  nodeId: number;
  /** Its colour, which its working tasks carry too. */
  color: string;
  now: number;
}

/** A subagent's badge: `◆ description · model · 12 min`, greyed with `done 2 min ago` once it has ended. */
export function AgentBadge({ data }: NodeProps<Node<AgentBadgeData, 'ipAgent'>>) {
  const { agent, nodeId, color, now } = data;
  return (
    <div
      className={`ip-agent${agent.endedAt ? ' ended' : ''}`}
      style={{ '--agent': color } as CSSProperties}
      title={`${agentLine(agent, now)} (${agent.agentType})`}
    >
      ◆ {agentLine(agent, now, nodeId)}
    </div>
  );
}
