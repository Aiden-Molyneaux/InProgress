import { useId, useLayoutEffect, useRef, type HTMLAttributes, type KeyboardEvent } from 'react';
import { cx } from './classes';
import { scrollToShow, tabStep } from './tabStripLogic';

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  /** The id of the panel this tab controls (tabs variant). */
  controls?: string;
}

export interface TabStripProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  variant?: 'tabs' | 'segmented';
  /** The accessible name of the tab list or group. */
  label: string;
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
}

/**
 * A row of tabs, or a segmented choice. Tabs are one Tab stop: Left, Right, Home and End move the selection with focus and
 * wrap at the ends. The selected one is kept in view when the strip scrolls sideways.
 */
export function TabStrip({ variant = 'tabs', label, items, value, onChange, className, onKeyDown, ...rest }: TabStripProps) {
  const root = useRef<HTMLDivElement>(null);
  const tabs = variant === 'tabs';
  const prefix = useId();
  const anySelected = items.some((item) => item.id === value);

  // Scroll the strip itself, never scrollIntoView: that scrolls the page too. The strip is its buttons' offsetParent.
  // It runs when the selection or the items change, and when the strip is resized.
  useLayoutEffect(() => {
    const strip = root.current;
    if (!strip) return;
    const show = () => {
      const current = strip.querySelector<HTMLElement>('.p-tab[aria-selected="true"], .p-tab[aria-pressed="true"]');
      if (current) strip.scrollLeft = scrollToShow(current.offsetLeft, current.offsetWidth, strip.scrollLeft, strip.clientWidth);
    };
    show();
    if (typeof ResizeObserver === 'undefined') return;
    const watcher = new ResizeObserver(show);
    watcher.observe(strip);
    return () => watcher.disconnect();
  }, [value, items]);

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (!tabs || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.p-tab') ?? []);
    const next = tabStep(event.key, buttons.indexOf(event.target as HTMLButtonElement), items.length);
    if (next === null) return;
    event.preventDefault();
    onChange(items[next].id);
    buttons[next]?.focus();
  };

  return (
    <div
      ref={root}
      className={cx('p-tabstrip', className)}
      data-variant={variant}
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
      onKeyDown={keys}
      {...rest}
    >
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            className="p-tab"
            id={`${prefix}-${item.id}`}
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? selected : undefined}
            aria-pressed={tabs ? undefined : selected}
            aria-controls={tabs ? item.controls : undefined}
            tabIndex={tabs && !selected && !(index === 0 && !anySelected) ? -1 : undefined}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.count !== undefined && <span className="p-tab-count">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
