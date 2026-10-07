import type { BuildInfo } from '../../src/core/build';
import type { DeletedProject, NodeDetail, Project, ProjectSnapshot, ProjectSummary, Resource } from '../../src/core/types';
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

/**
 * Never rejects. 'ok' means it was done; 'reload' means the server restarted with a new UI token; any other string is a
 * message for the user.
 */
async function postUi(path: string, body: unknown): Promise<'ok' | 'reload' | string> {
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
