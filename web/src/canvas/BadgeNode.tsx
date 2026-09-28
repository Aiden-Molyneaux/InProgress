import type { Node, NodeProps } from '@xyflow/react';
import { sessionDisplayTitle, type Session } from '../../../src/core/types';

const WORDS: Record<Session['state'], string> = { working: 'working', idle: 'idle', permission: 'needs permission', ended: 'ended' };

export interface BadgeNodeData extends Record<string, unknown> {
  session: Session;
}

export function BadgeNode({ data }: NodeProps<Node<BadgeNodeData, 'ipBadge'>>) {
  const s = data.session;
  const subs = s.subagents.length;
  return (
    <div className={`ip-badge s-${s.state}`} title={subs ? s.subagents.map((a) => a.agentType).join(', ') : undefined}>
      {s.state === 'working' && <span className="ip-pulse" />}◆ {sessionDisplayTitle(s)} · {WORDS[s.state]}
      {subs ? ` · ${subs} subagent${subs > 1 ? 's' : ''}` : ''}
    </div>
  );
}
