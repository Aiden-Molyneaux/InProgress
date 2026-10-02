import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectSummary } from '../../../src/core/types';
import { projectLabel } from './tabs';

interface TopBarProps {
  /** One per tab, in strip order (projectTabs). */
  tabs: ProjectSummary[];
  /** The ⋯ menu's projects (archivedProjects). */
  archived: ProjectSummary[];
  /** The open project's slug. */
  current: string | null;
  onSelect: (slug: string) => void;
}

/** The amber count of items waiting on Aiden, and the clay dot while a session works in the project. */
function Badges({ p }: { p: ProjectSummary }) {
  return (
    <>
      {p.needsYou > 0 && <span className="ip-tab-count">{p.needsYou}</span>}
      {p.workingSessions > 0 && <span className="ip-tab-dot" />}
    </>
  );
}

/** How much of the next tab along shows past a tab scrolled into view, as a hint that the strip goes on. */
const PEEK = 24;

/**
 * Scrolls the strip, when the current tab is not wholly in view, just far enough to show all of it and a little of its
 * neighbour. Tab edges fall between pixels and scrollLeft takes whole ones, so the scroll rounds up: rounding down
 * would leave a sliver of the tab cut off.
 */
function revealCurrent(strip: HTMLElement): void {
  const tab = strip.querySelector('[aria-selected="true"]');
  if (!tab) return;
  const box = strip.getBoundingClientRect();
  const t = tab.getBoundingClientRect();
  const peek = Math.max(0, Math.min(PEEK, (box.width - t.width) / 2));
  if (t.left < box.left) strip.scrollLeft -= Math.ceil(box.left - t.left + peek);
  else if (t.right > box.right) strip.scrollLeft += Math.ceil(t.right - box.right + peek);
}

/** Pixels per wheel step for each WheelEvent.deltaMode: pixels, lines, pages. */
const wheelStep = (e: WheelEvent, page: number) => [1, 16, page][e.deltaMode] ?? 1;

function TabStrip({ tabs, current, onSelect }: Omit<TopBarProps, 'archived'>) {
  const strip = useRef<HTMLDivElement>(null);
  const ids = tabs.map((p) => p.id).join(',');
  // A switch (click, key or link) brings the current tab into view, and so does a tab coming or going.
  useLayoutEffect(() => revealCurrent(strip.current!), [current, ids]);
  useEffect(() => {
    const el = strip.current!;
    // So does a narrower window.
    const resize = new ResizeObserver(() => revealCurrent(el));
    resize.observe(el);
    // The wheel scrolls the strip sideways. A sideways swipe already does, natively, and Ctrl+wheel still zooms.
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY * wheelStep(e, el.clientWidth);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      resize.disconnect();
      el.removeEventListener('wheel', wheel);
    };
  }, []);
  // The strip is one stop in the tab order: the current tab's, or the first tab's when none is current.
  const stop = tabs.some((p) => p.slug === current) ? current : tabs[0].slug;
  // Left and Right move along the strip, opening each tab they reach.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = buttons.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    onSelect(tabs[next].slug);
  };
  return (
    <div className="ip-tabs" role="tablist" aria-label="Projects" ref={strip} onKeyDown={onKeyDown}>
      {tabs.map((p) => {
        const archived = p.status === 'archived';
        return (
          <button
            key={p.id}
            role="tab"
            aria-selected={p.slug === current}
            tabIndex={p.slug === stop ? 0 : -1}
            className={`ip-tab${archived ? ' archived' : ''}`}
            title={archived ? `${p.name} (archived)` : p.name}
            aria-label={archived ? `${projectLabel(p)}, archived` : projectLabel(p)}
            onClick={() => onSelect(p.slug)}
          >
            <span className="ip-tab-name">{p.name}</span>
            <Badges p={p} />
          </button>
        );
      })}
    </div>
  );
}

function ArchiveMenu({ archived, current, onSelect }: Omit<TopBarProps, 'tabs'>) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', outside);
    return () => window.removeEventListener('mousedown', outside);
  }, [open]);
  /** Closes the menu. Focus goes back to ⋯ rather than falling to the page with the row that had it. */
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  // Escape closes the menu and nothing else: stopping it here keeps it from the app's own Escape, which closes Details.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open || e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  return (
    <div className="ip-archive" ref={box} onKeyDown={onKeyDown}>
      <button ref={button} className="ip-archive-btn" aria-label="Archived projects" title="Archived projects" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="ip-menu">
          <div className="ip-label">Archived</div>
          {archived.map((p) => (
            <button
              key={p.id}
              className={`ip-mi${p.slug === current ? ' cur' : ''}`}
              aria-current={p.slug === current || undefined}
              title={p.name}
              aria-label={projectLabel(p)}
              onClick={() => {
                close();
                onSelect(p.slug);
              }}
            >
              <span className="nm">{p.name}</span>
              <Badges p={p} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One tab per active project, then ⋯ with the archived ones. */
export function TopBar({ tabs, archived, current, onSelect }: TopBarProps) {
  return (
    <header className="ip-topbar">
      {tabs.length > 0 && <TabStrip tabs={tabs} current={current} onSelect={onSelect} />}
      {archived.length > 0 && <ArchiveMenu archived={archived} current={current} onSelect={onSelect} />}
    </header>
  );
}
