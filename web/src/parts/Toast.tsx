import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { Button } from './Button';
import { cx } from './classes';

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  tone?: 'neutral' | 'alarm';
  children: ReactNode;
  onDismiss?: () => void;
}

/** How long a neutral toast stays up before it dismisses itself. */
const TOAST_MS = 4000;

/**
 * A short message. A neutral toast with `onDismiss` calls it after four seconds; an alarm toast stays until its x is
 * pressed. The timer starts when the toast mounts: key the Toast per message to restart it for a new one. Put toasts
 * inside a ToastRegion.
 */
export function Toast({ tone = 'neutral', children, onDismiss, className, ...rest }: ToastProps) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const timed = tone === 'neutral' && onDismiss !== undefined;
  useEffect(() => {
    if (!timed) return;
    const timer = setTimeout(() => dismiss.current?.(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [timed]);
  return (
    <div className={cx('p-toast', className)} data-tone={tone} {...rest}>
      <p className="p-toast-text">{children}</p>
      {tone === 'alarm' && onDismiss && (
        <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </Button>
      )}
    </div>
  );
}

/** Where toasts stack, fixed at the bottom left. Keep it mounted so a screen reader hears each new toast as it arrives. */
export function ToastRegion({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="status" className={cx('p-toasts', className)} {...rest}>
      {children}
    </div>
  );
}
