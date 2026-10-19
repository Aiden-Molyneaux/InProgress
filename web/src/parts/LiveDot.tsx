import type { HTMLAttributes } from 'react';
import { cx } from './classes';

export interface LiveDotProps extends HTMLAttributes<HTMLSpanElement> {
  /** A dot that does not blink. */
  still?: boolean;
}

/** A small square with a blinking core: something is running. Hidden from a screen reader unless it has a title. */
export function LiveDot({ still, title, className, ...rest }: LiveDotProps) {
  return <span className={cx('p-livedot', className)} data-still={still || undefined} title={title} aria-hidden={title ? undefined : 'true'} {...rest} />;
}
