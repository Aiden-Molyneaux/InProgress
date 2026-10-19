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
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
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
 * homed here (running, or ended under five minutes ago) are listed under Background. One LIVE WORK head counts the
 * live tasks, subagents and commands over the four lists.
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
  if (tasks.length + agents.length + commands.length + trail.length === 0) return null;
  return (
    <section className="ip-dsec ip-dlive">
      <Eyebrow as="h3" glyph="[◈]">{`LIVE WORK · ${tasks.length + agents.length + commands.length}`}</Eyebrow>
      {tasks.length > 0 && (
        <>
          <Eyebrow className="ip-dsub">Working tasks</Eyebrow>
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
          <Eyebrow className="ip-dsub">Subagents</Eyebrow>
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
          <Eyebrow className="ip-dsub">Background</Eyebrow>
          <ul className="ip-dagents ip-dcmds">
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
          <Eyebrow className="ip-dsub">Ended work</Eyebrow>
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
    </section>
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
    <section className="ip-dsec">
      <Eyebrow as="h3" glyph="//">{`ASKS · ${open.length + answered.length}`}</Eyebrow>
      <ul className="ip-dasks">
        {open.map((a) => (
          <li key={a.id} className="ip-dask" data-ask={a.id}>
            <Eyebrow className="ip-dask-head">
              <span className="ip-id">{`a${a.id}`}</span> {KIND_MARK[a.kind]} {a.kind} · <span className="ip-time">{ageShort(a.raisedAt, now)}</span>
            </Eyebrow>
            <div className="ip-dask-who" title={raiser(a.sessionId)}>{raiser(a.sessionId)}</div>
            <p>{a.text}</p>
            <AskActions ask={a} area="details" />
          </li>
        ))}
        {answered.map((a) => (
          <li key={a.id} className="ip-dask cleared" data-ask={a.id}>
            <Eyebrow className="ip-dask-head">
              <span className="ip-id">{`a${a.id}`}</span> {KIND_MARK[a.kind]} ANSWERED · <span className="ip-time">{ageShort(a.clearedAt!, now)}</span>
            </Eyebrow>
            <span className="ip-dask-line">{`"${a.text}"`} · answered {`"${a.answer}"`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Details({ nodeId, snapshot, onClose, onSelectNode, onOpenResource, onStatus }: DetailsProps) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Counts Retry presses: the fetch below runs again for each. */
  const [attempt, setAttempt] = useState(0);
  /** Set by Retry, so a refetch that succeeds can put back the focus the Retry button took with it. */
  const retried = useRef(false);
  const [refocusAdd, setRefocusAdd] = useState(false);
  const retry = () => {
    retried.current = true;
    setAttempt((n) => n + 1);
  };
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
  /** Which of Park… and Unpark should take focus once it is drawn: a form closing, or the step changing state. */
  const [focusNext, setFocusNext] = useState<'park' | 'unpark' | null>(null);
  const parkButton = useRef<HTMLButtonElement>(null);
  const unparkButton = useRef<HTMLButtonElement>(null);
  const status = detail?.node.status;
  useEffect(() => {
    if (focusNext === 'park' && !parking && parkButton.current) parkButton.current.focus();
    else if (focusNext === 'unpark' && status === 'parked' && unparkButton.current) unparkButton.current.focus();
    else return;
    setFocusNext(null);
  }, [focusNext, parking, status]);
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
        if (retried.current) {
          retried.current = false;
          setRefocusAdd(true);
        }
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [nodeId, snapshot, attempt]);

  // Opening Details moves focus to its title once the step has loaded. A passive effect, not a layout effect: App's layout
  // effect has already recorded the tile that opened it.
  const title = useRef<HTMLHeadingElement>(null);
  const loaded = detail !== null;
  useEffect(() => {
    if (!loaded) return;
    // Never take focus from a field Aiden is typing in outside Details.
    const at = document.activeElement;
    const editable = at instanceof HTMLElement && (at.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName));
    if (!at || at === document.body || at.closest('.ip-details') || !editable) title.current?.focus();
  }, [loaded]);
  // A Retry in the strip unmounts itself when the refetch succeeds: focus falls to the page, so Add a step takes it.
  useEffect(() => {
    if (!refocusAdd) return;
    const at = document.activeElement;
    if (!at || at === document.body) addButton.current?.focus();
    setRefocusAdd(false);
  }, [refocusAdd, detail]);
  // The Park form closes if the step stops being parkable under it (parked or finished from elsewhere).
  const canPark = detail !== null && detail.parent !== null && (detail.node.status === 'todo' || detail.node.status === 'active' || detail.node.status === 'blocked');
  useEffect(() => {
    if (!canPark) setParking(false);
  }, [canPark]);

  if (!detail) {
    return (
      <aside className="ip-details" aria-label="Node details">
        <header className="ip-dhead">
          <div className="ip-dtop">
            <Eyebrow>{`#${nodeId}`}</Eyebrow>
            <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}>×</Button>
          </div>
        </header>
        <div className="ip-dbody">{error ? <ErrorLine message={error} onRetry={retry} /> : <p className="ip-dmuted">Loading…</p>}</div>
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
    if (result === 'ok') setFocusNext('park');
    else if (result === 'reload') window.location.reload();
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
  const statusTone = isNeedsYou(node, shelved.has(node.id)) ? 'needs' : node.status === 'active' ? 'live' : node.status === 'blocked' ? 'blocked' : node.status === 'parked' ? 'parked' : 'quiet';

  return (
    <aside className="ip-details" aria-label="Node details">
      <header className="ip-dhead">
        <div className="ip-dtop">
          <Eyebrow>{`#${node.id} · ${node.kind.toUpperCase()}`}</Eyebrow>
          <span className="ip-dtop-act">
            <Button variant="ghost" size="sm" onClick={() => void copy()}>{copied ? 'Copied' : `Copy #${node.id}`}</Button>
            <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}>×</Button>
          </span>
        </div>
        <h2 ref={title} tabIndex={-1} className="ip-dtitle">{node.title}</h2>
      </header>
      <div className="ip-dbody">
        <div className="ip-meta">
          {/* The canvas's marker, then the status as a chip. A paused step draws the sky ring here too; nothing pulses here. */}
          {marker(node)}
          <Chip tone={statusTone}>{node.status}</Chip>
          {node.label && (
            <Chip tone="label" glyph={LABEL_GLYPHS[node.label]} className="ip-meta-label">
              {node.label}
            </Chip>
          )}
          {node.assignee === 'me' ? <Chip tone="needs">YOU</Chip> : <span className="ip-dwho">Claude</span>}
          {detail.parent && (
            <span className="ip-dparent">
              in{' '}
              <button className="ip-link" onClick={() => onSelectNode(detail.parent!.id)}>
                #{detail.parent.id} {detail.parent.title}
              </button>
            </span>
          )}
        </div>
        {node.status === 'parked' && (
          <div className="ip-dparked">
            <Eyebrow>{node.parkedAt ? `Parked ${shortDate(node.parkedAt, now)}` : 'Parked'}</Eyebrow>
            <p>{node.parkedReason}</p>
            {node.parkedWhere && <p className="ip-dmuted">{`where ${node.parkedWhere}`}</p>}
            <Button ref={unparkButton} variant="outline" size="sm" busy={unparkBusy} onClick={() => void unpark()}>Unpark</Button>
          </div>
        )}
        <AsksSection nodeId={node.id} snapshot={snapshot} now={now} />
        {(handoff || marks.length > 0 || node.body || node.outcome) && (
          <section className="ip-dsec ip-dstep">
            {(handoff || marks.length > 0) && (
              <div className="ip-dmarks">
                {handoff && (
                  <button type="button" className="ip-chip-handoff" onClick={() => onOpenResource(handoff.id)}>
                    {`handoff · ${ageShort(handoff.createdAt, now)}`}
                  </button>
                )}
                {marks.map((m) => (
                  <Chip key={m} tone="quiet" dashed>
                    {MARK_WORDS[m]}
                  </Chip>
                ))}
              </div>
            )}
            {node.body && <Markdown text={node.body} />}
            {node.outcome && (
              <div className="ip-outcome">
                <Eyebrow glyph="[✓]">OUTCOME</Eyebrow>
                <p>{node.outcome}</p>
              </div>
            )}
          </section>
        )}
        <LiveWork nodeId={node.id} snapshot={snapshot} />
        {detail.resources.length > 0 && (
          <section className="ip-dsec">
            <Eyebrow as="h3" glyph="//">{`RESOURCES · ${detail.resources.length}`}</Eyebrow>
            <div className="ip-ress">
              {detail.resources.map((r) => (
                <button key={r.id} className="ip-res" onClick={() => onOpenResource(r.id)}>
                  <span className="ip-res-title">{r.title}</span>
                  <span className="sub">{resourceSummary(r)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {detail.children.length > 0 && (
          <section className="ip-dsec">
            <Eyebrow as="h3" glyph="//">{`STEPS · ${detail.children.length}`}</Eyebrow>
            <ul className="ip-kids">
              {detail.children.map((c) => (
                <li key={c.id}>
                  <button onClick={() => onSelectNode(c.id)}>
                    <span className="ip-kid-mark">{marker(c)}</span>
                    <span className="ip-kid-id">#{c.id}</span>{' '}
                    <span className="ip-kid-title">{c.title}</span>
                    {c.assignee === 'me' && c.status !== 'done' ? <Chip tone="needs">YOU</Chip> : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {detail.log.length > 0 && (
          <section className="ip-dsec">
            <Eyebrow as="h3" glyph="//">{`LOG · ${detail.log.length}`}</Eyebrow>
            <ul className="ip-log">
              {detail.log.map((l) => (
                <li key={l.id}>
                  <span className="ip-log-time">{relativeTime(l.createdAt)}</span> <span className="ip-log-text">{l.text}</span>
                  {l.sessionTitle ? <span className="ip-log-session"> · {l.sessionTitle}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="ip-dstrip">
        {parking && parkable ? (
          <ParkForm projectId={projectId} slug={snapshot.project.slug} nodeId={node.id} title={node.title} onStatus={onStatus} onDone={() => { setParking(false); setFocusNext('unpark'); }} onCancel={() => { setParking(false); setFocusNext('park'); }} />
        ) : adding ? (
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
          <>
            {parkable && <Button ref={parkButton} variant="outline" size="md" onClick={() => setParking(true)}>Park…</Button>}
            <Button ref={addButton} variant="ghost" size="md" aria-label={`Add a step under #${node.id}`} onClick={() => setAdding(true)}>Add a step</Button>
            {error ? (
              <ErrorLine className="ip-dstrip-error" message="Couldn't refresh" onRetry={retry} />
            ) : (
              <span className="ip-dupdated">{`UPDATED ${relativeTime(node.updatedAt).toUpperCase()}`}</span>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
