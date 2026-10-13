import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isLive } from '../../../src/core/board';
import { sessionTag, type Ask, type AskKind, type Session } from '../../../src/core/types';
import { clearAsk } from '../api';
import { Character } from '../Character';
import { characterState } from '../characterState';
import { commandLabel, runTime } from '../live';
import { rowClick } from './Marks';
import type { BandProps } from './bandProps';
import { ageShort } from './text';

const KIND_MARK: Record<AskKind, string> = { question: '?', permission: '⚿', review: '◎' };

/** The newest running command of a session, as "Shell npm run build": what a permission wait is probably about. */
function newestRunning(s: Session): string | null {
  const c = s.commands.filter((x) => x.endedAt === null).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return c ? `${c.kind === 'monitor' ? 'Monitor' : 'Shell'} ${commandLabel(c)}` : null;
}

/** Needs me: live permission waits, then open asks oldest first (spec 2.2). */
export function NeedsMe({ snapshot, board, now, onOpenNode }: BandProps) {
  const waits = snapshot.sessions.filter((s) => s.state === 'permission' && isLive(s, now)).sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  const asks = snapshot.asks.filter((a) => a.clearedAt === null);
  if (waits.length === 0 && asks.length === 0) return <p className="ip-quiet ip-empty-line">Nothing needs you</p>;
  const stepOf = (id: number | null) => (id === null ? undefined : (board.byId.get(id)?.node ?? snapshot.nodes.find((n) => n.id === id)));
  return (
    <ul className="ip-inbox">
      {waits.map((s) => {
        const step = stepOf(s.focusNodeId);
        const command = newestRunning(s);
        return (
          <li key={s.id} className="ip-msg ip-wait" onClick={step ? rowClick('needs_me', () => onOpenNode(step.id)) : undefined}>
            <Character size={24} state="wait" slot={s.slot} seed={s.id} />
            <div className="ip-msg-body">
              <div className="ip-msg-head">
                <b>{sessionTag(s.slot) || '?'}</b> is waiting · ⚿ permission · <span className="ip-time">{runTime(s.lastSeenAt, now)}</span> · <span className="ip-live">LIVE</span>
              </div>
              {command && <code className="ip-code">{command}</code>}
              {step && (
                <button type="button" className="ip-row-title ip-on-btn">
                  {`on #${step.id} ${step.title}`}
                </button>
              )}
            </div>
          </li>
        );
      })}
      {asks.map((a) => (
        <AskRow key={a.id} ask={a} snapshot={snapshot} now={now} step={stepOf(a.nodeId)} onOpenNode={onOpenNode} />
      ))}
    </ul>
  );
}

function AskRow({ ask, snapshot, now, step, onOpenNode }: { ask: Ask; snapshot: BandProps['snapshot']; now: number; step: { id: number; title: string } | undefined; onOpenNode: (id: number) => void }) {
  const raiser = ask.sessionId === null ? undefined : snapshot.sessions.find((s) => s.id === ask.sessionId);
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  /** Set by Escape: once the field has gone, focus returns to the button that opened it. */
  const restore = useRef(false);
  useEffect(() => {
    if (answering) field.current?.focus();
    else if (restore.current) {
      restore.current = false;
      opener.current?.focus();
    }
  }, [answering]);
  const send = async (answer?: string) => {
    setBusy(true);
    const result = await clearAsk(ask.id, answer);
    setBusy(false);
    if (result === 'reload') window.location.reload();
    else if (result !== 'ok') setProblem(result);
    // On 'ok' the stream brings a snapshot without this ask, and the row goes.
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void send(text.trim() || undefined);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      restore.current = true;
      setAnswering(false);
      setText('');
    }
  };
  const who = raiser ? sessionTag(raiser.slot) || '?' : null;
  return (
    <li className="ip-msg ip-ask" data-ask={ask.id} onClick={step ? rowClick('needs_me', () => onOpenNode(step.id)) : undefined}>
      {raiser ? (
        <Character size={24} state={characterState(raiser, now)} slot={raiser.slot} seed={raiser.id} />
      ) : (
        <span className="ip-avatar-dashed" aria-hidden="true" />
      )}
      <div className="ip-msg-body">
        <div className="ip-msg-head">
          {who ? <b>{who}</b> : <b>migrated</b>}
          {who ? ' asks' : ''} · {KIND_MARK[ask.kind]} {ask.kind} · <span className="ip-time">{ageShort(ask.raisedAt, now)}</span>
        </div>
        <p className="ip-clamp-2">{ask.text}</p>
        {step && (
          <button type="button" className="ip-row-title ip-on-btn">
            {`on #${step.id} ${step.title}`}
          </button>
        )}
        {answering ? (
          <input
            ref={field}
            data-act
            className="ip-answer"
            aria-label={`Answer to ${ask.text}`}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder="Your answer, then Enter"
          />
        ) : (
          <div className="ip-ask-actions">
            <button type="button" ref={opener} data-act className="ip-btn" onClick={() => setAnswering(true)}>
              Answer…
            </button>
            <button type="button" data-act className="ip-btn" disabled={busy} onClick={() => void send()}>
              Clear
            </button>
          </div>
        )}
        {problem && <div className="ip-problem" role="alert">{problem}</div>}
      </div>
    </li>
  );
}
