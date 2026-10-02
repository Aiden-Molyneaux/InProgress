import type { Node, NodeProps } from '@xyflow/react';
import { sessionDisplayTitle, type Session } from '../../../src/core/types';
import { agentName } from '../live';

const WORDS: Record<Session['state'], string> = { working: 'working', idle: 'idle', permission: 'needs permission', ended: 'ended' };

export interface BadgeNodeData extends Record<string, unknown> {
  session: Session;
}

export function BadgeNode({ data }: NodeProps<Node<BadgeNodeData, 'ipBadge'>>) {
  const s = data.session;
  // Ended subagents keep a greyed badge of their own for a while; the count is of the ones still running.
  const running = s.subagents.filter((a) => a.endedAt === null);
  const subs = running.length;
  return (
    <div className={`ip-badge s-${s.state}`} title={subs ? running.map((a) => agentName(a)).join(', ') : undefined}>
      {s.state === 'working' && <span className="ip-pulse" />}◆ {sessionDisplayTitle(s)} · {WORDS[s.state]}
      {subs ? ` · ${subs} subagent${subs > 1 ? 's' : ''}` : ''}
    </div>
  );
}
