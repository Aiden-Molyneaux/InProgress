import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button';

export interface ConfirmProps {
  question: string;
  detail?: ReactNode;
  /** The confirming button's label, a verb: "Delete step". */
  action: string;
  danger?: boolean;
  /** Focus Cancel when it mounts (the default), so a stray Enter cancels. */
  focusOnMount?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** An inline "are you sure": the question, what it will do, and the action beside Cancel. Escape cancels. */
export function Confirm({ question, detail, action, danger, focusOnMount = true, onConfirm, onCancel }: ConfirmProps) {
  const questionId = useId();
  const detailId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusOnMount) cancel.current?.focus();
  }, [focusOnMount]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  return (
    <div className="p-confirm" role="group" aria-labelledby={questionId} aria-describedby={detail ? detailId : undefined} onKeyDown={keys}>
      <p id={questionId} className="p-confirm-q">
        {question}
      </p>
      {detail && (
        <p id={detailId} className="p-confirm-detail">
          {detail}
        </p>
      )}
      <div className="p-confirm-acts">
        <Button variant={danger ? 'danger' : 'outline'} size="sm" onClick={onConfirm}>
          {action}
        </Button>
        <Button ref={cancel} size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
