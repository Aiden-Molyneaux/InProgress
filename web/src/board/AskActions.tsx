import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Ask } from '../../../src/core/types';
import { clearAsk } from '../api';

/**
 * Answer… and Clear for one open ask, as the Board's Needs me and Details both show them. Answer… opens a field that takes
 * focus; Enter clears the ask with the answer, Escape closes the field and returns focus to Answer…. A refusal shows
 * under the buttons. On success the stream brings a snapshot without the ask and the owner's row goes.
 */
export function AskActions({ ask }: { ask: Pick<Ask, 'id' | 'text'> }) {
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
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void send(text.trim() || undefined);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Escape here closes the field only; it must not reach a panel that closes on Escape.
      e.stopPropagation();
      restore.current = true;
      setAnswering(false);
      setText('');
    }
  };
  return (
    <>
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
    </>
  );
}
