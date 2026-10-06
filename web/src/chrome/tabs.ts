import type { DeletedProject, ProjectSummary } from '../../../src/core/types';

type Listed = Pick<ProjectSummary, 'id' | 'slug' | 'status'>;

const oldestFirst = (a: Listed, b: Listed) => a.id - b.id;

/**
 * The tab strip's projects: every active one, oldest first, so a tab never moves when another project gets busy (the
 * server lists the busiest first). An archived project that is open gets a tab at the end for as long as it stays open.
 */
export function projectTabs<P extends Listed>(projects: P[], current: string | null): P[] {
  const tabs = projects.filter((p) => p.status === 'active').sort(oldestFirst);
  const openArchived = projects.find((p) => p.slug === current && p.status !== 'active');
  return openArchived ? [...tabs, openArchived] : tabs;
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

/** A tab's or a ⋯ row's accessible name: the full name, then what its badges show. */
export function projectLabel(p: Pick<ProjectSummary, 'name' | 'needsYou' | 'workingSessions'>): string {
  return [p.name, p.needsYou > 0 && `${p.needsYou} need you`, p.workingSessions > 0 && 'working'].filter(Boolean).join(', ');
}
