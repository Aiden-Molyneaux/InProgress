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

const HINT = 'Run `inprogress start`, or `inprogress doctor` to diagnose.';

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
      throw new ApiClientError(0, `InProgress server unreachable at ${opts.baseUrl} (${(err as Error).message})`, HINT);
    }
    // Past this point the server has answered, so these failures keep its status (never 0, "unreachable"):
    // the request may have been carried out, and a caller must not take it for one that never arrived.
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new ApiClientError(res.status, `InProgress server at ${opts.baseUrl} broke off its answer to ${method} ${path} (${(err as Error).message})`, HINT);
    }
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
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiClientError(res.status, `InProgress server at ${opts.baseUrl} answered ${method} ${path} with something that is not JSON`, HINT);
    }
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
