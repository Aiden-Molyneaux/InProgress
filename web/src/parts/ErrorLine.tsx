import type { HTMLAttributes, ReactNode } from 'react';
import { Button } from './Button';
import { cx } from './classes';

export interface ErrorLineProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  message: ReactNode;
  onRetry?: () => void;
}

/** A failure, said once on an alarm rule, with Retry when there is something to retry. */
export function ErrorLine({ message, onRetry, className, ...rest }: ErrorLineProps) {
  return (
    <div className={cx('p-error', className)} {...rest}>
      <p className="p-error-text">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
