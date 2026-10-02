import type { BuildInfo } from '../../src/core/build';
import type { NodeDetail, ProjectSnapshot, ProjectSummary, Resource } from '../../src/core/types';

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
  project: (slug: string) => getJson<ProjectSnapshot>(`/api/projects/${encodeURIComponent(slug)}`),
  node: (id: number) => getJson<NodeDetail>(`/api/nodes/${id}`),
  resource: (id: number) => getJson<Resource>(`/api/resources/${id}`),
  /** Never rejects. 'reload' means the server restarted with a new UI token; any other string is a message to show. */
  async openResource(id: number): Promise<'opened' | 'reload' | string> {
    let res: Response;
    try {
      res = await fetch('/api/ui/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ip-ui-token': uiToken() },
        body: JSON.stringify({ resourceId: id }),
      });
    } catch {
      return 'Could not reach the InProgress server. Is it still running?';
    }
    if (res.ok) return 'opened';
    if (res.status === 401) return 'reload';
    const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    const message = body.error ?? `HTTP ${res.status}`;
    return body.hint ? `${message}. ${body.hint}` : message;
  },
};
