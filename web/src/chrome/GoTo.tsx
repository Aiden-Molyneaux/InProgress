import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { parseGoTo, type StepHit } from '../../../src/core/goto';
import { api } from '../api';
import { goToMessage, hitLabel, isGoToChord, pickHit } from './goToText';
import { menuStep } from './menu';

/** How long typing rests before the field asks the server. */
const DEBOUNCE_MS = 150;

export interface GoToHandle {
  /** Opens the field (or, when it is open, puts focus back in it). `/` and Ctrl+K call it. */
  open: () => void;
}

interface GoToProps {
  /**
   * The step picked: the window opens its project, unfolds it, centres on it, opens its Details and gives its card focus.
   * Until then focus waits on the search button, which keeps it if the jump is dropped.
   */
  onGo: (hit: StepHit) => void;
  /** The open project's slug: its steps list first within each tier. */
  current: string | null;
}

/** What the server answered for a query, as typed. */
interface Answer {
  text: string;
  hits: StepHit[];
  error?: string;
}

/** A magnifier, drawn in the button's ink. */
const Glass = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M9.2 9.2 12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/**
 * The search button at the right end of the top bar, and the Go to field it opens: a combobox floating under the bar on
 * the menus' surface. An id (`#77`, `77`) and Enter jumps to that step in whatever project holds it; words list the
 * steps whose titles hold them, across projects, as they are typed. Up and Down move through the list, Enter picks,
 * Escape closes back to whatever had focus before, and Tab closes. Typing clears the highlight, so Enter never picks a
 * row of the old list. Every key stays in here: the app's own keys would
 * otherwise act under it.
 */
export const GoTo = forwardRef<GoToHandle, GoToProps>(function GoTo({ onGo, current }, ref) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  /** Whatever had focus when the field opened: it gets focus back when the field closes. */
  const opener = useRef<HTMLElement | null>(null);
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  /** The option Up and Down have reached, or -1 for none. */
  const [active, setActive] = useState(-1);
  /** The id Enter looked for and found nothing at, while the text still names it. */
  const [missing, setMissing] = useState<number | null>(null);
  /** Numbers the requests, so a slow answer to older text never replaces a newer one. */
  const seq = useRef(0);
  const timer = useRef(0);

  const query = parseGoTo(text);
  const trimmed = text.trim();
  /** The answer for the text as it is now; an answer to older text stays on screen until a newer one lands. */
  const settled = answer?.text === trimmed ? answer : null;
  const hits = answer?.hits ?? [];

  const show = () => {
    if (open) {
      field.current?.focus();
      return;
    }
    const at = document.activeElement;
    opener.current = at instanceof HTMLElement && at !== document.body ? at : null;
    setText('');
    setAnswer(null);
    setActive(-1);
    setMissing(null);
    setOpen(true);
  };
  useImperativeHandle(ref, () => ({ open: show }));

  /** Closes the field. With `refocus`, focus goes back to the opener; otherwise it stays where it went (Tab, a click). */
  const close = (refocus: boolean) => {
    window.clearTimeout(timer.current);
    seq.current++;
    setOpen(false);
    if (!refocus) return;
    const back = opener.current;
    if (back?.isConnected) back.focus();
    else field.current?.blur();
  };

  useLayoutEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && close(false);
    window.addEventListener('mousedown', outside);
    return () => window.removeEventListener('mousedown', outside);
  }, [open]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /** Asks the server about `q` (the trimmed text) and keeps the answer if it is still the newest request. */
  const ask = async (q: string): Promise<Answer | null> => {
    const mine = ++seq.current;
    let next: Answer;
    try {
      next = { text: q, hits: await api.find(q, current) };
    } catch (e) {
      next = { text: q, hits: [], error: e instanceof Error ? e.message : String(e) };
    }
    if (mine !== seq.current) return null;
    setAnswer(next);
    setActive(next.hits.length ? 0 : -1);
    return next;
  };

  // Typing asks once it rests. Nothing typed clears the list.
  useEffect(() => {
    if (!open) return;
    window.clearTimeout(timer.current);
    if (query.kind === 'empty') {
      seq.current++;
      setAnswer(null);
      setActive(-1);
      return;
    }
    timer.current = window.setTimeout(() => void ask(trimmed), DEBOUNCE_MS);
  }, [open, trimmed]);

  /** Focus waits on the search button (the opener may be a card the switch takes away); the card takes it on landing. */
  const pick = (hit: StepHit) => {
    button.current?.focus();
    close(false);
    onGo(hit);
  };

  /** Enter: the option reached, else the first, asking at once when the answer is not in yet. An id found nowhere says so. */
  const enter = async () => {
    if (query.kind === 'empty') return;
    // By id: the list on screen may be an older one than the answer Enter waits for.
    const highlighted = active >= 0 ? hits[active]?.id : undefined;
    let now = settled;
    if (!now) {
      window.clearTimeout(timer.current);
      now = await ask(trimmed);
      // The text changed while the server answered: the newer text has its own Enter.
      if (!now) return;
    }
    const hit = pickHit(now.hits, highlighted);
    if (hit) pick(hit);
    else if (query.kind === 'id') setMissing(query.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close(true);
        return;
      case 'Enter':
        // Enter that ends an IME composition picks the characters, not a step.
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        void enter();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const next = menuStep(e.key, active, hits.length);
        if (next !== null) setActive(next);
        return;
      }
      default:
        // Ctrl+K again keeps focus here, rather than the browser's address bar taking it.
        if (isGoToChord(e.nativeEvent)) e.preventDefault();
    }
  };

  // Tab and Shift+Tab leave the field, and it closes behind them. A press elsewhere is the outside mousedown's.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to)) close(false);
  };

  // The active option stays in view as Up and Down move.
  useEffect(() => {
    if (active >= 0) document.getElementById(`${ids}o${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, ids]);

  const note = goToMessage(query, settled, missing);
  const listed = hits.length > 0;
  return (
    <div className="ip-goto" ref={wrap}>
      <button
        ref={button}
        className="ip-goto-btn"
        aria-label="Go to a step"
        title="Go to a step (/ or Ctrl+K)"
        aria-keyshortcuts="/ Control+K"
        aria-expanded={open}
        aria-controls={open ? `${ids}p` : undefined}
        // While open, a press on the button keeps focus in the field, so it closes on the click rather than the blur.
        onMouseDown={(e) => open && e.preventDefault()}
        onClick={() => (open ? close(true) : show())}
      >
        <Glass />
      </button>
      {open && (
        <div id={`${ids}p`} className="ip-menu ip-goto-menu" onKeyDown={onKeyDown} onBlur={onBlur} onContextMenu={(e) => e.preventDefault()}>
          <input
            ref={field}
            className="ip-goto-field"
            role="combobox"
            aria-label="Go to a step"
            aria-autocomplete="list"
            aria-expanded={listed}
            aria-controls={`${ids}l`}
            aria-activedescendant={listed && active >= 0 ? `${ids}o${active}` : undefined}
            placeholder="#id or words in a title"
            value={text}
            maxLength={200}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
              setMissing(null);
              setActive(-1);
            }}
          />
          <div role="listbox" id={`${ids}l`} aria-label="Steps" className="ip-goto-list" hidden={!listed}>
            {hits.map((h, i) => (
              <div
                key={h.id}
                id={`${ids}o${i}`}
                role="option"
                aria-selected={i === active}
                aria-label={hitLabel(h)}
                className={`ip-mi ip-goto-hit${h.status === 'done' || h.status === 'dropped' ? ' finished' : ''}`}
                // Focus stays in the field: a press only picks.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => pick(h)}
              >
                <span className="nm">
                  #{h.id} {h.title}
                </span>
                <span className={`ip-goto-proj${h.projectStatus === 'archived' ? ' archived' : ''}`}>{h.projectName}</span>
              </div>
            ))}
          </div>
          <div className="ip-goto-note" aria-live="polite">
            {note}
          </div>
        </div>
      )}
    </div>
  );
});
