import { createContext, useContext, useRef, useState, type LiHTMLAttributes, type ReactNode } from 'react';
import { sessionDisplayTitle } from '../../../src/core/types';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { openDesktop } from '../api';
import { noteAction, type MeasureArea } from '../measure';
import { LabelChip, rowClick, StepMarks } from './Marks';
import { boxSince, hueStyle, PILLS } from './boxState';
import { ageShort } from './text';

/** What a session line needs: an id to resume and a title to show (a live or a past session both have them). */
export interface SessionRef {
  id: string;
  title: string | null;
}

/** The command that resumes a session in the desktop app, shown when the server could not run it; with why, when it is known. */
export function CopyCommand({ command, reason }: { command: string; reason?: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied('yes');
    } catch (err) {
      // Clipboard access can be refused (no permission, an insecure context): the command stays on screen to select by hand.
      console.error('[copy command]', err);
      setCopied('failed');
    }
  };
  // data-act: selecting the command by hand must not open Details.
  return (
    <>
      <div className="ip-sess-cmd" data-act>
        <code className="ip-code">{command}</code>
        <button type="button" className="ip-btn" data-act onClick={() => void copy()}>
          {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </div>
      {reason && <p className="ip-sys" data-act>{reason}</p>}
    </>
  );
}

/** One session's Open session: a click while a request is out is ignored, and only the latest call's answer is applied. */
function useOpenSession(sessionId: string, area: MeasureArea) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ command: string; reason?: string } | null>(null);
  const calls = useRef(0);
  const inFlight = useRef(false);
  const open = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    noteAction(area, 'open_session');
    const call = ++calls.current;
    const result = await openDesktop(sessionId);
    if (call !== calls.current) return;
    inFlight.current = false;
    setBusy(false);
    if (result === 'reload') return window.location.reload();
    setFailure(result.ok ? null : { command: result.command, reason: result.reason });
  };
  return { busy, failure, open };
}
type OpenState = ReturnType<typeof useOpenSession>;
const OpenContext = createContext<OpenState | null>(null);

/** One Open session state for everything in a box that opens this session (its line and a permission block share it). Key it by session id. */
export function OpenScope({ session, area, children }: { session: SessionRef; area: MeasureArea; children: ReactNode }) {
  return <OpenContext.Provider value={useOpenSession(session.id, area)}>{children}</OpenContext.Provider>;
}

/** A button that opens the session in its scope; it reads "Opening…" while the request is out. */
export function OpenButton({ className, children }: { className: string; children: string }) {
  const state = useContext(OpenContext);
  if (!state) throw new Error('OpenButton needs an OpenScope');
  return (
    <button type="button" className={className} data-act aria-busy={state.busy} onClick={() => void state.open()}>
      {state.busy ? 'Opening…' : children}
    </button>
  );
}

/** The command to run by hand, once the scope's open has failed. */
export function OpenFailure() {
  const state = useContext(OpenContext);
  return state?.failure ? <CopyCommand command={state.failure.command} reason={state.failure.reason} /> : null;
}

function LineBody({ session }: { session: SessionRef }) {
  return (
    <>
      <div className="ip-sess">
        <span className="ip-sess-name" title={sessionDisplayTitle(session)}>{sessionDisplayTitle(session)}</span>
        <OpenButton className="ip-link-btn">Open session ↗</OpenButton>
      </div>
      <OpenFailure />
    </>
  );
}

/** The session's display title and "Open session ↗"; when the server could not open it, the command to run by hand shows under the line. */
export function SessionLine({ session, area }: { session: SessionRef | null; area: MeasureArea }) {
  const shared = useContext(OpenContext);
  if (!session) {
    return (
      <div className="ip-sess">
        <span className="ip-quiet">No session: raised before sessions were tracked</span>
      </div>
    );
  }
  if (shared) return <LineBody session={session} />;
  return (
    <OpenScope key={session.id} session={session} area={area}>
      <LineBody session={session} />
    </OpenScope>
  );
}

type DragProps = Pick<LiHTMLAttributes<HTMLLIElement>, 'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop'>;

/**
 * The one box every Board cell shares (the round-3 mock's `box()`): the top (id, the cell's extra, the state pill and its
 * age), the title, the cell's body, an optional system line, and the foot (marks, documents, label). The task hue sits on
 * the left edge. A box with no step (a permission wait on no step) has no id and a plain title.
 */
export function TaskBox({ box, now, area, docs = 0, extra, system, children, className = '', drag, onOpenNode, onOpenResource }: {
  box: BoxData;
  now: number;
  area: MeasureArea;
  /** How many resources the step holds. */
  docs?: number;
  /** Shown before the pill: a cell's own action ("back to Backlog"). */
  extra?: ReactNode;
  system?: string | null;
  children?: ReactNode;
  className?: string;
  drag?: DragProps;
  onOpenNode: (id: number) => void;
  onOpenResource: (id: number) => void;
}) {
  const { row, session, state } = box;
  const pill = PILLS[state];
  const since = boxSince(box);
  const node = row?.node;
  return (
    <li
      className={`ip-card st-${pill.cls}${className ? ` ${className}` : ''}`}
      data-node={node?.id}
      data-state={state}
      style={hueStyle(box)}
      onClick={node ? rowClick(area, () => onOpenNode(node.id)) : undefined}
      {...drag}
    >
      <div className="ip-card-top">
        {node && <span className="ip-sid">#{node.id}</span>}
        <span className="ip-card-right">
          {extra}
          <span className={`ip-st ${pill.cls}`}>{pill.label}</span>
          {since && <span className="ip-time">{ageShort(since, now)}</span>}
        </span>
      </div>
      {node ? (
        <button type="button" className="ip-row-title ip-card-title">{node.title}</button>
      ) : (
        <span className="ip-card-title">{session ? sessionDisplayTitle(session) : ''}</span>
      )}
      {children}
      {system && <p className="ip-sys">{system}</p>}
      {row && (
        <div className="ip-foot">
          <StepMarks row={row} now={now} onOpenResource={onOpenResource} noAsk area={area} />
          {docs > 0 && <span className="ip-docs" title={`${docs} resource${docs > 1 ? 's' : ''}`}>{`▤ ${docs}`}</span>}
          <LabelChip label={node!.label} />
        </div>
      )}
    </li>
  );
}
