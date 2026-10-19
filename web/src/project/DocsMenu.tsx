import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import type { ResourceMeta } from '../../../src/core/types';
import { Menu, MenuItem } from '../parts/Menu';
import { usePressOutside } from '../parts/usePressOutside';
import { resourceSummary } from '../panels/format';

/**
 * A section's `▤ n`: a button that opens a menu of its resources, each opening the resource viewer. Escape closes it and
 * puts focus back on the button; a press outside closes it; Tab leaves it; Down and Up move between the items.
 */
export function DocsMenu({ docs, label, onOpenResource }: { docs: ResourceMeta[]; label: string; onOpenResource: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const shut = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) opener.current?.focus();
  };
  usePressOutside(open, [surface, opener], () => {
    setOpen(false);
    // The press landed on nothing that takes focus: focus would fall to the page, so it goes back to the opener.
    window.setTimeout(() => {
      if (document.activeElement === document.body) opener.current?.focus();
    }, 0);
  });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Shift+Tab off the first item lands on the opener, and the menu closes behind it.
    if (e.key === 'Tab' && e.shiftKey && document.activeElement === e.currentTarget.querySelector('[role="menuitem"]')) {
      e.preventDefault();
      shut(true);
    }
  };
  // Tab and Shift+Tab leave the menu, and it closes behind them.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to) && to !== opener.current) setOpen(false);
  };
  return (
    <span className="ip-docs-wrap">
      <button
        ref={opener}
        type="button"
        className="ip-docs ip-docs-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${docs.length} resource${docs.length > 1 ? 's' : ''} in ${label}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          // Escape on the opener closes the menu and stops there: it must not also close Details.
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            shut(true);
          }
        }}
      >
        {`▤ ${docs.length}`}
      </button>
      {open && (
        <div ref={surface} className="ip-docs-pop" onKeyDown={onKeyDown} onBlur={onBlur}>
          <Menu label={`Resources in ${label}`} autoFocus onClose={() => shut(true)}>
            {docs.map((r) => (
              <MenuItem
                key={r.id}
                onSelect={() => {
                  shut(true);
                  onOpenResource(r.id);
                }}
              >
                {r.title} <span className="ip-docs-sum">{resourceSummary(r)}</span>
              </MenuItem>
            ))}
          </Menu>
        </div>
      )}
    </span>
  );
}
