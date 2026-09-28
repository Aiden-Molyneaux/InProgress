import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
