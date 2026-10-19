import { forwardRef, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { cx } from './classes';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  glyph?: '›' | '↗';
  /** Working: a blinking square shows, the button stays focusable and its click does nothing. */
  busy?: boolean;
}

/** The one button: four variants, two sizes, an optional trailing glyph and a busy state. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', glyph, busy, type = 'button', className, onClick, children, ...rest },
  ref,
) {
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      ref={ref}
      type={type}
      className={cx('p-btn', className)}
      data-variant={variant}
      data-size={size}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={click}
      {...rest}
    >
      {busy && <span className="p-btn-busy" aria-hidden="true" />}
      {children}
      {glyph && (
        <span className="p-btn-glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
    </button>
  );
});
