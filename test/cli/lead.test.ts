import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/commands';
import { LEAD_USAGE, runLead } from '../../src/cli/lead';
import { ApiClientError } from '../../src/lib/client';
import { ensureToken } from '../../src/lib/home';
import { buildApp } from '../../src/server/app';
import { openDb, type DB } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { noLeadNamed } from '../../src/server/lead';
import { createProject, setProjectLead } from '../../src/server/repo/projects';

let dir = '';
let db: DB;
let close: () => Promise<unknown>;
let conn: { baseUrl: string; token: string };
const saved = { port: process.env.INPROGRESS_PORT, home: process.env.INPROGRESS_HOME };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ip-lead-'));
  const token = ensureToken(dir);
  db = openDb(join(dir, 'inprogress.db'));
  const ctx = createCtx(db);
  createProject(ctx, 'test', { name: 'InGame' });
  createProject(ctx, 'test', { name: 'Leaderless' });
  setProjectLead(ctx, 'window', 'ingame', 'Progresser');
  const app = buildApp({ ctx, token, uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  conn = { baseUrl: `http://127.0.0.1:${port}`, token };
  process.env.INPROGRESS_PORT = String(port);
  process.env.INPROGRESS_HOME = dir;
  close = () => app.close();
});
afterAll(async () => {
  await close();
  db.close();
  for (const [k, v] of [['INPROGRESS_PORT', saved.port], ['INPROGRESS_HOME', saved.home]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
}

describe('inprogress lead brief', () => {
  it("prints the route's text, and with --json the brief", async () => {
    const text = capture();
    expect(await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', '1'], text.out, conn)).toBe(0);
    expect(text.lines).toHaveLength(1);
    expect(text.lines[0].split('\n')[0]).toMatch(/^Lead brief · InGame · .* · instructions v1 \(yours: v1\)$/);
    expect(text.lines[0]).toContain('In flight (0 of 3):');

    const json = capture();
    expect(await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', '1', '--json', '--mark'], json.out, conn)).toBe(0);
    const brief = JSON.parse(json.lines[0]);
    expect(brief).toMatchObject({ project: { slug: 'ingame', lead: 'Progresser' }, instructions: { current: 1, yours: 1 }, inFlight: [] });
  });

  it('marks the look only with --mark', async () => {
    const seen = () => db.prepare("SELECT lead_seen_at FROM projects WHERE slug = 'ingame'").pluck().get();
    const before = seen();
    await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', '1'], () => {}, conn);
    expect(seen()).toBe(before);
    await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', '1', '--mark'], () => {}, conn);
    expect(seen()).not.toBe(before);
  });

  it('prints the usage and exits 1 for a missing --as or --instructions, a bad number or another subcommand', async () => {
    for (const args of [
      ['brief', 'ingame', '--instructions', '1'],
      ['brief', 'ingame', '--as', 'Progresser'],
      ['brief', 'ingame', '--as', 'Progresser', '--instructions', 'x'],
      ['brief', '--as', 'Progresser', '--instructions', '1'],
      ['answer', 'ingame'],
      [],
    ]) {
      const c = capture();
      expect(await runLead(args, c.out, conn), args.join(' ')).toBe(1);
      expect(c.lines.at(-1)).toBe(LEAD_USAGE);
    }
  });

  it("prints the server's refusal and exits 1 for a project with no lead or another lead", async () => {
    for (const [project, as] of [['leaderless', 'Progresser'], ['ingame', 'Rich']]) {
      const c = capture();
      expect(await runLead(['brief', project, '--as', as, '--instructions', '1'], c.out, conn)).toBe(1);
      expect(c.lines[0]).toBe(noLeadNamed(as));
    }
  });

  it('rethrows an unreachable server for main.ts to print', async () => {
    await expect(runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', '1'], () => {}, { baseUrl: 'http://127.0.0.1:1', token: 'x' })).rejects.toBeInstanceOf(ApiClientError);
  });

  it('is dispatched by runCli, and the usage names lead', async () => {
    const c = capture();
    expect(await runCli(['lead', 'brief', 'ingame', '--as', 'progresser', '--instructions', '1'], c.out)).toBe(0);
    expect(c.lines[0]).toContain('Lead brief · InGame');
    const usage = capture();
    await runCli(['nonsense'], usage.out);
    expect(usage.lines[0]).toContain('lead brief <project> --as <name> --instructions <n> [--mark] [--json]');
  });
});
