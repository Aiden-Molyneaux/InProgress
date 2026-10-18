import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { parkStep } from '../api';
import { noteAction } from '../measure';

/**
 * The Park… form (in a Backlog row and in Details): why the step is set aside (required) and where its work lives
 * (optional). Enter in either field parks; Escape cancels. The buttons are disabled while the write is in flight, and a
 * refusal shows in the toast and keeps the text. `onDone` runs once the server has parked it.
 */
/** What a Park form holds, kept by its owner when the form can remount (a reorder moves its row to another group). `focused` is set once the reason field has had focus, so a remount does not take it back. */
export interface ParkDraft {
  reason: string;
  where: string;
  focused: boolean;
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
  const [busy, setBusy] = useState(false);
  const reasonField = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  useEffect(() => {
    if (kept.current.focused) return;
    kept.current.focused = true;
    reasonField.current?.focus();
  }, []);
  const ready = reason.trim().length > 0 && !busy;
  const submit = async () => {
    if (reason.trim().length === 0 || sending.current) return;
    sending.current = true;
    setBusy(true);
    noteAction('backlog', 'park');
    const result = await parkStep(projectId, slug, nodeId, reason.trim(), where.trim());
    sending.current = false;
    setBusy(false);
    if (result === 'ok') onDone();
    else if (result === 'reload') window.location.reload();
    else {
      onStatus?.(result);
      // A refusal keeps the text; the field takes focus back from the button that was pressed.
      reasonField.current?.focus();
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // While the write is in flight the form stays: closing it would hide a refusal's cause.
      if (!sending.current) onCancel();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <div className="ip-park" role="dialog" aria-modal={false} aria-label={`Park #${nodeId} ${title}`} data-act onKeyDown={onKeyDown}>
      <label>
        <span>Why is it set aside?</span>
        <input ref={reasonField} type="text" className="ip-park-field" aria-label="Reason" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label>
        <span>Where does the work live? (optional)</span>
        <input type="text" className="ip-park-field" aria-label="Where" maxLength={500} placeholder="a branch, worktree or commit" value={where} onChange={(e) => setWhere(e.target.value)} />
      </label>
      <div className="ip-park-actions">
        <button type="button" className="ip-btn go" disabled={!ready} onClick={() => void submit()}>Park</button>
        <button type="button" className="ip-btn" data-cancel onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
