import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AskKind, Ask, Session } from '../../../src/core/types';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { sessionActivity } from '../../../src/core/activity';
import { commandLabel, WORDS } from '../live';
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import { EmptyState } from '../parts/EmptyState';
import { Eyebrow } from '../parts/Eyebrow';
import type { CursorItemProps } from '../parts/ListCursor';
import { AskActions } from './AskActions';
import type { BandProps } from './bandProps';
import { BoardTile } from './BoardTile';
import { SessionLine } from './SessionLine';
import { OpenButton, OpenScope, type SessionRef } from './TaskBox';
import { ageShort } from './text';

export const KIND_MARK: Record<AskKind, string> = { question: '?', permission: '⚿', review: '◎' };
/** The kind a needs Chip and an ask panel's Eyebrow name. */
const KIND_WORD: Record<AskKind, string> = { question: 'QUESTION', permission: 'PERMISSION', review: 'REVIEW' };

/** The key of a Needs me tile: its step, or its session when the wait is on no step. The grid's cursor and the rise follow it. */
const keyOf = (box: BoxData): string => (box.row ? `n${box.row.node.id}` : `s${box.session!.id}`);

/** The keys of the Needs me tiles, in draw order. */
export function needsKeys(boxes: BandProps['boxes']): string[] {
  return boxes.needs.map(keyOf);
}

/** The newest running command of a session, as "npm run build" (a monitor reads "Monitor ..."): what a permission wait is probably about. */
function newestRunning(s: Session): string | null {
  const c = s.commands.filter((x) => x.endedAt === null).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return c ? `${c.kind === 'monitor' ? 'Monitor ' : ''}${commandLabel(c)}` : null;
}

/** A permission wait: what it is probably about, and the way to answer it (in the session, not here). Inside the session's OpenScope. */
function PermissionPanel({ session }: { session: Session }) {
  const command = newestRunning(session);
  return (
    <div className="ip-ask-panel ip-perm-panel">
      <p className="ip-ask-text">{command ? 'Allow a shell command' : 'Waiting for permission'}</p>
      {/* data-act: selecting the command by hand must not open Details. */}
      {command && <code className="ip-term" data-act>{command}</code>}
      <div className="ip-ask-actions">
        <OpenButton sessionId={session.id} className="ip-perm-open" variant="primary" glyph="↗">Open session to allow</OpenButton>
      </div>
    </div>
  );
}

/** An ask's text at four lines, with Show all / Show less only when it overflows. */
function AskText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const el = useRef<HTMLParagraphElement>(null);
  // Measured after every render while folded (a resize changes the lines); once open the button stays, so it can fold again.
  useLayoutEffect(() => {
    if (open || !el.current) return;
    const overflows = el.current.scrollHeight > el.current.clientHeight;
    if (overflows !== over) setOver(overflows);
  });
  return (
    <>
      <p ref={el} className="ip-ask-text ip-ask-clamp" data-open={open || undefined}>{text}</p>
      {over && (
        <Button variant="ghost" size="sm" className="ip-ask-more" data-act aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </Button>
      )}
    </>
  );
}

/** Needs me: one tile per task that waits on Aiden, oldest need first (spec 2.2); each ask in its own panel. */
export function NeedsMe({ snapshot, boxes, now, selectedNode, onOpenNode, onOpenResource, cursor, rise }: BandProps & {
  /** The grid cursor's props for the tile at this row. */
  cursor: (row: number) => CursorItemProps;
  /** The stagger place a tile key (`needs:<key>`) rises with. */
  rise: (key: string) => number | undefined;
}) {
  if (boxes.needs.length === 0) return <EmptyState>Nothing needs you</EmptyState>;
  /** The session an ask was raised from, live or past; one that is gone still names its id. */
  const raiser = (ask: Ask): SessionRef | null => {
    if (ask.sessionId === null) return null;
    return snapshot.sessions.find((s) => s.id === ask.sessionId) ?? snapshot.pastSessions.find((s) => s.id === ask.sessionId) ?? { id: ask.sessionId, title: null };
  };
  /** A session's state word, when it is one of the live ones. */
  const wordOf = (ref: SessionRef | null): string | undefined => {
    const live = ref ? snapshot.sessions.find((s) => s.id === ref.id) : undefined;
    return live ? WORDS[sessionActivity(live, now)] : undefined;
  };
  const body = (box: BoxData) => {
    // Every session of the step that waits on permission has its own panel (a focusless box holds just its session).
    const waiting = box.row ? box.row.sessions.filter((x) => x.state === 'permission') : box.session ? [box.session] : [];
    const asks = box.row?.waiting ?? [];
    // One session line per run of asks from the same session; a permission wait leads with its own session's line.
    const parts = [] as { key: string; node: ReactNode }[];
    // A focusless box is titled with its session's name, so its line does not repeat it.
    const nameless = !box.row;
    for (const w of waiting) {
      parts.push({ key: `wait${w.id}`, node: (
        <>
          <SessionLine session={w} word={wordOf(w)} nameless={nameless} />
          <PermissionPanel session={w} />
        </>
      ) });
    }
    let last: string | null | undefined = waiting.length ? waiting[waiting.length - 1].id : undefined;
    asks.forEach((ask, place) => {
      const from = raiser(ask);
      const showLine = (from?.id ?? null) !== last;
      last = from?.id ?? null;
      parts.push({ key: `ask${ask.id}`, node: (
        <>
          {showLine && <SessionLine session={from} word={wordOf(from)} />}
          <div className="ip-ask-panel" data-ask={ask.id}>
            <div className="ip-ask-head">
              <Eyebrow>{`${String(place + 1).padStart(2, '0')} ${KIND_WORD[ask.kind]}`}</Eyebrow>
              <span className="ip-tile-age">{ageShort(ask.raisedAt, now)}</span>
            </div>
            <AskText text={ask.text} />
            <AskActions ask={ask} area="needs_me" />
          </div>
        </>
      ) });
    });
    // One OpenScope for the tile, holding one Open session state per session id.
    return <OpenScope area="needs_me">{parts.map((p) => <Fragment key={p.key}>{p.node}</Fragment>)}</OpenScope>;
  };
  return (
    <ul className="ip-list">
      {boxes.needs.map((box, i) => {
        const key = keyOf(box);
        const kind = box.state === 'question' || box.state === 'permission' || box.state === 'review' ? KIND_WORD[box.state] : box.state.toUpperCase();
        return (
          <BoardTile
            key={key}
            box={box}
            now={now}
            area="needs_me"
            band="needs"
            docs={snapshot.resources.filter((r) => r.nodeId === box.row?.node.id).length}
            cursor={cursor(i)}
            rise={rise(`needs:${key}`)}
            selected={box.row ? selectedNode === box.row.node.id : false}
            chips={<Chip tone="needs">{kind}</Chip>}
            onOpenNode={onOpenNode}
            onOpenResource={onOpenResource}
          >
            {body(box)}
          </BoardTile>
        );
      })}
    </ul>
  );
}
