import { forwardRef, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { menuStep } from '../chrome/menu';

export interface MenuProps {
  /** The menu's name for a screen reader, when there is no `head`. */
  label?: string;
  /** A heading line above the items; it also names the menu. */
  head?: ReactNode;
  /** Focus the first enabled item when the menu mounts. */
  autoFocus?: boolean;
  /** Called on Escape. */
  onClose?: () => void;
  children: ReactNode;
}

/** The enabled items of a menu element, in order. */
const enabledItems = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));

/**
 * A list of actions. Down, Up, Home and End move focus between the enabled items, wrapping round; Escape calls `onClose`.
 * The menu does not position itself: a popover is the caller's.
 */
export function Menu({ label, head, autoFocus, onClose, children }: MenuProps) {
  const headId = useId();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus && menu.current) enabledItems(menu.current)[0]?.focus();
  }, [autoFocus]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }
    const items = enabledItems(event.currentTarget);
    const next = menuStep(event.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (next === null) return;
    event.preventDefault();
    items[next].focus();
  };
  return (
    <div className="p-menu">
      {head && (
        <div className="p-menu-head" id={headId}>
          {head}
        </div>
      )}
      <div ref={menu} role="menu" aria-label={label} aria-labelledby={head ? headId : undefined} onKeyDown={keys}>
        {children}
      </div>
    </div>
  );
}

export interface MenuItemProps {
  glyph?: string;
  /** A key shown at the right, such as "Del". */
  keyHint?: string;
  danger?: boolean;
  /** The item that is on now: marked with a volt arrow. */
  current?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}

/** One action in a Menu. */
export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem({ glyph, keyHint, danger, current, disabled, onSelect, children }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      className="p-menu-item"
      tabIndex={-1}
      data-danger={danger || undefined}
      aria-current={current ? 'true' : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="p-menu-cur" aria-hidden="true">
        {current ? '›' : ''}
      </span>
      {glyph && (
        <span className="p-menu-glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      <span className="p-menu-label">{children}</span>
      {keyHint && <kbd className="p-key">{keyHint}</kbd>}
    </button>
  );
});

/** A hairline between groups of items. */
export function MenuSeparator() {
  return <div role="separator" className="p-menu-sep" />;
}
