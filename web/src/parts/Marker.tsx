import type { HTMLAttributes } from 'react';
import type { NodeStatus } from '../../../src/core/types';
import { cx } from './classes';

export interface MarkerProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  status: NodeStatus;
  /** node.kind === 'question': the ? square. A done question keeps the ?. */
  question: boolean;
  /** Nobody is on this step: a hollow ring. */
  paused: boolean;
  /** The step is waiting on Aiden: a volt square. */
  needsYou: boolean;
  /** An active marker on a working card blinks. */
  pulse: boolean;
}

/**
 * A step's status marker. Its look is in parts.css, which draws the done check and the question's ?, so the span holds no
 * text and a step's name stays the first text beside it.
 */
export function Marker({ status, question, paused, needsYou, pulse, className, ...rest }: MarkerProps) {
  return (
    <span
      className={cx('p-marker', className)}
      data-status={status}
      data-question={question || undefined}
      data-paused={paused || undefined}
      data-you={needsYou || undefined}
      data-pulse={pulse || undefined}
      {...rest}
    />
  );
}
