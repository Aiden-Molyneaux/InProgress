import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupRunner } from '../../src/server/backup-runner';
import { openDb, type DB } from '../../src/server/db/connection';
import { initOffsite } from '../../src/server/offsite';

const dirs: string[] = [];
const dbs: DB[] = [];
function tempDir(prefix: string): string {
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

function setup() {
  const home = tempDir('ip-runner-');
  const db = openDb(join(home, 'inprogress.db'));
  dbs.push(db);
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(`info: ${m}`), error: (m: string) => lines.push(`error: ${m}`) };
  const maintenance = vi.fn();
  return { home, db, lines, maintenance, runner: createBackupRunner({ db, home, log, maintenance }) };
}

/** An offsite clone of a local bare remote; its hooks point at a missing folder so the user's global hooks never run (docs/known-issues.md). */
async function withRemote(home: string): Promise<string> {
  const remote = join(tempDir('ip-runner-remote-'), 'remote.git');
  sh(['init', '--bare', '--initial-branch=main', remote]);
  await initOffsite(home, remote);
  sh(['config', 'core.hooksPath', join(home, 'offsite', '.git', 'no-hooks')], join(home, 'offsite'));
  return remote;
}

describe('backup runner', { timeout: 120_000 }, () => {
  it('not set up still writes a snapshot, and says how to set up', async () => {
    const { home, runner } = setup();
    const result = await runner.backUpNow();
    expect(result).toMatchObject({ status: 'not set up', snapshot: 'written' });
    expect(result.message).toBe('Took a snapshot. The off-machine copy is not set up: run inprogress backup --init <remote url>');
    expect(readdirSync(join(home, 'backups')).filter((f) => f.endsWith('.db'))).toHaveLength(1);
    expect(runner.running()).toBe(false);
  });

  it('a second backUpNow while the first runs answers busy, and a tick does nothing', async () => {
    const { runner, maintenance } = setup();
    const first = runner.backUpNow();
    expect(runner.running()).toBe(true);
    expect(await runner.backUpNow()).toMatchObject({ status: 'busy', message: 'Another backup is running: try again in a few minutes' });
    await runner.tick();
    expect(maintenance).not.toHaveBeenCalled();
    await first;
    expect(runner.running()).toBe(false);
    // Once it is done a tick runs again.
    await runner.tick();
    expect(maintenance).toHaveBeenCalledTimes(1);
  });

  it('answers busy while another process holds the repo lock', async () => {
    const { home, runner } = setup();
    await withRemote(home);
    writeFileSync(join(home, 'offsite', '.git', 'inprogress-backup.lock'), 'someone else');
    expect(await runner.backUpNow()).toMatchObject({ status: 'busy' });
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  it('commits once to the remote and says Backed up and pushed.', async () => {
    const { home, runner } = setup();
    const remote = await withRemote(home);
    const result = await runner.backUpNow();
    expect(result).toEqual({ status: 'ok', snapshot: 'written', message: 'Backed up and pushed.' });
    const subjects = sh(['--git-dir', remote, 'log', '--format=%s', 'main']).split('\n');
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatch(/^Backup /);
    // A second click pushes a second commit: Back up now is forced, and the snapshot is found unchanged.
    const again = await runner.backUpNow();
    expect(again).toMatchObject({ status: 'ok', snapshot: 'unchanged' });
    expect(sh(['--git-dir', remote, 'log', '--format=%s', 'main']).split('\n')).toHaveLength(2);
  });

  it('reports a push that fails with the error it logged', async () => {
    const { home, runner, lines } = setup();
    const remote = await withRemote(home);
    rmSync(remote, { recursive: true, force: true });
    const result = await runner.backUpNow();
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/Could not push the backup/);
    expect(lines.some((l) => l.startsWith('error: Could not push'))).toBe(true);
    expect(runner.running()).toBe(false);
  });

  it('reports a failed snapshot with the offsite outcome', async () => {
    const { home, db, runner } = setup();
    db.close();
    dbs.pop();
    const result = await runner.backUpNow();
    expect(result.status).toBe('failed');
    expect(result.snapshot).toBe('failed');
    expect(result.message).toMatch(/^The snapshot failed: /);
    expect(home).toBeTruthy();
  });
});
