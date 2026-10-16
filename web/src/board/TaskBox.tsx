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

interface OpenState {
  busy: boolean;
  failure: { command: string; reason?: string } | null;
}
const IDLE: OpenState = { busy: false, failure: null };
interface OpenScopeValue {
  stateOf: (sessionId: string) => OpenState;
  open: (sessionId: string) => Promise<void>;
}
const OpenContext = createContext<OpenScopeValue | null>(null);

/**
 * The Open session of every session a box shows: one state per session id however many places show it (its line, a
 * permission block), so one session cannot launch twice from two buttons. A click while that session's request is out is
 * ignored.
 */
export function OpenScope({ area, children }: { area: MeasureArea; children: ReactNode }) {
  const [states, setStates] = useState<Readonly<Record<string, OpenState>>>({});
  const inFlight = useRef(new Set<string>());
  const patch = (id: string, state: OpenState) => setStates((prev) => ({ ...prev, [id]: state }));
  const open = async (id: string) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    patch(id, { busy: true, failure: null });
    noteAction(area, 'open_session');
    let next: OpenState = IDLE;
    try {
      const result = await openDesktop(id);
      if (result === 'reload') return window.location.reload();
      if (!result.ok) next = { busy: false, failure: { command: result.command, reason: result.reason } };
    } catch (err) {
      // openDesktop never rejects by contract; if it does, say so rather than leave the button stuck.
      console.error('[open session]', err);
      next = { busy: false, failure: { command: `claude --desktop --resume ${id}`, reason: "Could not reach the server. Run it in the session's folder." } };
    } finally {
      inFlight.current.delete(id);
    }
    patch(id, next);
  };
  return <OpenContext.Provider value={{ stateOf: (id) => states[id] ?? IDLE, open }}>{children}</OpenContext.Provider>;
}

/** A button that opens the session in its scope; it reads "Opening…" while the request is out. */
export function OpenButton({ sessionId, className, children }: { sessionId: string; className: string; children: string }) {
  const scope = useContext(OpenContext);
  if (!scope) throw new Error('OpenButton needs an OpenScope');
  const { busy } = scope.stateOf(sessionId);
  return (
    <button type="button" className={className} data-act aria-busy={busy} onClick={() => void scope.open(sessionId)}>
      {busy ? 'Opening…' : children}
    </button>
  );
}

/** The command to run by hand, once the scope's open has failed. */
export function OpenFailure({ sessionId }: { sessionId: string }) {
  const failure = useContext(OpenContext)?.stateOf(sessionId).failure;
  return failure ? <CopyCommand command={failure.command} reason={failure.reason} /> : null;
}

/** A session's role on a step with a driver (spec 1.4): the driver drives, every other session on it is helping. */
export type SessionRole = 'drives' | 'helping';

function LineBody({ session, nameless, role }: { session: SessionRef; nameless?: boolean; role?: SessionRole }) {
  return (
    <>
      <div className="ip-sess">
        {!nameless && <span className="ip-sess-name" title={sessionDisplayTitle(session)}>{sessionDisplayTitle(session)}</span>}
        {role && <span className="ip-role">· {role}</span>}
        <OpenButton sessionId={session.id} className="ip-link-btn">Open session ↗</OpenButton>
      </div>
      <OpenFailure sessionId={session.id} />
    </>
  );
}

/** The session's display title (unless `nameless`: the box's title already is it), its `role` on the step when given, and "Open session ↗"; when the server could not open it, the command to run by hand shows under the line. */
export function SessionLine({ session, area, nameless, role }: { session: SessionRef | null; area: MeasureArea; nameless?: boolean; role?: SessionRole }) {
  const shared = useContext(OpenContext);
  if (!session) {
    return (
      <div className="ip-sess">
        <span className="ip-quiet">No session: raised before sessions were tracked</span>
      </div>
    );
  }
  if (shared) return <LineBody session={session} nameless={nameless} role={role} />;
  return (
    <OpenScope key={session.id} area={area}>
      <LineBody session={session} nameless={nameless} role={role} />
    </OpenScope>
  );
}

/** What a cell sets on the box's `li` itself: drag and drop, and the Backlog confirm's press, Escape and busy state. */
type LiProps = Pick<LiHTMLAttributes<HTMLLIElement>, 'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop' | 'onMouseDown' | 'onKeyDown' | 'aria-busy'>;

/**
 * The one box every Board cell shares (the round-3 mock's `box()`): the top (id, the cell's extra, the state pill and its
 * age), the title, the cell's body, an optional system line, and the foot (marks, documents, label). The task hue sits on
 * the left edge, unless `noHue` (the Backlog fold wears none). A box with no step (a permission wait on no step) has no
 * id and a plain title.
 */
export function TaskBox({ box, now, area, docs = 0, extra, system, children, className = '', li, noHue = false, still = false, onOpenNode, onOpenResource }: {
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
  li?: LiProps;
  /** No hue on the left edge, whatever the state. */
  noHue?: boolean;
  /** A click does not open Details and Tab passes the title by: a confirm is open in the box, or it waits on a delete. */
  still?: boolean;
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
      style={noHue ? undefined : hueStyle(box)}
      onClick={node && !still ? rowClick(area, () => onOpenNode(node.id)) : undefined}
      {...li}
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
        <button type="button" className="ip-row-title ip-card-title" tabIndex={still ? -1 : undefined}>{node.title}</button>
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
