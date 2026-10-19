import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runRestore } from '../../src/cli/restore';
import { snapshotDb } from '../../src/server/backup';
import { openDb, type DB } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { createProject } from '../../src/server/repo/projects';
import { tableDigest } from '../../src/server/dump';
import { commitOffsite, exportOffsite, initOffsite, offsiteDir } from '../../src/server/offsite';

const dirs: string[] = [];
function tempDir(prefix = 'ip-rst-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

const down = async () => false;
const lines = () => {
  const out: string[] = [];
  return { out, say: (l: string) => out.push(l) };
};

/** A home with a project, one resource file the database points at, and a marker row. */
function makeHome(marker: string): { home: string; db: DB } {
  const home = tempDir('ip-home-');
  const db = openDb(join(home, 'inprogress.db'));
  const t = '2026-10-19T00:00:00.000Z';
  const project = createProject(createCtx(db), 'test', { name: 'P' });
  const file = `${home.replace(/\\/g, '/')}/resources/p/a.txt`;
  mkdirSync(join(home, 'resources', 'p'), { recursive: true });
  writeFileSync(join(home, 'resources', 'p', 'a.txt'), 'resource a');
  db.prepare("INSERT INTO resources (project_id, node_id, kind, title, path, created_at, updated_at) VALUES (?, ?, 'doc', 'A', ?, ?, ?)").run(project.id, project.rootNodeId, file, t, t);
  db.prepare("INSERT INTO meta (key, value) VALUES ('marker', ?)").run(marker);
  return { home, db };
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const sh = (args: string[], cwd?: string): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const marker = (file: string): string => {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'marker'").pluck().get() as string;
  } finally {
    db.close();
  }
};

describe('inprogress restore', { timeout: 120_000 }, () => {
  it('refuses while the server is up, and changes nothing', async () => {
    const { home, db } = makeHome('live');
    db.close();
    const { out, say } = lines();
    expect(await runRestore([], say, { home, serverUp: async () => true })).toBe(1);
    expect(out).toEqual(['Stop InProgress first: inprogress stop']);
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  it('restores the newest snapshot by default, keeping the replaced database aside', async () => {
    const { home, db } = makeHome('before');
    await snapshotDb(db, join(home, 'backups'), new Date(2026, 9, 18, 9, 0, 0));
    db.prepare("UPDATE meta SET value = 'after' WHERE key = 'marker'").run();
    db.close();
    const { out, say } = lines();
    expect(await runRestore([], say, { home, serverUp: down })).toBe(0);
    expect(marker(join(home, 'inprogress.db'))).toBe('before');
    const aside = readdirSync(join(home, 'backups')).filter((f) => f.startsWith('inprogress-pre-restore-'));
    expect(aside).toHaveLength(1);
    expect(marker(join(home, 'backups', aside[0]))).toBe('after');
    expect(out.join('\n')).toContain(aside[0]);
    expect(readdirSync(home).filter((f) => f.includes('.restore-'))).toEqual([]);
  });

  it('restores a named snapshot file, and removes a leftover -wal first', async () => {
    const { home, db } = makeHome('before');
    const { file } = await snapshotDb(db, join(home, 'backups'), new Date(2026, 9, 18, 9, 0, 0));
    db.prepare("UPDATE meta SET value = 'after' WHERE key = 'marker'").run();
    db.close();
    // A -wal the old database left would be replayed onto the restored copy.
    writeFileSync(join(home, 'inprogress.db-wal'), 'stale wal');
    expect(await runRestore(['--from', file!], () => undefined, { home, serverUp: down })).toBe(0);
    expect(existsSync(join(home, 'inprogress.db-wal'))).toBe(false);
    expect(marker(join(home, 'inprogress.db'))).toBe('before');
  });

  it('restores an offsite folder into a scratch home: resource paths follow the new home, the rest is identical', async () => {
    const source = makeHome('from the other machine');
    await exportOffsite(source.db, source.home, new Date(2026, 9, 19, 9, 0, 0));
    const sourceDigest = tableDigest(source.db);
    const sourceFiles = { 'p/a.txt': sha(join(source.home, 'resources', 'p', 'a.txt')) };
    source.db.close();
    const scratch = tempDir('ip-scratch-');
    const { out, say } = lines();
    expect(await runRestore(['--from', offsiteDir(source.home)], say, { home: scratch, serverUp: down })).toBe(0);
    const restored = new Database(join(scratch, 'inprogress.db'));
    try {
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      const digest = tableDigest(restored);
      for (const table of Object.keys(sourceDigest)) {
        if (table !== 'resources') expect(digest[table], table).toBe(sourceDigest[table]);
      }
      expect(restored.prepare('SELECT path FROM resources').pluck().get()).toBe(`${scratch.replace(/\\/g, '/')}/resources/p/a.txt`);
      expect(digest.resources).not.toBe(sourceDigest.resources);
    } finally {
      restored.close();
    }
    expect(sha(join(scratch, 'resources', 'p', 'a.txt'))).toBe(sourceFiles['p/a.txt']);
    expect(out.join('\n')).toContain('Restored');
  });

  it('restores a commit of the offsite repo', async () => {
    const remote = join(tempDir('ip-remote-'), 'remote.git');
    sh(['init', '--bare', '--initial-branch=main', remote]);
    const { home, db } = makeHome('first');
    await initOffsite(home, remote);
    await exportOffsite(db, home, new Date(2026, 9, 19, 9, 0, 0));
    const first = await commitOffsite(home, new Date(2026, 9, 19, 9, 0, 0));
    db.prepare("UPDATE meta SET value = 'second' WHERE key = 'marker'").run();
    await exportOffsite(db, home, new Date(2026, 9, 20, 9, 0, 0));
    await commitOffsite(home, new Date(2026, 9, 20, 9, 0, 0));
    db.close();
    expect(marker(join(home, 'inprogress.db'))).toBe('second');
    const { out, say } = lines();
    expect(await runRestore(['--from', first], say, { home, serverUp: down })).toBe(0);
    expect(marker(join(home, 'inprogress.db'))).toBe('first');
    expect(out.join('\n')).toContain('inprogress-pre-restore-');
    expect(readdirSync(join(home, 'backups')).some((f) => f.startsWith('resources-pre-restore-'))).toBe(true);
  });

  it('leaves the live database untouched when the source is damaged', async () => {
    const { home, db } = makeHome('live');
    db.close();
    const before = sha(join(home, 'inprogress.db'));
    const bad = join(tempDir('ip-bad-'), 'bad.db');
    writeFileSync(bad, 'this is not a database'.repeat(100));
    const { out, say } = lines();
    expect(await runRestore(['--from', bad], say, { home, serverUp: down })).toBe(1);
    expect(out[0]).toMatch(/^Could not restore: .*The current database is unchanged\.$/);
    expect(sha(join(home, 'inprogress.db'))).toBe(before);
    expect(readdirSync(home).filter((f) => f.includes('.restore-'))).toEqual([]);
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  it('names a --from that is neither a file, a folder nor a commit', async () => {
    const { home, db } = makeHome('live');
    db.close();
    const { out, say } = lines();
    expect(await runRestore(['--from', 'abc123'], say, { home, serverUp: down })).toBe(1);
    expect(out[0]).toContain('is not set up to look it up as a commit');
  });
});
