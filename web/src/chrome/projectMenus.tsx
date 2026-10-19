import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { PROJECT_NAME_MAX, type DeletedProject, type ProjectSummary } from '../../../src/core/types';
import { Button } from '../parts/Button';
import { Confirm } from '../parts/Confirm';
import { Eyebrow } from '../parts/Eyebrow';
import { Field } from '../parts/Field';
import { LiveDot } from '../parts/LiveDot';
import { MenuItem } from '../parts/Menu';
import { archiveNote, renamedTo, type ActionTarget, type ProjectAction } from '../projectActions';
import { daysLeftLabel } from '../time';
import { menuStep } from './menu';
import { footMenuAt, rowMenuAt } from './railLogic';
import { waitingOn, projectLabel } from './tabs';

/**
 * Runs an action picked in a menu. When it goes through, focus goes back to the element that opened the menu if it is
 * still there, else to the current row, else to the rail's foot button.
 */
export type Run = (action: ProjectAction, target: ActionTarget, opener: HTMLElement | null) => void;

/** Runs a rename saved in a row's menu, focus moving afterwards as for Run. */
export type RunRename = (target: ActionTarget, name: string, opener: HTMLElement | null) => void;

/** The project a Delete… item asks about. Its live sessions, which the delete stops tracking, give the confirm a line. */
type Confirming = ActionTarget & Pick<ProjectSummary, 'activeSessions'>;

/** Which way the rail runs: a column at the left of the page, or the strip under 720 px. */
export type RailLayout = 'column' | 'strip';

/** The layout the rail element says it is in. */
const layoutOf = (rail: HTMLElement | null): RailLayout => (rail?.dataset.layout === 'strip' ? 'strip' : 'column');

/**
 * A project's signals: how many asks and permission waits wait on Aiden (waitingOn) as a volt count, and a LiveDot
 * while a session works in the project or waits on a running worker or command of its own (busySessions). The dot
 * blinks while a session works and is still when sessions are only busy.
 */
export function Signals({ p }: { p: ProjectSummary }) {
  const waiting = waitingOn(p);
  if (waiting === 0 && p.busySessions === 0) return null;
  return (
    <span className="ip-rail-sig">
      {waiting > 0 && <span className="ip-rail-ask">{waiting}</span>}
      {p.busySessions > 0 && <LiveDot still={p.workingSessions === 0} />}
    </span>
  );
}

/** Shift+F10 or the Menu key: the keyboard's way to a row's menu, as a right-click is the mouse's. */
export const isMenuKey = (e: KeyboardEvent) => (e.key === 'F10' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) || e.key === 'ContextMenu';

/** The rename field's project: its name now, and what Enter does with the text. */
interface Renaming {
  name: string;
  onSave: (text: string) => void;
}

interface MenuSurfaceProps {
  surface: RefObject<HTMLDivElement>;
  id?: string;
  className: string;
  style?: { top: number; left: number };
  /** The menu's name: its own (a row's menu), or the button that opens it (the foot's). */
  label?: string;
  labelledBy?: string;
  /** The item focus starts on. */
  start: 'first' | 'last';
  /** While set, the delete confirm stands in for the items, on the same surface. */
  confirm: Confirming | null;
  onDelete: () => void;
  /** While set, the rename field stands in for the items, on the same surface (a row's menu only). */
  rename?: Renaming | null;
  /** Back from the confirm or the rename field to the items, focus on the item that asked. */
  onCancel: () => void;
  /** Closes the menu. With `refocus`, focus goes back to whatever opened it; otherwise it stays where it went. */
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}

/**
 * The rename field: the name selected, so typing replaces it. Enter saves; Escape (MenuSurface's) and a blur cancel.
 * Up to 120 characters, the server's rule.
 */
function RenameField({ rename, onCancel }: { rename: Renaming; onCancel: () => void }) {
  const [text, setText] = useState(rename.name);
  return (
    <Field
      size="sm"
      aria-label={`Rename ${rename.name}`}
      value={text}
      maxLength={PROJECT_NAME_MAX}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        // Enter that ends an IME composition picks the characters; it is not the save.
        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        rename.onSave(text);
      }}
      onBlur={onCancel}
    />
  );
}

/** The menu items of a surface, in order. */
const itemsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="menuitem"]')];

/** An item's identity across a re-render: the project and action a foot menu button carries, else null. */
const keyOf = (el: HTMLElement) => (el.dataset.project ? `${el.dataset.project}:${el.dataset.act}` : null);

/** Where focus goes when a menu closes under it and its opener is gone: the current row, else the rail's foot button. */
export function fallbackFocus(rail: HTMLElement | null): HTMLElement | null {
  return rail?.querySelector<HTMLElement>('a[aria-current="page"]') ?? rail?.querySelector<HTMLElement>('.ip-rail-foot button') ?? null;
}

/**
 * Closes a menu without refocus when the window resizes, the rail scrolls (a scroll that landed before the menu opened,
 * a click bringing its row into view, is not one that moves it away) or a press lands outside `inside` (the surface by
 * default). A resize or a scroll that takes focus from inside the surface sends it to `opener` rather than the body.
 */
function useDismiss({ surface, rail, inside, active = true, onClose, opener }: {
  surface: RefObject<HTMLElement>;
  rail: HTMLElement | null;
  inside?: RefObject<HTMLElement>;
  active?: boolean;
  onClose: (refocus: boolean) => void;
  opener: () => HTMLElement | null;
}): void {
  const latest = useRef({ onClose, opener });
  latest.current = { onClose, opener };
  useEffect(() => {
    if (!active) return;
    const from = { left: rail?.scrollLeft ?? 0, top: rail?.scrollTop ?? 0 };
    const away = () => {
      const had = surface.current?.contains(document.activeElement) ?? false;
      latest.current.onClose(false);
      if (had) latest.current.opener()?.focus();
    };
    const scrolled = () => rail && (rail.scrollLeft !== from.left || rail.scrollTop !== from.top) && away();
    const outside = (e: MouseEvent) => !(inside ?? surface).current?.contains(e.target as Node) && latest.current.onClose(false);
    rail?.addEventListener('scroll', scrolled);
    window.addEventListener('resize', away);
    window.addEventListener('mousedown', outside);
    return () => {
      rail?.removeEventListener('scroll', scrolled);
      window.removeEventListener('resize', away);
      window.removeEventListener('mousedown', outside);
    };
  }, [rail, active]);
}

/**
 * What a row's menu and the foot's menu share: roving focus over the menuitems (Down and Up wrap, Home and End), Escape
 * back to the opener, closing when focus leaves, and the delete confirm or the rename field in place of the items.
 * Every key stays here: [ ] 1-9 and Escape are the app's own keys otherwise, and would act under the open
 * menu (or, in the rename field, take the typing).
 */
function MenuSurface(props: MenuSurfaceProps) {
  const { surface, id, className, style, label, labelledBy, start, confirm, onDelete, rename = null, onCancel, onClose, children } = props;
  const mode = confirm ? 'confirm' : rename ? 'rename' : 'items';
  /** The live sessions a delete stops tracking, as Archive's line says it: a delete archives an active project first. */
  const note = confirm && archiveNote(confirm.activeSessions);
  /**
   * The item last focused, so a cancel from the confirm or the field puts focus back on the item that asked: found by its
   * data-project and data-act where it has them (the foot menu's, whose rows can change under the confirm), else by index.
   */
  const last = useRef<{ at: number; key: string | null } | null>(null);
  // On opening, focus the first (or last) item; in the confirm, its Delete, so Enter confirms; in the rename field, the whole name, so typing replaces it; back from
  // the confirm or the field, the item that asked. The Confirm part would focus Cancel, so its own focus is off.
  useLayoutEffect(() => {
    const el = surface.current!;
    if (mode === 'confirm') {
      el.querySelector<HTMLElement>('.p-btn[data-variant="danger"]')?.focus();
      return;
    }
    if (mode === 'rename') {
      const field = el.querySelector<HTMLInputElement>('input');
      field?.focus();
      field?.select();
      return;
    }
    const items = itemsOf(el);
    const asked = last.current;
    const back = asked === null ? undefined : ((asked.key === null ? undefined : items.find((el) => keyOf(el) === asked.key)) ?? items[asked.at]);
    last.current = null;
    (back ?? (start === 'last' ? items[items.length - 1] : items[0]))?.focus();
  }, [mode]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (mode !== 'items') onCancel();
      else onClose(true);
      return;
    }
    // In the confirm, Tab, Enter and Space do what they do on its two buttons; in the rename field, every key types.
    if (mode !== 'items') return;
    const items = itemsOf(e.currentTarget);
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
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (mode !== 'items') return;
    const at = itemsOf(e.currentTarget).indexOf(e.target as HTMLElement);
    if (at >= 0) last.current = { at, key: keyOf(e.target as HTMLElement) };
  };
  return (
    <div
      ref={surface}
      id={id}
      className={className}
      style={style}
      // The confirm and the rename field name themselves, so the surface around them is no menu and needs no name.
      role={mode === 'items' ? 'menu' : undefined}
      aria-label={mode === 'items' ? label : undefined}
      aria-labelledby={mode === 'items' ? labelledBy : undefined}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onFocus={onFocus}
      onContextMenu={(e) => e.preventDefault()}
    >
      {confirm ? (
        <Confirm
          question={`Delete ${confirm.name}?`}
          detail={`Hidden now, removed for good after 30 days. Restore it from Archived until then.${note ? ` ${note}` : ''}`}
          action="Delete"
          danger
          focusOnMount={false}
          onConfirm={onDelete}
          onCancel={onCancel}
        />
      ) : rename ? (
        <RenameField rename={rename} onCancel={onCancel} />
      ) : (
        children
      )}
    </div>
  );
}

/** The window's size, for placing a menu inside it. */
const windowSize = () => ({ width: window.innerWidth, height: window.innerHeight });

interface RowMenuProps {
  project: ProjectSummary;
  /** The row's element: the menu opens beside it. */
  row: HTMLElement;
  /** The rail, whose layout says where the menu opens and whose scrolling closes it. */
  rail: HTMLElement | null;
  onClose: (refocus: boolean) => void;
  run: Run;
  runRename: RunRename;
}

/**
 * A row's menu: Archive, Rename… and Delete… on an active project's row, Unarchive, Rename… and Delete… on the open
 * archived project's. Delete… on an active project archives and deletes it in one step, behind the same confirm.
 * Rename… turns the menu into a field holding the name: Enter saves a new one (the slug, so the project's links, stays),
 * Escape goes back to the items, and leaving it cancels. The menu floats right of its row in the column and under it in
 * the strip, fixed and outside the rail (whose overflow would clip it), and closes when the rail scrolls either way or
 * the window resizes, since it would point at nothing.
 */
export function RowMenu({ project, row, rail, onClose, run, runRename }: RowMenuProps) {
  const surface = useRef<HTMLDivElement>(null);
  const noteId = useId();
  /**
   * What stands in for the items: Delete…'s confirm, or Rename…'s field. The confirm reads the project as it is now, so
   * its line follows the live sessions.
   */
  const [panel, setPanel] = useState<'confirm' | 'rename' | null>(null);
  const [at, setAt] = useState({ top: 0, left: 0 });
  // Beside its row, and wholly inside the window, measured again when the confirm changes its size.
  useLayoutEffect(() => {
    const s = surface.current!;
    setAt(rowMenuAt(row.getBoundingClientRect(), { width: s.offsetWidth, height: s.offsetHeight }, windowSize(), layoutOf(rail)));
  }, [row, rail, panel]);
  useDismiss({ surface, rail, onClose, opener: () => (row.isConnected ? row : fallbackFocus(rail)) });
  const choose = (action: ProjectAction) => {
    onClose(true);
    run(action, project, row);
  };
  /** Enter in the field. An empty name does nothing; the same name closes the menu with nothing to save. */
  const save = (text: string) => {
    const name = renamedTo(text, project.name);
    if (name === null) {
      if (text.trim() === project.name) onClose(true);
      return;
    }
    onClose(true);
    runRename(project, name, row);
  };
  const archived = project.status === 'archived';
  const note = archived ? null : archiveNote(project.activeSessions);
  return (
    <MenuSurface
      surface={surface}
      className="p-menu ip-rail-menu"
      style={at}
      label={project.name}
      start="first"
      confirm={panel === 'confirm' ? project : null}
      onDelete={() => choose('delete')}
      rename={panel === 'rename' ? { name: project.name, onSave: save } : null}
      onCancel={() => setPanel(null)}
      onClose={onClose}
    >
      {archived ? (
        <MenuItem onSelect={() => choose('unarchive')}>Unarchive</MenuItem>
      ) : (
        // No confirm: Unarchive undoes it. The live sessions it stops tracking keep running, and the note says so.
        // MenuItem's markup with a name of its own: "Archive", the sessions line as its description.
        <button type="button" role="menuitem" className="p-menu-item" tabIndex={-1} aria-label="Archive" aria-describedby={note ? noteId : undefined} onClick={() => choose('archive')}>
          <span className="p-menu-cur" aria-hidden="true" />
          <span className="p-menu-label">
            Archive
            {note && (
              <span id={noteId} className="ip-rail-note">
                {note}
              </span>
            )}
          </span>
        </button>
      )}
      <MenuItem onSelect={() => setPanel('rename')}>Rename…</MenuItem>
      <MenuItem danger onSelect={() => setPanel('confirm')}>
        Delete…
      </MenuItem>
    </MenuSurface>
  );
}

interface FootMenuProps {
  archived: ProjectSummary[];
  deleted: DeletedProject[];
  current: string | null;
  onSelect: (slug: string) => void;
  run: Run;
  /** The rail, whose layout says where the menu opens and whose scrolling closes it. */
  rail: RefObject<HTMLElement>;
  /** The foot button's ref, for the rail to give focus back to. */
  button: RefObject<HTMLButtonElement>;
}

/**
 * The rail foot and its menu: the archived projects (open one, unarchive it, delete it), then the recently deleted ones
 * (restore one, with the days it has left). The button reads `Archived · n`; under 720 px it shows `⋯` and keeps that
 * name. The menu is fixed above the button in the column and under it in the strip.
 */
export function FootMenu({ archived, deleted, current, onSelect, run, rail, button }: FootMenuProps) {
  const ids = useId();
  /** Where focus starts when the menu is open: ArrowUp on the button starts at the last item. */
  const [open, setOpen] = useState<'first' | 'last' | null>(null);
  const [confirm, setConfirm] = useState<Confirming | null>(null);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  /** Closes the menu. With `refocus`, focus goes back to the button rather than falling to the page with the item that had it. */
  const shut = (refocus: boolean) => {
    setOpen(null);
    setConfirm(null);
    if (refocus) button.current?.focus();
  };
  useDismiss({ surface, rail: rail.current, inside: wrap, active: open !== null, onClose: shut, opener: () => button.current });
  // Measured with the menu in the page and before it paints; again when the confirm changes its size.
  useLayoutEffect(() => {
    if (!open || !surface.current || !button.current) return;
    const s = surface.current;
    setAt(footMenuAt(button.current.getBoundingClientRect(), { width: s.offsetWidth, height: s.offsetHeight }, windowSize(), layoutOf(rail.current)));
  }, [open, confirm, archived.length, deleted.length]);
  // Enter and Space click the button, which opens on the first item; Down opens on the first too, and Up on the last.
  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const start = e.key === 'ArrowUp' ? 'last' : 'first';
    if (!open) return setOpen(start);
    const items = surface.current ? itemsOf(surface.current) : [];
    items[start === 'last' ? items.length - 1 : 0]?.focus();
  };
  const act = (action: ProjectAction, target: ActionTarget) => {
    shut(true);
    run(action, target, button.current);
  };
  const now = Date.now();
  return (
    <div className="ip-rail-foot" ref={wrap}>
      <Button
        ref={button}
        id={`${ids}b`}
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open ? `${ids}m` : undefined}
        // While open, a press on the button keeps focus in the menu, so the menu closes on the click rather than on the blur.
        onMouseDown={(e) => open && e.preventDefault()}
        onClick={() => (open ? shut(true) : setOpen('first'))}
        onKeyDown={onButtonKey}
      >
        <span className="ip-rail-foot-full">{`Archived · ${archived.length + deleted.length}`}</span>
        <span className="ip-rail-foot-short" aria-hidden="true">
          ⋯
        </span>
      </Button>
      {open && (
        <MenuSurface
          surface={surface}
          id={`${ids}m`}
          className="p-menu ip-rail-menu"
          style={at}
          labelledBy={`${ids}b`}
          start={open}
          confirm={confirm}
          onDelete={() => act('delete', confirm!)}
          onCancel={() => setConfirm(null)}
          onClose={shut}
        >
          {archived.length > 0 && (
            <div role="group" aria-labelledby={`${ids}a`}>
              <Eyebrow glyph="//" id={`${ids}a`} role="none" className="ip-rail-menu-head">
                Archived
              </Eyebrow>
              {archived.map((p) => (
                <div key={p.id} role="none" className="ip-rail-menu-row">
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="ip-rail-open"
                    data-project={p.id}
                    data-act="open"
                    aria-current={p.slug === current || undefined}
                    title={p.name}
                    aria-label={projectLabel(p)}
                    onClick={() => {
                      shut(true);
                      onSelect(p.slug);
                    }}
                  >
                    <span className="ip-rail-open-name">{p.name}</span>
                    <Signals p={p} />
                  </button>
                  <button type="button" role="menuitem" tabIndex={-1} className="ip-rail-act" data-project={p.id} data-act="unarchive" aria-label={`Unarchive ${p.name}`} onClick={() => act('unarchive', p)}>
                    Unarchive
                  </button>
                  <button type="button" role="menuitem" tabIndex={-1} className="ip-rail-act" data-project={p.id} data-act="delete" aria-label={`Delete ${p.name}`} onClick={() => setConfirm(p)}>
                    Delete…
                  </button>
                </div>
              ))}
            </div>
          )}
          {archived.length > 0 && deleted.length > 0 && <div role="separator" className="p-menu-sep" />}
          {deleted.length > 0 && (
            <div role="group" aria-labelledby={`${ids}d`}>
              <Eyebrow glyph="//" id={`${ids}d`} role="none" className="ip-rail-menu-head">
                Recently deleted
              </Eyebrow>
              {deleted.map((d) => (
                <div key={d.id} role="none" className="ip-rail-menu-row">
                  {/* A deleted project cannot be opened, so its name is not an item. */}
                  <span className="ip-rail-open-name ip-rail-gone" title={d.name}>
                    {d.name}
                  </span>
                  <span className="ip-rail-left" id={`${ids}l${d.id}`}>
                    {daysLeftLabel(d.purgeAt, now)}
                  </span>
                  <button type="button" role="menuitem" tabIndex={-1} className="ip-rail-act" data-project={d.id} data-act="restore" aria-label={`Restore ${d.name}`} aria-describedby={`${ids}l${d.id}`} onClick={() => act('restore', d)}>
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
