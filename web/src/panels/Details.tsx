import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { agentHome, agentShown, homedTrailAgents } from '../../../src/core/layout';
import { isNeedsYou } from '../../../src/core/tree';
import { LABEL_GLYPHS, sessionDisplayTitle, type NodeDetail, type ProjectSnapshot, type TrailAgent, type WorkItem } from '../../../src/core/types';
import { agentKey } from '../agentColors';
import { api } from '../api';
import { TASK_MARK, agentLine, taskOwner, trailAgentLine, waitsFor, withoutOwnId, workMark } from '../live';
import { relativeTime } from '../time';
import { useNow } from '../useNow';
import { resourceSummary } from './format';
import { Markdown } from './Markdown';

interface DetailsProps {
  nodeId: number;
  snapshot: ProjectSnapshot;
  onClose: () => void;
  onSelectNode: (id: number) => void;
  onOpenResource: (id: number) => void;
  /** Each subagent's colour, by agentKey. */
  agentColors: ReadonlyMap<string, string>;
}

/** One session's part of a node's trail: what it left there, under its title. */
interface TrailGroup {
  id: string;
  title: string;
  /** When the session ended; null for a live session, whose stopped subagents are its only trail. */
  endedAt: string | null;
  tasks: WorkItem[];
  agents: TrailAgent[];
}

/** The node's trail by session: live sessions first, then past ones, newest first, as the snapshot lists them. */
function trailGroups(snapshot: ProjectSnapshot, tasks: WorkItem[], agents: TrailAgent[]): TrailGroup[] {
  const known = [
    ...snapshot.sessions.map((s) => ({ id: s.id, title: sessionDisplayTitle(s), endedAt: null })),
    ...snapshot.pastSessions.map((s) => ({ id: s.id, title: sessionDisplayTitle(s), endedAt: s.endedAt })),
  ];
  const ids = [...new Set([...tasks.map((w) => w.sessionId), ...agents.map((a) => a.sessionId)])];
  const order = (id: string) => {
    const i = known.findIndex((s) => s.id === id);
    return i < 0 ? known.length : i;
  };
  return ids
    .sort((a, b) => order(a) - order(b))
    .map((id) => ({
      ...(known.find((s) => s.id === id) ?? { id, title: 'A session', endedAt: null }),
      tasks: tasks.filter((w) => w.sessionId === id),
      agents: agents.filter((a) => a.sessionId === id),
    }));
}

/**
 * The node's working tasks, with who is on each, the subagents working on it, and its trail of ended work (tasks an
 * ended session left here and subagents that stopped), under each session's title: live, from the snapshot.
 */
function LiveWork({ nodeId, snapshot, agentColors }: Pick<DetailsProps, 'nodeId' | 'snapshot' | 'agentColors'>) {
  const now = useNow(30_000);
  const { pastSessions, trailAgents } = snapshot;
  const onNode = snapshot.workItems.filter((w) => w.nodeId === nodeId).sort((a, b) => a.position - b.position || a.id - b.id);
  const tasks = onNode.filter((w) => w.endedAt === null);
  const inTree = new Set(snapshot.nodes.map((n) => n.id));
  const agents = snapshot.sessions.flatMap((s) =>
    s.subagents.filter((a) => agentShown(a, now) && agentHome(s, a, (id) => inTree.has(id)) === nodeId).map((agent) => ({ session: s, agent })),
  );
  const trailHere = homedTrailAgents({ sessions: snapshot.sessions, trailAgents, pastSessions, now }, (id) => inTree.has(id))
    .filter((t) => t.nodeId === nodeId)
    .map((t) => t.agent);
  const trail = trailGroups(snapshot, onNode.filter((w) => w.endedAt !== null), trailHere);
  return (
    <>
      {tasks.length > 0 && (
        <>
          <div className="ip-label">Working tasks</div>
          <ul className="ip-wts">
            {tasks.map((w) => {
              const waits = waitsFor(w, snapshot.workItems);
              const color = w.agentId ? agentColors.get(agentKey(w.sessionId, w.agentId)) : undefined;
              return (
                <li key={w.id} className={`ip-wt w-${w.status}`}>
                  <span className="ip-work-mark">{TASK_MARK[w.status]}</span> {color && <span className="ip-work-agent" style={{ background: color }} />}
                  {withoutOwnId(w.subject, w.nodeId)}{' '}
                  <span className="muted">
                    — {taskOwner(w, snapshot.sessions, pastSessions, trailAgents)}
                    {waits.length ? ` · after ${waits.join(', ')}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {agents.length > 0 && (
        <>
          <div className="ip-label">Subagents</div>
          <ul className="ip-dagents">
            {agents.map(({ session, agent }) => (
              <li
                key={agentKey(session.id, agent.agentId)}
                className={`ip-dagent${agent.endedAt ? ' ended' : ''}`}
                style={{ '--agent': agentColors.get(agentKey(session.id, agent.agentId)) } as CSSProperties}
                title={`${agent.agentType}, for ${sessionDisplayTitle(session)}`}
              >
                <span className="ip-agent-dot">◆</span> {agentLine(agent, now, nodeId)}
              </li>
            ))}
          </ul>
        </>
      )}
      {trail.length > 0 && (
        <>
          <div className="ip-label">Ended work</div>
          {trail.map((g) => (
            <div key={g.id} className="ip-trail">
              <div className="ip-trail-head">
                {g.title}
                {g.endedAt ? ` · ended ${relativeTime(g.endedAt, now)}` : ''}
              </div>
              <ul className="ip-wts">
                {g.tasks.map((w) => (
                  <li key={w.id} className={`ip-wt w-${w.status} stale`}>
                    <span className="ip-work-mark">{workMark(w.status, true)}</span> {withoutOwnId(w.subject, w.nodeId)}
                    {w.agentId ? <span className="muted"> — {taskOwner(w, snapshot.sessions, pastSessions, trailAgents)}</span> : null}
                  </li>
                ))}
                {g.agents.map((a) => (
                  <li key={agentKey(a.sessionId, a.agentId)} className="ip-dtrail" title={`${a.agentType}, for ${g.title}`}>
                    <span className="ip-agent-dot">◆</span> {trailAgentLine(a, now, nodeId)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </>
  );
}

export function Details({ nodeId, snapshot, onClose, onSelectNode, onOpenResource, agentColors }: DetailsProps) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  // Refetch whenever the snapshot changes, so the panel follows Claude's edits. A failed refetch keeps the last good detail.
  useEffect(() => {
    let alive = true;
    api
      .node(nodeId)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [nodeId, snapshot]);

  if (!detail) {
    return (
      <aside className="ip-details" aria-label="Node details">
        <header>
          <b>#{nodeId}</b>
          <button className="ip-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="muted">{error || 'Loading…'}</p>
      </aside>
    );
  }

  const { node } = detail;
  const copy = async () => {
    await navigator.clipboard.writeText(`#${node.id} ${node.title}`);
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <aside className="ip-details" aria-label="Node details">
      <div className="ip-grab" />
      <header>
        <b>#{node.id} {node.title}</b>
        <button className="ip-btn" onClick={() => void copy()}>{copied ? 'Copied' : `Copy #${node.id}`}</button>
        <button className="ip-btn" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="ip-meta">
        {isNeedsYou(node) ? <span className="ip-pill you">NEEDS YOU</span> : <span className={`ip-pill st-${node.status}`}>{node.status}</span>}
        <span>{node.kind}</span>
        {node.label && (
          <span className="ip-meta-label">
            · <span className={`ip-glyph l-${node.label}`}>{LABEL_GLYPHS[node.label]}</span> {node.label}
          </span>
        )}
        <span>· {node.assignee === 'me' ? 'you' : 'Claude'}</span>
        {detail.parent && (
          <span>
            · in{' '}
            <button className="ip-link" onClick={() => onSelectNode(detail.parent!.id)}>
              #{detail.parent.id} {detail.parent.title}
            </button>
          </span>
        )}
      </div>
      {node.body && <Markdown text={node.body} />}
      {node.outcome && (
        <p className="ip-outcome">
          <b>Outcome:</b> {node.outcome}
        </p>
      )}
      {detail.resources.length > 0 && (
        <>
          <div className="ip-label">Resources</div>
          {detail.resources.map((r) => (
            <button key={r.id} className="ip-res" onClick={() => onOpenResource(r.id)}>
              ▤ <b>{r.title}</b>
              <span className="sub">{resourceSummary(r)}</span>
            </button>
          ))}
        </>
      )}
      <LiveWork nodeId={node.id} snapshot={snapshot} agentColors={agentColors} />
      {detail.children.length > 0 && (
        <>
          <div className="ip-label">Steps</div>
          <ul className="ip-kids">
            {detail.children.map((c) => (
              <li key={c.id}>
                <button onClick={() => onSelectNode(c.id)}>
                  <span className={`ip-marker m-${c.status}`} />#{c.id} {c.title}
                  {c.assignee === 'me' && c.status !== 'done' ? <span className="ip-you">YOU</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {detail.log.length > 0 && (
        <>
          <div className="ip-label">Log</div>
          <ul className="ip-log">
            {detail.log.map((l) => (
              <li key={l.id}>
                {relativeTime(l.createdAt)} · {l.text}
                {l.sessionTitle ? <i> — {l.sessionTitle}</i> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted" style={{ marginTop: 12 }}>
        Updated {relativeTime(node.updatedAt)} · {snapshot.project.name}
      </p>
      {error && <p className="muted">Couldn't refresh: {error}</p>}
    </aside>
  );
}
