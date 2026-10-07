import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { DeletedProject, ProjectSummary } from '../../../src/core/types';
import { archiveNote, type ActionTarget, type ProjectAction } from '../projectActions';
import { daysLeftLabel } from '../time';
import { useNow } from '../useNow';
import { menuStep } from './menu';
import { projectLabel, recentlyDeleted } from './tabs';

interface TopBarProps {
  /** One per tab, in strip order (projectTabs). */
  tabs: ProjectSummary[];
  /** The ⋯ menu's Archived rows (archivedProjects). */
  archived: ProjectSummary[];
  /** Projects deleted in the last 30 days: the ⋯ menu's Recently deleted rows, once any past its time is dropped. */
  deleted: DeletedProject[];
  /** The open project's slug. */
  current: string | null;
  onSelect: (slug: string) => void;
  /** Archive, unarchive, delete or restore. Resolves true when it went through. */
  onAction: (action: ProjectAction, target: ActionTarget) => Promise<boolean>;
}

/**
 * Runs an action picked in a menu. When it goes through, focus goes back to the element that opened the menu if it is
 * still there, else to the current tab, else to ⋯.
 */
type Run = (action: ProjectAction, target: ActionTarget, opener: HTMLElement | null) => void;

/** The project a Delete… item asks about. Its live sessions, which the delete stops tracking, give the confirm a line. */
type Confirming = ActionTarget & Pick<ProjectSummary, 'activeSessions'>;

/** How many items wait on Aiden, as a muted numeral, and an ink dot while a session works in the project. */
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

/** Shift+F10 or the Menu key: the keyboard's way to a tab's menu, as a right-click is the mouse's. */
const isMenuKey = (e: KeyboardEvent) => (e.key === 'F10' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) || e.key === 'ContextMenu';

interface TabStripProps {
  strip: RefObject<HTMLDivElement>;
  tabs: ProjectSummary[];
  current: string | null;
  onSelect: (slug: string) => void;
  /** The project whose menu is open, if any: its tab shows it. */
  menuFor: number | null;
  onMenu: (p: ProjectSummary, tab: HTMLButtonElement) => void;
}

function TabStrip({ strip, tabs, current, onSelect, menuFor, onMenu }: TabStripProps) {
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
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = buttons.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    // Shift+F10 or the Menu key opens the tab's menu. Handled here too, in case the browser makes no contextmenu of it.
    if (isMenuKey(e)) {
      e.preventDefault();
      onMenu(tabs[at], buttons[at]);
      return;
    }
    // Left and Right move along the strip, opening each tab they reach.
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey) return;
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
            className={`ip-tab${archived ? ' archived' : ''}${p.id === menuFor ? ' menu-open' : ''}`}
            title={archived ? `${p.name} (archived)` : p.name}
            aria-label={archived ? `${projectLabel(p)}, archived` : projectLabel(p)}
            onClick={() => onSelect(p.slug)}
            // A right-click opens the tab's menu without opening the tab, and never the browser's own menu.
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(p, e.currentTarget);
            }}
          >
            <span className="ip-tab-name">{p.name}</span>
            <Badges p={p} />
          </button>
        );
      })}
    </div>
  );
}

interface MenuSurfaceProps {
  surface: RefObject<HTMLDivElement>;
  id?: string;
  className: string;
  style?: { top: number; left: number };
  /** The menu's name: its own (a tab's menu), or the button that opens it (⋯). */
  label?: string;
  labelledBy?: string;
  /** The item focus starts on. */
  start: 'first' | 'last';
  /** While set, the delete confirm stands in for the items, on the same surface. */
  confirm: Confirming | null;
  onDelete: () => void;
  /** Back from the confirm to the items, focus on the Delete item that asked. */
  onCancel: () => void;
  /** Closes the menu. With `refocus`, focus goes back to whatever opened it; otherwise it stays where it went. */
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}

/**
 * What a tab's menu and the ⋯ menu share: roving focus over the menuitems (Down and Up wrap, Home and End), Escape
 * back to the opener, closing when focus leaves, and the delete confirm in place of the items. Every key stays here:
 * [ ] 1-9 f n Home End and Escape are the app's own keys otherwise, and would act under the open menu.
 */
function MenuSurface(props: MenuSurfaceProps) {
  const { surface, id, className, style, label, labelledBy, start, confirm, onDelete, onCancel, onClose, children } = props;
  const ids = useId();
  const confirming = confirm !== null;
  /** The live sessions a delete stops tracking, as Archive's line says it: a delete archives an active project first. */
  const note = confirm && archiveNote(confirm.activeSessions);
  /** The project whose Delete item asked for the confirm, so a cancel puts focus back on that item. */
  const asked = useRef<number | null>(null);
  if (confirm) asked.current = confirm.id;
  // On opening, focus the first (or last) item; on the confirm, its Delete, so Enter confirms; back from it, the asker.
  useLayoutEffect(() => {
    const el = surface.current!;
    if (confirming) {
      el.querySelector<HTMLElement>('.ip-btn.go')?.focus();
      return;
    }
    const items = [...el.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const back = asked.current === null ? null : el.querySelector<HTMLElement>(`[data-item="delete-${asked.current}"]`);
    asked.current = null;
    (back ?? (start === 'last' ? items[items.length - 1] : items[0]))?.focus();
  }, [confirming]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirming) onCancel();
      else onClose(true);
      return;
    }
    // In the confirm, Tab, Enter and Space do what they do on its two buttons.
    if (confirming) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const next = menuStep(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (next === null) return;
    e.preventDefault();
    items[next].focus();
  };
  // Tab and Shift+Tab leave the menu, and it closes behind them. A press elsewhere is the outside mousedown's.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to)) onClose(false);
  };
  return (
    <div
      ref={surface}
      id={id}
      className={className}
      style={style}
      role={confirming ? 'dialog' : 'menu'}
      aria-modal={confirming ? false : undefined}
      aria-label={confirming ? undefined : label}
      aria-labelledby={confirming ? `${ids}q` : labelledBy}
      aria-describedby={confirming ? (note ? `${ids}d ${ids}n` : `${ids}d`) : undefined}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onContextMenu={(e) => e.preventDefault()}
    >
      {confirm ? (
        <div className="ip-confirm">
          <b id={`${ids}q`}>Delete {confirm.name}?</b>
          <p id={`${ids}d`}>Hidden now, removed for good after 30 days. Restore it from ⋯ until then.</p>
          {note && <p id={`${ids}n`}>{note}</p>}
          <div>
            <button className="ip-btn go" onClick={onDelete}>
              Delete
            </button>
            <button className="ip-btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

interface TabMenuProps {
  project: ProjectSummary;
  tab: HTMLButtonElement;
  strip: HTMLDivElement | null;
  onClose: (refocus: boolean) => void;
  run: Run;
}

/**
 * A tab's menu: Archive and Delete… on an active project's tab, Unarchive and Delete… on the open archived project's.
 * Delete… on an active project archives and deletes it in one step, behind the same confirm. The menu floats under its
 * tab, outside the strip (whose overflow would clip it), and closes when the strip scrolls or the window resizes, since
 * it would point at nothing.
 */
function TabMenu({ project, tab, strip, onClose, run }: TabMenuProps) {
  const surface = useRef<HTMLDivElement>(null);
  const noteId = useId();
  /** Whether Delete… is asking. The confirm reads the project as it is now, so its line follows the live sessions. */
  const [asking, setAsking] = useState(false);
  const [at, setAt] = useState(() => {
    const r = tab.getBoundingClientRect();
    return { top: r.bottom + 4, left: r.left };
  });
  // Under its tab, and wholly inside the window, measured again when the confirm changes its width.
  useLayoutEffect(() => {
    const r = tab.getBoundingClientRect();
    const width = surface.current!.offsetWidth;
    setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  }, [tab, asking]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // A scroll that landed before the menu opened (a click bringing its tab into view) is not one that moves it away.
    const from = strip?.scrollLeft ?? 0;
    const scrolled = () => strip && strip.scrollLeft !== from && close.current(false);
    const resized = () => close.current(false);
    const outside = (e: MouseEvent) => !surface.current?.contains(e.target as Node) && close.current(false);
    strip?.addEventListener('scroll', scrolled);
    window.addEventListener('resize', resized);
    window.addEventListener('mousedown', outside);
    return () => {
      strip?.removeEventListener('scroll', scrolled);
      window.removeEventListener('resize', resized);
      window.removeEventListener('mousedown', outside);
    };
  }, [strip]);
  const choose = (action: ProjectAction) => {
    onClose(true);
    run(action, project, tab);
  };
  const archived = project.status === 'archived';
  const note = archived ? null : archiveNote(project.activeSessions);
  const ask = (
    <button role="menuitem" tabIndex={-1} className="ip-mi" data-item={`delete-${project.id}`} onClick={() => setAsking(true)}>
      Delete…
    </button>
  );
  return (
    <MenuSurface
      surface={surface}
      className="ip-menu ip-tab-menu"
      style={at}
      label={project.name}
      start="first"
      confirm={asking ? project : null}
      onDelete={() => choose('delete')}
      onCancel={() => setAsking(false)}
      onClose={onClose}
    >
      {archived ? (
        <>
          <button role="menuitem" tabIndex={-1} className="ip-mi" onClick={() => choose('unarchive')}>
            Unarchive
          </button>
          {ask}
        </>
      ) : (
        <>
          {/* No confirm: Unarchive undoes it. The live sessions it stops tracking keep running, and the note says so. */}
          <button role="menuitem" tabIndex={-1} className="ip-mi" aria-label="Archive" aria-describedby={note ? noteId : undefined} onClick={() => choose('archive')}>
            <span>
              Archive
              {note && (
                <span id={noteId} className="ip-mi-note">
                  {note}
                </span>
              )}
            </span>
          </button>
          {ask}
        </>
      )}
    </MenuSurface>
  );
}

interface ArchiveMenuProps {
  archived: ProjectSummary[];
  deleted: DeletedProject[];
  current: string | null;
  onSelect: (slug: string) => void;
  run: Run;
}

/**
 * ⋯ and its menu: the archived projects (open one, unarchive it, delete it), then the recently deleted ones (restore
 * one, with the days it has left).
 */
function ArchiveMenu({ archived, deleted, current, onSelect, run }: ArchiveMenuProps) {
  const ids = useId();
  /** Where focus starts when the menu is open: ArrowUp on ⋯ starts at the last item. */
  const [open, setOpen] = useState<'first' | 'last' | null>(null);
  const [confirm, setConfirm] = useState<Confirming | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  /** Closes the menu. With `refocus`, focus goes back to ⋯ rather than falling to the page with the item that had it. */
  const shut = (refocus: boolean) => {
    setOpen(null);
    setConfirm(null);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) {
        setOpen(null);
        setConfirm(null);
      }
    };
    window.addEventListener('mousedown', outside);
    return () => window.removeEventListener('mousedown', outside);
  }, [open]);
  // Enter and Space click ⋯, which opens on the first item; Down opens on the first too, and Up on the last.
  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const start = e.key === 'ArrowUp' ? 'last' : 'first';
    if (!open) return setOpen(start);
    const items = surface.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [];
    items[start === 'last' ? items.length - 1 : 0]?.focus();
  };
  const act = (action: ProjectAction, target: ActionTarget) => {
    shut(true);
    run(action, target, button.current);
  };
  const now = Date.now();
  return (
    <div className="ip-archive" ref={wrap}>
      <button
        ref={button}
        id={`${ids}b`}
        className="ip-archive-btn"
        aria-label="Archived and deleted projects"
        title="Archived and deleted projects"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open ? `${ids}m` : undefined}
        // While open, a press on ⋯ keeps focus in the menu, so the menu closes on the click rather than on the blur.
        onMouseDown={(e) => open && e.preventDefault()}
        onClick={() => (open ? shut(true) : setOpen('first'))}
        onKeyDown={onButtonKey}
      >
        ⋯
      </button>
      {open && (
        <MenuSurface
          surface={surface}
          id={`${ids}m`}
          className="ip-menu"
          labelledBy={`${ids}b`}
          start={open}
          confirm={confirm}
          onDelete={() => act('delete', confirm!)}
          onCancel={() => setConfirm(null)}
          onClose={shut}
        >
          {archived.length > 0 && (
            <div role="group" aria-labelledby={`${ids}a`}>
              <div className="ip-label" role="none" id={`${ids}a`}>
                Archived
              </div>
              {archived.map((p) => (
                <div key={p.id} role="none" className="ip-mi-row">
                  <button
                    role="menuitem"
                    tabIndex={-1}
                    className={`ip-mi${p.slug === current ? ' cur' : ''}`}
                    aria-current={p.slug === current || undefined}
                    title={p.name}
                    aria-label={projectLabel(p)}
                    onClick={() => {
                      shut(true);
                      onSelect(p.slug);
                    }}
                  >
                    <span className="nm">{p.name}</span>
                    <Badges p={p} />
                  </button>
                  <button role="menuitem" tabIndex={-1} className="ip-mi-act" aria-label={`Unarchive ${p.name}`} onClick={() => act('unarchive', p)}>
                    Unarchive
                  </button>
                  <button role="menuitem" tabIndex={-1} className="ip-mi-act" data-item={`delete-${p.id}`} aria-label={`Delete ${p.name}`} onClick={() => setConfirm(p)}>
                    Delete…
                  </button>
                </div>
              ))}
            </div>
          )}
          {archived.length > 0 && deleted.length > 0 && <div role="separator" className="ip-menu-sep" />}
          {deleted.length > 0 && (
            <div role="group" aria-labelledby={`${ids}d`}>
              <div className="ip-label" role="none" id={`${ids}d`}>
                Recently deleted
              </div>
              {deleted.map((d) => (
                <div key={d.id} role="none" className="ip-mi-row">
                  {/* A deleted project cannot be opened, so its name is not an item. */}
                  <span className="nm" title={d.name}>
                    {d.name}
                  </span>
                  <span className="ip-mi-left" id={`${ids}l${d.id}`}>
                    {daysLeftLabel(d.purgeAt, now)}
                  </span>
                  <button role="menuitem" tabIndex={-1} className="ip-mi-act" aria-label={`Restore ${d.name}`} aria-describedby={`${ids}l${d.id}`} onClick={() => act('restore', d)}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </MenuSurface>
      )}
    </div>
  );
}

/** One tab per active project, then ⋯ with the archived and recently deleted ones. */
export function TopBar({ tabs, archived, deleted: listed, current, onSelect, onAction }: TopBarProps) {
  const header = useRef<HTMLElement>(null);
  // A row past its purge time drops out even if the purge has not run yet; the clock is the bar's, not the app's.
  const now = useNow(60_000);
  const deleted = useMemo(() => recentlyDeleted(listed, now), [listed, now]);
  const strip = useRef<HTMLDivElement>(null);
  const [tabMenu, setTabMenu] = useState<{ id: number; tab: HTMLButtonElement } | null>(null);
  const menuProject = tabMenu ? tabs.find((p) => p.id === tabMenu.id) : undefined;
  // The menu's tab went (its project archived or deleted from elsewhere): the menu goes with it.
  const menuGone = tabMenu !== null && (!menuProject || !tabMenu.tab.isConnected);
  useEffect(() => {
    if (menuGone) setTabMenu(null);
  }, [menuGone]);
  const closeTabMenu = (refocus: boolean) => {
    const tab = tabMenu?.tab;
    setTabMenu(null);
    if (refocus && tab?.isConnected) tab.focus();
  };
  /**
   * Set once an action has gone through, so focus moves after the render that shows its result: back to where the
   * action began while that is still in the page, else the current tab, else ⋯. So an action from ⋯ keeps focus on ⋯,
   * even a delete of the open project that opened another tab. One from a tab's menu stays on that tab, or lands on the
   * current tab once that one has left the strip.
   */
  const [refocus, setRefocus] = useState<{ opener: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    if (!refocus) return;
    const bar = header.current;
    const target = refocus.opener?.isConnected
      ? refocus.opener
      : (bar?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? bar?.querySelector<HTMLElement>('.ip-archive-btn'));
    target?.focus();
  }, [refocus]);
  const run: Run = async (action, target, opener) => {
    if (await onAction(action, target)) setRefocus({ opener });
  };
  return (
    <header className="ip-topbar" ref={header}>
      {tabs.length > 0 && (
        <TabStrip
          strip={strip}
          tabs={tabs}
          current={current}
          onSelect={onSelect}
          menuFor={menuProject && !menuGone ? menuProject.id : null}
          onMenu={(p, tab) => setTabMenu({ id: p.id, tab })}
        />
      )}
      {tabMenu && menuProject && !menuGone && (
        <TabMenu key={tabMenu.id} project={menuProject} tab={tabMenu.tab} strip={strip.current} onClose={closeTabMenu} run={run} />
      )}
      {(archived.length > 0 || deleted.length > 0) && <ArchiveMenu archived={archived} deleted={deleted} current={current} onSelect={onSelect} run={run} />}
    </header>
  );
}
