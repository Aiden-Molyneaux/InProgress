import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectSnapshot } from '../../src/core/types';
import { createFreshClient } from '../../src/mcp/client';
import { buildApp } from '../../src/server/app';
import { makeCtx } from '../helpers';

let base = '';
let home = '';
let close: () => Promise<unknown>;
const configuredHome = process.env.INPROGRESS_HOME;

beforeAll(async () => {
  const app = buildApp({ ctx: makeCtx(), token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
  // A data dir with no token yet, as on a first run before the server has written one.
  home = mkdtempSync(join(tmpdir(), 'ip-fresh-'));
  process.env.INPROGRESS_HOME = home;
});
afterAll(async () => {
  process.env.INPROGRESS_HOME = configuredHome;
  rmSync(home, { recursive: true, force: true });
  await close();
});

const writeToken = () => writeFileSync(join(home, 'token'), 'tok\n');

describe('createFreshClient', () => {
  it('picks up a token file written after it was created', async () => {
    const client = createFreshClient(base);
    await expect(client.post('/api/projects', { name: 'Early' })).rejects.toMatchObject({ status: 401 });
    writeToken();
    expect((await client.post<{ slug: string }>('/api/projects', { name: 'Late' })).slug).toBe('late');
  });

  it('passes each method and its call options through', async () => {
    writeToken();
    const client = createFreshClient(base);
    const lastActor = async () => (await client.get<ProjectSnapshot>('/api/projects/wired')).lastEvent?.actor;
    await client.post('/api/projects', { name: 'Wired' }, { actor: 'scribe:post' });
    expect(await lastActor()).toBe('scribe:post');
    await client.patch('/api/projects/wired', { description: 'Wiring check' }, { actor: 'scribe:patch' });
    expect(await lastActor()).toBe('scribe:patch');
    const binding = await client.post<{ id: number }>('/api/projects/wired/bindings', { path: 'C:/wired' }, { actor: 'scribe:bind' });
    await client.del(`/api/bindings/${binding.id}`, { actor: 'scribe:del' });
    expect(await lastActor()).toBe('scribe:del');
    expect(await client.text('/api/projects/wired/outline')).toContain('Project Wired');
  });
});
