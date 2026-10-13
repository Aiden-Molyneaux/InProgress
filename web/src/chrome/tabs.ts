import type { DeletedProject, ProjectSummary } from '../../../src/core/types';
import { loadJson, save } from '../storage';

type Listed = Pick<ProjectSummary, 'id' | 'slug' | 'status'>;

const oldestFirst = (a: Listed, b: Listed) => a.id - b.id;

/**
 * The tab strip's projects: every active one, then an archived project that is open (at the end, for as long as it stays
 * open). Active projects with a place in `order` (Aiden's dragged order) come first, in that order; the rest follow,
 * oldest first, so a new or unarchived project lands at the end and a tab never moves when another project gets busy
 * (the server lists the busiest first). Ids in `order` that are not active projects are ignored.
 */
export function projectTabs<P extends Listed>(projects: P[], current: string | null, order: number[] = []): P[] {
  const place = (p: Listed) => {
    const at = order.indexOf(p.id);
    return at < 0 ? Infinity : at;
  };
  const tabs = projects.filter((p) => p.status === 'active').sort((a, b) => place(a) - place(b) || oldestFirst(a, b));
  const openArchived = projects.find((p) => p.slug === current && p.status !== 'active');
  return openArchived ? [...tabs, openArchived] : tabs;
}

/**
 * The active tab ids with `id` moved before the tab `before` (null: after the last active tab). The archived tab is
 * neither moved nor counted. A `before` that is `id` itself leaves the order as it is.
 */
export function moveTab(tabs: Listed[], id: number, before: number | null): number[] {
  const ids = tabs.filter((t) => t.status === 'active').map((t) => t.id);
  if (!ids.includes(id) || before === id) return ids;
  const rest = ids.filter((i) => i !== id);
  const at = before === null ? -1 : rest.indexOf(before);
  if (at < 0) rest.push(id);
  else rest.splice(at, 0, id);
  return rest;
}

/**
 * Where a drop over a tab lands, as `dropSlot` does for the Next column but sideways: before the tab when the pointer is
 * in its left half, else before the active tab after it (null: the end). A slot that is the dragged tab itself reads as
 * the tab after the dragged one, so the drop changes nothing. `activeIds` is the active tabs' order.
 */
export function tabDropSlot(activeIds: number[], overId: number, leftHalf: boolean, dragging: number): number | null {
  const at = activeIds.indexOf(overId);
  if (at < 0) return null;
  const slot = leftHalf ? overId : (activeIds[at + 1] ?? null);
  if (slot !== dragging) return slot;
  return activeIds[activeIds.indexOf(dragging) + 1] ?? null;
}

/** The stored order without the projects that left the active list (archived or deleted), so they return at the end. */
export function pruneOrder(order: number[], projects: Listed[], deleted: Pick<DeletedProject, 'id'>[]): number[] {
  const gone = new Set([...projects.filter((p) => p.status !== 'active').map((p) => p.id), ...deleted.map((d) => d.id)]);
  return order.filter((id) => !gone.has(id));
}

const TAB_ORDER_KEY = 'ip.tabOrder';

/** The stored tab order: the positive whole numbers in it, first occurrence of each. Anything else gives []. */
export function loadTabOrder(): number[] {
  const raw = loadJson<unknown>(TAB_ORDER_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((id, i): id is number => Number.isInteger(id) && id > 0 && raw.indexOf(id) === i);
}

export function saveTabOrder(ids: number[]): void {
  save(TAB_ORDER_KEY, JSON.stringify(ids));
}

/**
 * The project to open when the current one leaves the list: the current one while it is listed, else the first active
 * project in the server's order (the busiest), else the first listed one.
 */
export function pickSlug(projects: Listed[], current: string | null): string | null {
  if (current && projects.some((p) => p.slug === current)) return current;
  return (projects.find((p) => p.status === 'active') ?? projects[0])?.slug ?? null;
}

/**
 * Where the window goes when a tab's project leaves the strip (archived or deleted while open): the tab to its right,
 * else the one to its left, as a browser does when a tab closes. Null for a lone tab or a slug with no tab.
 */
export function neighbourTab(tabs: Pick<ProjectSummary, 'slug'>[], slug: string | null): string | null {
  const at = tabs.findIndex((t) => t.slug === slug);
  if (at < 0) return null;
  return (tabs[at + 1] ?? tabs[at - 1])?.slug ?? null;
}

/** What the ⋯ menu lists: the archived projects, oldest first. */
export function archivedProjects<P extends Listed>(projects: P[]): P[] {
  return projects.filter((p) => p.status === 'archived').sort(oldestFirst);
}

/**
 * The ⋯ menu's Recently deleted rows: the most recently deleted first, without any past its purge time (the purge runs
 * every few hours, so one can outstay it a little).
 */
export function recentlyDeleted<D extends Pick<DeletedProject, 'id' | 'deletedAt' | 'purgeAt'>>(deleted: D[], now: number): D[] {
  return deleted
    .filter((d) => Date.parse(d.purgeAt) > now)
    .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt) || b.id - a.id);
}

/**
 * The tab `step` places on from the current one (`]` is 1, `[` is -1), wrapping round at either end. With no current
 * tab, `]` starts from the first and `[` from the last.
 */
export function stepTab(tabs: Pick<ProjectSummary, 'slug'>[], current: string | null, step: 1 | -1): string | null {
  if (!tabs.length) return null;
  const at = tabs.findIndex((t) => t.slug === current);
  const from = at >= 0 ? at : step > 0 ? -1 : tabs.length;
  return tabs[(from + step + tabs.length) % tabs.length].slug;
}

/** A tab's count (spec 2.1): the project's open asks plus its sessions waiting on a permission. */
export const waitingOn = (p: Pick<ProjectSummary, 'openAsks' | 'permissionWaits'>): number => p.openAsks + p.permissionWaits;

/**
 * A tab's or a ⋯ row's accessible name: the full name, then what its badges show. The dot shows while a session works
 * there (`working`, a pulsing dot) or is busy on a running worker or command of its own (`busy`, a still dot).
 */
export function projectLabel(p: Pick<ProjectSummary, 'name' | 'openAsks' | 'permissionWaits' | 'workingSessions' | 'busySessions'>): string {
  const activity = p.workingSessions > 0 ? 'working' : p.busySessions > 0 ? 'busy' : null;
  const waiting = waitingOn(p);
  return [p.name, waiting > 0 && `${waiting} need you`, activity].filter(Boolean).join(', ');
}
