import { useEffect, useMemo, useRef, useState } from 'react';
import { commandShown } from '../../../src/core/activity';
import { deriveBoard } from '../../../src/core/board';
import { agentHome, agentVisible, atLimit, homedTrailAgents, isPaused, occupiedSteps } from '../../../src/core/layout';
import { buildIndex, isNeedsYou, shelvedIds } from '../../../src/core/tree';
import { LABEL_GLYPHS, isReader, sessionDisplayTitle, type NodeDetail, type ProjectSnapshot, type TrailAgent, type TreeNode, type WorkItem } from '../../../src/core/types';
import { AgentWords } from '../AgentWords';
import { api, postEvent, unparkStep } from '../api';
import { ParkForm } from '../backlog/ParkForm';
import { shortDate } from '../done/doneGroups';
import { AskActions } from '../board/AskActions';
import { MARK_WORDS } from '../board/Marks';
import { KIND_MARK } from '../board/NeedsMe';
import { QuickAdd } from '../board/QuickAdd';
import { ageShort } from '../board/text';
import { TASK_MARK, agentLineParts, commandDescription, commandLabel, commandMark, commandWhen, taskOwner, trailAgentParts, waitsFor, withoutOwnId, workMark } from '../live';
import { Marker } from '../Marker';
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
  /** A line for the window's toast: why adding a step was refused. */
  onStatus?: (text: string) => void;
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

/** A subagent's purpose as the second line of its Details entry; nothing while it is unknown. */
function PurposeLine({ purpose }: { purpose: string | null }) {
  return purpose ? <div className="ip-dpurpose">{purpose}</div> : null;
}

/**
 * The node's working tasks, with who is on each, the subagents working on it, and its trail of ended work (tasks an
 * ended session left here and subagents that stopped), under each session's title: live, from the snapshot. A running
 * reader is listed marked `◇`; an ended one is not. Each subagent's purpose, when known, is a second line under it. The commands
 * homed here (running, or ended under five minutes ago) are listed under Background.
 */
function LiveWork({ nodeId, snapshot }: Pick<DetailsProps, 'nodeId' | 'snapshot'>) {
  const now = useNow(30_000);
  const { pastSessions, trailAgents } = snapshot;
  const onNode = snapshot.workItems.filter((w) => w.nodeId === nodeId).sort((a, b) => a.position - b.position || a.id - b.id);
  const tasks = onNode.filter((w) => w.endedAt === null);
  const inTree = new Set(snapshot.nodes.map((n) => n.id));
  const agents = snapshot.sessions.flatMap((s) =>
    s.subagents.filter((a) => agentVisible(a, now) && agentHome(s, a, (id) => inTree.has(id)) === nodeId).map((agent) => ({ session: s, agent })),
  );
  const commands = snapshot.sessions.flatMap((s) =>
    s.commands.filter((c) => commandShown(c, now) && agentHome(s, c, (id) => inTree.has(id)) === nodeId).map((command) => ({ session: s, command })),
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
              const owner = taskOwner(w, snapshot.sessions, pastSessions, trailAgents);
              return (
                <li key={w.id} className={`ip-wt w-${w.status}`}>
                  <span className="ip-work-mark">{TASK_MARK[w.status]}</span> {withoutOwnId(w.subject, w.nodeId)}{' '}
                  <span className="muted">
                    · {owner}
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
            {agents.map(({ session, agent }) => {
              return (
                <li
                  key={`${session.id}:${agent.agentId}`}
                  className={`ip-dagent${agent.endedAt ? ' ended' : ''}${atLimit(agent) ? ' limit' : ''}`}
                  title={`${agent.agentType}, for ${sessionDisplayTitle(session)}`}
                >
                  {isReader(agent.agentType) && <span className="ip-reader-mark">◇ </span>}
                  <AgentWords parts={agentLineParts(agent, now, nodeId)} limit={atLimit(agent)} />
                  <PurposeLine purpose={agent.purpose} />
                </li>
              );
            })}
          </ul>
        </>
      )}
      {commands.length > 0 && (
        <>
          <div className="ip-label">Background</div>
          <ul className="ip-dagents">
            {commands.map(({ session, command }) => {
              const description = commandDescription(command);
              return (
                <li
                  key={`${session.id}:${command.taskId}`}
                  className={`ip-dagent${command.endedAt ? ' ended' : ''}${command.endedAt === null && commandMark(command, now) === '◦' ? ' serving' : ''}`}
                  title={`Background command, for ${sessionDisplayTitle(session)}`}
                >
                  <span className="ip-cmd-mark">{commandMark(command, now)}</span>{' '}
                  {description && `${description} · `}
                  {commandLabel(command)} · {commandWhen(command, now)}
                </li>
              );
            })}
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
                    {w.agentId ? <span className="muted"> · {taskOwner(w, snapshot.sessions, pastSessions, trailAgents)}</span> : null}
                  </li>
                ))}
                {g.agents.map((a) => (
                  <li key={`${a.sessionId}:${a.agentId}`} className="ip-dtrail" title={`${a.agentType}, for ${g.title}`}>
                    <span className="ip-agent-dot">◆</span> <AgentWords parts={trailAgentParts(a, now, nodeId)} limit={atLimit(a)} />
                    <PurposeLine purpose={a.purpose} />
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

/**
 * The step's asks (spec 2.7): the open ones with Answer… and Clear as on the Board, then the cleared ones that were
 * answered, as `a5 ◎ "text" · answered "yes" · 2d`. Nothing when there are none.
 */
function AsksSection({ nodeId, snapshot, now }: { nodeId: number; snapshot: ProjectSnapshot; now: number }) {
  const here = snapshot.asks.filter((a) => a.nodeId === nodeId);
  const open = here.filter((a) => a.clearedAt === null);
  const answered = here.filter((a) => a.clearedAt !== null && a.answer !== '').sort((a, b) => b.clearedAt!.localeCompare(a.clearedAt!));
  if (open.length === 0 && answered.length === 0) return null;
  // An ask from before sessions were recorded has no session; one whose session ended names it from the past sessions.
  const raiser = (sessionId: string | null) => {
    if (sessionId === null) return 'migrated';
    const s = snapshot.sessions.find((x) => x.id === sessionId) ?? snapshot.pastSessions.find((x) => x.id === sessionId);
    return sessionDisplayTitle(s ?? { id: sessionId, title: null });
  };
  return (
    <>
      <div className="ip-label">Asks</div>
      <ul className="ip-dasks">
        {open.map((a) => (
          <li key={a.id} className="ip-dask" data-ask={a.id}>
            <div className="ip-dask-head">
              <span className="ip-id">{`a${a.id}`}</span> {KIND_MARK[a.kind]} {a.kind} · <span className="ip-dask-who" title={raiser(a.sessionId)}>{raiser(a.sessionId)}</span> · <span className="ip-time">{ageShort(a.raisedAt, now)}</span>
            </div>
            <p>{a.text}</p>
            <AskActions ask={a} area="details" />
          </li>
        ))}
        {answered.map((a) => (
          <li key={a.id} className="ip-dask cleared" data-ask={a.id}>
            <span className="ip-id">{`a${a.id}`}</span> {KIND_MARK[a.kind]} {`"${a.text}"`} · answered {`"${a.answer}"`} · {ageShort(a.clearedAt!, now)}
          </li>
        ))}
      </ul>
    </>
  );
}

export function Details({ nodeId, snapshot, onClose, onSelectNode, onOpenResource, onStatus }: DetailsProps) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  // Paused as the canvas draws it: the layout's own test, run on the snapshot's copy of each step.
  const byId = useMemo(() => new Map(snapshot.nodes.map((n) => [n.id, n] as const)), [snapshot.nodes]);
  const now = useNow(30_000);
  const [adding, setAdding] = useState(false);
  /** The Park… form is open; an Unpark is in flight. */
  const [parking, setParking] = useState(false);
  const [unparkBusy, setUnparkBusy] = useState(false);
  const addField = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (adding) addField.current?.focus();
  }, [adding]);
  // Details is keyed by its step, so a mount is an open (spec 2.6).
  const projectId = snapshot.project.id;
  useEffect(() => {
    postEvent('details_open', projectId, { node: nodeId });
  }, [projectId, nodeId]);
  const board = useMemo(() => deriveBoard(snapshot, now), [snapshot, now]);
  const shelved = useMemo(() => shelvedIds(buildIndex(snapshot.nodes)), [snapshot.nodes]);
  const occupied = useMemo(() => occupiedSteps(byId, snapshot.sessions, snapshot.workItems, now), [byId, snapshot.sessions, snapshot.workItems, now]);

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
  const marks = board.byId.get(node.id)?.marks ?? [];
  const handoff = snapshot.resources.filter((r) => r.nodeId === node.id && r.purpose === 'handoff').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  /** A step's marker as its card draws it, the sky ring and its tooltip too when paused, but never pulsing. */
  const marker = (n: Pick<TreeNode, 'id' | 'status' | 'kind' | 'assignee'>) => {
    const step = byId.get(n.id);
    const paused = step !== undefined && isPaused(step, occupied);
    return (
      <Marker
        status={n.status}
        question={n.kind === 'question'}
        paused={paused}
        needsYou={isNeedsYou(n, shelved.has(n.id))}
        pulse={false}
        title={paused ? `Nobody is on this. Last change ${relativeTime(step.updatedAt)}` : undefined}
      />
    );
  };
  const unpark = async () => {
    setUnparkBusy(true);
    const result = await unparkStep(projectId, snapshot.project.slug, nodeId, false);
    setUnparkBusy(false);
    if (result === 'reload') window.location.reload();
    else if (result !== 'ok') onStatus?.(result);
  };
  /** An open step can be set aside; the root, a finished, dropped or parked one cannot. */
  const parkable = detail.parent !== null && (node.status === 'todo' || node.status === 'active' || node.status === 'blocked');
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
        <b tabIndex={-1}>#{node.id} {node.title}</b>
        <button className="ip-btn" onClick={() => void copy()}>{copied ? 'Copied' : `Copy #${node.id}`}</button>
        <button className="ip-btn" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="ip-meta">
        {/* The canvas's marker, then the status as a muted word. A paused step draws the sky ring here too; nothing
            pulses here. */}
        {marker(node)}
        <span>{node.status}</span>
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
      {node.status === 'parked' && (
        <div className="ip-dparked">
          <p>
            <b>{node.parkedAt ? `Parked ${shortDate(node.parkedAt, now)}:` : 'Parked:'}</b> {node.parkedReason}
          </p>
          {node.parkedWhere && <p className="muted">{`where ${node.parkedWhere}`}</p>}
          <button type="button" className="ip-btn" disabled={unparkBusy} onClick={() => void unpark()}>Unpark</button>
        </div>
      )}
      <AsksSection nodeId={node.id} snapshot={snapshot} now={now} />
      {(handoff || marks.length > 0) && (
        <div className="ip-dmarks">
          {handoff && (
            <button type="button" className="ip-chip-handoff" onClick={() => onOpenResource(handoff.id)}>
              {`handoff · ${ageShort(handoff.createdAt, now)}`}
            </button>
          )}
          {marks.map((m) => (
            <span key={m} className="ip-mark hygiene">
              {MARK_WORDS[m]}
            </span>
          ))}
        </div>
      )}
      {node.body && <Markdown text={node.body} />}
      {node.outcome && (
        <p className="ip-outcome">
          <b>Outcome:</b> {node.outcome}
        </p>
      )}
      <LiveWork nodeId={node.id} snapshot={snapshot} />
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
                  <span className="ip-kid-mark">{marker(c)}</span>
                  #{c.id} {c.title}
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
                <span className="ip-log-time">{relativeTime(l.createdAt)}</span> · <span className="ip-log-text">{l.text}</span>
                {l.sessionTitle ? <span> · {l.sessionTitle}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {parkable && (
        <div className="ip-dadd">
          {parking ? (
            <ParkForm projectId={projectId} slug={snapshot.project.slug} nodeId={node.id} title={node.title} onStatus={onStatus} onDone={() => setParking(false)} onCancel={() => setParking(false)} />
          ) : (
            <button type="button" className="ip-btn" onClick={() => setParking(true)}>Park…</button>
          )}
        </div>
      )}
      <div className="ip-dadd">
        {adding ? (
          <QuickAdd
            projectId={snapshot.project.id}
            slug={snapshot.project.slug}
            inputRef={addField}
            onStatus={onStatus}
            parent={node.id}
            label={`Add a step under #${node.id}`}
            onClose={() => {
              setAdding(false);
              // The button is not mounted until the field is gone, so focus waits for the next frame.
              requestAnimationFrame(() => addButton.current?.focus());
            }}
          />
        ) : (
          <button type="button" ref={addButton} className="ip-btn" onClick={() => setAdding(true)}>
            Add a step under this one
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 12 }}>
        Updated {relativeTime(node.updatedAt)} · {snapshot.project.name}
      </p>
      {error && <p className="muted">Couldn't refresh: {error}</p>}
    </aside>
  );
}
