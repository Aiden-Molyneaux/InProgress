import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/commands';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { LEAD_TIMEOUT, LEAD_USAGE, RELAY_NO_ANSWER, RELAY_TIMEOUT_MS, START_NO_ANSWER, runLead } from '../../src/cli/lead';
import { TASKS_NOT_RUNNING_HINT } from '../../src/cli/tasks';
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
    expect(await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)], text.out, conn)).toBe(0);
    expect(text.lines).toHaveLength(1);
    expect(text.lines[0].split('\n')[0]).toMatch(/^Lead brief · InGame · .* · instructions v6 \(yours: v6\)$/);
    expect(text.lines[0]).toContain('In flight (0 of 3):');

    const json = capture();
    expect(await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION), '--json', '--mark'], json.out, conn)).toBe(0);
    const brief = JSON.parse(json.lines[0]);
    expect(brief).toMatchObject({ project: { slug: 'ingame', lead: 'Progresser' }, instructions: { current: LEAD_INSTRUCTIONS_VERSION, yours: LEAD_INSTRUCTIONS_VERSION }, inFlight: [] });
  });

  it('marks the look only with --mark', async () => {
    const seen = () => db.prepare("SELECT lead_seen_at FROM projects WHERE slug = 'ingame'").pluck().get();
    const before = seen();
    await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)], () => {}, conn);
    expect(seen()).toBe(before);
    await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION), '--mark'], () => {}, conn);
    expect(seen()).not.toBe(before);
  });

  it('prints the brief first, then posts seen; a failure there prints its sentence and exits 1', async () => {
    const c = capture();
    expect(await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION), '--mark'], c.out, { ...conn, token: 'wrong' })).toBe(1);
    expect(c.lines[0]).toContain('Lead brief · InGame');
    expect(c.lines[1]).toBe('Missing or invalid InProgress token');
  });

  it('prints the usage and exits 1 for a missing --as or --instructions, a bad number or another subcommand', async () => {
    for (const args of [
      ['brief', 'ingame', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)],
      ['brief', 'ingame', '--as', 'Progresser'],
      ['brief', 'ingame', '--as', 'Progresser', '--instructions', 'x'],
      ['brief', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)],
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
      expect(await runLead(['brief', project, '--as', as, '--instructions', String(LEAD_INSTRUCTIONS_VERSION)], c.out, conn)).toBe(1);
      expect(c.lines[0]).toBe(noLeadNamed(as));
    }
  });

  it('rethrows an unreachable server for main.ts to print', async () => {
    await expect(runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)], () => {}, { baseUrl: 'http://127.0.0.1:1', token: 'x' })).rejects.toBeInstanceOf(ApiClientError);
  });

  it('says why and exits 1 when the server will not start, without asking it anything', async () => {
    const c = capture();
    const down = { baseUrl: 'http://127.0.0.1:1', token: 'x', bringUp: async () => 'InProgress did not start. See server.log' };
    expect(await runLead(['brief', 'ingame', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)], c.out, down)).toBe(1);
    expect(c.lines).toEqual(['InProgress did not start. See server.log']);
  });

  it('starts a stopped server through runCli, but not for arguments it cannot use', async () => {
    const port = process.env.INPROGRESS_PORT;
    process.env.INPROGRESS_PORT = '1';
    try {
      let started = 0;
      const stopped = capture();
      expect(await runCli(['lead', 'brief', 'ingame', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)], stopped.out, { ensureServer: async () => (started++, false) })).toBe(1);
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
    expect(await runCli(['lead', 'brief', 'ingame', '--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)], c.out, { ensureServer: async () => (started++, true) })).toBe(0);
    expect(started).toBe(0);
  });

  it('is dispatched by runCli, and the usage names lead', async () => {
    const c = capture();
    expect(await runCli(['lead', 'brief', 'ingame', '--as', 'progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)], c.out)).toBe(0);
    expect(c.lines[0]).toContain('Lead brief · InGame');
    const usage = capture();
    await runCli(['nonsense'], usage.out);
    expect(usage.lines[0]).toContain('lead brief <project> --as <name> --instructions <n> [--mark] [--json]');
  });
});

describe('inprogress lead rules', () => {
  it('GETs the rules for the named lead and prints the text, with no --instructions', async () => {
    const c = capture();
    expect(await runLead(['rules', 'ingame', '--as', 'Progresser'], c.out, conn)).toBe(0);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0].split('\n')[0]).toBe('Rules for Progresser, the lead for InGame. Version 6.');
    expect(c.lines[0]).toContain(`lead brief ingame --as Progresser --instructions ${LEAD_INSTRUCTIONS_VERSION}`);
    // --instructions, when given, is ignored.
    const given = capture();
    expect(await runLead(['rules', 'ingame', '--as', 'progresser', '--instructions', '1'], given.out, conn)).toBe(0);
    expect(given.lines[0].split('\n')[0]).toBe('Rules for Progresser, the lead for InGame. Version 6.');
  });

  it('prints the three lines to paste with --bootstrap', async () => {
    const c = capture();
    expect(await runLead(['rules', 'ingame', '--as', 'Progresser', '--bootstrap'], c.out, conn)).toBe(0);
    const lines = c.lines[0].split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('You are Progresser, the lead for InGame.');
    expect(lines[2]).toMatch(/^node .*main\.js lead rules ingame --as Progresser$/);
  });

  it('refuses a name that is not the lead, with the no-lead sentence', async () => {
    const c = capture();
    expect(await runLead(['rules', 'ingame', '--as', 'Rich'], c.out, conn)).toBe(1);
    expect(c.lines[0]).toBe(noLeadNamed('Rich'));
  });

  it('prints the usage without --as, and a write command still needs --instructions', async () => {
    const c = capture();
    expect(await runLead(['rules', 'ingame'], c.out, conn)).toBe(1);
    expect(c.lines.at(-1)).toBe(LEAD_USAGE);
    const park = capture();
    expect(await runLead(['park', 'ingame', String(steps.first), '--as', 'Progresser'], park.out, conn)).toBe(1);
    expect(park.lines).toEqual(['Missing --instructions <n>', LEAD_USAGE]);
  });

  it('has the rules line first in the usage', () => {
    expect(LEAD_USAGE.split('\n')[1]).toBe('  inprogress lead rules <project> --as <name> [--bootstrap]');
  });
});

describe("inprogress lead's commands", () => {
  const WHO = ['--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)];
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
    const parked = await run(['park', 'ingame', `#${steps.first}`, '--reason', 'Later', ...WHO]);
    expect(parked.code).toBe(0);
    expect(parked.lines).toEqual([`Parked #${steps.first} Dark mode. Decision d${db.prepare("SELECT MAX(id) FROM lead_events WHERE kind = 'park'").pluck().get()}.`]);
    expect(await run(['park', 'ingame', String(steps.first), ...WHO])).toEqual({ code: 1, lines: [`#${steps.first} is already parked.`] });
  });

  it('drop: prints the sentence, with the reason from stdin', async () => {
    const stdin = io('Nobody wants it.');
    const dropped = await run(['drop', 'ingame', String(steps.second), '--reason', '-', ...WHO], stdin.io);
    expect(dropped.code).toBe(0);
    expect(dropped.lines[0]).toMatch(/^Dropped #\d+ Sound\. Decision d\d+\.$/);
    expect(db.prepare("SELECT text FROM lead_events WHERE kind = 'drop' ORDER BY id DESC").pluck().get()).toBe('Nobody wants it.');
  });

  it('answer --says: stores the answer his words accepted beside his words', async () => {
    const ask = raiseAsk(createCtx(db), 'test', { nodeId: steps.fourth, kind: 'question', text: 'Which region?' });
    expect(await run(['answer', 'ingame', String(ask.id), '--aiden', 'yes', '--says', 'eu-west', ...WHO])).toEqual({ code: 0, lines: [`Answered a${ask.id} with Aiden's words.`] });
    expect(row('SELECT answer FROM asks WHERE id = ?', ask.id)).toEqual({ answer: 'eu-west (Aiden said: "yes")' });
  });

  it('decide and undo: a7 and 7, d12 and 12, print the route sentence; a second undo prints its refusal', async () => {
    const ask = raiseAsk(createCtx(db), 'test', { nodeId: steps.fourth, kind: 'question', text: 'Which font?' });
    const decided = await run(['decide', 'ingame', `a${ask.id}`, '--answer', 'Inter', '--reason', 'Already in use', ...WHO]);
    const m = /^Decided a(\d+): decision d(\d+)\. No session is waiting on it\.$/.exec(decided.lines[0]);
    expect(decided.code).toBe(0);
    expect(m, decided.lines[0]).not.toBeNull();
    expect(Number(m![1])).toBe(ask.id);
    expect(row('SELECT answer, answered_via FROM asks WHERE id = ?', ask.id)).toEqual({ answer: 'Inter', answered_via: 'lead_decided' });
    const undone = await run(['undo', 'ingame', `d${m![2]}`, '--aiden', 'undo it', ...WHO]);
    expect(undone.code).toBe(0);
    expect(undone.lines[0]).toMatch(/^Undid d\d+: the question is Aiden's again as a\d+\. Your answer was: "Inter"\.$/);
    expect(await run(['undo', 'ingame', m![2], '--aiden', 'again', ...WHO])).toEqual({ code: 1, lines: [`d${m![2]} is already undone.`] });
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

  it('intent: with no file it reads the stored record back and sends nothing', async () => {
    const stdin = io('never read');
    const res = await run(['intent', 'ingame', ...WHO], stdin.io);
    expect(res.code).toBe(0);
    expect(res.lines).toEqual([db.prepare("SELECT intent FROM projects WHERE slug = 'ingame'").pluck().get()]);
    expect(stdin.reads.stdin).toBe(0);
    expect(await run(['intent', 'ingame', '--as', 'Rich', '--instructions', '4'])).toEqual({ code: 1, lines: [noLeadNamed('Rich')] });
  });

  it('step: prints the step record, as #5 or as 5, and refuses another name or a missing step', async () => {
    const a = await run(['step', 'ingame', `#${steps.fourth}`, ...WHO]);
    expect(a.code).toBe(0);
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0].split('\n')[0]).toBe(`#${steps.fourth} Privacy page · todo · origin asked`);
    expect(a.lines[0]).toContain('Asks (');
    expect(await run(['step', 'ingame', String(steps.fourth), ...WHO])).toEqual(a);
    expect(await run(['step', 'ingame', String(steps.fourth), '--as', 'Rich', '--instructions', '4'])).toEqual({ code: 1, lines: [noLeadNamed('Rich')] });
    expect((await run(['step', 'ingame', '999999', ...WHO])).code).toBe(1);
  });

  it('resource: r5 and 5 name the same document, and a missing one is refused', async () => {
    const res = await run(['resource', 'ingame', 'r999999', ...WHO]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("r999999 not found.");
    expect(await run(['resource', 'ingame', '999999', ...WHO])).toEqual(res);
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
      ['decide', 'ingame', 'a1', '--answer', 'x', ...WHO],
      ['decide', 'ingame', 'a1', '--reason', 'x', ...WHO],
      ['decide', 'ingame', 'x1', '--answer', 'x', '--reason', 'y', ...WHO],
      ['undo', 'ingame', 'd1', ...WHO],
      ['undo', 'ingame', 'a1', '--aiden', 'x', ...WHO],
      ['undo', 'ingame', '--aiden', 'x', ...WHO],
      ['park', 'ingame', '5', '--note', 'x', ...WHO],
      ['drop', 'ingame', '5', ...WHO],
      ['drop', 'ingame', '5', '--reason', '-', '--aiden', '-', ...WHO],
      ['promise', 'ingame', 'Send it', ...WHO],
      ['promise', 'ingame', 'Send it', '--due', 'x', '--step', 'a5', ...WHO],
      ['kept', 'ingame', '#5', ...WHO],
      ['step', 'ingame', ...WHO],
      ['step', 'ingame', 'x5', ...WHO],
      ['step', 'ingame', '5', '6', ...WHO],
      ['resource', 'ingame', '#5', ...WHO],
      ['resource', 'ingame', ...WHO],
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

  it('says a write that timed out may still have been applied, and exits 1 with no hint; brief and other failures are as before', async () => {
    // The client reads a fetch that throws a TimeoutError as its timeout (code TIMEOUT), as AbortSignal.timeout does.
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', async () => {
      throw timeout;
    });
    try {
      expect(await run(['park', 'ingame', String(steps.third), '--aiden', 'Park it.', ...WHO])).toEqual({ code: 1, lines: [LEAD_TIMEOUT] });
      expect(LEAD_TIMEOUT).toBe('InProgress did not answer in time. The command may still have been applied: read the brief before you try again.');
      // The brief changes nothing, so its timeout is rethrown for main.ts to print, as before.
      await expect(run(['brief', 'ingame', ...WHO])).rejects.toMatchObject({ status: 0, code: 'TIMEOUT' });
    } finally {
      vi.unstubAllGlobals();
    }
    // Nothing listening is not a timeout: a write rethrows it with the not-running hint, as before.
    await expect(runLead(['kept', 'ingame', 'a1', ...WHO], () => {}, { baseUrl: 'http://127.0.0.1:1', token: 'x' }, io().io)).rejects.toMatchObject({
      status: 0,
      hint: TASKS_NOT_RUNNING_HINT,
    });
  });

  it('lists the reads and the commands in the usage, one line each (intent has a read and a write form)', () => {
    const lines = LEAD_USAGE.split('\n');
    expect(lines).toHaveLength(18);
    expect(lines.slice(1).map((l) => l.trim().split(' ')[2])).toEqual(['rules', 'brief', 'step', 'resource', 'answer', 'decide', 'undo', 'park', 'drop', 'promise', 'kept', 'intent', 'intent', 'relay', 'start', 'allow', 'disallow']);
    expect(lines[15]).toBe('  inprogress lead start <project> <step id> [--aiden <words>] --as <name> --instructions <n>');
    expect(lines[16]).toBe('  inprogress lead allow <project> starts|landing --aiden <words> --as <name> --instructions <n>');
    expect(lines[17]).toBe('  inprogress lead disallow <project> starts|landing [--aiden <words>] --as <name> --instructions <n>');
    expect(lines[3]).toBe('  inprogress lead step <project> <step id> --as <name> --instructions <n>');
    expect(lines[4]).toBe('  inprogress lead resource <project> <document id> --as <name> --instructions <n>');
    expect(lines[5]).toBe('  inprogress lead answer <project> <ask id> --aiden <words> [--says <text>] --as <name> --instructions <n>');
    expect(lines[6]).toBe('  inprogress lead decide <project> <ask id> --answer <text> --reason <text> [--aiden <words>] --as <name> --instructions <n>');
    expect(lines[7]).toBe('  inprogress lead undo <project> <decision> --aiden <words> --as <name> --instructions <n>');
    expect(lines[12]).toBe('  inprogress lead intent <project> --as <name> --instructions <n>');
    expect(lines[13]).toBe('  inprogress lead intent <project> <file | -> --as <name> --instructions <n>');
    expect(lines[14]).toBe('  inprogress lead relay <project> <step id> <message | -> --as <name> --instructions <n>');
  });
});

describe('inprogress lead relay', () => {
  const WHO = ['--as', 'Progresser', '--instructions', String(LEAD_INSTRUCTIONS_VERSION)];
  type Sent = { url: string; body: unknown; timeoutMs: number | undefined };
  /** Stubs fetch to answer `text` and records what was posted, with the timeout the client asked for. */
  function stubbed(answer: () => Promise<Response>): Sent[] {
    const sent: Sent[] = [];
    let timeoutMs: number | undefined;
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeoutMs = ms;
      return real(ms);
    });
    vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
      sent.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body), timeoutMs });
      return answer();
    });
    return sent;
  }
  const delivered = async () => new Response(JSON.stringify({ text: 'Delivered to "Signing work".', sessionId: 's1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  const run = async (args: string[], stdin = '') => {
    const c = capture();
    let reads = 0;
    const code = await runLead(args, c.out, conn, { stdin: async () => (reads++, stdin), readFile: () => '' });
    return { code, lines: c.lines, reads };
  };

  it('posts the step and the message to the relay route, waiting RELAY_TIMEOUT_MS, and prints the sentence', async () => {
    const sent = stubbed(delivered);
    try {
      expect(await run(['relay', 'inprogress', '42', 'hi', ...WHO])).toEqual({ code: 0, lines: ['Delivered to "Signing work".'], reads: 0 });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
    expect(sent).toEqual([{ url: `${conn.baseUrl}/api/lead/inprogress/relay`, body: { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, stepId: 42, message: 'hi' }, timeoutMs: RELAY_TIMEOUT_MS }]);
    expect(RELAY_TIMEOUT_MS).toBe(75_000);
  });

  it('sends what stdin held for -, with the step given as #42', async () => {
    const sent = stubbed(delivered);
    let res;
    try {
      res = await run(['relay', 'inprogress', '#42', '-', ...WHO], 'Use the release keystore.\n');
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
    expect(res).toMatchObject({ code: 0, reads: 1 });
    expect(sent.map((s) => s.body)).toEqual([{ as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION, stepId: 42, message: 'Use the release keystore.\n' }]);
  });

  it('prints the not-a-step sentence and the usage for a step that is not one, reading no stdin', async () => {
    for (const args of [
      ['relay', 'inprogress', 'x', 'hi', ...WHO],
      ['relay', 'inprogress', 'x', '-', ...WHO],
    ]) {
      const res = await run(args, 'words');
      expect(res, args.join(' ')).toEqual({ code: 1, lines: ['x is not a step: give it as #42 or 42', LEAD_USAGE], reads: 0 });
    }
    const missing = await run(['relay', 'inprogress', '42', ...WHO]);
    expect(missing.code).toBe(1);
    expect(missing.lines.at(-1)).toBe(LEAD_USAGE);
  });

  it('says the message may have been delivered when no answer comes back, and exits 1', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    // The server went away mid-send (a restart): the request had arrived, so the send may have happened.
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    for (const failure of [timeout, reset]) {
      stubbed(async () => {
        throw failure;
      });
      try {
        expect(await run(['relay', 'inprogress', '42', 'hi', ...WHO]), failure.message).toEqual({ code: 1, lines: [RELAY_NO_ANSWER], reads: 0 });
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    }
    expect(RELAY_NO_ANSWER).toBe('InProgress did not answer. The message may have been delivered: do not send it again.');
  });

  it('rethrows a refused connection: the relay never arrived', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    stubbed(async () => {
      throw refused;
    });
    try {
      await expect(run(['relay', 'inprogress', '42', 'hi', ...WHO])).rejects.toMatchObject({ status: 0, code: 'ECONNREFUSED' });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('posts allow and disallow with the switch, and refuses a switch that is not one, or an allow with no words, before posting', async () => {
    const sent = stubbed(async () => new Response(JSON.stringify({ text: 'Starts is on for InGame.' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      expect(await run(['allow', 'inprogress', 'starts', '--aiden', 'yes, go', ...WHO])).toEqual({ code: 0, lines: ['Starts is on for InGame.'], reads: 0 });
      expect(await run(['disallow', 'inprogress', 'landing', ...WHO])).toMatchObject({ code: 0 });
      expect(await run(['disallow', 'inprogress', 'landing', '--aiden', 'stop it', ...WHO])).toMatchObject({ code: 0 });
      const bad = await run(['allow', 'inprogress', 'deploys', '--aiden', 'go', ...WHO]);
      expect(bad).toEqual({ code: 1, lines: ['deploys is not a switch: give starts or landing', LEAD_USAGE], reads: 0 });
      const noWords = await run(['allow', 'inprogress', 'starts', ...WHO]);
      expect(noWords).toEqual({ code: 1, lines: ['Missing --aiden', LEAD_USAGE], reads: 0 });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
    const who = { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION };
    expect(sent.map((s) => [s.url.replace(conn.baseUrl, ''), s.body])).toEqual([
      ['/api/lead/inprogress/allow', { ...who, switch: 'starts', aidenWords: 'yes, go' }],
      ['/api/lead/inprogress/disallow', { ...who, switch: 'landing' }],
      ['/api/lead/inprogress/disallow', { ...who, switch: 'landing', aidenWords: 'stop it' }],
    ]);
  });

  it('posts start with its step and optional words, waiting RELAY_TIMEOUT_MS, and says a thread may have been started when no answer comes back', async () => {
    const sent = stubbed(async () => new Response(JSON.stringify({ text: 'Started a thread for #42 Dark mode: t3-1. It claims the step on its first turn.', threadId: 't3-1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      expect(await run(['start', 'inprogress', '#42', ...WHO])).toMatchObject({ code: 0 });
      expect(await run(['start', 'inprogress', '42', '--aiden', 'go on', ...WHO])).toMatchObject({ code: 0 });
      expect(await run(['start', 'inprogress', 'x', ...WHO])).toEqual({ code: 1, lines: ['x is not a step: give it as #42 or 42', LEAD_USAGE], reads: 0 });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
    const who = { as: 'Progresser', instructions: LEAD_INSTRUCTIONS_VERSION };
    expect(sent.map((s) => [s.url.replace(conn.baseUrl, ''), s.body, s.timeoutMs])).toEqual([
      ['/api/lead/inprogress/start', { ...who, stepId: 42 }, RELAY_TIMEOUT_MS],
      ['/api/lead/inprogress/start', { ...who, stepId: 42, aidenWords: 'go on' }, RELAY_TIMEOUT_MS],
    ]);
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    stubbed(async () => {
      throw timeout;
    });
    try {
      expect(await run(['start', 'inprogress', '42', ...WHO])).toEqual({ code: 1, lines: [START_NO_ANSWER], reads: 0 });
      expect(START_NO_ANSWER).toBe('InProgress did not answer, and a thread may have been started. Do not run it again: read the brief and tell Aiden.');
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("prints the server's refusal and exits 1", async () => {
    stubbed(async () => new Response(JSON.stringify({ error: 'It may have been delivered. Not retried.' }), { status: 502 }));
    try {
      expect(await run(['relay', 'inprogress', '42', 'hi', ...WHO])).toEqual({ code: 1, lines: ['It may have been delivered. Not retried.'], reads: 0 });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
