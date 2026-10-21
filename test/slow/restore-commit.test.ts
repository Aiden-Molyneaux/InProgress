import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runRestore } from '../../src/cli/restore';
import { openDb, type DB } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { createProject } from '../../src/server/repo/projects';
import { commitOffsite, exportOffsite, initOffsite } from '../../src/server/offsite';

// Moved from test/cli/restore.test.ts: this case clones, commits and reads back through real git.
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
});
