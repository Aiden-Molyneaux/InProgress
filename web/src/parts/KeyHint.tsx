import type { HTMLAttributes } from 'react';
import { cx } from './classes';

export interface KeyHintProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  keys: string[];
  label: string;
}

/** A key (or keys) and what it does, "Esc Close": the hints along a footer and in a menu. */
export function KeyHint({ keys, label, className, ...rest }: KeyHintProps) {
  return (
    <span className={cx('p-keyhint', className)} {...rest}>
      {keys.map((key) => (
        <kbd key={key} className="p-key">
          {key}
        </kbd>
      ))}
      <span className="p-keyhint-label">{label}</span>
    </span>
  );
}
