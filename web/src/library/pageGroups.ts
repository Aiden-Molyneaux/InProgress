import type { LibraryPage } from '../../../src/core/types';

export interface PageGroup {
  projectId: number;
  projectName: string;
  pages: LibraryPage[];
}

/**
 * The pages grouped by owning project: the source project (Shipwright) first, then the projects in the rail's order, then
 * any others by name. A page keeps the server's order inside its group.
 */
export function groupPages(pages: readonly LibraryPage[], sourceProjectId: number | null, railOrder: readonly number[]): PageGroup[] {
  const groups = new Map<number, PageGroup>();
  for (const page of pages) {
    const group = groups.get(page.projectId) ?? { projectId: page.projectId, projectName: page.projectName, pages: [] };
    group.pages.push(page);
    groups.set(page.projectId, group);
  }
  const rank = (id: number): number => (id === sourceProjectId ? -1 : railOrder.includes(id) ? railOrder.indexOf(id) : Number.MAX_SAFE_INTEGER);
  return [...groups.values()].sort((a, b) => rank(a.projectId) - rank(b.projectId) || a.projectName.localeCompare(b.projectName));
}

/** What a page's freshness says: nothing without covers, "confirm again" once the claim left history, else the count. */
export function freshText(fresh: number | null | undefined): { text: string; alarm: boolean } | null {
  if (fresh === undefined) return null;
  if (fresh === null) return { text: 'confirm again', alarm: false };
  return fresh === 0 ? { text: 'current', alarm: false } : { text: `${fresh} since confirmed`, alarm: true };
}
