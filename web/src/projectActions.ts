import { DELETED_RETENTION_MS, type DeletedProject, type ProjectSummary } from '../../src/core/types';

/** The window's own writes to a project: archive and unarchive from a tab or ⋯, delete and restore from ⋯. */
export type ProjectAction = 'archive' | 'unarchive' | 'delete' | 'restore';

/** The project an action is on: its id is the address, its slug a check that the id still means it. */
export type ActionTarget = Pick<ProjectSummary, 'id' | 'slug' | 'name'>;

/** The status line after an action: what happened, and where to find the project now. */
export function actionMessage(action: ProjectAction, name: string): string {
  switch (action) {
    case 'archive':
      return `Archived ${name}. It is under ⋯.`;
    case 'unarchive':
      return `${name} is back in the tabs.`;
    case 'delete':
      return `Deleted ${name}. Restore it from ⋯ within 30 days.`;
    case 'restore':
      return `Restored ${name}. It is under Archived in ⋯.`;
  }
}

/** Archive's second line in a tab's menu: the live sessions it stops tracking (they keep running). */
export function archiveNote(activeSessions: number): string | null {
  if (activeSessions <= 0) return null;
  return `Stops tracking ${activeSessions} ${activeSessions === 1 ? 'session' : 'sessions'}`;
}

/**
 * The project list as it stands once an action has gone through, until the reload that follows lands. A restored
 * project is not patched in: the list leaves deleted projects out, so the window has no summary of it to add.
 */
export function patchProjects<P extends Pick<ProjectSummary, 'id' | 'status'>>(projects: P[], action: ProjectAction, id: number): P[] {
  switch (action) {
    case 'archive':
    case 'unarchive': {
      const status = action === 'archive' ? 'archived' : 'active';
      return projects.map((p) => (p.id === id ? { ...p, status } : p));
    }
    case 'delete':
      return projects.filter((p) => p.id !== id);
    case 'restore':
      return projects;
  }
}

/** The Recently deleted list once an action has gone through: a delete goes first with its 30 days, a restore leaves. */
export function patchDeleted(deleted: DeletedProject[], action: ProjectAction, target: ActionTarget, now: number): DeletedProject[] {
  if (action === 'delete') {
    const row = { ...pick(target), deletedAt: new Date(now).toISOString(), purgeAt: new Date(now + DELETED_RETENTION_MS).toISOString() };
    return [row, ...deleted.filter((d) => d.id !== target.id)];
  }
  if (action === 'restore') return deleted.filter((d) => d.id !== target.id);
  return deleted;
}

const pick = ({ id, slug, name }: ActionTarget) => ({ id, slug, name });
