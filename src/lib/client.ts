export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

export interface CallOptions {
  actor?: string;
  timeoutMs?: number;
}

export function createClient(opts: ClientOptions) {
  async function call(method: string, path: string, body: unknown, co: CallOptions, as: 'json' | 'text'): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (co.actor) headers['x-inprogress-actor'] = co.actor;
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(co.timeoutMs ?? opts.timeoutMs ?? 5000),
      });
    } catch (err) {
      throw new ApiClientError(0, `InProgress server unreachable at ${opts.baseUrl} (${(err as Error).message})`, 'Run `inprogress start`, or `inprogress doctor` to diagnose.');
    }
    const text = await res.text();
    if (!res.ok) {
      let payload: { error?: string; hint?: string } = {};
      try {
        payload = JSON.parse(text) as { error?: string; hint?: string };
      } catch {
        // not JSON
      }
      throw new ApiClientError(res.status, payload.error ?? `HTTP ${res.status}`, payload.hint);
    }
    if (as === 'text') return text;
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
  return {
    get: <T>(path: string, co: CallOptions = {}) => call('GET', path, undefined, co, 'json') as Promise<T>,
    text: (path: string, co: CallOptions = {}) => call('GET', path, undefined, co, 'text') as Promise<string>,
    post: <T>(path: string, body: unknown, co: CallOptions = {}) => call('POST', path, body ?? {}, co, 'json') as Promise<T>,
    patch: <T>(path: string, body: unknown, co: CallOptions = {}) => call('PATCH', path, body, co, 'json') as Promise<T>,
    del: <T>(path: string, co: CallOptions = {}) => call('DELETE', path, undefined, co, 'json') as Promise<T>,
  };
}

export type Client = ReturnType<typeof createClient>;
