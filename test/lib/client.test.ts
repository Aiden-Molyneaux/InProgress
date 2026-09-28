import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClientError, createClient } from '../../src/lib/client';
import { ensureServer, isServerUp } from '../../src/lib/ensure-server';
import { buildApp } from '../../src/server/app';
import { makeCtx } from '../helpers';

let base = '';
let close: () => Promise<unknown>;

beforeAll(async () => {
  const app = buildApp({ ctx: makeCtx(), token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
});
afterAll(() => close());

describe('client', () => {
  it('sends the token and actor, and parses JSON and text', async () => {
    const c = createClient({ baseUrl: base, token: 'tok' });
    const p = await c.post<{ slug: string; rootNodeId: number }>('/api/projects', { name: 'Client' }, { actor: 'scribe:s9' });
    expect(p.slug).toBe('client');
    expect(await c.text('/api/projects/client/outline')).toContain('Project Client');
    expect((await c.get<{ slug: string }[]>('/api/projects')).map((x) => x.slug)).toContain('client');
  });

  it('surfaces server errors with their hint', async () => {
    const c = createClient({ baseUrl: base, token: 'tok' });
    await expect(c.get('/api/projects/missing')).rejects.toMatchObject({ status: 404, message: 'Project "missing" not found' });
    await expect(createClient({ baseUrl: base }).post('/api/projects', { name: 'x' })).rejects.toMatchObject({ status: 401 });
  });

  it('reports an unreachable server clearly', async () => {
    const err = (await createClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 }).get('/api/health').catch((e) => e)) as ApiClientError;
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.status).toBe(0);
    expect(err.message).toContain('unreachable');
  });
});

describe('ensureServer', () => {
  it('returns true without spawning when the server is up', async () => {
    expect(await isServerUp(base)).toBe(true);
    expect(await ensureServer({ baseUrl: base, entry: 'does-not-exist.js' })).toBe(true);
  });

  it('gives up after waitMs when the spawned server never answers', async () => {
    expect(await isServerUp('http://127.0.0.1:1')).toBe(false);
    const started = Date.now();
    expect(await ensureServer({ baseUrl: 'http://127.0.0.1:1', entry: 'does-not-exist.js', waitMs: 400 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
