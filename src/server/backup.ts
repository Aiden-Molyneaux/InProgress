import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db/connection';

export function timestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 'ok', or the first problem PRAGMA quick_check reports (it can also throw SQLITE_CORRUPT). */
function quickCheck(db: DB): string {
  try {
    const result = String(db.pragma('quick_check', { simple: true }));
    if (result === 'ok') return result;
    return result.split('\n').find((line) => line.trim() && !line.startsWith('***')) ?? result;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Back up the database, keeping the newest `keep` copies. Refuses a damaged database, so it never displaces a good backup. */
export async function backupDb(db: DB, dir: string, keep = 7, stamp: string = timestamp()): Promise<string> {
  const check = quickCheck(db);
  if (check !== 'ok') throw new Error(`Skipped the database backup: quick_check reported ${check}`);
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
