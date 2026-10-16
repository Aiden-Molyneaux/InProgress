import { Fragment, type ReactNode } from 'react';
import type { AskKind, Ask, Session } from '../../../src/core/types';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { commandLabel } from '../live';
import { AskActions } from './AskActions';
import type { BandProps } from './bandProps';
import { OpenButton, OpenScope, SessionLine, TaskBox, type SessionRef } from './TaskBox';

export const KIND_MARK: Record<AskKind, string> = { question: '?', permission: '⚿', review: '◎' };

/** The newest running command of a session, as "npm run build" (a monitor reads "Monitor ..."): what a permission wait is probably about. */
function newestRunning(s: Session): string | null {
  const c = s.commands.filter((x) => x.endedAt === null).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return c ? `${c.kind === 'monitor' ? 'Monitor ' : ''}${commandLabel(c)}` : null;
}

/** A permission wait: what it is probably about, and the way to answer it (in the session, not here). Inside the session's OpenScope. */
function PermissionBlock({ session }: { session: Session }) {
  const command = newestRunning(session);
  // data-act: selecting the command by hand must not open Details.
  return (
    <div className="ip-block" data-act>
      <p className="ip-card-main">{command ? 'Allow a shell command' : 'Waiting for permission'}</p>
      {command && <code className="ip-code">{command}</code>}
      <div className="ip-ask-actions">
        <OpenButton sessionId={session.id} className="ip-btn">Open session to allow</OpenButton>
      </div>
    </div>
  );
}

/** Needs me: one box per task that waits on Aiden, oldest need first (spec 2.2). */
export function NeedsMe({ snapshot, boxes, now, onOpenNode, onOpenResource }: BandProps) {
  if (boxes.needs.length === 0) return <p className="ip-quiet ip-empty-line">Nothing needs you</p>;
  /** The session an ask was raised from, live or past; one that is gone still names its id. */
  const raiser = (ask: Ask): SessionRef | null => {
    if (ask.sessionId === null) return null;
    return snapshot.sessions.find((s) => s.id === ask.sessionId) ?? snapshot.pastSessions.find((s) => s.id === ask.sessionId) ?? { id: ask.sessionId, title: null };
  };
  const body = (box: BoxData) => {
    // Every session of the step that waits on permission has its own block (a focusless box holds just its session).
    const waiting = box.row ? box.row.sessions.filter((x) => x.state === 'permission') : box.session ? [box.session] : [];
    const asks = box.row?.asks ?? [];
    // One session line per run of asks from the same session; a permission wait leads with its own session's line.
    const parts = [] as { key: string; node: ReactNode }[];
    // A focusless box is titled with its session's name, so its line does not repeat it.
    const nameless = !box.row;
    for (const w of waiting) {
      parts.push({ key: `wait${w.id}`, node: (
        <>
          <SessionLine session={w} area="needs_me" nameless={nameless} />
          <PermissionBlock session={w} />
        </>
      ) });
    }
    let last: string | null | undefined = waiting.length ? waiting[waiting.length - 1].id : undefined;
    for (const ask of asks) {
      const from = raiser(ask);
      const showLine = (from?.id ?? null) !== last;
      last = from?.id ?? null;
      parts.push({ key: `ask${ask.id}`, node: (
        <>
          {showLine && <SessionLine session={from} area="needs_me" />}
          <div className="ip-block" data-ask={ask.id}>
            <p className="ip-card-main ip-clamp-2">{ask.text}</p>
            <AskActions ask={ask} area="needs_me" />
          </div>
        </>
      ) });
    }
    // One OpenScope for the box, holding one Open session state per session id.
    return <OpenScope area="needs_me">{parts.map((p) => <Fragment key={p.key}>{p.node}</Fragment>)}</OpenScope>;
  };
  return (
    <ul className="ip-list">
      {boxes.needs.map((box) => (
        <TaskBox
          key={box.row ? box.row.node.id : `s${box.session!.id}`}
          box={box}
          now={now}
          area="needs_me"
          docs={snapshot.resources.filter((r) => r.nodeId === box.row?.node.id).length}
          onOpenNode={onOpenNode}
          onOpenResource={onOpenResource}
        >
          {body(box)}
        </TaskBox>
      ))}
    </ul>
  );
}
