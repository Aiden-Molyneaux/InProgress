import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

export function write(dir: string, rel: string, text: string): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export const lines = (n: number, tag: string): string => `${Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join('\n')}\n`;

export function commit(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

export interface TestRepo {
  /** The main checkout, on main, with dist/build.json at the base commit. */
  main: string;
  /** A worktree of the same repository on branch `feature`, the folder a session works in. */
  wt: string;
  base: string;
  root: string;
  cleanup: () => void;
}

/**
 * A temporary repository: main with a few files, a feature worktree beside it, refs/remotes/origin/feature at the base (a
 * fake origin: nothing is fetched or pushed), an origin URL on github.com, and dist/build.json in the main checkout.
 */
export function makeRepo(): TestRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ip-landing-')));
  const main = join(root, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'core.autocrlf', 'false');
  // The live build is never committed: a commit of the tree would otherwise carry it.
  write(main, '.git/info/exclude', 'dist/\n');
  write(main, 'web/app.ts', lines(5, 'base'));
  write(main, 'README.md', lines(3, 'readme'));
  write(main, 'src/hooks/x.ts', lines(5, 'base'));
  const base = commit(main, 'base');
  git(main, 'config', 'remote.origin.url', 'https://github.com/acme/widgets.git');
  git(main, 'update-ref', 'refs/remotes/origin/main', base);
  git(main, 'update-ref', 'refs/remotes/origin/feature', base);
  write(main, 'dist/build.json', JSON.stringify({ sha: base, dirty: false, builtAt: '2026-11-25T00:00:00.000Z' }));
  const wt = join(root, 'wt');
  git(main, 'worktree', 'add', '-q', wt, '-b', 'feature');
  return { main, wt, base, root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
