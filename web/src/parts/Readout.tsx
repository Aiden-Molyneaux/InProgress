import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './classes';

export interface ReadoutProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  label: string;
  value: ReactNode;
  tone?: 'text' | 'volt' | 'alarm';
  face?: 'mono' | 'dot';
}

/** A boxed key and its value, "[KEY] value": a count, a time, a state, read at a glance. */
export function Readout({ label, value, tone = 'text', face = 'mono', className, ...rest }: ReadoutProps) {
  return (
    <span className={cx('p-readout', className)} {...rest}>
      <span className="p-readout-key">{label}</span>
      <span className="p-readout-value" data-tone={tone} data-face={face}>
        {value}
      </span>
    </span>
  );
}
