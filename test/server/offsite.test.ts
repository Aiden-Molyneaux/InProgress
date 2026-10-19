import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../../src/server/db/connection';
import { loadDump, readDump, tableDigest } from '../../src/server/dump';
import { commitOffsite, credentialArgs, exportOffsite, initOffsite, lastDrill, offsiteDir, runDrill, runOffsite, tickOffsite } from '../../src/server/offsite';
import Database from 'better-sqlite3';

const dirs: string[] = [];
const dbs: DB[] = [];
function tempDir(prefix = 'ip-off-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
// Every database is closed first: Windows can't delete an open file.
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

const sh = (args: string[], cwd?: string): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const logs = () => {
  const lines: string[] = [];
  return { lines, info: (m: string) => lines.push(`info: ${m}`), error: (m: string) => lines.push(`error: ${m}`) };
};

/** An empty bare repo to push to, as a local path: no network, no gh. */
function bareRemote(): string {
  const dir = join(tempDir('ip-remote-'), 'remote.git');
  sh(['init', '--bare', '--initial-branch=main', dir]);
  return dir;
}

/** A home with a database holding a project, a resource file, and the files that must never leave the machine. */
function makeHome(): { home: string; db: DB } {
  const home = tempDir('ip-home-');
  const db = openDb(join(home, 'inprogress.db'));
  dbs.push(db);
  db.prepare("INSERT INTO meta (key, value) VALUES ('marker', ?)").run('line one\r\nline two');
  mkdirSync(join(home, 'resources', 'proj'), { recursive: true });
  writeFileSync(join(home, 'resources', 'proj', 'a.txt'), 'resource a');
  writeFileSync(join(home, 'token'), 'secret-token');
  writeFileSync(join(home, 'server.log'), 'log');
  writeFileSync(join(home, 'hooks.log'), 'log');
  writeFileSync(join(home, 'server.pid'), '123');
  mkdirSync(join(home, 'capture'));
  writeFileSync(join(home, 'capture', 'x.json'), '{}');
  return { home, db };
}

const remoteFiles = (remote: string): string[] => sh(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).split('\n');
const remoteCommits = (remote: string): number => Number(sh(['--git-dir', remote, 'rev-list', '--count', 'main']));

// Every git call costs about a second on a machine with global hooks, and a run makes a handful of them.
describe('offsite backup', { timeout: 120_000 }, () => {
  it('pushes a commit holding the dump, the resources and a manifest, and nothing private', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    await initOffsite(home, remote);
    const log = logs();
    expect(await runOffsite(db, home, log, { force: true })).toBe('ok');
    const files = remoteFiles(remote);
    expect(files).toEqual(expect.arrayContaining(['schema.sql', 'manifest.json', 'data/meta.sql', 'resources/proj/a.txt', '.gitattributes', 'README.md']));
    for (const never of ['token', 'server.log', 'hooks.log', 'server.pid']) expect(files).not.toContain(never);
    expect(files.some((f) => f.startsWith('capture/'))).toBe(false);
    const manifest = JSON.parse(sh(['--git-dir', remote, 'show', 'main:manifest.json'])) as { format_version: number; tables: Record<string, number>; resources: { count: number; files: Record<string, string> }; home: string };
    expect(manifest.format_version).toBe(1);
    expect(manifest.tables.meta).toBeGreaterThan(0);
    expect(manifest.resources.count).toBe(1);
    expect(Object.keys(manifest.resources.files)).toEqual(['proj/a.txt']);
    expect(manifest.home).not.toContain('\\');
    expect(log.lines.filter((l) => l.startsWith('error'))).toEqual([]);
  });

  it('refuses to set up twice, and is a no-op while not set up', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    expect(await runOffsite(db, home, logs(), { force: true })).toBe('not set up');
    await initOffsite(home, remote);
    await expect(initOffsite(home, remote)).rejects.toThrow(/already exists/);
  });

  it('commits at most daily unless forced', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    await initOffsite(home, remote);
    const t0 = new Date(2026, 9, 19, 9, 0, 0);
    expect(await runOffsite(db, home, logs(), { now: t0 })).toBe('ok');
    expect(remoteCommits(remote)).toBe(1);
    await runOffsite(db, home, logs(), { now: new Date(t0.getTime() + 60 * 60 * 1000) });
    expect(remoteCommits(remote)).toBe(1);
    await runOffsite(db, home, logs(), { now: new Date(t0.getTime() + 60 * 60 * 1000), force: true });
    expect(remoteCommits(remote)).toBe(2);
    await runOffsite(db, home, logs(), { now: new Date(t0.getTime() + 26 * 60 * 60 * 1000) });
    expect(remoteCommits(remote)).toBe(3);
  });

  it('keeps a commit whose push failed, and pushes it on the next run without a new commit', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    await initOffsite(home, remote);
    const away = `${remote}.away`;
    renameSync(remote, away);
    const t0 = new Date(2026, 9, 19, 9, 0, 0);
    const log = logs();
    expect(await runOffsite(db, home, log, { now: t0 })).toBe('failed');
    expect(log.lines.some((l) => l.startsWith('error: Could not push the backup'))).toBe(true);
    expect(Number(sh(['rev-list', '--count', 'HEAD'], offsiteDir(home)))).toBe(1);
    renameSync(away, remote);
    expect(await runOffsite(db, home, logs(), { now: new Date(t0.getTime() + 60 * 60 * 1000) })).toBe('ok');
    expect(remoteCommits(remote)).toBe(1);
  });

  it('refuses the commit when the dump does not load back to the manifest row counts', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    await initOffsite(home, remote);
    await expect(
      exportOffsite(db, home, new Date(), (dir) => {
        const file = join(dir, 'data', 'meta.sql');
        writeFileSync(file, readFileSync(file, 'utf8').split('\n').slice(1).join('\n'));
      }),
    ).rejects.toThrow(/^Refused the backup commit: table meta loads \d+ rows, the manifest says \d+$/);
  });

  it('serves a busy lock, and takes over a stale one', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    await initOffsite(home, remote);
    const lock = join(offsiteDir(home), '.git', 'inprogress-backup.lock');
    writeFileSync(lock, '');
    expect(await runOffsite(db, home, logs(), { force: true })).toBe('busy');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
    expect(await runOffsite(db, home, logs(), { force: true })).toBe('ok');
    expect(existsSync(lock)).toBe(false);
  });

  it('the drill passes on a good push and fails once a resource differs from its manifest', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    await initOffsite(home, remote);
    await runOffsite(db, home, logs(), { force: true });
    const good = await runDrill(db, home, new Date());
    expect(good).toMatchObject({ ok: true });
    expect(lastDrill(db)).toEqual(good);
    // Change a resource in a new commit on the remote without touching the manifest.
    const other = join(tempDir('ip-other-'), 'clone');
    sh(['clone', '--branch', 'main', remote, other]);
    writeFileSync(join(other, 'resources', 'proj', 'a.txt'), 'tampered');
    sh(['add', '-A'], other);
    sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'tamper'], other);
    sh(['push', 'origin', 'HEAD:main'], other);
    const bad = await runDrill(db, home, new Date());
    expect(bad.ok).toBe(false);
    expect(bad.detail).toBe('resource proj/a.txt differs from the manifest');
    expect(lastDrill(db)).toEqual(bad);
  });

  it('a tick drills when there is no drill or the last is over 7 days old, and not otherwise', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    await tickOffsite(db, home, logs(), new Date());
    expect(lastDrill(db)).toBeUndefined();
    await initOffsite(home, remote);
    const t0 = new Date(2026, 9, 19, 9, 0, 0);
    await tickOffsite(db, home, logs(), t0);
    expect(lastDrill(db)?.at).toBe(t0.toISOString());
    const t1 = new Date(t0.getTime() + 3 * 24 * 60 * 60 * 1000);
    await tickOffsite(db, home, logs(), t1);
    expect(lastDrill(db)?.at).toBe(t0.toISOString());
    const t2 = new Date(t0.getTime() + 8 * 24 * 60 * 60 * 1000);
    await tickOffsite(db, home, logs(), t2);
    expect(lastDrill(db)?.at).toBe(t2.toISOString());
  });

  it('keeps a \\r\\n inside a value byte for byte through the round trip', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    await initOffsite(home, remote);
    await runOffsite(db, home, logs(), { force: true });
    const clone = join(tempDir('ip-clone-'), 'clone');
    sh(['clone', '--branch', 'main', remote, clone]);
    expect(readFileSync(join(clone, 'data', 'meta.sql'), 'utf8')).toContain('line one\r\nline two');
    const file = join(tempDir('ip-load-'), 'loaded.db');
    loadDump(file, readDump(clone));
    const loaded = new Database(file);
    try {
      expect(tableDigest(loaded)).toEqual(tableDigest(db));
    } finally {
      loaded.close();
    }
  });

  it('commitOffsite stamps the commit with the given time and the backup identity', async () => {
    const remote = bareRemote();
    const { home, db } = makeHome();
    await initOffsite(home, remote);
    const at = new Date(Date.UTC(2026, 9, 19, 9, 0, 0));
    await exportOffsite(db, home, at);
    const sha = await commitOffsite(home, at);
    expect(sh(['log', '-1', '--format=%an <%ae>|%cI|%s', sha], offsiteDir(home))).toBe('InProgress backup <inprogress-backup@localhost>|2026-10-19T09:00:00Z|Backup 2026-10-19T09:00:00.000Z');
  });

  it('adds the gh credential helper for a github https remote only', () => {
    expect(credentialArgs('https://github.com/aiden/inprogress-backup.git')[3]).toContain('gh auth token --user aiden');
    expect(credentialArgs('C:/some/bare.git')).toEqual([]);
    expect(credentialArgs('git@github.com:aiden/x.git')).toEqual([]);
  });
});
