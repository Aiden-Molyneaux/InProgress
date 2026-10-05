import type { CSSProperties } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { sessionDisplayTitle, sessionTag, type Session } from '../../../src/core/types';
import { familyVar } from '../family';
import { agentName } from '../live';

const WORDS: Record<Session['state'], string> = { working: 'working', idle: 'idle', permission: 'needs permission', ended: 'ended' };

export interface BadgeNodeData extends Record<string, unknown> {
  session: Session;
}

/** A session's focus badge, in its family's hue: `◆ A · title · working · 2 subagents`. */
export function BadgeNode({ data }: NodeProps<Node<BadgeNodeData, 'ipBadge'>>) {
  const s = data.session;
  // Ended subagents keep a greyed badge of their own for a while; the count is of the ones still running.
  const running = s.subagents.filter((a) => a.endedAt === null);
  const subs = running.length;
  const letter = sessionTag(s.slot);
  return (
    <div
      className={`ip-badge s-${s.state}`}
      style={{ '--fam': familyVar(s.slot) } as CSSProperties}
      title={subs ? running.map((a) => agentName(a)).join(', ') : undefined}
    >
      {s.state === 'working' && <span className="ip-pulse" />}
      {/* One run of text, so the badge's gap falls only after the pulse. */}
      <span>
        ◆{' '}
        {letter && (
          <>
            <span className="ip-tag">{letter}</span>
            {' · '}
          </>
        )}
        {sessionDisplayTitle(s)} · {WORDS[s.state]}
        {subs ? ` · ${subs} subagent${subs > 1 ? 's' : ''}` : ''}
      </span>
    </div>
  );
}
