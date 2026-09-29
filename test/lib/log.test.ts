import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendLog } from '../../src/lib/log';

const MiB = 1024 * 1024;
const dirs: string[] = [];
function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ip-log-'));
  dirs.push(dir);
  return join(dir, 'logs', 'hooks.log');
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('appendLog', () => {
  it('appends timestamped lines, creating the folder', () => {
    const file = logFile();
    appendLog(file, 'first');
    appendLog(file, 'second');
    expect(readFileSync(file, 'utf8')).toMatch(/^\S+Z first\n\S+Z second\n$/);
  });

  it('moves a log past 1 MiB to <name>.1, replacing an older one, and starts fresh', () => {
    const file = logFile();
    appendLog(file, 'create the folder');
    writeFileSync(`${file}.1`, 'older rotation\n');
    writeFileSync(file, 'x'.repeat(MiB + 1));
    appendLog(file, 'after rotation');
    expect(statSync(`${file}.1`).size).toBe(MiB + 1);
    expect(readFileSync(file, 'utf8')).toMatch(/^\S+Z after rotation\n$/);
  });

  it('keeps appending to a log of exactly 1 MiB', () => {
    const file = logFile();
    appendLog(file, 'create the folder');
    writeFileSync(file, 'x'.repeat(MiB));
    appendLog(file, 'still here');
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(statSync(file).size).toBeGreaterThan(MiB);
  });
});
