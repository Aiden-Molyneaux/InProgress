import type { TrailAgent } from '../../../src/core/types';
import { trailAgentLine } from '../live';

export interface TrailAgentRowProps {
  agent: TrailAgent;
  /** The step it sits in: a leading #id that names it is left out. */
  nodeId: number;
  /** Its session's title, for the tooltip. */
  sessionTitle: string;
  now: number;
}

/**
 * A subagent in the trail, under its step's open done row: `◆ description · model · ran 40 min · stopped 2 h ago`.
 * Neutral, with no colour of its own, and never pulsing. Its tooltip is its purpose when known.
 */
export function TrailAgentRow({ agent, nodeId, sessionTitle, now }: TrailAgentRowProps) {
  return (
    <div className="ip-trail-agent" title={agent.purpose ?? `${trailAgentLine(agent, now)} (${agent.agentType}), for ${sessionTitle}`}>
      ◆ {trailAgentLine(agent, now, nodeId)}
    </div>
  );
}
