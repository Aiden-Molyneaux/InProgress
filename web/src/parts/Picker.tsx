import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { menuStep } from '../chrome/menu';
import { usePressOutside } from './usePressOutside';

export interface PickerOption {
  value: string;
  label: string;
  /** A short mark before the label (a label's glyph). */
  mark?: string;
  /** A colour for the square before the label, when the choice has one. */
  swatch?: string;
  /** Shown in the button while it is the value, but not offered in the list. */
  hidden?: boolean;
}

/** The options a list offers: every one but the hidden. */
const offered = (options: PickerOption[]) => options.filter((o) => !o.hidden);

/**
 * A themed stand-in for a native select: a button that shows the value and opens a dark list of the options under it, with a
 * thin volt line on top, a small mono caption and a slim scrollbar. Down, Up, Home and End move between the options (Down
 * or Up on the button opens the list); Enter or Space picks the focused option, which closes the list with focus on the
 * button and then calls `onChange` when the value changed. Escape and Shift+Tab close with focus on the button; Tab out
 * closes it; a press outside closes it. `ctl` lands on the button as `data-insp`, so a caller can find it again.
 */
export function Picker({ label, caption, value, options, busy, ctl, onChange }: {
  /** The button's name for a screen reader. */
  label: string;
  /** The list's caption, after the `//`. */
  caption: string;
  value: string;
  options: PickerOption[];
  busy?: boolean;
  ctl?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const shown = options.find((o) => o.value === value);
  const shut = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) opener.current?.focus();
  };
  const items = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
  /** Focus the chosen option, or the first; with none to offer, close. */
  const focusChosen = () => {
    const all = items();
    const target = all.find((el) => el.getAttribute('aria-selected') === 'true') ?? all[0];
    if (!target) return shut(true);
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  };
  // On open, focus goes into the list.
  useEffect(() => {
    if (open) focusChosen();
    // `focusChosen` reads refs only: it is safe to leave out.
  }, [open]);
  // When the focused option goes away under a live update, focus would fall to the page: keep it in the list.
  const keys = offered(options).map((o) => o.value).join('|');
  useEffect(() => {
    if (open && document.activeElement === document.body) focusChosen();
  }, [keys]);
  usePressOutside(open, [surface, opener], () => {
    setOpen(false);
    window.setTimeout(() => {
      if (document.activeElement === document.body) opener.current?.focus({ preventScroll: true });
    }, 0);
  });
  const pick = (next: string) => {
    shut(true);
    if (next !== value) onChange(next);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to) && to !== opener.current) setOpen(false);
  };
  const listKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || (e.key === 'Tab' && e.shiftKey)) {
      // Escape stops here: it must not also close the inspector or Details.
      e.preventDefault();
      e.stopPropagation();
      shut(true);
      return;
    }
    const el = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute('role') === 'option') {
      e.preventDefault();
      e.stopPropagation();
      pick(el.dataset.value ?? '');
      return;
    }
    const all = items();
    const next = menuStep(e.key, all.indexOf(document.activeElement as HTMLElement), all.length);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    all[next].focus();
  };
  const buttonKeys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      shut(true);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    }
  };
  return (
    <span className="p-pick">
      <button
        ref={opener}
        type="button"
        role="combobox"
        className={`p-pick-btn${busy ? ' busy' : ''}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-busy={busy || undefined}
        data-insp={ctl}
        data-value={value}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={buttonKeys}
      >
        {shown?.mark && (
          <span className="p-pick-mark" aria-hidden="true">
            {shown.mark}
          </span>
        )}
        <span className="p-pick-value">{shown?.label ?? ''}</span>
        <span className="p-pick-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={surface} className="p-pick-pop" onKeyDown={listKeys} onBlur={onBlur}>
          <div className="p-pick-cap" aria-hidden="true">
            <span className="p-pick-cap-glyph">//</span> {caption}
          </div>
          <div ref={list} id={listId} role="listbox" aria-label={label} className="p-pick-list">
            {offered(options).map((o) => (
              <div
                key={o.value}
                role="option"
                tabIndex={-1}
                className="p-pick-opt"
                aria-selected={o.value === value}
                data-value={o.value}
                onClick={() => pick(o.value)}
              >
                {o.swatch ? (
                  <span className="p-pick-sq" style={{ background: o.swatch }} aria-hidden="true" />
                ) : (
                  <span className="p-pick-mark" aria-hidden="true">
                    {o.mark ?? ''}
                  </span>
                )}
                <span className="p-pick-label">{o.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
