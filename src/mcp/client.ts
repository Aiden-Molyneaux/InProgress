import { createClient, type CallOptions, type Client } from '../lib/client';
import { readToken } from '../lib/home';

/**
 * A Client that reads the token file on every call. On a first run the server writes the token
 * after this process starts, so a token read once at startup could stay missing for good.
 */
export function createFreshClient(baseUrl: string): Client {
  const fresh = () => createClient({ baseUrl, token: readToken() });
  return {
    get: <T>(path: string, co?: CallOptions) => fresh().get<T>(path, co),
    text: (path: string, co?: CallOptions) => fresh().text(path, co),
    post: <T>(path: string, body: unknown, co?: CallOptions) => fresh().post<T>(path, body, co),
    patch: <T>(path: string, body: unknown, co?: CallOptions) => fresh().patch<T>(path, body, co),
    del: <T>(path: string, co?: CallOptions) => fresh().del<T>(path, co),
  };
}
