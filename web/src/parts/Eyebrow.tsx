import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from './classes';

export interface EyebrowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  glyph?: '//' | '[+]' | '[!]' | '>>' | '[◈]' | '[✓]' | '[⌕]';
  glyphTone?: 'volt' | 'dim';
  as?: 'span' | 'h2' | 'h3' | 'label';
  /** For `as="label"`: the id of the field it names. */
  htmlFor?: string;
  children?: ReactNode;
}

/** A small uppercase label with an optional leading glyph: a section's name, a field's label, a column's marker. */
export function Eyebrow({ glyph, glyphTone = 'volt', as = 'span', htmlFor, className, children, ...rest }: EyebrowProps) {
  const As = as as ElementType;
  return (
    <As className={cx('p-eyebrow', className)} {...rest} {...(as === 'label' ? { htmlFor } : {})}>
      {glyph && (
        <span className="p-eyebrow-glyph" data-tone={glyphTone} aria-hidden="true">
          {glyph}
        </span>
      )}
      {children}
    </As>
  );
}
