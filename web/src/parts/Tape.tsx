import type { HTMLAttributes } from 'react';
import { cx } from './classes';

export interface TapeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: 'volt' | 'alarm';
}

/** A hazard-tape stripe: the top edge of the one slab that speaks for the whole window. */
export function Tape({ tone = 'volt', className, ...rest }: TapeProps) {
  return <div className={cx('p-tape', className)} data-tone={tone} aria-hidden="true" {...rest} />;
}
