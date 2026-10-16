import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Ask } from '../../../src/core/types';
import { clearAsk } from '../api';
import { noteAction, type MeasureArea } from '../measure';
import { focusTargetAfter } from './focus';

/**
 * Answer… and Clear for one open ask, as the Board's Needs me and Details both show them. Answer… opens a field that takes
 * focus; Enter clears the ask with the answer (an empty field does nothing), Escape closes the field and returns focus to
 * Answer…. A refusal shows under the buttons and focus returns to where it was. On success the stream brings a snapshot
 * without the ask and the owner's row goes; focus has moved to a neighbouring row by then.
 */
export function AskActions({ ask, area }: { ask: Pick<Ask, 'id' | 'text'>; area: MeasureArea }) {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
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
    if (busy) return;
    const row = (field.current ?? opener.current)?.closest('li') ?? null;
    // A box holding another open ask hands focus to that ask's controls; otherwise the walk to the next row.
    const own = (field.current ?? opener.current)?.closest('[data-ask]') ?? null;
    // Details' row is itself the ask (li.ip-dask): its siblings are under its parent.
    const scope = row && row === own ? row.parentElement : row;
    const sibling = scope ? [...scope.querySelectorAll<HTMLElement>('[data-ask]')].find((b) => b !== own && !b.classList.contains('cleared')) : undefined;
    const target = sibling?.querySelector<HTMLElement>('input, button') ?? focusTargetAfter(row);
    setBusy(true);
    const result = await clearAsk(ask.id, answer);
    setBusy(false);
    if (result === 'reload') return window.location.reload();
    // Aiden may have moved on while the request ran: focus moves only if it is still on this ask's row, or fell to the page.
    const active = document.activeElement;
    if (active && active !== document.body && !row?.contains(active)) {
      if (result !== 'ok') setProblem(result);
      return;
    }
    if (result !== 'ok') {
      setProblem(result);
      (field.current ?? clearButton.current)?.focus();
    } else if (target?.isConnected) target.focus();
    // On 'ok' the stream brings a snapshot without this ask, and the row goes.
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      const answer = text.trim();
      if (!answer) return;
      noteAction(area, 'answer');
      void send(answer);
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
          // readOnly, not disabled: a disabled field would drop focus while the answer is on its way.
          readOnly={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Your answer, then Enter"
        />
      ) : (
        <div className="ip-ask-actions">
          <button
            type="button"
            ref={opener}
            data-act
            className="ip-btn"
            onClick={() => {
              noteAction(area, 'answer_open');
              setAnswering(true);
            }}
          >
            Answer…
          </button>
          <button
            type="button"
            ref={clearButton}
            data-act
            className="ip-btn"
            aria-disabled={busy}
            onClick={() => {
              noteAction(area, 'clear');
              void send();
            }}
          >
            Clear
          </button>
        </div>
      )}
      {problem && <div className="ip-problem" role="alert">{problem}</div>}
    </>
  );
}
