import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { agentHome, agentShown } from '../../../src/core/layout';
import { isNeedsYou } from '../../../src/core/tree';
import { sessionDisplayTitle, type NodeDetail, type ProjectSnapshot } from '../../../src/core/types';
import { agentKey } from '../agentColors';
import { api } from '../api';
import { TASK_MARK, agentLine, taskOwner, waitsFor, withoutOwnId } from '../live';
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

/** The node's working tasks, with who is on each, and the subagents working on it: live, from the snapshot. */
function LiveWork({ nodeId, snapshot, agentColors }: Pick<DetailsProps, 'nodeId' | 'snapshot' | 'agentColors'>) {
  const now = useNow(30_000);
  const tasks = snapshot.workItems.filter((w) => w.nodeId === nodeId).sort((a, b) => a.position - b.position || a.id - b.id);
  const inTree = new Set(snapshot.nodes.map((n) => n.id));
  const agents = snapshot.sessions.flatMap((s) =>
    s.subagents.filter((a) => agentShown(a, now) && agentHome(s, a, (id) => inTree.has(id)) === nodeId).map((agent) => ({ session: s, agent })),
  );
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
                    — {taskOwner(w, snapshot.sessions)}
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
