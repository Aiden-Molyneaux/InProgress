import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectBranch } from '../../src/lib/git';

function repo(head: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ip-git-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), head);
  return root;
}

describe('detectBranch', () => {
  it('reads the branch from a parent folder', () => {
    const root = repo('ref: refs/heads/feature/VCAD-978-fix\n');
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(detectBranch(nested, root)).toBe('feature/VCAD-978-fix');
  });
  it('returns undefined for a detached HEAD', () => {
    const root = repo('3f2a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b\n');
    expect(detectBranch(root, root)).toBeUndefined();
  });
  it('treats the reftable HEAD stub as no branch', () => {
    const root = repo('ref: refs/heads/.invalid\n');
    expect(detectBranch(root, root)).toBeUndefined();
  });
  it('follows a worktree .git file', () => {
    const main = repo('ref: refs/heads/main\n');
    const wtGit = join(main, '.git', 'worktrees', 'wt1');
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/wt-branch\n');
    const wt = mkdtempSync(join(tmpdir(), 'ip-wt-'));
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
    expect(detectBranch(wt, wt)).toBe('wt-branch');
  });
  it('returns undefined when no repo is found below the ceiling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-norepo-'));
    expect(detectBranch(dir, dir)).toBeUndefined();
  });
});
