import type { HTMLAttributes } from 'react';
import { cx } from './classes';

export interface FrameProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'volt' | 'alarm';
}

/** Four corner brackets drawn just outside the box they sit in, marking the one thing waiting on you. The parent must be `position: relative`. */
export function Frame({ tone = 'volt', className, ...rest }: FrameProps) {
  return <span className={cx('p-frame', className)} data-tone={tone} aria-hidden="true" {...rest} />;
}
