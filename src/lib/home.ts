import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Data dir. A relative INPROGRESS_HOME is made absolute so child processes with another cwd agree. */
export function homeDir(): string {
  const configured = process.env.INPROGRESS_HOME;
  if (!configured) return join(homedir(), '.inprogress');
  return isAbsolute(configured) ? configured : resolve(configured);
}

export function port(): number {
  const value = Number(process.env.INPROGRESS_PORT);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 4317;
}

export function baseUrl(p: number = port()): string {
  return `http://127.0.0.1:${p}`;
}

export function tokenPath(home: string = homeDir()): string {
  return join(home, 'token');
}

export function readToken(home: string = homeDir()): string | undefined {
  try {
    return readFileSync(tokenPath(home), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function ensureToken(home: string = homeDir()): string {
  mkdirSync(home, { recursive: true });
  const existing = readToken(home);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath(home), `${token}\n`, { mode: 0o600 });
  return token;
}
