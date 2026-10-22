import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { parkStep } from '../api';
import { noteAction } from '../measure';
import { Button } from '../parts/Button';
import { Field } from '../parts/Field';

/**
 * The Park… form (in a Backlog row and in Details): why the step is set aside (required) and where its work lives
 * (optional). Enter in either field parks (Shift+Enter is a new line in the reason, a box that grows with it); Escape cancels. The buttons are disabled while the write is in flight, and a
 * refusal shows in the toast and keeps the text. `onDone` runs once the server has parked it.
 */
/**
 * What a Park form holds, kept by its owner when the form can remount (a reorder moves its row to another group): the
 * text, whether a write is in flight, and where focus was. `focused` is set once the reason field has had focus; `held`
 * says the form had focus when it went away, so a remount takes focus back only then. `settle` is the mounted form's
 * way to hear that the write ended, whichever copy of the form sent it.
 */
export interface ParkDraft {
  reason: string;
  where: string;
  focused: boolean;
  held?: boolean;
  sending?: boolean;
  settle?: ((refused: boolean) => void) | null;
}

export function ParkForm({ projectId, slug, nodeId, title, draft, onDone, onCancel, onStatus }: {
  projectId: number;
  slug: string;
  nodeId: number;
  title: string;
  draft?: ParkDraft;
  onDone: () => void;
  onCancel: () => void;
  onStatus?: (text: string) => void;
}) {
  const kept = useRef<ParkDraft>(draft ?? { reason: '', where: '', focused: false });
  const root = useRef<HTMLDivElement>(null);
  const [reason, setReasonState] = useState(kept.current.reason);
  const [where, setWhereState] = useState(kept.current.where);
  const setReason = (v: string) => {
    kept.current.reason = v;
    setReasonState(v);
  };
  const setWhere = (v: string) => {
    kept.current.where = v;
    setWhereState(v);
  };
  const [busy, setBusy] = useState(kept.current.sending === true);
  const reasonField = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => {
    const d = kept.current;
    d.settle = (refused) => {
      setBusy(false);
      // A refusal keeps the text; the field takes focus back from the button that was pressed.
      if (refused) reasonField.current?.focus();
    };
    // Only a form that is new, or that held focus when it went away, takes focus.
    if (!d.focused || d.held) reasonField.current?.focus();
    d.focused = true;
    return () => {
      d.settle = null;
    };
  }, []);
  // Runs before the form leaves the page: whether focus is inside it still shows.
  useLayoutEffect(() => {
    const d = kept.current;
    return () => {
      d.held = root.current?.contains(document.activeElement) === true;
    };
  }, []);
  const ready = reason.trim().length > 0 && !busy;
  const submit = async () => {
    if (reason.trim().length === 0 || kept.current.sending) return;
    const d = kept.current;
    d.sending = true;
    setBusy(true);
    noteAction('backlog', 'park');
    const result = await parkStep(projectId, slug, nodeId, reason.trim(), where.trim());
    d.sending = false;
    if (result === 'ok') {
      d.settle?.(false);
      onDone();
    } else if (result === 'reload') window.location.reload();
    else {
      onStatus?.(result);
      d.settle?.(true);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // While the write is in flight the form stays: closing it would hide a refusal's cause.
      if (!kept.current.sending) onCancel();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey && ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <div ref={root} className="ip-park" role="dialog" aria-modal={false} aria-label={`Park #${nodeId} ${title}`} data-act onKeyDown={onKeyDown}>
      {/* A reason runs to a few hundred characters: a box that grows with it, so it reads whole while typed. */}
      <Field ref={reasonField} size="sm" multiline label="Why is it set aside?" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      <Field size="sm" label="Where does the work live? (optional)" maxLength={500} placeholder="a branch, worktree or commit" value={where} onChange={(e) => setWhere(e.target.value)} />
      <div className="ip-park-actions">
        <Button variant="primary" size="sm" disabled={!ready} onClick={() => void submit()}>Park</Button>
        <Button variant="ghost" size="sm" data-cancel disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
