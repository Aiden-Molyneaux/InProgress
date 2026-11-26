import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LANDING_HELD, LANDING_USAGE, runLanding } from '../../src/cli/landing';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { ensureToken } from '../../src/lib/home';
import { buildApp } from '../../src/server/app';
import { openDb, type DB } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { leadAllow } from '../../src/server/lead-commands';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject, setProjectLead } from '../../src/server/repo/projects';
import { commit, lines, makeRepo, write, type TestRepo } from '../git-repo';

let dir = '';
let db: DB;
let close: () => Promise<unknown>;
let conn: { baseUrl: string; token: string };
let repo: TestRepo;
let stepId = 0;
let strayId = 0;

beforeAll(async () => {
  repo = makeRepo();
  dir = mkdtempSync(join(tmpdir(), 'ip-landing-cli-'));
  const token = ensureToken(dir);
  db = openDb(join(dir, 'inprogress.db'));
  const ctx = createCtx(db);
  const game = createProject(ctx, 'test', { name: 'InGame' });
  setProjectLead(ctx, 'window', game.slug, 'Progresser');
  leadAllow(ctx, game.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, { switch: 'landing', aidenWords: 'yes' });
  const [step] = addNodes(ctx, 'test', { parentId: game.rootNodeId, nodes: [{ title: 'Build tabs' }] });
  stepId = step.id;
  strayId = stepId + 1000;
  const app = buildApp({ ctx, token, uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  conn = { baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, token };
  close = () => app.close();
});
afterAll(async () => {
  await close();
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  repo.cleanup();
});

async function landing(args: string[], folder = repo.wt): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runLanding(args, (l) => lines.push(l), conn, folder);
  return { code, lines };
}

describe('inprogress landing', () => {
  it('prints Clear to land and exits 0 for a change off the risk list', async () => {
    write(repo.wt, 'web/app.ts', lines(8, 'feature'));
    commit(repo.wt, 'feature');
    expect(await landing([String(stepId), '--action', 'merge'])).toEqual({ code: 0, lines: ['Clear to land'] });
    expect(await landing([`#${stepId}`, '--action', 'merge', '--branch', 'feature'], repo.main)).toEqual({ code: 0, lines: ['Clear to land'] });
  });

  it("prints the hold and exits 3 for what is Aiden's", async () => {
    expect(await landing([String(stepId), '--action', 'publish'])).toEqual({ code: LANDING_HELD, lines: ["hold: this is Aiden's (a publish goes out in his name)"] });
    write(repo.wt, 'src/hooks/x.ts', lines(8, 'feature'));
    commit(repo.wt, 'hooks');
    expect(await landing([String(stepId), '--action', 'merge'])).toEqual({ code: 3, lines: ["hold: this is Aiden's (it touches src/hooks/x.ts)"] });
  });

  it('exits 1 with a plain line for a step that is not there, a folder that is not a checkout, an unknown action, a missing flag', async () => {
    const stray = await landing([String(strayId), '--action', 'merge']);
    expect(stray.code).toBe(1);
    expect(stray.lines[0]).toMatch(/not found/i);
    const plain = mkdtempSync(join(tmpdir(), 'ip-notgit-'));
    try {
      expect(await landing([String(stepId), '--action', 'merge'], plain)).toEqual({ code: 1, lines: [`${plain} is not a git checkout.`] });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    const unknown = await landing([String(stepId), '--action', 'ship']);
    expect(unknown.code).toBe(1);
    expect(unknown.lines).toEqual(['ship is not an action: give merge, deploy, push, publish, push-public', LANDING_USAGE]);
    expect((await landing([String(stepId)])).lines).toEqual(['Missing --action', LANDING_USAGE]);
    expect((await landing(['abc', '--action', 'merge'])).lines[0]).toBe('abc is not a step: give it as #42 or 42');
    expect((await landing([String(stepId), '--action', 'merge', '--flag'])).lines[0]).toBe('Unknown flag --flag');
  });
});
