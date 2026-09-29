import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClientError, createClient } from '../../src/lib/client';
import { ensureServer, isServerUp } from '../../src/lib/ensure-server';
import { homeDir } from '../../src/lib/home';
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

  it('records why nothing answered: a refused connection, or a timeout that may follow an applied write', async () => {
    let closedPort = 0;
    await withRawServer(() => undefined, async (url) => {
      closedPort = Number(new URL(url).port);
      const timedOut = (await createClient({ baseUrl: url, timeoutMs: 200 }).post('/api/projects', { name: 'x' }).catch((e) => e)) as ApiClientError;
      expect(timedOut).toMatchObject({ status: 0, code: 'TIMEOUT' });
    });
    const refused = (await createClient({ baseUrl: `http://127.0.0.1:${closedPort}`, timeoutMs: 2000 }).get('/api/health').catch((e) => e)) as ApiClientError;
    expect(refused).toMatchObject({ status: 0, code: 'ECONNREFUSED' });
  });

  it('reports an unreachable server clearly', async () => {
    const err = (await createClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 }).get('/api/health').catch((e) => e)) as ApiClientError;
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.status).toBe(0);
    expect(err.message).toContain('unreachable');
  });
});

/** A plain HTTP server standing in for a misbehaving InProgress server. */
async function withRawServer(handler: RequestListener, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const HINT = 'Run `inprogress start`, or `inprogress doctor` to diagnose.';

describe('client failures past the headers', () => {
  it('wraps a response body that breaks off in ApiClientError', async () => {
    await withRawServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
        res.write('{"slug":');
        setTimeout(() => res.destroy(), 20);
      },
      async (url) => {
        const err = await createClient({ baseUrl: url }).get('/api/projects').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiClientError);
        expect(err).toMatchObject({ status: 200, hint: HINT });
        expect((err as ApiClientError).message).toMatch(new RegExp(`^InProgress server at ${url} broke off its answer to GET /api/projects \\(.+\\)$`));
      },
    );
  });

  it('wraps a success response that is not JSON in ApiClientError', async () => {
    await withRawServer(
      (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>a proxy page</html>'),
      async (url) => {
        const err = await createClient({ baseUrl: url }).post('/api/projects', { name: 'x' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiClientError);
        expect(err).toMatchObject({ status: 200, hint: HINT, message: `InProgress server at ${url} answered POST /api/projects with something that is not JSON` });
        // Text reads have nothing to parse.
        expect(await createClient({ baseUrl: url }).text('/api/projects/x/outline')).toBe('<html>a proxy page</html>');
      },
    );
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

  it('spawns the server in its data dir with an absolute INPROGRESS_HOME', async () => {
    // Windows locks a process's cwd, so a server left running in the caller's folder would pin it.
    // A stand-in entry records where it ran (written then renamed, so it is never read half-written).
    const dir = mkdtempSync(join(tmpdir(), 'ip-entry-'));
    const entry = join(dir, 'probe.cjs');
    const seen = join(dir, 'seen.json');
    writeFileSync(
      entry,
      "const fs = require('node:fs');\n" +
        "fs.writeFileSync(__dirname + '/seen.tmp', JSON.stringify({ cwd: process.cwd(), home: process.env.INPROGRESS_HOME }));\n" +
        "fs.renameSync(__dirname + '/seen.tmp', __dirname + '/seen.json');\n",
    );
    try {
      expect(await ensureServer({ baseUrl: 'http://127.0.0.1:1', entry, waitMs: 200 })).toBe(false);
      for (let i = 0; i < 50 && !existsSync(seen); i++) await new Promise((r) => setTimeout(r, 100));
      expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual({ cwd: homeDir(), home: homeDir() });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
