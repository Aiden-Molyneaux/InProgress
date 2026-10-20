import { useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../parts/Button';
import { Menu, MenuItem } from '../parts/Menu';
import { usePressOutside } from '../parts/usePressOutside';

export interface MenuButtonItem {
  key: string | number;
  label: string;
  /** The item that is on now. */
  current?: boolean;
  onSelect: () => void;
}

/**
 * A Button that toggles a popover holding a Menu (the tidy list, the Backlog phase). Select focuses the button, closes the
 * menu, then calls `onSelect`. Escape and Shift+Tab close with focus on the button; a press outside and Tab out close it.
 */
export function MenuButton({ children, items, menuLabel, variant = 'ghost', title, align = 'end' }: {
  /** The button's face. */
  children: ReactNode;
  items: MenuButtonItem[];
  /** The menu's name for a screen reader. */
  menuLabel: string;
  variant?: 'ghost' | 'danger';
  title?: string;
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
  // A press elsewhere closes it and leaves focus where the press put it.
  usePressOutside(open, [surface, opener], () => setOpen(false));
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
  return (
    <span className="ip-menubtn">
      <Button
        ref={opener}
        variant={variant}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          // Escape on the button closes the menu and stops there: it must not also close Details.
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            shut(true);
          }
        }}
      >
        {children}
      </Button>
      {open && (
        <div ref={surface} className="ip-menubtn-pop" data-align={align} onKeyDown={onKeyDown} onBlur={onBlur}>
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
