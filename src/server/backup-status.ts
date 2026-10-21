import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BackupLevel, BackupStatus } from '../core/backups';
import { parseStamp } from './backup';
import { lockHeld, offsiteDir as offsiteOf } from './offsite';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ago = (ms: number): string => (ms >= DAY_MS ? `${Math.floor(ms / DAY_MS)} d` : `${Math.floor(ms / HOUR_MS)} h`);

/** Runs git in the backup repo without touching the network; nothing when it fails. Async: the hooks share the event loop. */
function gitQuiet(dir: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => {
      // Not a repo, no such ref, or no git: each reads as "nothing to report" and the caller says what is missing.
      resolve(err ? undefined : stdout.trim());
    });
  });
}

/** The stored result of the last backup drill, read without writing; nothing when there is none. */
function readDrill(file: string): { at: string; ok: boolean; detail: string } | undefined {
  if (!existsSync(file)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const raw = db.prepare("SELECT value FROM meta WHERE key = 'backup_drill'").pluck().get() as string | undefined;
    return raw ? (JSON.parse(raw) as { at: string; ok: boolean; detail: string }) : undefined;
  } catch {
    // An unreadable database is the Database check's to report; here it only means no drill is known.
    return undefined;
  } finally {
    db?.close();
  }
}

export interface BackupStatusOptions {
  serverUp: boolean;
  now: Date;
  /** Undefined reads the stored drill from <home>/inprogress.db; null means none. */
  drill?: { at: string; ok: boolean; detail: string } | null;
}

/**
 * The backups: the newest snapshot (stale after 26 hours while the server is up), the newest pushed commit (warns after
 * 3 days, fails after 7), the last drill (warns when missing, failed or over 14 days old) and the backup repo's size
 * (warns over 500 MB). Only a push over 7 days old fails the run. The one place these thresholds and their wording live.
 */
export async function backupStatus(home: string, o: BackupStatusOptions): Promise<BackupStatus> {
  const { serverUp, now } = o;
  const warnings: string[] = [];
  let fail = false;
  const parts: string[] = [];
  /** Records a warning and returns it, so the row it belongs to can carry it as its note. */
  const warn = (text: string): string => {
    warnings.push(text);
    return text;
  };
  // Snapshots
  const dir = join(home, 'backups');
  const newest = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => parseStamp(f)).sort().pop();
  let snapshot: BackupStatus['snapshot'] = null;
  if (newest) {
    // A tick that finds nothing changed touches the newest snapshot instead of writing another, so its mtime counts too.
    const at = Math.max(parseStamp(newest)!.getTime(), statSync(join(dir, newest)).mtimeMs);
    const age = now.getTime() - at;
    parts.push(`newest snapshot ${newest} (${ago(age)} ago)`);
    const stale = age > 26 * HOUR_MS && serverUp;
    snapshot = { name: newest, at: new Date(at).toISOString(), level: stale ? 'warn' : 'ok', note: stale ? warn('the newest snapshot is over 26 hours old') : undefined };
  } else {
    parts.push(`no snapshot in ${dir}`);
    if (serverUp) warn('no snapshot yet');
  }
  // Pushed commit, drill and size
  const repo = offsiteOf(home);
  const setUp = existsSync(join(repo, '.git'));
  const pushedAt = setUp ? await gitQuiet(repo, ['log', '-1', '--format=%cI', 'origin/main']) : undefined;
  let pushed: BackupStatus['pushed'] = null;
  if (!setUp) {
    parts.push('not set up: run inprogress backup --init <remote url>');
    warn('the off-machine copy is not set up');
  } else if (!pushedAt) {
    parts.push('no pushed commit yet: run inprogress backup --push');
    warn('nothing is pushed yet');
  } else {
    const age = now.getTime() - new Date(pushedAt).getTime();
    parts.push(`newest pushed commit ${ago(age)} ago`);
    let level: BackupLevel = 'ok';
    let note: string | undefined;
    if (age > 7 * DAY_MS) {
      fail = true;
      level = 'fail';
      note = warn('the newest pushed commit is over 7 days old');
    } else if (age > 3 * DAY_MS) {
      level = 'warn';
      note = warn('the newest pushed commit is over 3 days old');
    }
    pushed = { at: new Date(pushedAt).toISOString(), level, note };
  }
  let drillRow: BackupStatus['drill'] = null;
  let repoBytes: number | null = null;
  let repoLevel: BackupLevel = 'ok';
  if (setUp) {
    const drill = o.drill === undefined ? readDrill(join(home, 'inprogress.db')) : (o.drill ?? undefined);
    if (!drill) {
      parts.push('no drill yet');
      warn('the backup has never been drilled');
    } else {
      const age = now.getTime() - Date.parse(drill.at);
      parts.push(`last drill ${drill.ok ? 'passed' : `FAILED (${drill.detail})`} ${ago(age)} ago`);
      let note: string | undefined;
      if (!drill.ok) note = warn('the last drill failed');
      else if (age > 14 * DAY_MS) note = warn('the last drill is over 14 days old');
      drillRow = { at: drill.at, ok: drill.ok, detail: drill.detail, level: note ? 'warn' : 'ok', note };
    }
    const counts = await gitQuiet(repo, ['count-objects', '-v']);
    if (counts !== undefined) {
      const kib = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, 'm').exec(counts)?.[1] ?? 0);
      const total = kib('size-pack') + kib('size');
      repoBytes = total * 1024;
      parts.push(`repo ${(total / 1024).toFixed(1)} MB`);
      if (total > 500 * 1024) {
        warn('the backup repo is over 500 MB');
        repoLevel = 'warn';
      }
    }
  }
  const detail = parts.join('; ');
  const check: BackupStatus['check'] = warnings.length ? { name: 'Backups', ok: false, warnOnly: !fail, detail: `${warnings.join('; ')} (${detail})` } : { name: 'Backups', ok: true, detail };
  return { backupsDir: dir, offsiteDir: repo, snapshot, setUp, pushed, drill: drillRow, repoBytes, repoLevel, busy: setUp && lockHeld(repo), warnings, fail, check };
}

/** Doctor's Backups check. */
export async function backupsCheck(home: string, serverUp: boolean, now: Date): Promise<BackupStatus['check']> {
  return (await backupStatus(home, { serverUp, now })).check;
}
