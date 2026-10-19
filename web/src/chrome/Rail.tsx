import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { DeletedProject, ProjectSummary } from '../../../src/core/types';
import { Chip } from '../parts/Chip';
import { Eyebrow } from '../parts/Eyebrow';
import type { ActionTarget, ProjectAction } from '../projectActions';
import { useNow } from '../useNow';
import type { View } from '../views/view';
import { fallbackFocus, FootMenu, isMenuKey, RowMenu, Signals, type RailLayout, type Run, type RunRename } from './projectMenus';
import { railStep, viewTitle, type RailView } from './railLogic';
import { moveTab, projectLabel, recentlyDeleted, tabDropSlot } from './tabs';

export interface RailProps {
  /** One per row, in rail order (projectTabs). */
  tabs: ProjectSummary[];
  /** The foot menu's Archived rows (archivedProjects). */
  archived: ProjectSummary[];
  /** Projects deleted in the last 30 days: the foot menu's Recently deleted rows, once any past its time is dropped. */
  deleted: DeletedProject[];
  /** The open project's slug. */
  current: string | null;
  onSelect: (slug: string) => void;
  /** Moves an active row before another (null: to the end), by drag or Alt with Up, Down, Left or Right. */
  onMove: (id: number, before: number | null) => void;
  /** Archive, unarchive, delete or restore. Resolves true when it went through. */
  onAction: (action: ProjectAction, target: ActionTarget) => Promise<boolean>;
  /** Renames a project (its name only: the slug stays). Resolves true when it went through. */
  onRename: (target: ActionTarget, name: string) => Promise<boolean>;
  /** The view shown, and the pick of another. */
  view: View;
  onView: (v: View) => void;
  /** The current project's views with their counts (railViews). */
  views: RailView[];
  /** Each row's three-letter code, by project id (railCodes). */
  codes: Map<number, string>;
}

/** A row drag's data type. Not text/plain, which a text field would take as typed text. */
const ROW_DRAG = 'application/x-inprogress-tab';

/** Whether a drag over the rail is one of its rows, and not a step row or a file from outside. */
const isRowDrag = (e: DragEvent) => e.dataTransfer.types.includes(ROW_DRAG);

/** The narrow window the rail becomes a strip in. Keep in step with rail.css. */
const STRIP_QUERY = '(max-width: 719px)';

/** Which way the rail runs now, and again when the window crosses 720 px. */
function useLayout(): RailLayout {
  const [strip, setStrip] = useState(() => window.matchMedia(STRIP_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(STRIP_QUERY);
    const changed = () => setStrip(query.matches);
    changed();
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  return strip ? 'strip' : 'column';
}

/**
 * The module rail: a row per active project (and the open archived one, at the end), under the current one its views,
 * and a foot for the archived and recently deleted projects. A column at the left of the page; under 720 px a strip.
 */
export function Rail({ tabs, archived, deleted: listed, current, onSelect, onMove, onAction, onRename, view, onView, views, codes }: RailProps) {
  const layout = useLayout();
  const rail = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const foot = useRef<HTMLButtonElement>(null);
  // A row past its purge time drops out even if the purge has not run yet; the clock is the rail's, not the app's.
  const now = useNow(60_000);
  const deleted = useMemo(() => recentlyDeleted(listed, now), [listed, now]);
  const ids = tabs.map((p) => p.id).join(',');
  const hasFoot = archived.length > 0 || deleted.length > 0;
  /** Whether the nav renders at all: the observer attaches once it does, not only on the first render. */
  const shown = tabs.length > 0 || hasFoot;
  const activeIds = tabs.filter((p) => p.status === 'active').map((p) => p.id);
  const activeKey = activeIds.join();
  /** The row being dragged, and where it would drop: before this row, or null for the end. Null while nothing drags. */
  const [dragState, setDrag] = useState<{ id: number; slot: number | null } | null>(null);
  // A row that leaves the rail mid-drag (archived or deleted elsewhere) ends its drag: its dragend never reaches React.
  const drag = dragState && activeIds.includes(dragState.id) ? dragState : null;
  // Cleared too, not only hidden, so the row coming back later does not bring the old drag with it.
  useEffect(() => {
    if (dragState && !drag) setDrag(null);
  }, [activeKey]);
  /** Whether dropping now would change the order: the drop line shows only then. */
  const changes = drag !== null && moveTab(tabs, drag.id, drag.slot).join() !== activeKey;
  /** The row a move carries, by key or by drag: it gets focus back if the reorder took it. */
  const moved = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (moved.current === null) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-tab="${moved.current}"]`);
    moved.current = null;
    if (row && document.activeElement !== row) row.focus();
  }, [ids]);
  // A switch (click, key or link) brings the current row into view, and so does a row coming or going, and a resize.
  useLayoutEffect(() => {
    rail.current?.querySelector('a[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current, ids]);
  useEffect(() => {
    const el = rail.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(() => el.querySelector('a[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    resize.observe(el);
    return () => resize.disconnect();
  }, [shown]);

  // The roving stops follow focus: the row (or view) focused last, until the current one changes, which resets them to it.
  const [rowStop, setRowStop] = useState<{ from: string | null; slug: string } | null>(null);
  const [viewStop, setViewStop] = useState<{ from: string; view: View } | null>(null);
  // Whether focus is in the views list. Switching project swaps that list for the new current row's, which takes focus
  // with it; it goes to the new list's current view instead of the page.
  const inViews = useRef(false);
  useLayoutEffect(() => {
    const had = inViews.current;
    inViews.current = false;
    if (!had) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rail.current?.querySelector<HTMLElement>('button.ip-rail-view[aria-current="page"]')?.focus();
  }, [current]);

  const [rowMenu, setRowMenu] = useState<{ id: number; row: HTMLElement } | null>(null);
  const menuProject = rowMenu ? tabs.find((p) => p.id === rowMenu.id) : undefined;
  // The menu's row went (its project archived or deleted from elsewhere): the menu goes with it.
  const menuGone = rowMenu !== null && (!menuProject || !rowMenu.row.isConnected);
  useEffect(() => {
    if (!menuGone) return;
    // The menu has already left the page with its row, so focus that was in it now sits on the body: it goes to the
    // current row (or the foot) rather than the page.
    const active = document.activeElement;
    setRowMenu(null);
    if (!active || active === document.body) fallbackFocus(rail.current)?.focus();
  }, [menuGone]);
  const closeRowMenu = (refocus: boolean) => {
    const row = rowMenu?.row;
    setRowMenu(null);
    if (refocus && row?.isConnected) row.focus();
  };
  /**
   * Set once an action has gone through, so focus moves after the render that shows its result: back to where the
   * action began while that is still in the page, else the current row, else the foot button. So an action from the
   * foot keeps focus on the foot, even a delete of the open project that opened another row. One from a row's menu
   * stays on that row, or lands on the current row once that one has left the rail.
   */
  const [refocus, setRefocus] = useState<{ opener: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    if (!refocus) return;
    const target = refocus.opener?.isConnected ? refocus.opener : (rail.current?.querySelector<HTMLElement>('a[aria-current="page"]') ?? foot.current);
    target?.focus();
  }, [refocus]);
  const run: Run = async (action, target, opener) => {
    if (await onAction(action, target)) setRefocus({ opener });
  };
  const runRename: RunRename = async (target, name, opener) => {
    if (await onRename(target, name)) setRefocus({ opener });
  };

  /** The rows' keys: the menu key, Alt with an arrow to reorder, a bare arrow, Home or End to move focus, Space to open. */
  const onRowKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>('a[data-tab]')];
    const at = rows.indexOf(e.target as HTMLAnchorElement);
    if (at < 0) return;
    // Shift+F10 or the Menu key opens the row's menu. Handled here too, in case the browser makes no contextmenu of it.
    if (isMenuKey(e)) {
      e.preventDefault();
      setRowMenu({ id: tabs[at].id, row: rows[at] });
      return;
    }
    const arrow = e.key.startsWith('Arrow');
    // Alt with an arrow moves an active row along the rail, without opening it. Always taken: Alt+Left is the browser's
    // Back, and the window routes by hash.
    if (arrow && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      const p = tabs[at];
      if (p.status !== 'active') return;
      const earlier = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
      if (earlier ? at > 0 : at + 1 < activeIds.length) {
        moved.current = p.id;
        onMove(p.id, earlier ? activeIds[at - 1] : (activeIds[at + 2] ?? null));
      }
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Space opens a row, as Enter does: a link does not take it natively.
    if (e.key === ' ') {
      e.preventDefault();
      onSelect(tabs[at].slug);
      return;
    }
    // The arrows, Home and End move focus and open nothing.
    const next = railStep(e.key, at, rows.length);
    if (next === null) return;
    e.preventDefault();
    rows[next].focus();
  };
  /** The views' keys: the same moves between the view buttons. Enter and Space are the button's own. */
  const onViewKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const next = railStep(e.key, buttons.indexOf(e.target as HTMLButtonElement), buttons.length);
    if (next === null) return;
    e.preventDefault();
    buttons[next].focus();
  };
  /** The anchor of the row under a drag event, and the row's project id; NaN for the foot, the head or nothing. */
  const rowUnder = (e: DragEvent) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-row]');
    const a = li?.querySelector<HTMLElement>(':scope > a[data-tab]') ?? null;
    return { a, id: a ? Number(a.dataset.tab) : NaN };
  };
  /** Over the rail while one of our rows drags: the slot under the pointer. The archived row and the empty rail mean the end. */
  const onDragOver = (e: DragEvent<HTMLUListElement>) => {
    if (!drag || !isRowDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const { a, id } = rowUnder(e);
    let slot: number | null = null;
    if (a && activeIds.includes(id)) {
      const r = a.getBoundingClientRect();
      const first = layout === 'column' ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
      slot = tabDropSlot(activeIds, id, first, drag.id);
    }
    if (slot !== drag.slot) setDrag({ id: drag.id, slot });
  };
  /** Out of the rail mid-drag: no line, as a drop there does nothing. */
  const onDragLeave = (e: DragEvent<HTMLUListElement>) => {
    if (drag && !list.current!.contains(e.relatedTarget as Node | null)) setDrag({ id: drag.id, slot: drag.id });
  };
  const select = (e: MouseEvent<HTMLAnchorElement>, slug: string) => {
    // Ctrl or Shift with the click, or a press other than the main one: the browser's own link (a new tab or window).
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    onSelect(slug);
  };

  if (!shown) return null;
  // The rows are one stop in the tab order: the one focused last, else the current row's, else the first row's.
  const stop = rowStop && rowStop.from === current && tabs.some((p) => p.slug === rowStop.slug) ? rowStop.slug : tabs.some((p) => p.slug === current) ? current : tabs[0]?.slug;
  // The views stop resets on a new view or a new project, whose list starts at its current view.
  const viewsStop = viewStop && viewStop.from === `${current}:${view}` ? viewStop.view : view;
  const lastActive = activeIds[activeIds.length - 1];
  return (
    <nav className="ip-rail" aria-label="Projects" data-layout={layout} ref={rail}>
      <Eyebrow glyph="//" className="ip-rail-head">
        <span className="ip-rail-head-text">Projects</span>
      </Eyebrow>
      {tabs.length > 0 && (
        <ul
          className="ip-rail-rows"
          ref={list}
          onKeyDown={onRowKey}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={(e) => {
            if (!drag || !isRowDrag(e)) return;
            e.preventDefault();
            // The press focused the dragged row, and moving it in the DOM can drop that focus.
            if (changes && document.activeElement === list.current?.querySelector(`[data-tab="${drag.id}"]`)) moved.current = drag.id;
            if (changes) onMove(drag.id, drag.slot);
            setDrag(null);
          }}
        >
          {tabs.map((p) => {
            const isArchived = p.status === 'archived';
            const isCurrent = p.slug === current;
            return (
              <li key={p.id} data-row>
                <a
                  href={`#/p/${p.slug}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  tabIndex={p.slug === stop ? 0 : -1}
                  data-tab={p.id}
                  className={`ip-rail-row${isArchived ? ' archived' : ''}${p.id === menuProject?.id && !menuGone ? ' menu-open' : ''}${drag?.id === p.id ? ' dragging' : ''}${changes && drag.slot === p.id ? ' drop-before' : ''}${changes && drag.slot === null && p.id === lastActive ? ' drop-after' : ''}`}
                  style={{ '--rr': `var(--hue-${p.id % 7})` } as CSSProperties}
                  draggable={!isArchived}
                  onFocus={() => setRowStop({ from: current, slug: p.slug })}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    // A link drags its address as text too, which a text field would take; only the row's own data goes.
                    e.dataTransfer.clearData();
                    e.dataTransfer.setData(ROW_DRAG, String(p.id));
                    setDrag({ id: p.id, slot: p.id });
                  }}
                  onDragEnd={() => setDrag(null)}
                  title={isArchived ? `${p.name} (archived)` : p.name}
                  aria-label={isArchived ? `${projectLabel(p)}, archived` : projectLabel(p)}
                  onClick={(e) => select(e, p.slug)}
                  // A right-click opens the row's menu without opening the project, and never the browser's own menu.
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setRowMenu({ id: p.id, row: e.currentTarget });
                  }}
                >
                  <span className="ip-rail-rule" />
                  <span className="ip-rail-name">{p.name}</span>
                  {isArchived && <Chip className="ip-rail-chip">ARCHIVED</Chip>}
                  <span className="ip-rail-code">{codes.get(p.id)}</span>
                  <Signals p={p} />
                </a>
                {isCurrent && (
                  <ul
                    className="ip-rail-views"
                    aria-label="Views"
                    onKeyDown={onViewKey}
                    onFocus={() => (inViews.current = true)}
                    onBlur={(e) => {
                      // A removed list reports a blur with nowhere to go; that is the switch the effect above answers.
                      if (e.currentTarget.isConnected) inViews.current = e.currentTarget.contains(e.relatedTarget as Node | null);
                    }}
                  >
                    {views.map((v) => (
                      <li key={v.view}>
                        <button
                          type="button"
                          className="ip-rail-view"
                          aria-current={v.view === view ? 'page' : undefined}
                          tabIndex={v.view === viewsStop ? 0 : -1}
                          onFocus={() => setViewStop({ from: `${current}:${view}`, view: v.view })}
                          title={viewTitle(v)}
                          aria-label={viewTitle(v)}
                          onClick={() => onView(v.view)}
                        >
                          <span className="ip-rail-vlabel">{v.label}</span>
                          <span className="ip-rail-vcode">{v.code}</span>
                          {v.count !== undefined && <span className="ip-rail-n">{v.unit ? `${v.count} ${v.unit}` : v.count}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rowMenu && menuProject && !menuGone && <RowMenu key={rowMenu.id} project={menuProject} row={rowMenu.row} rail={rail.current} onClose={closeRowMenu} run={run} runRename={runRename} />}
      {hasFoot && <FootMenu archived={archived} deleted={deleted} current={current} onSelect={onSelect} run={run} rail={rail} button={foot} />}
    </nav>
  );
}
