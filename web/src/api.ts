import type { BuildInfo } from '../../src/core/build';
import type { StepHit } from '../../src/core/goto';
import type { DeletedProject, NodeDetail, Project, ProjectSnapshot, ProjectSummary, QueueOp, Resource } from '../../src/core/types';
import type { ActionTarget, ProjectAction } from './projectActions';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const uiToken = () => document.querySelector<HTMLMetaElement>('meta[name="ip-ui-token"]')?.content ?? '';

export const api = {
  health: () => getJson<{ build: BuildInfo | null }>('/api/health'),
  projects: () => getJson<ProjectSummary[]>('/api/projects'),
  /** Projects deleted in the last 30 days, the most recent first: Recently deleted in ⋯. */
  deletedProjects: () => getJson<DeletedProject[]>('/api/deleted-projects'),
  project: (slug: string) => getJson<ProjectSnapshot>(`/api/projects/${encodeURIComponent(slug)}`),
  node: (id: number) => getJson<NodeDetail>(`/api/nodes/${id}`),
  resource: (id: number) => getJson<Resource>(`/api/resources/${id}`),
  /**
   * The Go to field: the step an id names, or the steps whose titles hold the words, across projects, those of `here`
   * (the open project's slug) first within each tier.
   */
  find: (q: string, here: string | null) => getJson<StepHit[]>(`/api/find?q=${encodeURIComponent(q)}${here ? `&here=${encodeURIComponent(here)}` : ''}`),
  openResource: (id: number) => postUi('/api/ui/open', { resourceId: id }),
  /** Opens an http(s) link in the default browser: from the Edge app window a plain link would open in Edge. */
  openUrl: (url: string) => postUi('/api/ui/open-url', { url }),
  /**
   * Archive, unarchive, delete or restore, by id. The slug goes along so the server can refuse an id that a purge freed.
   * Done, it answers the project as it now stands, or null after a delete.
   */
  projectAction: async (action: ProjectAction, p: ActionTarget): Promise<{ project: Project | null } | 'reload' | string> => {
    const answer = await sendUi<{ project?: Project }>(`/api/ui/projects/${p.id}/${action}`, { slug: p.slug });
    return typeof answer === 'string' ? answer : { project: answer.project ?? null };
  },
  /** Renames a project, by id, the slug going along as for projectAction. Done, it answers the project as renamed. */
  renameProject: (p: ActionTarget, name: string) => sendUi<{ project: Project }>(`/api/ui/projects/${p.id}/rename`, { slug: p.slug, name }),
};

/** What a window write answers: 'ok' when it was done, 'reload' after a server restart, else a message for the user. */
export type UiResult = 'ok' | 'reload' | string;

/** The window's measurement events (spec 2.6). */
export type WindowEventName = 'view' | 'shown' | 'first_action' | 'backlog_open' | 'details_open';

/** One change to the project's Next queue (spec 2.5), applied on the server to the queue as it stands. */
export const queueOp = (projectId: number, slug: string, op: QueueOp): Promise<UiResult> => postUi(`/api/ui/projects/${projectId}/queue`, { slug, op });

/** Quick-add: a todo step under `parent`, or under the root when null. */
export const createStep = (projectId: number, slug: string, title: string, parent: number | null): Promise<UiResult> =>
  postUi(`/api/ui/projects/${projectId}/nodes`, { slug, title, parent });

/** Deletes a step from the tree, by id; the server refuses one with steps under it. */
export const deleteStep = (projectId: number, slug: string, nodeId: number): Promise<UiResult> =>
  postUi(`/api/ui/projects/${projectId}/nodes/${nodeId}/delete`, { slug });

/**
 * Marks a step done from its Now box. The outcome goes along only when it has text; `driver` is the live session the box
 * named (or null), which the server checks is still the one driving it.
 */
export const markDone = (projectId: number, slug: string, nodeId: number, outcome: string, driver: string | null): Promise<UiResult> =>
  postUi(`/api/ui/projects/${projectId}/nodes/${nodeId}/done`, { slug, driver, ...(outcome.trim() ? { outcome } : {}) });

/** What Open session answers: done; the command to run by hand (with why the server could not, when it says); or 'reload' after a server restart. */
export type OpenDesktopResult = { ok: true } | { ok: false; command: string; reason?: string } | 'reload';

/**
 * Opens a session in the Claude desktop app. When the server could not, the answer holds the command to copy, and the
 * reason: the server's own when it could not launch, else why the request failed (with a hint to run the command in the
 * session's folder, since the window builds that command without one). Never rejects.
 */
export async function openDesktop(sessionId: string): Promise<OpenDesktopResult> {
  const answer = await sendUi<{ ok: boolean; command?: string; reason?: string }>(`/api/ui/sessions/${encodeURIComponent(sessionId)}/open-desktop`, {});
  if (answer === 'reload') return 'reload';
  // The command the window builds itself has no folder in it, so the reason says where to run it.
  const own = (reason: string): OpenDesktopResult => ({ ok: false, command: `claude --desktop --resume ${sessionId}`, reason: `${/[.!?]$/.test(reason) ? reason : `${reason}.`} Run it in the session's folder.` });
  if (typeof answer === 'string') return own(answer);
  if (answer === null || typeof answer !== 'object') return own('The InProgress server gave an answer the window could not read.');
  if (answer.ok) return { ok: true };
  if (answer.command) return { ok: false, command: answer.command, reason: answer.reason };
  return own(answer.reason ?? 'Claude Code could not be opened.');
}

/** Clears an ask, with an answer when Aiden typed one. */
export const clearAsk = (askId: number, answer?: string): Promise<UiResult> => postUi(`/api/ui/asks/${askId}/clear`, answer === undefined ? {} : { answer });

/** A measurement: fire and forget, so a failure never reaches the user. */
export function postEvent(name: WindowEventName, projectId: number | null, data?: Record<string, string | number | boolean | null>): void {
  void postUi('/api/ui/events', { name, projectId, ...(data ? { data } : {}) });
}

/**
 * Never rejects. 'ok' means it was done; 'reload' means the server restarted with a new UI token; any other string is a
 * message for the user.
 */
async function postUi(path: string, body: unknown): Promise<UiResult> {
  const answer = await sendUi(path, body);
  return typeof answer === 'string' ? answer : 'ok';
}

/** postUi, answering with the server's answer when it was done. */
async function sendUi<T extends object>(path: string, body: unknown): Promise<T | 'reload' | string> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ip-ui-token': uiToken() },
      body: JSON.stringify(body),
    });
  } catch {
    return 'Could not reach the InProgress server. Is it still running?';
  }
  if (res.ok) return (await res.json().catch(() => ({}))) as T;
  if (res.status === 401) return 'reload';
  const payload = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
  const message = payload.error ?? `HTTP ${res.status}`;
  return payload.hint ? `${message}. ${payload.hint}` : message;
}
