import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { portState, reportStartupFailure } from '../../src/server/startup';

const dirs: string[] = [];
function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ip-start-'));
  dirs.push(dir);
  return join(dir, 'server.log');
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('reportStartupFailure', () => {
  it('exits quietly when another InProgress server answers (this start lost a race)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = logFile();
    expect(await reportStartupFailure(new Error('table projects already exists'), log, async () => true)).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it('otherwise writes one clear line to server.log and stderr, and exits 1', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = logFile();
    const err = new Error('InProgress database schema v9 is newer than this build (v1);\nupdate InProgress');
    expect(await reportStartupFailure(err, log, async () => false)).toBe(1);
    const line = 'InProgress: the server did not start: InProgress database schema v9 is newer than this build (v1); update InProgress';
    expect(readFileSync(log, 'utf8')).toMatch(new RegExp(`^\\S+ ${line.replace(/[.()]/g, '\\$&')}\\n$`));
    expect(errors.mock.calls).toEqual([[line]]);
  });

  it('writes the line once when stderr already goes to server.log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = logFile();
    const fd = openSync(log, 'a');
    try {
      expect(await reportStartupFailure(new Error('boom'), log, async () => false, fd)).toBe(1);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(log, 'utf8')).toBe('');
    expect(errors.mock.calls).toEqual([['InProgress: the server did not start: boom']]);
  });
});

describe('portState', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  /** An HTTP server on a free port that answers every request with this JSON body; returns its base URL. */
  async function answering(body: object): Promise<string> {
    const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  /** A port that was free a moment ago. */
  async function freeUrl(): Promise<string> {
    const url = await answering({});
    await new Promise((r) => servers.pop()!.close(r));
    return url;
  }

  it('answers "free" for a port nothing listens on, without an HTTP request (a cold start skips loading fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await portState(await freeUrl())).toBe('free');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers "inprogress" when an InProgress server holds the port', async () => {
    expect(await portState(await answering({ app: 'inprogress' }))).toBe('inprogress');
  });

  it('answers "other" when another program holds the port', async () => {
    expect(await portState(await answering({ app: 'something-else' }))).toBe('other');
  });
});
