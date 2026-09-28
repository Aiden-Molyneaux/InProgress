import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { baseUrl, ensureToken, homeDir, port, readToken } from '../../src/lib/home';

afterEach(() => {
  delete process.env.INPROGRESS_HOME;
  delete process.env.INPROGRESS_PORT;
});

describe('home', () => {
  it('honours INPROGRESS_HOME and INPROGRESS_PORT', () => {
    process.env.INPROGRESS_HOME = 'C:/tmp/ip-home';
    process.env.INPROGRESS_PORT = '4399';
    expect(homeDir()).toBe('C:/tmp/ip-home');
    expect(port()).toBe(4399);
    expect(baseUrl()).toBe('http://127.0.0.1:4399');
  });
  it('defaults the port to 4317 when unset or invalid', () => {
    expect(port()).toBe(4317);
    process.env.INPROGRESS_PORT = 'abc';
    expect(port()).toBe(4317);
  });
  it('creates the token once and then reuses it', () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-home-'));
    expect(readToken(home)).toBeUndefined();
    const t = ensureToken(home);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureToken(home)).toBe(t);
    expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(t);
  });
  it('adopts the token of a process that created the file first', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-home-'));
    const file = join(home, 'token');
    const winner = 'ab'.repeat(32);
    // The winner has created the file but not written its token yet.
    writeFileSync(file, '');
    const worker = new Worker(
      `const { writeFileSync } = require('node:fs');
       const { workerData } = require('node:worker_threads');
       setTimeout(() => writeFileSync(workerData.file, workerData.content), 50);`,
      { eval: true, workerData: { file, content: `${winner}\n` } },
    );
    await once(worker, 'online');
    expect(ensureToken(home)).toBe(winner);
    expect(readFileSync(file, 'utf8').trim()).toBe(winner);
    await once(worker, 'exit');
  });
  it('replaces an empty token file left by a crashed writer', () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-home-'));
    writeFileSync(join(home, 'token'), '');
    const t = ensureToken(home);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(t);
  });
});
