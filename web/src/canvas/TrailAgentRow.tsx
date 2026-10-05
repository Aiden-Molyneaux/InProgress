import type { Node, NodeProps } from '@xyflow/react';
import type { TrailAgent } from '../../../src/core/types';
import { trailAgentLine } from '../live';

export interface TrailAgentRowData extends Record<string, unknown> {
  agent: TrailAgent;
  /** The row it sits under: a leading #id that names it is left out. */
  nodeId: number;
  /** Its session's title, for the tooltip. */
  sessionTitle: string;
  now: number;
}

/**
 * A subagent in the trail, under its node's open done row: `◆ description · model · ran 40 min · stopped 2 h ago`.
 * Greyed like an ended badge, with no colour of its own, and never pulsing.
 */
export function TrailAgentRow({ data }: NodeProps<Node<TrailAgentRowData, 'ipTrailAgent'>>) {
  const { agent, nodeId, sessionTitle, now } = data;
  return (
    <div className="ip-trail-agent" title={`${trailAgentLine(agent, now)} (${agent.agentType}), for ${sessionTitle}`}>
      ◆ {trailAgentLine(agent, now, nodeId)}
    </div>
  );
}
