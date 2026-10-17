import { commandShown, orderCommands } from '../../../src/core/activity';
import type { BoardRow } from '../../../src/core/board';
import { isReader, sessionDisplayTitle, type Session } from '../../../src/core/types';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { markDone } from '../api';
import { agentName, commandLineParts, runTime, withoutOwnId } from '../live';
import { noteAction } from '../measure';
import { focusTargetAfter } from './focus';
import { endedLine } from './Marks';
import type { BandProps } from './bandProps';
import { SessionLine, TaskBox } from './TaskBox';

/** One session on a step: its line, then a block with its in-progress task, its commands line and its running subagents. */
function SessionPart({ session, row, snapshot, now }: { session: Session; row: BoardRow; snapshot: BandProps['snapshot']; now: number }) {
  const task = snapshot.workItems
    .filter((w) => w.sessionId === session.id && w.agentId === '' && w.status === 'in_progress')
    .sort((a, b) => (a.nodeId === row.node.id ? 0 : 1) - (b.nodeId === row.node.id ? 0 : 1) || a.position - b.position)[0];
  const kin = session.subagents.filter((a) => a.endedAt === null && !isReader(a.agentType));
  const commands = orderCommands(session.commands.filter((c) => commandShown(c, now)));
  const line = commands.length ? commandLineParts(commands, now) : null;
  return (
    <>
      <SessionLine session={session} area="now" role={row.driver ? (row.driver.id === session.id ? 'drives' : 'helping') : undefined} />
      {(task || line || kin.length > 0) && (
        <div className="ip-block" data-session={session.id}>
          {task && <p className="ip-card-main">{withoutOwnId(task.subject, row.node.id)}</p>}
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

/**
 * Now: one box per step in flight, with each session on it; a step nobody is on says so (spec 2.8). "Done…" on a box
 * opens a form inside it: an optional one-line outcome, then Mark done (Enter in the field does the same). A live driver
 * is named in the form; it keeps its focus.
 */
export function NowColumn({ snapshot, boxes, now, onStatus, onOpenNode, onOpenResource }: BandProps) {
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
    heading.current = home?.querySelector<HTMLElement>('h3, header b') ?? null;
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
  const refocus = (id: number) => window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`li[data-node="${id}"] [data-done]`)?.focus());
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
    else if (here) root.current?.querySelector<HTMLElement>(`li[data-node="${id}"] .ip-done-form input`)?.focus();
  };
  if (boxes.now.length === 0) return <p className="ip-quiet ip-empty-line">Nothing is in flight</p>;
  return (
    <ul className="ip-list" ref={root}>
      {boxes.now.map((box) => {
        const row = box.row!;
        const sessions = row.sessions;
        const asking = closing === row.node.id;
        const waiting = pending.includes(row.node.id);
        const key = `nd${row.node.id}`;
        return (
          <TaskBox
            key={row.node.id}
            box={box}
            now={now}
            area="now"
            docs={snapshot.resources.filter((r) => r.nodeId === row.node.id).length}
            system={endedLine(row, snapshot.pastSessions, now)}
            className={`ip-now-row${waiting ? ' pending' : ''}${asking ? ' confirming' : ''}`}
            still={asking || waiting}
            li={{
              'aria-busy': waiting || undefined,
              // A press on the box outside the form's buttons and field puts focus in the form (or keeps it there), so
              // Escape still closes it.
              onMouseDown: asking ? (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('.ip-confirm button') || target.closest('.ip-confirm input')) return;
                e.preventDefault();
                const form = e.currentTarget.querySelector<HTMLElement>('.ip-confirm');
                if (form && !form.contains(document.activeElement)) form.focus();
              } : undefined,
              // Escape anywhere in the box closes the form.
              onKeyDown: asking ? (e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();
                cancel(row.node.id);
              } : undefined,
            }}
            extra={asking ? undefined : (
              <button type="button" className="ip-hover-act" data-act data-done aria-haspopup="dialog" onClick={() => open(row.node.id)}>Done…</button>
            )}
            onOpenNode={onOpenNode}
            onOpenResource={onOpenResource}
          >
            {sessions.length > 0 ? (
              sessions.map((s) => <SessionPart key={s.id} session={s} row={row} snapshot={snapshot} now={now} />)
            ) : (
              <div className="ip-sess">
                <span className="ip-quiet">No session is on it</span>
              </div>
            )}
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
                <input
                  className="ip-answer"
                  type="text"
                  aria-label="Outcome (optional)"
                  placeholder="Outcome (optional), then Enter"
                  maxLength={2000}
                  value={text}
                  readOnly={waiting}
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
                <div>
                  <button type="button" className="ip-btn go" aria-disabled={waiting || undefined} onClick={(e) => {
                    if (!waiting) void finish(row, e.currentTarget.closest('li'));
                  }}>
                    {waiting ? 'Marking done…' : 'Mark done'}
                  </button>
                  <button type="button" className="ip-btn" data-cancel aria-disabled={waiting || undefined} onClick={() => cancel(row.node.id)}>
                    Cancel
                  </button>
                </div>
                {problem && <div className="ip-problem" role="alert">{problem}</div>}
              </div>
            )}
          </TaskBox>
        );
      })}
    </ul>
  );
}
