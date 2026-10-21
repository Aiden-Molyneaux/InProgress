import type { LineParts } from './live';

/**
 * A subagent's line as text, `who · when` (agentLineParts or trailAgentParts), with `when` in --volt for one that
 * hit the usage limit: it waits for Aiden to resume it. Its text reads the same as agentLine or trailAgentLine.
 */
export function AgentWords({ parts, limit }: { parts: LineParts; limit: boolean }) {
  return (
    <>
      {parts.who}
      {' · '}
      {limit ? <span className="ip-limit-words">{parts.when}</span> : parts.when}
    </>
  );
}
