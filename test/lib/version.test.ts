import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBuild, sameBuild } from '../../src/lib/version';

const dir = mkdtempSync(join(tmpdir(), 'ip-build-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('build identity', () => {
  it('reads build.json, and is null when it is missing or broken', () => {
    const file = join(dir, 'build.json');
    expect(readBuild(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ sha: 'abc1234', dirty: false, builtAt: '2026-10-02T12:00:00.000Z' }));
    expect(readBuild(file)).toEqual({ sha: 'abc1234', dirty: false, builtAt: '2026-10-02T12:00:00.000Z' });
    writeFileSync(file, '{ not json');
    expect(readBuild(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ sha: 7 }));
    expect(readBuild(file)).toBeNull();
  });

  it('compares builds by sha and build time, treating "no build info" as unknown', () => {
    const a = { sha: 'abc1234', dirty: false, builtAt: '2026-10-02T12:00:00.000Z' };
    expect(sameBuild(a, { ...a })).toBe(true);
    expect(sameBuild(a, { ...a, builtAt: '2026-10-02T12:05:00.000Z' })).toBe(false);
    expect(sameBuild(a, { ...a, sha: 'def5678' })).toBe(false);
    expect(sameBuild(null, a)).toBe(true);
    expect(sameBuild(a, null)).toBe(true);
  });
});
