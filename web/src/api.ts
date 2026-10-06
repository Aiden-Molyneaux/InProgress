import type { BuildInfo } from '../../src/core/build';
import type { DeletedProject, NodeDetail, ProjectSnapshot, ProjectSummary, Resource } from '../../src/core/types';
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
  /** Archive, unarchive, delete or restore, by id. The slug goes along so the server can refuse an id that a purge freed. */
  projectAction: (action: ProjectAction, p: ActionTarget) => postUi(`/api/ui/projects/${p.id}/${action}`, { slug: p.slug }),
};

/**
 * Never rejects. 'ok' means it was done; 'reload' means the server restarted with a new UI token; any other string is a
 * message for the user.
 */
async function postUi(path: string, body: unknown): Promise<'ok' | 'reload' | string> {
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
  if (res.ok) return 'ok';
  if (res.status === 401) return 'reload';
  const payload = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
  const message = payload.error ?? `HTTP ${res.status}`;
  return payload.hint ? `${message}. ${payload.hint}` : message;
}
