import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportStartupFailure } from '../../src/server/startup';

const dirs: string[] = [];
function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ip-start-'));
  dirs.push(dir);
  return join(dir, 'server.log');
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('reportStartupFailure', () => {
  it('exits quietly when another InProgress server answers (this start lost a race)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = logFile();
    expect(await reportStartupFailure(new Error('table projects already exists'), log, async () => true)).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it('otherwise writes one clear line to server.log and stderr, and exits 1', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = logFile();
    const err = new Error('InProgress database schema v9 is newer than this build (v1);\nupdate InProgress');
    expect(await reportStartupFailure(err, log, async () => false)).toBe(1);
    const line = 'InProgress: the server did not start: InProgress database schema v9 is newer than this build (v1); update InProgress';
    expect(readFileSync(log, 'utf8')).toMatch(new RegExp(`^\\S+ ${line.replace(/[.()]/g, '\\$&')}\\n$`));
    expect(errors.mock.calls).toEqual([[line]]);
  });

  it('writes the line once when stderr already goes to server.log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = logFile();
    const fd = openSync(log, 'a');
    try {
      expect(await reportStartupFailure(new Error('boom'), log, async () => false, fd)).toBe(1);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(log, 'utf8')).toBe('');
    expect(errors.mock.calls).toEqual([['InProgress: the server did not start: boom']]);
  });
});
