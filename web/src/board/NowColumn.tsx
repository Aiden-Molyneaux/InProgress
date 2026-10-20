import { commandShown, orderCommands } from '../../../src/core/activity';
import type { BoardRow } from '../../../src/core/board';
import type { TaskState } from '../../../src/core/taskState';
import { isReader, sessionDisplayTitle, type Session } from '../../../src/core/types';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { markDone } from '../api';
import { agentName, commandLineParts, runTime, withoutOwnId } from '../live';
import { noteAction } from '../measure';
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import { EmptyState } from '../parts/EmptyState';
import { ErrorLine } from '../parts/ErrorLine';
import { Field } from '../parts/Field';
import type { CursorItemProps } from '../parts/ListCursor';
import { focusTargetAfter } from './focus';
import { endedLine } from './Marks';
import type { BandProps } from './bandProps';
import { BoardTile } from './BoardTile';
import { taskProgress } from './nowTask';
import { SessionLine } from './SessionLine';
import { OpenScope } from './TaskBox';

/** One session on a step: its line, then a terminal readout with its in-progress task, its commands line and its running subagents. */
function SessionPart({ session, row, snapshot, now }: { session: Session; row: BoardRow; snapshot: BandProps['snapshot']; now: number }) {
  const progress = taskProgress(snapshot.workItems, session.id, row.node.id);
  const kin = session.subagents.filter((a) => a.endedAt === null && !isReader(a.agentType));
  const commands = orderCommands(session.commands.filter((c) => commandShown(c, now)));
  const line = commands.length ? commandLineParts(commands, now) : null;
  return (
    <>
      <SessionLine session={session} role={row.driver ? (row.driver.id === session.id ? 'drives' : 'helping') : undefined} />
      {(progress || line || kin.length > 0) && (
        <div className="ip-term" data-session={session.id}>
          {progress && <p className="ip-term-task">{`Task ${progress.place} of ${progress.total} · ${withoutOwnId(progress.item.subject, row.node.id)}`}</p>}
          {line && (
            <div className={`ip-cmd${line.serving ? ' serving' : ''}${line.ended ? ' ended' : ''}`} role="group" title={line.title} aria-label={line.title}>
              {`${line.mark} ${line.label}${line.when ? ` · ${line.when}` : ''}`}
            </div>
          )}
          {kin.length > 0 && (
            <div className="ip-kin-count" title={kin.map((a) => `${agentName(a, row.node.id)} · ${runTime(a.runStartedAt, now)}`).join('\n')}>
              {`${kin.length} subagent${kin.length > 1 ? 's' : ''}`}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** The chip a Now tile wears for its state. */
function StateChip({ state }: { state: TaskState }) {
  if (state === 'working') return <Chip tone="live">WORKING</Chip>;
  if (state === 'idle') return <Chip tone="quiet">IDLE</Chip>;
  if (state === 'unattended') return <Chip tone="quiet" dashed>UNATTENDED</Chip>;
  if (state === 'blocked') return <Chip tone="blocked">BLOCKED</Chip>;
  return null;
}

/** The keys of the Now tiles, in draw order: the grid's cursor and the rise follow them. */
export function nowKeys(boxes: BandProps['boxes']): string[] {
  return boxes.now.map((b) => String(b.row!.node.id));
}

/**
 * Now: one box per step in flight, with each session on it; a step nobody is on says so (spec 2.8). "Done…" on a box
 * opens a form inside it: an optional one-line outcome, then Mark done (Enter in the field does the same). A live driver
 * is named in the form; it keeps its focus.
 */
export function NowColumn({ snapshot, boxes, now, selectedNode, onStatus, onOpenNode, onOpenResource, cursor, rise }: BandProps & {
  /** The grid cursor's props for the tile at this row. */
  cursor: (row: number) => CursorItemProps;
  /** The stagger place a tile key (`now:<id>`) rises with. */
  rise: (key: string) => number | undefined;
}) {
  /** The box whose Done form is open: one at a time. */
  const [closing, setClosing] = useState<number | null>(null);
  /** Steps marked done and waiting for the answer, or for the snapshot that moves them out of Now. */
  const [pending, setPending] = useState<number[]>([]);
  /** The server's refusal, shown in the open form. */
  const [problem, setProblem] = useState<string | null>(null);
  /** The outcome typed in the open form. */
  const [text, setText] = useState('');
  /** Which form is open as of the last draw: an answer that comes back after another form opened must not touch it. */
  const openId = useRef<number | null>(null);
  openId.current = closing;
  const root = useRef<HTMLUListElement>(null);
  /** The band heading, for when the form's box leaves and takes focus with it. */
  const heading = useRef<HTMLElement | null>(null);
  const { id: projectId, slug } = snapshot.project;
  const ids = boxes.now.map((b) => b.row!.node.id).join(',');
  // The field takes focus when a form opens.
  useEffect(() => {
    if (closing === null) return;
    const home = root.current?.closest<HTMLElement>('.ip-band');
    heading.current = home?.querySelector<HTMLElement>('h2') ?? null;
    root.current?.querySelector<HTMLElement>('.ip-done-form input')?.focus();
  }, [closing]);
  // A box that left Now (done here or elsewhere) no longer waits or confirms; if it took focus with it, the heading has it.
  useEffect(() => {
    const here = new Set(ids ? ids.split(',').map(Number) : []);
    if (closing !== null && !here.has(closing)) {
      setClosing(null);
      setProblem(null);
      setText('');
      if (document.activeElement === document.body) heading.current?.focus();
    }
    setPending((p) => (p.some((id) => !here.has(id)) ? p.filter((id) => here.has(id)) : p));
  }, [ids, closing]);
  /** Puts focus back on that box's Done… button, once it is drawn again. */
  const refocus = (id: number) => window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-node="${id}"] [data-done]`)?.focus());
  const open = (id: number) => {
    setProblem(null);
    setText('');
    setClosing(id);
  };
  const cancel = (id: number) => {
    // Not while the request is out: the answer would land on a form that is gone.
    if (pending.includes(id)) return;
    setClosing(null);
    setProblem(null);
    setText('');
    refocus(id);
  };
  const finish = async (row: BoardRow, li: HTMLElement | null) => {
    const id = row.node.id;
    noteAction('now', 'done');
    const after = focusTargetAfter(li);
    setProblem(null);
    setPending((p) => [...p, id]);
    const result = await markDone(projectId, slug, id, text, row.driver?.id ?? null);
    const mine = openId.current === id;
    const here = !li || li.contains(document.activeElement) || document.activeElement === document.body;
    if (result === 'ok') {
      if (mine) {
        setClosing((c) => (c === id ? null : c));
        setText('');
      }
      // Only when focus is still in that box or fell to the body: the user may have moved on while it was out.
      if (here) after?.focus();
      return;
    }
    if (result === 'reload') return window.location.reload();
    // Drawn at once, so the field is there to focus. A refusal shows in its own form; with that form gone it is a status.
    flushSync(() => {
      setPending((p) => p.filter((x) => x !== id));
      if (mine) setProblem(result);
    });
    if (!mine) onStatus?.(result);
    else if (here) root.current?.querySelector<HTMLElement>(`[data-node="${id}"] .ip-done-form input`)?.focus();
  };
  if (boxes.now.length === 0) return <EmptyState>Nothing is in flight</EmptyState>;
  return (
    <ul className="ip-list" ref={root}>
      {boxes.now.map((box, at) => {
        const row = box.row!;
        const sessions = row.sessions;
        const asking = closing === row.node.id;
        const waiting = pending.includes(row.node.id);
        const key = `nd${row.node.id}`;
        return (
          <BoardTile
            key={row.node.id}
            box={box}
            now={now}
            area="now"
            band="now"
            docs={snapshot.resources.filter((r) => r.nodeId === row.node.id).length}
            system={endedLine(row, snapshot.pastSessions, now)}
            cursor={cursor(at)}
            rise={rise(`now:${row.node.id}`)}
            selected={selectedNode === row.node.id}
            chips={<StateChip state={box.state} />}
            age={box.state === 'working' ? 'NOW' : undefined}
            still={asking || waiting}
            pending={waiting}
            li={{
              'aria-busy': waiting || undefined,
              // A press on the tile outside the form's buttons and field puts focus in the form (or keeps it there), so
              // Escape still closes it.
              onMouseDown: asking ? (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('.ip-confirm button') || target.closest('.ip-confirm input')) return;
                e.preventDefault();
                const form = e.currentTarget.querySelector<HTMLElement>('.ip-confirm');
                if (form && !form.contains(document.activeElement)) form.focus();
              } : undefined,
              // Escape anywhere in the tile closes the form.
              onKeyDown: asking ? (e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();
                cancel(row.node.id);
              } : undefined,
            }}
            actions={asking ? undefined : (
              <Button variant="ghost" size="sm" className="ip-hover-act" data-act data-done aria-haspopup="dialog" onClick={() => open(row.node.id)}>
                Done…
              </Button>
            )}
            onOpenNode={onOpenNode}
            onOpenResource={onOpenResource}
          >
            <OpenScope area="now">
              {sessions.length > 0 ? (
                sessions.map((s) => <SessionPart key={s.id} session={s} row={row} snapshot={snapshot} now={now} />)
              ) : (
                <span className="ip-quiet">No session is on it</span>
              )}
            </OpenScope>
            {asking && (
              <div
                className="ip-confirm ip-done-form"
                role="dialog"
                aria-modal={false}
                aria-labelledby={`${key}q`}
                aria-describedby={row.driver ? `${key}d` : undefined}
                tabIndex={-1}
                data-act
              >
                <b id={`${key}q`}>Mark #{row.node.id} {row.node.title} done?</b>
                {row.driver && <p id={`${key}d`}>{`“${sessionDisplayTitle(row.driver)}” drives it. It stays on this step until it claims another, ends or goes stale.`}</p>}
                <Field
                  size="sm"
                  aria-label="Outcome (optional)"
                  placeholder="Outcome (optional), then Enter"
                  maxLength={2000}
                  value={text}
                  busy={waiting}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (!waiting) void finish(row, e.currentTarget.closest('li'));
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      cancel(row.node.id);
                    }
                  }}
                />
                <div className="ip-confirm-buttons">
                  <Button variant="primary" size="sm" aria-disabled={waiting || undefined} onClick={(e) => {
                    if (!waiting) void finish(row, e.currentTarget.closest('li'));
                  }}>
                    {waiting ? 'Marking done…' : 'Mark done'}
                  </Button>
                  <Button variant="ghost" size="sm" data-cancel aria-disabled={waiting || undefined} onClick={() => cancel(row.node.id)}>
                    Cancel
                  </Button>
                </div>
                {problem && <ErrorLine message={problem} role="alert" />}
              </div>
            )}
          </BoardTile>
        );
      })}
    </ul>
  );
}
