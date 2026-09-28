import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db/connection';

export function timestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function backupDb(db: DB, dir: string, keep = 7, stamp: string = timestamp()): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `inprogress-${stamp}.db`);
  await db.backup(file);
  const files = readdirSync(dir).filter((f) => /^inprogress-\d{8}-\d{6}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true });
  return file;
}

export function truncateIfLarge(file: string, maxBytes: number): void {
  try {
    if (statSync(file).size > maxBytes) writeFileSync(file, '');
  } catch {
    // missing file: nothing to do
  }
}
