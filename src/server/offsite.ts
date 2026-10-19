import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { readBuild, VERSION } from '../lib/version';
import type { DB } from './db/connection';
import { dumpDb, loadDump, readDump, writeDump } from './dump';

/** What a pushed commit holds besides the dump: written last, read by restore, the drill and doctor. */
export interface Manifest {
  format_version: number;
  created_at: string;
  /** Where the data lived, with forward slashes: restore rewrites resource paths from it. */
  home: string;
  version: string;
  git_sha: string | null;
  schema_version: number;
  min_reader_version: number | null;
  integrity_check: string;
  tables: Record<string, number>;
  resources: { count: number; bytes: number; files: Record<string, string> };
}

export interface DrillResult {
  at: string;
  ok: boolean;
  detail: string;
  commit: string | null;
}

export interface OffsiteLog {
  info(message: string): void;
  error(message: string): void;
}

export const offsiteDir = (home: string): string => join(home, 'offsite');

const GIT_TIMEOUT_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
/** The identity on every backup commit, so a machine with no git identity still commits. */
const IDENTITY = ['-c', 'user.name=InProgress backup', '-c', 'user.email=inprogress-backup@localhost'];

/** The arguments minus the `-c key=value` pairs, so an error names the command and not the credential helper. */
function withoutConfig(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++;
    else out.push(args[i]);
  }
  return out;
}

/** Runs git and returns its stdout; a failure throws with git's own message. Async, so a slow push never blocks the server. */
export function git(args: string[], cwd?: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${withoutConfig(args).join(' ')} failed: ${String(stderr).trim() || err.message}`));
        else resolve(String(stdout));
      },
    );
  });
}

/** For a GitHub https remote, `gh auth token` supplies the password; any other remote (a path, ssh) needs nothing. */
export function credentialArgs(remoteUrl: string): string[] {
  const owner = /^https:\/\/github\.com\/([^/]+)\//.exec(remoteUrl)?.[1];
  if (!owner) return [];
  return ['-c', 'credential.helper=', '-c', `credential.helper=!f() { echo username=x-access-token; echo password=$(gh auth token --user ${owner}); }; f`];
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Every plain file under `root`, as forward-slashed paths relative to it. Folders and links are not followed. */
function listFiles(root: string, rel = ''): string[] {
  if (!existsSync(join(root, rel))) return [];
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

/** Clones the backup repo into `<home>/offsite`, and writes the two files that make it safe and self-explaining. */
export async function initOffsite(home: string, remoteUrl: string): Promise<void> {
  const dir = offsiteDir(home);
  if (existsSync(dir)) throw new Error(`${dir} already exists: the backup repo is set up (delete the folder to start over)`);
  mkdirSync(home, { recursive: true });
  await git([...credentialArgs(remoteUrl), 'clone', remoteUrl, 'offsite'], home);
  await git(['config', 'core.autocrlf', 'false'], dir);
  // Windows git must never rewrite the dump: a \r\n inside a value has to come back byte for byte.
  writeFileSync(join(dir, '.gitattributes'), '* -text\n', 'utf8');
  writeFileSync(
    join(dir, 'README.md'),
    'InProgress backup: a canonical SQL dump of the database, its resources folder and a manifest. Restore it with `inprogress restore --from <this folder>` (InProgress stopped first).\n',
    'utf8',
  );
}

/** Copies new and changed files from `<home>/resources` into the repo and deletes the ones that are gone. */
function mirrorResources(home: string, dir: string): Manifest['resources'] {
  const from = join(home, 'resources');
  const to = join(dir, 'resources');
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const rel of listFiles(from)) {
    const src = join(from, rel);
    const hash = sha256(src);
    files[rel] = hash;
    bytes += statSync(src).size;
    const dest = join(to, rel);
    if (existsSync(dest) && sha256(dest) === hash) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  for (const rel of listFiles(to)) {
    if (!(rel in files)) rmSync(join(to, rel), { force: true });
  }
  pruneEmptyDirs(to);
  return { count: Object.keys(files).length, bytes, files };
}

function pruneEmptyDirs(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    pruneEmptyDirs(join(root, entry.name));
    if (readdirSync(join(root, entry.name)).length === 0) rmdirSync(join(root, entry.name));
  }
}

/** Throws if the database at `file` is damaged or its row counts differ from the manifest's. */
export function checkLoaded(file: string, manifest: Manifest): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = String(db.pragma('integrity_check', { simple: true }));
    if (result !== 'ok') throw new Error(`the dump loads into a database that reports ${result}`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[];
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get() !== undefined) tables.push('sqlite_sequence');
    for (const table of tables) {
      const count = db.prepare(`SELECT count(*) FROM "${table.replace(/"/g, '""')}"`).pluck().get() as number;
      if (count !== manifest.tables[table]) throw new Error(`table ${table} loads ${count} rows, the manifest says ${manifest.tables[table]}`);
    }
    const missing = Object.keys(manifest.tables).filter((t) => !tables.includes(t));
    if (missing.length) throw new Error(`the manifest lists ${missing.join(', ')}, which the dump does not load`);
  } finally {
    db.close();
  }
}

/** Throws if the dump in `dir` does not load into a sound database with the manifest's row counts. */
function verifyDump(dir: string, manifest: Manifest): void {
  const scratch = mkdtempSync(join(tmpdir(), 'ip-verify-'));
  try {
    const file = join(scratch, 'verify.db');
    loadDump(file, readDump(dir));
    checkLoaded(file, manifest);
  } catch (err) {
    throw new Error(`Refused the backup commit: ${(err as Error).message}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Writes the dump, the resources and the manifest into `<home>/offsite`, then proves the dump loads back to the same
 * rows before anything is committed. `beforeVerify` is a seam for tests, called with the repo folder.
 */
export async function exportOffsite(db: DB, home: string, now: Date, beforeVerify?: (dir: string) => void): Promise<Manifest> {
  const dir = offsiteDir(home);
  const scratch = mkdtempSync(join(tmpdir(), 'ip-export-'));
  let dump: ReturnType<typeof dumpDb>;
  let integrity: string;
  let schemaVersion: number;
  let minReader: number | null;
  try {
    const file = join(scratch, 'snapshot.db');
    // A consistent copy first: the dump then reads one moment, whatever the server writes meanwhile.
    await db.backup(file);
    const copy = new Database(file);
    try {
      integrity = String(copy.pragma('integrity_check', { simple: true }));
      dump = dumpDb(copy);
      const meta = (key: string) => copy.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key) as string | undefined;
      schemaVersion = Number(meta('schema_version') ?? 0);
      minReader = meta('min_reader_version') === undefined ? null : Number(meta('min_reader_version'));
    } finally {
      copy.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
  if (integrity !== 'ok') throw new Error(`Refused the backup commit: integrity_check reported ${integrity.split('\n')[0]}`);
  writeDump(dir, dump);
  const manifest: Manifest = {
    format_version: 1,
    created_at: now.toISOString(),
    home: home.replace(/\\/g, '/'),
    version: VERSION,
    git_sha: readBuild()?.sha ?? null,
    schema_version: schemaVersion,
    min_reader_version: minReader,
    integrity_check: integrity,
    tables: dump.counts,
    resources: mirrorResources(home, dir),
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  beforeVerify?.(dir);
  verifyDump(dir, manifest);
  return manifest;
}

/** Commits everything in the repo and returns the new commit's sha. */
export async function commitOffsite(home: string, now: Date): Promise<string> {
  const dir = offsiteDir(home);
  await git(['add', '-A'], dir);
  const stamp = now.toISOString();
  await git([...IDENTITY, 'commit', '-m', `Backup ${stamp}`], dir, { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
  return (await git(['rev-parse', 'HEAD'], dir)).trim();
}

export async function pushOffsite(home: string): Promise<void> {
  const dir = offsiteDir(home);
  const url = (await git(['remote', 'get-url', 'origin'], dir)).trim();
  await git([...credentialArgs(url), 'push', 'origin', 'HEAD:main'], dir);
}

/** The author-visible time of the commit at `ref`, or nothing when there is none. */
async function commitTime(dir: string, ref: string): Promise<Date | undefined> {
  try {
    const out = (await git(['log', '-1', '--format=%cI', ref], dir)).trim();
    return out ? new Date(out) : undefined;
  } catch {
    // No commit yet (a fresh clone of an empty remote): nothing is there to be old.
    return undefined;
  }
}

async function unpushed(dir: string): Promise<boolean> {
  try {
    return Number((await git(['rev-list', '--count', 'origin/main..HEAD'], dir)).trim()) > 0;
  } catch {
    // origin/main does not exist yet: a first commit is waiting if there is a HEAD at all.
    return git(['rev-parse', '--verify', 'HEAD'], dir).then(() => true, () => false);
  }
}

/** Takes the repo's lock; a lock older than 10 minutes belonged to a crashed run and is taken over. */
function takeLock(dir: string): (() => void) | undefined {
  const lock = join(dir, '.git', 'inprogress-backup.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, 'wx'));
      return () => rmSync(lock, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return undefined;
      rmSync(lock, { force: true });
    }
  }
  return undefined;
}

/**
 * The daily off-machine copy: commits when `force` or the last commit is over 24 hours old, and pushes when anything
 * is waiting to go. A push that fails leaves its commit queued for the next run. Never throws.
 */
export async function runOffsite(db: DB, home: string, log: OffsiteLog, o: { force?: boolean; now?: Date } = {}): Promise<'not set up' | 'busy' | 'ok' | 'failed'> {
  const dir = offsiteDir(home);
  if (!existsSync(join(dir, '.git'))) return 'not set up';
  const now = o.now ?? new Date();
  let release: (() => void) | undefined;
  try {
    release = takeLock(dir);
    if (!release) return 'busy';
    const last = await commitTime(dir, 'HEAD');
    if (o.force || !last || now.getTime() - last.getTime() > DAY_MS) {
      const manifest = await exportOffsite(db, home, now);
      const sha = await commitOffsite(home, now);
      log.info(`Backup committed ${sha.slice(0, 8)}: ${Object.keys(manifest.tables).length} tables, ${manifest.resources.count} resource files`);
    }
    if (o.force || (await unpushed(dir))) {
      try {
        await pushOffsite(home);
        log.info('Backup pushed');
      } catch (err) {
        log.error(`Could not push the backup (the commit stays queued): ${(err as Error).message}`);
        return 'failed';
      }
    }
    return 'ok';
  } catch (err) {
    log.error(`Could not make the off-machine backup: ${(err as Error).message}`);
    return 'failed';
  } finally {
    release?.();
  }
}

/** Clones the pushed repo afresh, loads it into a scratch database and checks it against its manifest. */
export async function runDrill(db: DB, home: string, now: Date): Promise<DrillResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'ip-drill-'));
  let result: DrillResult;
  let commit: string | null = null;
  try {
    const url = (await git(['remote', 'get-url', 'origin'], offsiteDir(home))).trim();
    const clone = join(scratch, 'clone');
    await git([...credentialArgs(url), '-c', 'core.autocrlf=false', 'clone', '--depth', '1', '--branch', 'main', url, clone]);
    commit = (await git(['rev-parse', 'HEAD'], clone)).trim();
    const manifest = JSON.parse(readFileSync(join(clone, 'manifest.json'), 'utf8')) as Manifest;
    verifyDump(clone, manifest);
    for (const [rel, hash] of Object.entries(manifest.resources.files)) {
      const file = join(clone, 'resources', rel);
      if (!existsSync(file) || sha256(file) !== hash) throw new Error(`resource ${rel} differs from the manifest`);
    }
    const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
    result = { at: now.toISOString(), ok: true, detail: `commit ${commit.slice(0, 8)} loads ${rows} rows and ${manifest.resources.count} resource files`, commit };
  } catch (err) {
    result = { at: now.toISOString(), ok: false, detail: (err as Error).message.replace(/^Refused the backup commit: /, ''), commit };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('backup_drill', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(result));
  return result;
}

/** The last drill, as runDrill stored it. */
export function lastDrill(db: DB): DrillResult | undefined {
  const raw = db.prepare("SELECT value FROM meta WHERE key = 'backup_drill'").pluck().get() as string | undefined;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as DrillResult;
  } catch {
    // A value that is not JSON counts as no drill: the next tick writes a fresh one.
    return undefined;
  }
}

/** The server's tick: the daily copy, then the weekly drill when the copy is set up and the last drill is over 7 days old. Never throws. */
export async function tickOffsite(db: DB, home: string, log: OffsiteLog, now: Date = new Date()): Promise<void> {
  const status = await runOffsite(db, home, log, { now });
  if (status === 'not set up' || status === 'busy') return;
  try {
    const drill = lastDrill(db);
    if (drill && now.getTime() - Date.parse(drill.at) <= 7 * DAY_MS) return;
    const result = await runDrill(db, home, now);
    if (result.ok) log.info(`Backup drill passed: ${result.detail}`);
    else log.error(`Backup drill FAILED: ${result.detail}`);
  } catch (err) {
    log.error(`Could not run the backup drill: ${(err as Error).message}`);
  }
}
