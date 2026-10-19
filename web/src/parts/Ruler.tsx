import type { HTMLAttributes } from 'react';
import { cx } from './classes';

export interface RulerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  variant?: 'hud' | 'since';
  label?: string;
}

/** A tick-mark rule. `hud` is the bar's ruler under the top bar; `since` is a violet rule that names where "new since you looked" starts. */
export function Ruler({ variant = 'hud', label, className, ...rest }: RulerProps) {
  if (variant === 'since') {
    return (
      <div className={cx('p-ruler', className)} data-variant="since" {...rest}>
        <span className="p-ruler-label">{label}</span>
      </div>
    );
  }
  return <div className={cx('p-ruler', className)} data-variant="hud" aria-hidden="true" {...rest} />;
}
