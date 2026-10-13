import { DELETED_RETENTION_MS, PROJECT_NAME_MAX, type DeletedProject, type Project, type ProjectSnapshot, type ProjectSummary, type TreeNode } from '../../src/core/types';

/**
 * The window's own writes to a project: archive from a tab, unarchive and delete from a tab or ⋯, restore from ⋯. A
 * delete of an active project archives it in the same write.
 */
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

/**
 * What a rename field's text renames the project to: the text trimmed, when that is 1 to 120 characters (the server's
 * rule) and not the name it has now. Null otherwise, and the field does nothing.
 */
export function renamedTo(text: string, current: string): string | null {
  const name = text.trim();
  return name && name.length <= PROJECT_NAME_MAX && name !== current ? name : null;
}

/** The status line after a rename. */
export const renameMessage = (name: string): string => `Renamed to ${name}.`;

/** The project list with one project's name changed, as it stands once a rename has gone through, until the reload. */
export function patchName<P extends Pick<ProjectSummary, 'id' | 'name'>>(projects: P[], id: number, name: string): P[] {
  return projects.map((p) => (p.id === id ? { ...p, name } : p));
}

interface RenameableSnapshot {
  project: Pick<ProjectSnapshot['project'], 'id' | 'name' | 'rootNodeId'>;
  nodes: Pick<TreeNode, 'id' | 'title'>[];
}

/**
 * The open snapshot once project `id` is renamed to `name`, until the refresh that follows lands: the project's name
 * (the window title's) and its root step's title, which the server keeps the same. Another project's, or none, as is.
 */
export function renamedSnapshot<S extends RenameableSnapshot>(snapshot: S | null, id: number, name: string): S | null {
  if (!snapshot || snapshot.project.id !== id) return snapshot;
  const root = snapshot.project.rootNodeId;
  return { ...snapshot, project: { ...snapshot.project, name }, nodes: snapshot.nodes.map((n) => (n.id === root ? { ...n, title: name } : n)) };
}

/**
 * Archive's second line in a tab's menu: the live sessions it stops tracking (they keep running). Delete's confirm
 * says it too, since a delete archives an active project first.
 */
export function archiveNote(activeSessions: number): string | null {
  if (activeSessions <= 0) return null;
  return `Stops tracking ${activeSessions} ${activeSessions === 1 ? 'session' : 'sessions'}`;
}

/**
 * The project list as it stands once an action has gone through, until the reload that follows lands. A restored
 * project comes back at once as `restored`, the server's answer: left to the reload, ⋯ would close in between when
 * the project was its only row, and focus would fall elsewhere. One the list already holds stays as it is.
 */
export function patchProjects<P extends Pick<ProjectSummary, 'id' | 'status'>>(projects: P[], action: ProjectAction, id: number, restored?: P): P[] {
  switch (action) {
    case 'archive':
    case 'unarchive': {
      const status = action === 'archive' ? 'archived' : 'active';
      return projects.map((p) => (p.id === id ? { ...p, status } : p));
    }
    case 'delete':
      return projects.filter((p) => p.id !== id);
    case 'restore':
      return restored && !projects.some((p) => p.id === id) ? [...projects, restored] : projects;
  }
}

/** A project the server answered with, as the list holds it until the reload brings its counts: none of them yet. */
export function summaryOf(project: Project): ProjectSummary {
  return { ...project, openAsks: 0, permissionWaits: 0, activeSessions: 0, workingSessions: 0, busySessions: 0, lastEventAt: null };
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
