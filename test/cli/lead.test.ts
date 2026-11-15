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
import { raiseAsk } from '../../src/server/repo/asks';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject, setProjectLead } from '../../src/server/repo/projects';

let dir = '';
let db: DB;
let close: () => Promise<unknown>;
let conn: { baseUrl: string; token: string };
let steps: { first: number; second: number; third: number; fourth: number };
let asks: { stdin: number; plain: number };
const saved = { port: process.env.INPROGRESS_PORT, home: process.env.INPROGRESS_HOME };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ip-lead-'));
  const token = ensureToken(dir);
  db = openDb(join(dir, 'inprogress.db'));
  const ctx = createCtx(db);
  const game = createProject(ctx, 'test', { name: 'InGame' });
  createProject(ctx, 'test', { name: 'Leaderless' });
  setProjectLead(ctx, 'window', 'ingame', 'Progresser');
  const [first, second, third, fourth] = addNodes(ctx, 'test', {
    parentId: game.rootNodeId,
    nodes: [
      { title: 'Dark mode', origin: 'proposed' },
      { title: 'Sound', origin: 'proposed' },
      { title: 'Play app signing' },
      { title: 'Privacy page' },
    ],
  });
  steps = { first: first.id, second: second.id, third: third.id, fourth: fourth.id };
  asks = {
    stdin: raiseAsk(ctx, 'test', { nodeId: third.id, kind: 'question', text: 'Which keystore?' }).id,
    plain: raiseAsk(ctx, 'test', { nodeId: fourth.id, kind: 'question', text: 'Which host?' }).id,
  };
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

  it('prints the brief first, then posts seen; a failure there prints its sentence and exits 1', async () => {
    const c = capture();
    expect(await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', '1', '--mark'], c.out, { ...conn, token: 'wrong' })).toBe(1);
    expect(c.lines[0]).toContain('Lead brief · InGame');
    expect(c.lines[1]).toBe('Missing or invalid InProgress token');
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

  it('says why and exits 1 when the server will not start, without asking it anything', async () => {
    const c = capture();
    const down = { baseUrl: 'http://127.0.0.1:1', token: 'x', bringUp: async () => 'InProgress did not start. See server.log' };
    expect(await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', '1'], c.out, down)).toBe(1);
    expect(c.lines).toEqual(['InProgress did not start. See server.log']);
  });

  it('starts a stopped server through runCli, but not for arguments it cannot use', async () => {
    const port = process.env.INPROGRESS_PORT;
    process.env.INPROGRESS_PORT = '1';
    try {
      let started = 0;
      const stopped = capture();
      expect(await runCli(['lead', 'brief', 'ingame', '--as', 'Progresser', '--instructions', '1'], stopped.out, { ensureServer: async () => (started++, false) })).toBe(1);
      expect(started).toBe(1);
      expect(stopped.lines[0]).toMatch(/^InProgress did not start\. See /);
      const bad = capture();
      expect(await runCli(['lead', 'brief', 'ingame'], bad.out, { ensureServer: async () => (started++, false) })).toBe(1);
      expect(started).toBe(1);
      expect(bad.lines.at(-1)).toBe(LEAD_USAGE);
    } finally {
      process.env.INPROGRESS_PORT = port;
    }
  });

  it('leaves a running server alone', async () => {
    let started = 0;
    const c = capture();
    expect(await runCli(['lead', 'brief', 'ingame', '--as', 'Progresser', '--instructions', '1'], c.out, { ensureServer: async () => (started++, true) })).toBe(0);
    expect(started).toBe(0);
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

describe("inprogress lead's commands", () => {
  const WHO = ['--as', 'Progresser', '--instructions', '1'];
  /** An io whose stdin is `text` and whose files are `files`; it counts the reads. */
  const io = (text = '', files: Record<string, string> = {}) => {
    const reads = { stdin: 0, files: [] as string[] };
    return {
      reads,
      io: {
        stdin: async () => (reads.stdin++, text),
        readFile: (path: string) => {
          reads.files.push(path);
          if (!(path in files)) throw new Error(`ENOENT: no such file, open '${path}'`);
          return files[path];
        },
      },
    };
  };
  const run = async (args: string[], i = io().io) => {
    const c = capture();
    const code = await runLead(args, c.out, conn, i);
    return { code, lines: c.lines };
  };
  const row = (sql: string, id: number) => db.prepare(sql).get(id) as Record<string, unknown>;

  it("answer: reads Aiden's words from stdin with --aiden -, prints the sentence and exits 0", async () => {
    const stdin = io('Use the release keystore.\n');
    const res = await run(['answer', 'ingame', `a${asks.stdin}`, '--aiden', '-', ...WHO], stdin.io);
    expect(res).toEqual({ code: 0, lines: [`Answered a${asks.stdin} with Aiden's words.`] });
    expect(stdin.reads.stdin).toBe(1);
    expect(row('SELECT answer, answered_via FROM asks WHERE id = ?', asks.stdin)).toEqual({ answer: 'Use the release keystore.', answered_via: 'lead' });
  });

  it('answer: 7 and a7 name the same ask, and a refusal prints its sentence and exits 1', async () => {
    expect(await run(['answer', 'ingame', String(asks.plain), '--aiden', 'Netlify.', ...WHO])).toEqual({ code: 0, lines: [`Answered a${asks.plain} with Aiden's words.`] });
    expect(await run(['answer', 'ingame', `a${asks.plain}`, '--aiden', 'Vercel.', ...WHO])).toEqual({ code: 1, lines: ['Already answered: "Netlify.".'] });
  });

  it('park: 5 and #5 name the same step', async () => {
    expect(await run(['park', 'ingame', `#${steps.first}`, '--reason', 'Later', ...WHO])).toEqual({ code: 0, lines: [`Parked #${steps.first} Dark mode.`] });
    expect(await run(['park', 'ingame', String(steps.first), ...WHO])).toEqual({ code: 1, lines: [`#${steps.first} is already parked.`] });
  });

  it('drop: prints the sentence, with the reason from stdin', async () => {
    const stdin = io('Nobody wants it.');
    expect(await run(['drop', 'ingame', String(steps.second), '--reason', '-', ...WHO], stdin.io)).toEqual({ code: 0, lines: [`Dropped #${steps.second} Sound.`] });
    expect(db.prepare("SELECT text FROM lead_events WHERE kind = 'drop' ORDER BY id DESC").pluck().get()).toBe('Nobody wants it.');
  });

  it('promise and kept: 7 and a7 name the same ask', async () => {
    const due = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const promised = await run(['promise', 'ingame', 'Send Aiden the draft', '--due', due, '--step', `#${steps.fourth}`, ...WHO]);
    expect(promised.code).toBe(0);
    const m = /^Promised a(\d+), due \d{4}-\d\d-\d\d \d\d:\d\d\.$/.exec(promised.lines[0]);
    expect(m, promised.lines[0]).not.toBeNull();
    const id = Number(m![1]);
    expect(row('SELECT owner, node_id FROM asks WHERE id = ?', id)).toEqual({ owner: 'lead', node_id: steps.fourth });
    expect(await run(['kept', 'ingame', String(id), '--note', 'Sent.', ...WHO])).toEqual({ code: 0, lines: [`Kept a${id}.`] });
    expect(await run(['kept', 'ingame', `a${id}`, ...WHO])).toEqual({ code: 1, lines: [`a${id} is already cleared.`] });
  });

  it('intent: reads the record from a file, or from stdin with -', async () => {
    const record = '## Goal\nShip the game.\n\n## Phase\nBeta.\n';
    const files = io('', { 'C:/notes/intent.md': record });
    expect(await run(['intent', 'ingame', 'C:/notes/intent.md', ...WHO], files.io)).toEqual({ code: 0, lines: [`Intent record replaced (${record.length} characters).`] });
    expect(files.reads.files).toEqual(['C:/notes/intent.md']);
    const piped = `${record}More.\n`;
    const stdin = io(piped);
    expect(await run(['intent', 'ingame', '-', ...WHO], stdin.io)).toEqual({ code: 0, lines: [`Intent record replaced (${piped.length} characters).`] });
    expect(db.prepare("SELECT intent FROM projects WHERE slug = 'ingame'").pluck().get()).toBe(piped);
  });

  it('intent: a file it cannot read says so and exits 1', async () => {
    const res = await run(['intent', 'ingame', 'C:/nowhere.md', ...WHO]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain('C:/nowhere.md');
  });

  it('prints the usage and exits 1 for arguments it cannot use, reading no stdin', async () => {
    for (const args of [
      ['answer', 'ingame', 'a1', ...WHO],
      ['answer', 'ingame', '--aiden', 'Yes.', ...WHO],
      ['answer', 'ingame', 'x7', '--aiden', 'Yes.', ...WHO],
      ['park', 'ingame', ...WHO],
      ['park', 'ingame', '5', '--note', 'x', ...WHO],
      ['drop', 'ingame', '5', ...WHO],
      ['drop', 'ingame', '5', '--reason', '-', '--aiden', '-', ...WHO],
      ['promise', 'ingame', 'Send it', ...WHO],
      ['promise', 'ingame', 'Send it', '--due', 'x', '--step', 'a5', ...WHO],
      ['kept', 'ingame', '#5', ...WHO],
      ['intent', 'ingame', ...WHO],
      ['park', 'ingame', '5', '--as', 'Progresser'],
      ['bogus', 'ingame'],
    ]) {
      const stdin = io('words');
      const res = await run(args, stdin.io);
      expect(res.code, args.join(' ')).toBe(1);
      expect(res.lines.at(-1), args.join(' ')).toBe(LEAD_USAGE);
      expect(stdin.reads.stdin, args.join(' ')).toBe(0);
    }
  });

  it('lists brief and the six commands in the usage, one line each', () => {
    const lines = LEAD_USAGE.split('\n');
    expect(lines).toHaveLength(8);
    expect(lines.slice(1).map((l) => l.trim().split(' ')[2])).toEqual(['brief', 'answer', 'park', 'drop', 'promise', 'kept', 'intent']);
  });
});
