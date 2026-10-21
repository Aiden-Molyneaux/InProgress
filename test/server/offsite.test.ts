import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialArgs, takeLock } from '../../src/server/offsite';

// The cases that run git (a remote, a clone, a push) are in test/slow/offsite.test.ts.
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

describe('offsite backup', () => {
  it('a lock taken over as stale is not deleted by the first holder releasing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-off-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.git'));
    const lock = join(dir, '.git', 'inprogress-backup.lock');
    const first = takeLock(dir)!;
    expect(takeLock(dir)).toBeUndefined();
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
    const second = takeLock(dir)!;
    expect(second).toBeDefined();
    first();
    expect(existsSync(lock)).toBe(true);
    second();
    expect(existsSync(lock)).toBe(false);
  });

  it('adds the gh credential helper for a github https remote only', () => {
    expect(credentialArgs('https://github.com/aiden/inprogress-backup.git')[3]).toContain('gh auth token --user aiden');
    expect(credentialArgs('https://github.com/Aiden-M1/x.git')[3]).toContain('--user Aiden-M1');
    expect(credentialArgs('https://github.com/a b/x.git')).toEqual([]);
    expect(credentialArgs('C:/some/bare.git')).toEqual([]);
    expect(credentialArgs('git@github.com:aiden/x.git')).toEqual([]);
  });
});
