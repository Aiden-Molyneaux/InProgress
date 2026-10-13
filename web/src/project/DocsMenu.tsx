import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ResourceMeta } from '../../../src/core/types';
import { menuStep } from '../chrome/menu';
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
  useEffect(() => {
    if (!open) return;
    surface.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (surface.current?.contains(target) || opener.current?.contains(target)) return;
      setOpen(false);
      // The press landed on nothing that takes focus: focus would fall to the page, so it goes back to the opener.
      window.setTimeout(() => {
        if (document.activeElement === document.body) opener.current?.focus();
      }, 0);
    };
    window.addEventListener('mousedown', outside);
    return () => window.removeEventListener('mousedown', outside);
  }, [open]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      shut(true);
      return;
    }
    const items0 = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const items = items0;
    // Shift+Tab off the first item lands on the opener, and the menu closes behind it.
    if (e.key === 'Tab' && e.shiftKey && document.activeElement === items[0]) {
      e.preventDefault();
      shut(true);
      return;
    }
    const next = menuStep(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (next === null) return;
    e.preventDefault();
    items[next]!.focus();
  };
  // Tab and Shift+Tab leave the menu, and it closes behind them.
  const onBlur = (e: React.FocusEvent<HTMLDivElement>) => {
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
        <div ref={surface} className="ip-menu ip-docs-menu" role="menu" aria-label={`Resources in ${label}`} onKeyDown={onKeyDown} onBlur={onBlur}>
          {docs.map((r) => (
            <button
              key={r.id}
              type="button"
              role="menuitem"
              className="ip-mi"
              onClick={() => {
                shut(true);
                onOpenResource(r.id);
              }}
            >
              <span className="nm">{r.title}</span>
              <span className="ip-quiet">{resourceSummary(r)}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
