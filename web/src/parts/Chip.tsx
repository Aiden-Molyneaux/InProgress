import { Children, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from './classes';

export interface ChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  tone?: 'needs' | 'live' | 'ready' | 'blocked' | 'parked' | 'quiet' | 'label' | 'count';
  dashed?: boolean;
  glyph?: string;
  onRemove?: () => void;
  removeLabel?: string;
  children?: ReactNode;
}

/** The text in a chip's children, for the remove button's name. */
function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .filter((child): child is string | number => typeof child === 'string' || typeof child === 'number')
    .join('');
}

/** A short status or label tag. Tone says what it means; `onRemove` adds a trailing x that takes it away. */
export function Chip({ tone = 'quiet', dashed, glyph, onRemove, removeLabel, className, children, ...rest }: ChipProps) {
  return (
    <span className={cx('p-chip', className)} data-tone={tone} data-dashed={dashed || undefined} {...rest}>
      {glyph && (
        <span className="p-chip-glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      {children}
      {onRemove && (
        <button type="button" className="p-chip-remove" aria-label={`Remove ${removeLabel ?? (textOf(children) || 'chip')}`} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}
