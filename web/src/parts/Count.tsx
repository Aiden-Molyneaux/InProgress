import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { cx } from './classes';
import { countRose } from './countLogic';

export interface CountProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  value: number;
  size?: 'h1' | 'h3';
  tone?: 'muted' | 'text' | 'volt';
}

/** A big dot-matrix figure, a column's count. When the value goes up the figure strobes once. */
export function Count({ value, size = 'h1', tone = 'muted', className, ...rest }: CountProps) {
  const previous = useRef<number | undefined>(undefined);
  const [rise, setRise] = useState(0);
  // The ref is written after the check, so StrictMode's second run of this effect sees the value it already has and no rise fires.
  useEffect(() => {
    if (countRose(previous.current, value)) setRise((n) => n + 1);
    previous.current = value;
  }, [value]);
  return (
    <span className={cx('p-count', className)} data-size={size} data-tone={tone} {...rest}>
      <span key={rise} className={rise > 0 ? 'p-count-figure p-count-rise' : 'p-count-figure'}>
        {value}
      </span>
    </span>
  );
}
