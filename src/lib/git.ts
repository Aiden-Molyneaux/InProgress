import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Current git branch for `cwd`, found by walking up to `.git` and reading HEAD.
 * No git process is spawned. `ceiling` stops the walk (used by tests).
 */
export function detectBranch(cwd: string, ceiling?: string): string | undefined {
  try {
    let dir = resolve(cwd);
    const stop = ceiling ? resolve(ceiling) : undefined;
    for (;;) {
      const dotGit = join(dir, '.git');
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (!m) return undefined;
          const target = m[1].trim();
          gitDir = isAbsolute(target) ? target : resolve(dir, target);
        }
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref && ref[1] !== '.invalid' ? ref[1] : undefined;
      }
      if (stop && dir === stop) return undefined;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}
