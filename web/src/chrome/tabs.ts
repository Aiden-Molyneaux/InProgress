import type { ProjectSummary } from '../../../src/core/types';

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

/** What the ⋯ menu lists: the archived projects, oldest first. */
export function archivedProjects<P extends Listed>(projects: P[]): P[] {
  return projects.filter((p) => p.status === 'archived').sort(oldestFirst);
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
