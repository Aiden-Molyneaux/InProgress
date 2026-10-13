import { useRef, type KeyboardEvent, type RefObject } from 'react';
import { createStep } from '../api';

/**
 * The quick-add field at the foot of Backlog (spec 2.5): Enter creates a todo step under the root and keeps the field open,
 * empty and focused for the next one; Escape closes it, and `onClose` puts focus back on "+ add". A refusal shows in the
 * toast and keeps the text.
 */
export function QuickAdd({ projectId, slug, inputRef, onStatus, onClose }: { projectId: number; slug: string; inputRef: RefObject<HTMLInputElement>; onStatus?: (text: string) => void; onClose: () => void }) {
  // One create at a time, so a held Enter never posts the same title twice.
  const sending = useRef(false);
  const onKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const field = e.currentTarget;
    const title = field.value.trim();
    if (!title || sending.current) return;
    sending.current = true;
    const result = await createStep(projectId, slug, title, null);
    sending.current = false;
    if (result === 'ok') {
      field.value = '';
      field.focus();
    } else if (result !== 'reload') onStatus?.(result);
  };
  return <input ref={inputRef} className="ip-quick-add" type="text" aria-label="Add a step to the backlog" placeholder="Add a step…" onKeyDown={onKeyDown} />;
}
