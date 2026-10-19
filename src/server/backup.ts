import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT = /^inprogress-(\d{8}-\d{6})\.db$/;
const PRE_MIGRATION = /^inprogress-pre-v\d+-(\d{8}-\d{6})\.db$/;

function parseStampText(stamp: string): Date {
  const n = (from: number, len: number) => Number(stamp.slice(from, from + len));
  return new Date(n(0, 4), n(4, 2) - 1, n(6, 2), n(9, 2), n(11, 2), n(13, 2));
}

/** The local time in `inprogress-YYYYMMDD-HHMMSS.db`; nothing for any other name. */
export function parseStamp(name: string): Date | undefined {
  const m = SNAPSHOT.exec(name);
  return m ? parseStampText(m[1]) : undefined;
}

/** Local midnight of the Monday that starts `d`'s ISO week. */
function weekStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Which snapshots to keep: the newest 8 from the last 48 hours, the newest of each local day for 14 days, the newest of
 * each ISO week (Monday start) for 8 weeks. A name stamped in the future is kept, as is anything that is not a snapshot's name.
 */
export function keepSnapshots(names: string[], now: Date): Set<string> {
  const keep = new Set<string>();
  const past: { name: string; at: Date }[] = [];
  for (const name of names) {
    const at = parseStamp(name);
    if (!at) continue;
    if (at.getTime() > now.getTime()) keep.add(name);
    else past.push({ name, at });
  }
  past.sort((a, b) => b.at.getTime() - a.at.getTime());
  const recent = past.filter((s) => s.at.getTime() >= now.getTime() - 2 * DAY_MS);
  for (const s of recent.slice(0, 8)) keep.add(s.name);
  const firstDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13);
  const thisWeek = weekStart(now);
  const firstWeek = new Date(thisWeek.getFullYear(), thisWeek.getMonth(), thisWeek.getDate() - 49);
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const s of past) {
    if (s.at >= firstDay && !days.has(dayKey(s.at))) {
      days.add(dayKey(s.at));
      keep.add(s.name);
    }
    const week = dayKey(weekStart(s.at));
    if (s.at >= firstWeek && !weeks.has(week)) {
      weeks.add(week);
      keep.add(s.name);
    }
  }
  return keep;
}

/** Deletes pre-migration copies but the newest 3 and any under 30 days old. Other files in `dir` stay. */
export function prunePreMigration(dir: string, now: Date): void {
  const copies = readdirSync(dir)
    .map((name) => ({ name, m: PRE_MIGRATION.exec(name) }))
    .filter((c): c is { name: string; m: RegExpExecArray } => c.m !== null)
    .sort((a, b) => b.m[1].localeCompare(a.m[1]));
  for (const c of copies.slice(3)) {
    if (parseStampText(c.m[1]).getTime() < now.getTime() - 30 * DAY_MS) rmSync(join(dir, c.name), { force: true });
  }
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Copy the database to backups/inprogress-<stamp>.db, then thin the snapshots (keepSnapshots). Refuses a damaged
 * database, and a copy that fails its integrity_check, so it never displaces a good backup. A copy byte-identical to the
 * newest snapshot is dropped: nothing changed since.
 */
export async function snapshotDb(db: DB, dir: string, now: Date = new Date()): Promise<{ file?: string; skipped?: 'unchanged' }> {
  const check = quickCheck(db);
  if (check !== 'ok') throw new Error(`Skipped the database backup: quick_check reported ${check}`);
  mkdirSync(dir, { recursive: true });
  // A crashed run's copy in progress; anything over a day old will never be finished.
  for (const f of readdirSync(dir)) {
    if (!/^inprogress-.*\.db\.\d+\.tmp$/.test(f)) continue;
    try {
      if (now.getTime() - statSync(join(dir, f)).mtimeMs > DAY_MS) rmSync(join(dir, f), { force: true });
    } catch {
      // Renamed or removed by its own run meanwhile: nothing to sweep.
    }
  }
  const file = join(dir, `inprogress-${timestamp(now)}.db`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await db.backup(tmp);
    const copy = new Database(tmp, { readonly: true, fileMustExist: true });
    let result: string;
    try {
      result = String(copy.pragma('integrity_check', { simple: true }));
    } finally {
      copy.close();
    }
    if (result !== 'ok') throw new Error(`Skipped the database backup: integrity_check on the copy reported ${result.split('\n')[0]}`);
    const newest = readdirSync(dir).filter((f) => SNAPSHOT.test(f)).sort().pop();
    if (newest && sha256(join(dir, newest)) === sha256(tmp)) {
      rmSync(tmp, { force: true });
      // The newest snapshot is still current: doctor reads its mtime as "checked and found unchanged".
      try {
        utimesSync(join(dir, newest), now, now);
      } catch {
        // A locked file (a scanner, a sync client) keeps its old mtime; the snapshot itself is still current.
      }
      return { skipped: 'unchanged' };
    }
    renameSync(tmp, file);
  } finally {
    // A WAL-flagged copy may leave its side files behind a read-only open.
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
  }
  const keep = keepSnapshots(readdirSync(dir), now);
  for (const f of readdirSync(dir)) {
    if (SNAPSHOT.test(f) && !keep.has(f)) rmSync(join(dir, f), { force: true });
  }
  return { file };
}

export function truncateIfLarge(file: string, maxBytes: number): void {
  try {
    if (statSync(file).size > maxBytes) writeFileSync(file, '');
  } catch {
    // missing file: nothing to do
  }
}
