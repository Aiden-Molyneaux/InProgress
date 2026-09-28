import type { EventRow, NodeDetail, ProjectSnapshot, ProjectSummary, Resource } from '../../src/core/types';

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
  projects: () => getJson<ProjectSummary[]>('/api/projects'),
  project: (slug: string) => getJson<ProjectSnapshot>(`/api/projects/${encodeURIComponent(slug)}`),
  node: (id: number) => getJson<NodeDetail>(`/api/nodes/${id}`),
  resource: (id: number) => getJson<Resource>(`/api/resources/${id}`),
  /** 'reload' means the server restarted with a new UI token. */
  async openResource(id: number): Promise<'opened' | 'reload' | string> {
    const res = await fetch('/api/ui/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ip-ui-token': uiToken() },
      body: JSON.stringify({ resourceId: id }),
    });
    if (res.ok) return 'opened';
    if (res.status === 401) return 'reload';
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  },
};

/** Live events. Reconnects after errors and replays what was missed via ?since. */
export function subscribe(onEvent: (e: EventRow) => void, onStatus: (s: 'open' | 'reconnecting') => void): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let lastId: number | undefined;
  let timer = 0;
  const connect = () => {
    source = new EventSource(lastId === undefined ? '/api/events/stream' : `/api/events/stream?since=${lastId}`);
    source.onopen = () => onStatus('open');
    source.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as EventRow;
      lastId = e.id;
      onEvent(e);
    };
    source.onerror = () => {
      onStatus('reconnecting');
      source?.close();
      if (!closed) timer = window.setTimeout(connect, 1500);
    };
  };
  connect();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    source?.close();
  };
}
