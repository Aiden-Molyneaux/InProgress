import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button';
import { Menu, MenuItem } from './Menu';
import { usePressOutside } from './usePressOutside';

export interface MenuButtonItem {
  key: string | number;
  label: ReactNode;
  /** The item that is on now. */
  current?: boolean;
  onSelect: () => void;
}

/**
 * A button that toggles a popover holding a Menu (the tidy list, the Backlog phase, a section's resources). Select focuses
 * the button, closes the menu, then calls `onSelect`. Escape and Shift+Tab close with focus on the button; Tab out closes
 * it; a press outside closes it, and focus goes back to the button when the press landed on nothing that takes focus.
 */
export function MenuButton({ children, items, menuLabel, variant = 'ghost', className, title, label, align = 'end' }: {
  /** The button's face. */
  children: ReactNode;
  items: MenuButtonItem[];
  /** The menu's name for a screen reader. */
  menuLabel: string;
  /** A Button variant, or 'bare' for a plain button that `className` alone styles. */
  variant?: 'ghost' | 'outline' | 'danger' | 'bare';
  className?: string;
  title?: string;
  /** The button's name for a screen reader, when its face does not say enough. */
  label?: string;
  /** Which edge of the button the popover lines up with. */
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const shut = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) opener.current?.focus();
  };
  // When the item holding focus goes away (a live update drops it), focus would fall to the page: keep it in the menu.
  // Focus on the button is not lost: a press on it, mid-close, puts it there.
  const keys = items.map((i) => i.key).join('|');
  useEffect(() => {
    if (!open || !surface.current || surface.current.contains(document.activeElement) || document.activeElement === opener.current) return;
    const all = Array.from(surface.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
    const target = all.find((el) => el.getAttribute('aria-current') === 'true') ?? all[0];
    if (target) target.focus();
    else shut(true);
    // `shut` only closes and focuses the button: it is safe to leave out.
  }, [open, keys]);
  usePressOutside(open, [surface, opener], () => {
    setOpen(false);
    // The press landed on nothing that takes focus: focus would fall to the page, so it goes back to the button.
    window.setTimeout(() => {
      if (document.activeElement === document.body) opener.current?.focus({ preventScroll: true });
    }, 0);
  });
  // Tab and Shift+Tab leave the menu, and it closes behind them.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to) && to !== opener.current) setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Menu items are out of the Tab order, so Shift+Tab from one would land on the button with the menu still open.
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      shut(true);
    }
  };
  const openerProps = {
    ref: opener,
    className,
    title,
    'aria-label': label,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      // Escape on the button closes the menu and stops there: it must not also close Details.
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        e.stopPropagation();
        shut(true);
      }
    },
  };
  return (
    <span className="p-menubtn">
      {variant === 'bare' ? (
        <button type="button" {...openerProps}>
          {children}
        </button>
      ) : (
        <Button variant={variant} size="sm" {...openerProps}>
          {children}
        </Button>
      )}
      {open && (
        <div ref={surface} className="p-menubtn-pop" data-align={align} onKeyDown={onKeyDown} onBlur={onBlur}>
          <Menu label={menuLabel} autoFocus onClose={() => shut(true)}>
            {items.map((item) => (
              <MenuItem
                key={item.key}
                current={item.current}
                onSelect={() => {
                  // Focus goes to the button first: Details records the focused element as its opener, and Escape returns there.
                  shut(true);
                  item.onSelect();
                }}
              >
                {item.label}
              </MenuItem>
            ))}
          </Menu>
        </div>
      )}
    </span>
  );
}
