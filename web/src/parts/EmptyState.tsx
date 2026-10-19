import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './classes';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: ReactNode;
  action?: ReactNode;
}

/** The line a list shows when it has nothing: what is missing, and optionally the one thing to do about it. */
export function EmptyState({ children, action, className, ...rest }: EmptyStateProps) {
  return (
    <div className={cx('p-empty', className)} {...rest}>
      <p className="p-empty-text">{children}</p>
      {action}
    </div>
  );
}
