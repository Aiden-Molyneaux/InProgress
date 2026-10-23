import { useRef, type KeyboardEvent, type RefObject } from 'react';
import { createStep } from '../api';

/** The notes field grows with its text, up to about six lines. */
const NOTES_MAX = 6 * 18 + 8;

/**
 * The quick-add pair at the foot of Backlog (spec 2.5): a title field and a Notes field under it. Enter in either creates a
 * todo step under `parent` (the root when null), the notes as its body, and keeps the pair open, empty and focused on the title for the next one;
 * Shift+Enter in the notes is a new line; Escape closes it, and `onClose` puts focus back on "+ add". A refusal shows in the
 * toast and keeps the text.
 */
export function QuickAdd({ projectId, slug, inputRef, onStatus, onClose, parent = null, label = 'Add a step to the backlog', band }: { projectId: number; slug: string; inputRef: RefObject<HTMLInputElement>; onStatus?: (text: string) => void; onClose: () => void; parent?: number | null; label?: string; band?: 'soon' }) {
  // One create at a time, so a held Enter never posts the same title twice.
  const sending = useRef(false);
  const notes = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = notes.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border, which the border-box height includes.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, NOTES_MAX + border)}px`;
  };
  const onKeyDown = async (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // Shift+Enter in the notes is a new line.
    if (e.shiftKey && e.currentTarget === notes.current) return;
    e.preventDefault();
    const sentTitle = inputRef.current?.value ?? '';
    const sentNotes = notes.current?.value ?? '';
    const title = sentTitle.trim();
    // Notes with no title yet: the title is what is missing, so go there.
    if (!title) {
      inputRef.current?.focus();
      return;
    }
    if (sending.current) return;
    sending.current = true;
    const result = await createStep(projectId, slug, title, parent, band, sentNotes);
    sending.current = false;
    if (result === 'ok') {
      // Text typed while the create was in flight is the next step's: only what was sent is cleared, and focus moves only
      // if it is still in the pair.
      const pair = inputRef.current?.parentElement;
      if (inputRef.current && inputRef.current.value === sentTitle) inputRef.current.value = '';
      if (notes.current && notes.current.value === sentNotes) notes.current.value = '';
      grow();
      if (pair?.contains(document.activeElement)) inputRef.current?.focus();
    } else if (result === 'reload') window.location.reload();
    else onStatus?.(result);
  };
  return (
    <div className="ip-quick-wrap">
      <input ref={inputRef} className="ip-quick-add" type="text" aria-label={label} placeholder="Add a step…" onKeyDown={onKeyDown} />
      <textarea ref={notes} className="ip-quick-notes" rows={1} aria-label="Notes for the new step" placeholder="Notes (optional)" onInput={grow} onKeyDown={onKeyDown} />
    </div>
  );
}
