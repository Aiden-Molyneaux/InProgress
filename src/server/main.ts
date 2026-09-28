import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrl, ensureToken, homeDir, port as configuredPort } from '../lib/home';
import { VERSION } from '../lib/version';
import { buildApp } from './app';
import { backupDb, truncateIfLarge } from './backup';
import { openDb } from './db/connection';
import { createCtx } from './db/tx';

type Probe = 'inprogress' | 'other' | 'free';

async function probe(url: string): Promise<Probe> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = (await res.json().catch(() => null)) as { app?: string } | null;
    return body?.app === 'inprogress' ? 'inprogress' : 'other';
  } catch {
    return 'free';
  }
}

async function main(): Promise<void> {
  const home = homeDir();
  mkdirSync(home, { recursive: true });
  const port = configuredPort();
  const url = baseUrl(port);
  const first = await probe(url);
  if (first === 'inprogress') return;
  if (first === 'other') {
    console.error(`InProgress: port ${port} is used by another program. Set INPROGRESS_PORT to pick another port.`);
    process.exitCode = 1;
    return;
  }
  const logFile = join(home, 'server.log');
  truncateIfLarge(logFile, 5 * 1024 * 1024);
  const token = ensureToken(home);
  const db = openDb(join(home, 'inprogress.db'));
  const ctx = createCtx(db);
  let closing = false;
  const app = buildApp({
    ctx,
    token,
    uiToken: randomBytes(16).toString('hex'),
    version: VERSION,
    webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
    logger: { level: 'info', file: logFile },
    onShutdown: () => void shutdown(),
  });
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    await app.close().catch(() => undefined);
    db.close();
    rmSync(join(home, 'server.pid'), { force: true });
    process.exit(0);
  }
  try {
    await app.listen({ port, host: '127.0.0.1' });
  } catch (err) {
    db.close();
    // Two sessions starting together: whoever lost the race exits quietly if the winner is ours.
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await probe(url)) === 'inprogress') return;
    console.error(`InProgress: could not listen on ${port}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(join(home, 'server.pid'), String(process.pid));
  // Back up only once we own the port, so two racing starts never write the same backup file.
  await backupDb(db, join(home, 'backups'), 7).catch(() => undefined);
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
