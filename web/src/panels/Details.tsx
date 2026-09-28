import { useEffect, useState } from 'react';
import { isNeedsYou } from '../../../src/core/tree';
import type { NodeDetail, ProjectSnapshot } from '../../../src/core/types';
import { api } from '../api';
import { relativeTime } from '../time';
import { resourceSummary } from './format';
import { Markdown } from './Markdown';

interface DetailsProps {
  nodeId: number;
  snapshot: ProjectSnapshot;
  onClose: () => void;
  onSelectNode: (id: number) => void;
  onOpenResource: (id: number) => void;
}

export function Details({ nodeId, snapshot, onClose, onSelectNode, onOpenResource }: DetailsProps) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Refetch whenever the snapshot changes, so the panel follows Claude's edits.
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

  if (error) {
    return (
      <aside className="ip-details" aria-label="Node details">
        <header>
          <b>#{nodeId}</b>
          <button className="ip-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="muted">{error}</p>
      </aside>
    );
  }
  if (!detail) {
    return (
      <aside className="ip-details" aria-label="Node details">
        <p className="muted">Loading…</p>
      </aside>
    );
  }

  const { node } = detail;
  const copy = async () => {
    await navigator.clipboard.writeText(`#${node.id} ${node.title}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
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
    </aside>
  );
}
