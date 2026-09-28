import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from './home';

export async function isServerUp(baseUrl: string, timeoutMs = 300): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { app?: string };
    return body.app === 'inprogress';
  } catch {
    return false;
  }
}

/** dist/server/main.js, resolved from the bundled entry that calls this (dist/<dir>/<file>.js). */
export function serverEntry(): string {
  return fileURLToPath(new URL('../server/main.js', import.meta.url));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the server detached if it is not answering, then wait up to `waitMs` for health. */
export async function ensureServer(o: { baseUrl: string; entry?: string; waitMs?: number }): Promise<boolean> {
  if (await isServerUp(o.baseUrl)) return true;
  const home = homeDir();
  mkdirSync(home, { recursive: true });
  const out = openSync(join(home, 'server.log'), 'a');
  try {
    const child = spawn(process.execPath, [o.entry ?? serverEntry()], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env });
    child.on('error', () => undefined);
    child.unref();
  } finally {
    closeSync(out);
  }
  const deadline = Date.now() + (o.waitMs ?? 2000);
  while (Date.now() < deadline) {
    await sleep(100);
    if (await isServerUp(o.baseUrl, 200)) return true;
  }
  return false;
}
