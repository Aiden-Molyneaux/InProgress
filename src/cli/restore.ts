import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { timestamp } from '../server/backup';
import { loadDump, readDump } from '../server/dump';
import { MIGRATIONS } from '../server/db/schema';
import { checkLoaded, git, offsiteDir, type Manifest } from '../server/offsite';

const USAGE = 'Usage: inprogress restore [--from <snapshot .db | backup folder | commit in the offsite repo>]';

interface Source {
  /** A snapshot file to copy, or a folder holding a dump and its manifest. */
  kind: 'db' | 'dump';
  path: string;
}

const slashed = (path: string): string => path.replace(/\\/g, '/');
const sameCase = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The newest backups/inprogress-<stamp>.db, or nothing. */
function newestSnapshot(home: string): string | undefined {
  const dir = join(home, 'backups');
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).filter((f) => /^inprogress-\d{8}-\d{6}\.db$/.test(f)).sort().pop();
  return name ? join(dir, name) : undefined;
}

/** Resolves --from: a .db file, a folder with manifest.json, or else a commit of <home>/offsite checked out into `scratch`. */
async function resolveSource(from: string | undefined, home: string, scratch: string): Promise<Source> {
  if (from === undefined) {
    const newest = newestSnapshot(home);
    if (!newest) throw new Error(`There is no snapshot in ${join(home, 'backups')} to restore; pass --from`);
    return { kind: 'db', path: newest };
  }
  if (existsSync(from)) {
    if (statSync(from).isFile()) {
      if (!from.endsWith('.db')) throw new Error(`${from} is not a .db snapshot`);
      return { kind: 'db', path: from };
    }
    if (!existsSync(join(from, 'manifest.json'))) throw new Error(`${from} has no manifest.json: it is not a backup folder`);
    return { kind: 'dump', path: from };
  }
  const repo = offsiteDir(home);
  if (!existsSync(join(repo, '.git'))) throw new Error(`${from} is not a file or folder, and ${repo} is not set up to look it up as a commit`);
  const clone = join(scratch, 'clone');
  await git(['-c', 'core.autocrlf=false', 'clone', '--shared', '--no-checkout', repo, clone]);
  await git(['-c', 'core.autocrlf=false', 'checkout', from], clone);
  return { kind: 'dump', path: clone };
}

/** Copies the current database aside before it is replaced. A damaged one is copied as a file, since restoring is what it needs. */
async function copyCurrentAside(file: string, target: string): Promise<string> {
  // Read before the open: SQLite may delete a -wal it cannot use when the connection closes.
  const sides = ['-wal', '-shm'].filter((side) => existsSync(`${file}${side}`)).map((side) => ({ side, bytes: readFileSync(`${file}${side}`) }));
  try {
    const db = new Database(file, { fileMustExist: true });
    try {
      await db.backup(target);
    } finally {
      db.close();
    }
    return target;
  } catch (err) {
    rmSync(target, { force: true });
    copyFileSync(file, target);
    // The restore deletes these next; they may hold the newest writes of a database that would not open.
    for (const { side, bytes } of sides) writeFileSync(`${target}${side}`, bytes);
    return `${target} (a plain file copy: ${(err as Error).message})`;
  }
}

/** `inprogress restore`: replaces inprogress.db (and, from a backup folder, resources/) with a backup. Run with the server stopped. */
export async function runRestore(args: string[], out: (line: string) => void, o: { home: string; serverUp: () => Promise<boolean> }): Promise<number> {
  const at = args.indexOf('--from');
  const from = at >= 0 ? args[at + 1] : undefined;
  if (args.some((_, i) => at < 0 || (i !== at && i !== at + 1)) || (at >= 0 && !from)) {
    out(USAGE);
    return 1;
  }
  if (await o.serverUp()) {
    out('Stop InProgress first: inprogress stop');
    return 1;
  }
  const { home } = o;
  const live = join(home, 'inprogress.db');
  const tmp = join(home, `inprogress.db.restore-${process.pid}.tmp`);
  const scratch = mkdtempSync(join(tmpdir(), 'ip-restore-'));
  let swapped = false;
  const savedPaths: string[] = [];
  try {
    mkdirSync(home, { recursive: true });
    const source = await resolveSource(from, home, scratch);
    let manifest: Manifest | undefined;
    if (source.kind === 'db') {
      const src = new Database(source.path, { readonly: true, fileMustExist: true });
      try {
        await src.backup(tmp);
      } finally {
        src.close();
      }
      const copy = new Database(tmp, { readonly: true });
      try {
        const result = String(copy.pragma('integrity_check', { simple: true }));
        if (result !== 'ok') throw new Error(`${source.path} fails its integrity_check: ${result.split('\n')[0]}`);
      } finally {
        copy.close();
      }
    } else {
      manifest = JSON.parse(readFileSync(join(source.path, 'manifest.json'), 'utf8')) as Manifest;
      // A backup that only a newer build can read would restore into a database this build refuses to open.
      if (manifest.schema_version > MIGRATIONS.length && !(manifest.min_reader_version !== null && manifest.min_reader_version <= MIGRATIONS.length)) {
        throw new Error(`This backup is from a newer InProgress (schema v${manifest.schema_version}); update InProgress first`);
      }
      loadDump(tmp, readDump(source.path));
      checkLoaded(tmp, manifest);
      // The dump may come from another machine, whose home folder resources/ paths still name.
      const there = slashed(manifest.home);
      const here = slashed(home);
      if (!sameCase(there, here)) {
        const db = new Database(tmp);
        try {
          // Rows stored with backslashes match too, and come out forward-slashed.
          const flat = "replace(path, char(92), '/')";
          db.prepare(`UPDATE resources SET path = ? || substr(${flat}, length(?) + 1) WHERE lower(substr(${flat}, 1, length(?))) = lower(?)`).run(here, there, there, there);
        } finally {
          db.close();
        }
      }
    }
    // The new database is built and sound: only now is anything of the current one touched.
    const stamp = timestamp();
    const backups = join(home, 'backups');
    mkdirSync(backups, { recursive: true });
    const saved = savedPaths;
    if (existsSync(live)) saved.push(await copyCurrentAside(live, join(backups, `inprogress-pre-restore-${stamp}.db`)));
    const resources = join(home, 'resources');
    if (source.kind === 'dump' && existsSync(resources)) {
      const aside = join(backups, `resources-pre-restore-${stamp}`);
      cpSync(resources, aside, { recursive: true });
      saved.push(aside);
    }
    rmSync(`${live}-wal`, { force: true });
    rmSync(`${live}-shm`, { force: true });
    renameSync(tmp, live);
    swapped = true;
    if (source.kind === 'dump') {
      rmSync(resources, { recursive: true, force: true });
      if (existsSync(join(source.path, 'resources'))) cpSync(join(source.path, 'resources'), resources, { recursive: true });
    }
    out(`Restored ${live} from ${source.path}${manifest ? ` (backup made ${manifest.created_at})` : ''}.`);
    if (source.kind === 'dump') out(`Replaced ${resources} with the backup's resources.`);
    for (const s of saved) out(`The previous data is kept at ${s}`);
    out('Next: run `inprogress start`.');
    return 0;
  } catch (err) {
    if (swapped) {
      out(`Could not finish the restore: ${(err as Error).message}. The database was already replaced.`);
      for (const s of savedPaths) out(`The previous data is kept at ${s}`);
    } else {
      out(`Could not restore: ${(err as Error).message}. The current database is unchanged.`);
    }
    return 1;
  } finally {
    // A read-only open of the WAL-flagged copy can leave side files beside it.
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}
