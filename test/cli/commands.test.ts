import { mkdirSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install } from '../../src/cli/claude-config';
import { runCli } from '../../src/cli/commands';
import { runChecks } from '../../src/cli/doctor';
import { edgeArgs } from '../../src/cli/open';
import { ensureToken } from '../../src/lib/home';
import { buildApp } from '../../src/server/app';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { createProject } from '../../src/server/repo/projects';

let base = '';
let home = '';
let close: () => Promise<unknown>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ip-cli-'));
  const token = ensureToken(home);
  const ctx = createCtx(openDb(join(home, 'inprogress.db')));
  createProject(ctx, 'test', { name: 'CLI Demo' });
  const app = buildApp({ ctx, token, uiToken: 'u', version: '0.1.0' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  process.env.INPROGRESS_PORT = String(port);
  process.env.INPROGRESS_HOME = home;
  close = () => app.close();
});
afterAll(() => close());

function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
}

describe('runCli', () => {
  it('prints status and outlines', async () => {
    const s = capture();
    expect(await runCli(['status'], s.out)).toBe(0);
    expect(s.lines.join('\n')).toContain('cli-demo');
    const o = capture();
    expect(await runCli(['outline', 'cli-demo'], o.out)).toBe(0);
    expect(o.lines.join('\n')).toContain('Project CLI Demo (slug cli-demo)');
    const bad = capture();
    expect(await runCli(['outline'], bad.out)).toBe(1);
    expect(await runCli(['nonsense'], capture().out)).toBe(1);
  });

  it('builds the Edge app-window arguments', () => {
    expect(edgeArgs('http://127.0.0.1:4317')).toEqual(['--app=http://127.0.0.1:4317', '--window-size=520,1000']);
  });
});

describe('doctor checks', () => {
  it('passes after install and reports what is missing before it', async () => {
    const claude = mkdtempSync(join(tmpdir(), 'ip-doc-'));
    const repo = process.cwd().replace(/\\/g, '/');
    const before = await runChecks({ baseUrl: base, home, claudeDir: claude, repo, skipMcp: true });
    expect(before.find((c) => c.name === 'Server')).toMatchObject({ ok: true });
    expect(before.find((c) => c.name === 'Hooks')).toMatchObject({ ok: false });
    mkdirSync(join(claude, 'agents'), { recursive: true });
    install({ repo, claudeDir: claude, stamp: 'x' });
    const after = await runChecks({ baseUrl: base, home, claudeDir: claude, repo, skipMcp: true });
    const failing = after.filter((c) => !c.ok && !c.warnOnly).map((c) => `${c.name}: ${c.detail}`);
    expect(failing).toEqual([]);
  });
});
