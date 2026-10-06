import type { CSSProperties } from 'react';
import { agentTag, sessionDisplayTitle, sessionTag, type Session, type SubagentInfo } from '../../../src/core/types';
import { familyVar } from '../family';
import { WORDS, agentLine, kinTitle, runTime, withTag } from '../live';
import { WorkDoneRow, type WorkDoneRowProps } from './WorkDoneRow';

/** How many kin a line draws. Past that, a muted `+n` stands for the rest. */
const MAX_KIN = 6;

export interface AgentLineProps {
  session: Session;
  /** The step the line sits in: a kin's leading `#id` that names it is left out of the kin's name. */
  nodeId: number;
  /** The session's focus anchors on this step: the line draws its lead and its label. */
  lead: boolean;
  /** Its shown workers on this step, in the session's order (LayoutLineItem.agentIds, resolved). */
  agents: SubagentInfo[];
  now: number;
  /** The card's done row, when this is the card's last line and it holds no kin. */
  done: WorkDoneRowProps | null;
}

interface KinProps {
  agent: SubagentInfo;
  session: Session;
  nodeId: number;
  now: number;
}

/** One shown worker: its tag and, while it runs, its run time. Its name and tooltip carry the rest, then its purpose. */
function Kin({ agent, session, nodeId, now }: KinProps) {
  const tag = agentTag(session.slot, agent.ordinal);
  const name = kinTitle(agent, session.slot, now, nodeId);
  const running = agent.endedAt === null;
  return (
    <span className={running ? 'ip-agent' : 'ip-agent ended'} role="img" aria-label={name} title={name}>
      {tag && <span className="ip-agent-tag">{tag}</span>}
      {running && <span className="ip-agent-time">{runTime(agent.startedAt, now)}</span>}
    </span>
  );
}

/**
 * One session's line in a card. Where its focus anchors: its kin, then its label `A · E2E session · working`. Away
 * from its focus: its letter, then its kin, with no label. Its accessible name leads with the letter either way. The
 * card's done row rides at its right end when this is the card's last line and it holds no kin.
 */
export function AgentLine({ session, nodeId, lead, agents, now, done }: AgentLineProps) {
  const letter = sessionTag(session.slot);
  const title = sessionDisplayTitle(session);
  const word = WORDS[session.state];
  const hidden = agents.slice(MAX_KIN);
  return (
    <div
      className={`ip-badge s-${session.state}`}
      role="group"
      aria-label={withTag(letter, lead ? `${title} · ${word}` : `subagents of ${title}`)}
      style={{ '--fam': familyVar(session.slot) } as CSSProperties}
    >
      {!lead && letter && <span className="ip-tag">{letter}</span>}
      {agents.slice(0, MAX_KIN).map((a) => (
        <Kin key={a.agentId} agent={a} session={session} nodeId={nodeId} now={now} />
      ))}
      {hidden.length > 0 && (
        <span className="ip-agent-more" title={hidden.map((a) => withTag(agentTag(session.slot, a.ordinal), agentLine(a, now, nodeId))).join('\n')}>
          +{hidden.length}
        </span>
      )}
      {lead && (
        <span className="ip-badge-label">
          {letter && (
            <>
              <span className="ip-tag">{letter}</span>
              <span className="ip-badge-sep"> · </span>
            </>
          )}
          <span className="ip-badge-title">{title}</span>
          <span className="ip-badge-sep"> · </span>
          <span className="ip-badge-word">{word}</span>
        </span>
      )}
      {done && <WorkDoneRow {...done} />}
    </div>
  );
}
