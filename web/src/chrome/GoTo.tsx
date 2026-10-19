import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { parseGoTo, type StepHit } from '../../../src/core/goto';
import { api } from '../api';
import { Eyebrow } from '../parts/Eyebrow';
import { Frame } from '../parts/Frame';
import { KeyHint } from '../parts/KeyHint';
import { goTargets, goToMessage, hitLabel, isGoToChord, matchTargets, pickHit, targetKey, type GoTarget } from './goToText';
import { menuStep } from './menu';

/** How long typing rests before the field asks the server. */
const DEBOUNCE_MS = 150;

export interface GoToHandle {
  /** Opens the field (or, when it is open, puts focus back in it). `/` and Ctrl+K call it. */
  open: () => void;
}

/** What the bar was told to open: a step found by the search, or a view or a project from the Go to rows. */
export type GoPick = { kind: 'step'; hit: StepHit } | GoTarget;

interface GoToProps {
  /**
   * The row picked. A step: the window opens its project, unfolds it, centres on it, opens its Details and gives its card
   * focus. Until then focus waits on the search button, which keeps it if the jump is dropped.
   */
  onGo: (pick: GoPick) => void;
  /** The open project's slug: its steps list first within each tier, and it is left out of the Go to rows. */
  current: string | null;
  /** The projects in rail order, for the Go to rows. */
  projects: { slug: string; name: string }[];
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
 * The Find button at the right end of the HUD bar, and the command bar it opens: a modal dialog under the top edge, the
 * window behind it inert. With nothing typed it lists the views and projects; words narrow those (Go to) and list the
 * steps whose titles hold them, across projects, as they are typed (Steps). An id (`#77`, `77`) and Enter jumps to that
 * step in whatever project holds it. Up and Down move through the rows, Enter picks, Escape closes back to whatever had
 * focus before. Tab stays in the field. Typing moves the highlight to the first Go to row, so Enter never picks a row of
 * an old list. Every key stays in here: the app's own keys would otherwise act under it.
 */
export const GoTo = forwardRef<GoToHandle, GoToProps>(function GoTo({ onGo, current, projects }, ref) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  /** Whatever had focus when the bar opened: it gets focus back when the bar closes. */
  const opener = useRef<HTMLElement | null>(null);
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  /** The row Up and Down have reached, by key (`view:backlog`, `project:ingame`, `step:77`), or null for none. */
  const [active, setActive] = useState<string | null>(null);
  /** The id Enter looked for and found nothing at, while the text still names it. */
  const [missing, setMissing] = useState<number | null>(null);
  /** Numbers the requests, so a slow answer to older text never replaces a newer one. */
  const seq = useRef(0);
  const timer = useRef(0);

  const query = parseGoTo(text);
  const trimmed = text.trim();
  /** The answer for the text as it is now; an answer to older text stays on screen until a newer one lands. */
  const settled = answer?.text === trimmed ? answer : null;
  const hits = useMemo(() => answer?.hits ?? [], [answer]);
  const targets = useMemo(() => goTargets(projects, current), [projects, current]);
  const goRows = useMemo(() => matchTargets(text, targets), [text, targets]);
  const rows = useMemo(() => [...goRows.map(targetKey), ...hits.map((h) => `step:${h.id}`)], [goRows, hits]);
  const rowId = (key: string) => `${ids}-${key}`;

  const show = () => {
    if (open) {
      field.current?.focus();
      return;
    }
    const at = document.activeElement;
    opener.current = at instanceof HTMLElement && at !== document.body ? at : null;
    setText('');
    setAnswer(null);
    setActive(targets[0] ? targetKey(targets[0]) : null);
    setMissing(null);
    setOpen(true);
  };
  useImperativeHandle(ref, () => ({ open: show }));

  /**
   * Closes the bar. With `refocus`, focus goes back to the opener; otherwise it stays where the dialog's close puts it.
   * The dialog closes first, here and not in an effect: while it is modal the rest of the window is inert and cannot
   * take focus.
   */
  const close = (refocus: boolean) => {
    window.clearTimeout(timer.current);
    seq.current++;
    if (dialog.current?.open) dialog.current.close();
    setOpen(false);
    if (!refocus) return;
    const back = opener.current;
    if (back?.isConnected) back.focus();
    else field.current?.blur();
  };

  useLayoutEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) {
      d.showModal();
      field.current?.focus();
    }
  }, [open]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // The highlight follows its row: when that row leaves the list, the first row takes it (none when there are none).
  useEffect(() => {
    if (active !== null && !rows.includes(active)) setActive(rows[0] ?? null);
  }, [rows, active]);

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
    // The steps take the highlight only when no Go to row has it.
    setActive((now) => now ?? (next.hits[0] ? `step:${next.hits[0].id}` : null));
    return next;
  };

  // Typing asks once it rests. Nothing typed clears the steps.
  useEffect(() => {
    if (!open) return;
    window.clearTimeout(timer.current);
    if (query.kind === 'empty') {
      seq.current++;
      setAnswer(null);
      return;
    }
    timer.current = window.setTimeout(() => void ask(trimmed), DEBOUNCE_MS);
  }, [open, trimmed]);

  /** Focus waits on the search button (the opener may be a card the switch takes away); the card takes it on landing. */
  const pick = (picked: GoPick) => {
    close(false);
    button.current?.focus();
    onGo(picked);
  };

  /** Enter: a Go to row reached is picked at once; else the step reached, else the first, asking when the answer is not in yet. An id found nowhere says so. */
  const enter = async () => {
    const reached = goRows.find((t) => targetKey(t) === active);
    if (reached) return pick(reached);
    if (query.kind === 'empty') {
      if (goRows[0]) pick(goRows[0]);
      return;
    }
    if (active === null && goRows[0]) return pick(goRows[0]);
    // By id: the list on screen may be an older one than the answer Enter waits for.
    const highlighted = active?.startsWith('step:') ? Number(active.slice(5)) : undefined;
    let now = settled;
    if (!now) {
      window.clearTimeout(timer.current);
      now = await ask(trimmed);
      // The text changed while the server answered: the newer text has its own Enter.
      if (!now) return;
    }
    const hit = pickHit(now.hits, highlighted);
    if (hit) pick({ kind: 'step', hit });
    else if (query.kind === 'id') setMissing(query.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    e.stopPropagation();
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close(true);
        return;
      case 'Tab':
        // The bar has one focus stop.
        e.preventDefault();
        return;
      case 'Enter':
        // Enter that ends an IME composition picks the characters, not a row.
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        void enter();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const next = menuStep(e.key, active === null ? -1 : rows.indexOf(active), rows.length);
        if (next !== null) setActive(rows[next]);
        return;
      }
      default:
        // Ctrl+K again keeps focus here, rather than the browser's address bar taking it.
        if (isGoToChord(e.nativeEvent)) e.preventDefault();
    }
  };

  // The active row stays in view as Up and Down move.
  useEffect(() => {
    if (active !== null) document.getElementById(rowId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, ids]);

  const note = goToMessage(query, settled, missing);
  const alarm = /^(No step #|Couldn't search)/.test(note);
  const listed = rows.length > 0;
  const rowProps = (key: string) => ({
    id: rowId(key),
    role: 'option' as const,
    'aria-selected': key === active,
    // Focus stays in the field: a press only picks.
    onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
    onMouseMove: () => key !== active && setActive(key),
  });
  return (
    <div className="ip-goto">
      <button
        ref={button}
        className="ip-goto-btn"
        aria-label="Find, go to a step"
        title="Find, go to a step (/ or Ctrl+K)"
        aria-keyshortcuts="/ Control+K"
        aria-expanded={open}
        aria-controls={open ? `${ids}p` : undefined}
        // While open the window is inert, so the button is only ever pressed to open.
        onClick={() => (open ? close(true) : show())}
      >
        <Glass />
        <KeyHint keys={['Ctrl K']} label="Find" className="ip-goto-hint" />
      </button>
      <dialog
        ref={dialog}
        id={`${ids}p`}
        className="ip-cmd"
        aria-label="Find"
        onKeyDown={onKeyDown}
        // Escape is ours (keydown above); the dialog's own cancel would close it without returning focus.
        onCancel={(e) => e.preventDefault()}
        // A press on the backdrop is a press on the dialog itself. Elsewhere in the bar a press keeps focus in the field.
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close(false);
          else if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {open && (
          <>
            <Frame />
            <div className="ip-cmd-field">
              <Eyebrow as="label" glyph="[⌕]" htmlFor={`${ids}f`}>
                Find
              </Eyebrow>
              <input
                ref={field}
                id={`${ids}f`}
                className="ip-cmd-input"
                role="combobox"
                aria-label="Find: go to a step, a project or a view"
                aria-autocomplete="list"
                aria-expanded={listed}
                aria-controls={`${ids}l`}
                aria-activedescendant={listed && active !== null ? rowId(active) : undefined}
                placeholder="#id, a step's title, a project or a view"
                value={text}
                maxLength={200}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  const first = matchTargets(e.target.value, targets)[0];
                  setText(e.target.value);
                  setMissing(null);
                  setActive(first ? targetKey(first) : null);
                }}
              />
            </div>
            <div role="listbox" id={`${ids}l`} aria-label="Results" className="ip-cmd-list" hidden={!listed}>
              {goRows.length > 0 && (
                <div role="group" aria-label="Go to" className="ip-cmd-group">
                  <Eyebrow glyph="//" aria-hidden="true">
                    Go to
                  </Eyebrow>
                  {goRows.map((t) => (
                    <div key={targetKey(t)} {...rowProps(targetKey(t))} aria-label={t.label} className="ip-cmd-row" onClick={() => pick(t)}>
                      <span className="ip-cmd-name">{t.label}</span>
                      <span className="ip-cmd-tag">{t.kind === 'view' ? 'VIEW' : 'PROJECT'}</span>
                    </div>
                  ))}
                </div>
              )}
              {hits.length > 0 && (
                <div role="group" aria-label="Steps" className="ip-cmd-group">
                  <Eyebrow glyph="//" aria-hidden="true">
                    Steps
                  </Eyebrow>
                  {hits.map((h) => (
                    <div
                      key={h.id}
                      {...rowProps(`step:${h.id}`)}
                      aria-label={hitLabel(h)}
                      className={`ip-cmd-row${h.status === 'done' || h.status === 'dropped' ? ' finished' : ''}`}
                      onClick={() => pick({ kind: 'step', hit: h })}
                    >
                      <span className="ip-cmd-id">#{h.id}</span>
                      <span className="ip-cmd-name">{h.title}</span>
                      <span className="ip-cmd-tag ip-cmd-proj">
                        {h.projectName}
                        {h.projectStatus === 'archived' ? ' · ARCHIVED' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="ip-cmd-note" data-tone={alarm ? 'alarm' : undefined} aria-live="polite">
              {note}
            </div>
            <div className="ip-cmd-foot">
              <KeyHint keys={['↑↓']} label="Move" />
              <KeyHint keys={['Enter']} label="Open" />
              <KeyHint keys={['Esc']} label="Close" />
            </div>
          </>
        )}
      </dialog>
    </div>
  );
});
