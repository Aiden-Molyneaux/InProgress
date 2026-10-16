import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASK_USAGE, CLAIM_USAGE, ORCHESTRATE_USAGE, parseAskArgs, parseClaimArgs, parseOrchestrateArgs, runAsk, runClaim, runOrchestrate } from '../../src/cli/claim';
import { runCli } from '../../src/cli/commands';
import { ensureToken } from '../../src/lib/home';
import { buildApp } from '../../src/server/app';
import { openDb, type DB } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { clearAsk } from '../../src/server/repo/asks';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { enrollSession } from '../../src/server/session-flow';

let dir = '';
let db: DB;
let close: () => Promise<unknown>;
let conn: { baseUrl: string; token: string };
const saved = { port: process.env.INPROGRESS_PORT, home: process.env.INPROGRESS_HOME };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ip-claim-'));
  const token = ensureToken(dir);
  db = openDb(join(dir, 'inprogress.db'));
  const app = buildApp({ ctx: createCtx(db), token, uiToken: 'u', version: 'test' });
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

/** A project with one step and a session tracked in it. */
function scenario(name: string, session: string) {
  const ctx = createCtx(db);
  const project = createProject(ctx, 'test', { name });
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'The step' }] });
  enrollSession(ctx, `scribe:${session}`, session, project.slug);
  return { ctx, project, step };
}

describe('argument parsing', () => {
  it('claim: a step and --session, the step with or without #', () => {
    expect(parseClaimArgs(['42', '--session', 's1'])).toEqual({ session: 's1', nodeId: 42, takeOver: false });
    expect(parseClaimArgs(['--session', 's1', '#42'])).toEqual({ session: 's1', nodeId: 42, takeOver: false });
    expect(parseClaimArgs(['12', '--take-over', '--session', 's'])).toEqual({ session: 's', nodeId: 12, takeOver: true });
    expect(parseClaimArgs(['12', '--session', 's'])).toEqual({ session: 's', nodeId: 12, takeOver: false });
    expect(parseClaimArgs(['--session', 's1'])).toEqual({ error: 'Missing the step id' });
    expect(parseClaimArgs(['42'])).toEqual({ error: 'Missing --session <session id>' });
    expect(parseClaimArgs(['x', '--session', 's1'])).toEqual({ error: 'Not a step id: x' });
    expect(parseClaimArgs(['4', '5', '--session', 's1'])).toEqual({ error: 'Name one step' });
    expect(parseClaimArgs(['4', '--session'])).toEqual({ error: '--session needs the session id' });
    expect(parseClaimArgs(['4', '--session', 's1', '--now'])).toEqual({ error: 'Unknown flag --now' });
  });

  it('orchestrate: --session and an optional --status', () => {
    expect(parseOrchestrateArgs(['--session', 's1'])).toEqual({ session: 's1', status: false });
    expect(parseOrchestrateArgs(['--status', '--session', 's1'])).toEqual({ session: 's1', status: true });
    expect(parseOrchestrateArgs([])).toEqual({ error: 'Missing --session <session id>' });
    expect(parseOrchestrateArgs(['42', '--session', 's1'])).toEqual({ error: 'Unexpected argument 42' });
  });

  it('ask: exactly one kind flag with its text', () => {
    expect(parseAskArgs(['42', '--session', 's1', '--question', 'Which port?'])).toEqual({ session: 's1', nodeId: 42, kind: 'question', text: 'Which port?' });
    expect(parseAskArgs(['42', '--permission', 'Allow it', '--session', 's1'])).toMatchObject({ kind: 'permission' });
    expect(parseAskArgs(['42', '--session', 's1', '--review', 'Look'])).toMatchObject({ kind: 'review', text: 'Look' });
    expect(parseAskArgs(['42', '--session', 's1'])).toEqual({ error: 'Give exactly one of --question, --permission, --review' });
    expect(parseAskArgs(['42', '--session', 's1', '--question', 'a', '--review', 'b'])).toEqual({ error: 'Give exactly one of --question, --permission, --review' });
    expect(parseAskArgs(['42', '--session', 's1', '--question'])).toEqual({ error: '--question needs the text' });
    expect(parseAskArgs(['42', '--session', 's1', '--question', '--review'])).toEqual({ error: '--question needs the text' });
    // Text that merely starts with -- is text.
    expect(parseAskArgs(['42', '--session', 's1', '--question', '--force push ok?'])).toMatchObject({ kind: 'question', text: '--force push ok?' });
  });
});

describe('claim, orchestrate and ask through runCli', () => {
  it('claim prints the notes and then the step block, exit 0', async () => {
    const { step } = scenario('Claim Demo', 'c1');
    const s = capture();
    expect(await runCli(['claim', String(step.id), '--session', 'c1'], s.out)).toBe(0);
    expect(s.lines[0]).toBe(`Note: #${step.id} is not in Next.`);
    expect(s.lines[1]).toBe(`You drive #${step.id}.`);
    expect(s.lines[2]).toMatch(/^Your step: #\d+ Claim Demo$/);
    expect(s.lines[3]).toBe(`  #${step.id} The step · active`);
  });

  it('claim --take-over sends the flag and prints whom it took over from', async () => {
    const { ctx, project, step } = scenario('Take Demo', 't1');
    enrollSession(ctx, 'scribe:t2', 't2', project.slug);
    expect(await runClaim([String(step.id), '--session', 't1'], capture().out, conn)).toBe(0);
    const s = capture();
    expect(await runClaim([String(step.id), '--take-over', '--session', 't2'], s.out, conn)).toBe(0);
    expect(s.lines.some((l) => /^You drive #\d+; took over from \S+\.$/.test(l))).toBe(true);
  });

  it('claim of another project\'s step prints the error and the hint, exit 1', async () => {
    const { project } = scenario('Claim Home', 'c2');
    const other = scenario('Claim Away', 'c3');
    const s = capture();
    expect(await runClaim([String(other.step.id), '--session', 'c2'], s.out, conn)).toBe(1);
    expect(s.lines).toEqual([`#${other.step.id} is not in this session's project`, 'Use enroll_session to move the session to another project first.']);
    expect(project.slug).toBeTruthy();
  });

  it('claim and orchestrate exit 1 with the usage line on bad arguments', async () => {
    const claim = capture();
    expect(await runCli(['claim', '--session', 's1'], claim.out)).toBe(1);
    expect(claim.lines).toEqual(['Missing the step id', CLAIM_USAGE]);
    const orc = capture();
    expect(await runCli(['orchestrate'], orc.out)).toBe(1);
    expect(orc.lines).toEqual(['Missing --session <session id>', ORCHESTRATE_USAGE]);
    const ask = capture();
    expect(await runCli(['ask', '4', '--session', 's1'], ask.out)).toBe(1);
    expect(ask.lines).toEqual(['Give exactly one of --question, --permission, --review', ASK_USAGE]);
  });

  it('orchestrate prints the opening, with the digest for --status', async () => {
    scenario('Orc Demo', 'o1');
    const plain = capture();
    expect(await runOrchestrate(['--session', 'o1'], plain.out, conn)).toBe(0);
    expect(plain.lines.join('\n')).toContain('Role: orchestrator. You never implement');
    const status = capture();
    expect(await runOrchestrate(['--session', 'o1', '--status'], status.out, conn)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'session.orchestrate'").get()).toEqual({ n: 2 });
  });

  it('ask prints "a7 raised on #42" and nothing more for a fresh ask by a tracked session', async () => {
    const { step } = scenario('Ask Demo', 'a1');
    const s = capture();
    expect(await runCli(['ask', String(step.id), '--session', 'a1', '--question', 'Which port?'], s.out)).toBe(0);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatch(new RegExp(`^a\\d+ raised on #${step.id}$`));
    expect(db.prepare("SELECT session_id, kind FROM asks WHERE node_id = ?").get(step.id)).toEqual({ session_id: 'a1', kind: 'question' });
  });

  it('ask says when the session is not tracked, and when it joined an ask another session raised', async () => {
    const { ctx, project, step } = scenario('Ask Notes', 'a2');
    enrollSession(ctx, 'scribe:a3', 'a3', project.slug);
    const stray = capture();
    expect(await runAsk([String(step.id), '--session', 'ghost', '--review', 'Look at it'], stray.out, conn)).toBe(0);
    expect(stray.lines[1]).toBe('Note: session ghost is not tracked in InProgress, so no answer will come back to it.');

    const first = capture();
    await runAsk([String(step.id), '--session', 'a2', '--permission', 'Allow it'], first.out, conn);
    expect(first.lines).toHaveLength(1);
    const joined = capture();
    await runAsk([String(step.id), '--session', 'a3', '--permission', 'Allow it'], joined.out, conn);
    expect(joined.lines[1]).toMatch(/^Note: a\d+ was already open, raised by another session; its answer goes to that session, not to this one\.$/);
    const again = capture();
    await runAsk([String(step.id), '--session', 'a2', '--permission', 'Allow it'], again.out, conn);
    expect(again.lines[1]).toMatch(/was already open from this session; nothing new was raised\./);

    const id = Number(/^a(\d+)/.exec(first.lines[0])![1]);
    clearAsk(ctx, 'window', id, 'yes');
    expect(db.prepare('SELECT answer FROM asks WHERE id = ?').get(id)).toEqual({ answer: 'yes' });
  });

  it('ask for an unknown kind of step prints the server error and exits 1', async () => {
    scenario('Ask Bad', 'a4');
    const s = capture();
    expect(await runAsk(['999999', '--session', 'a4', '--question', 'x'], s.out, conn)).toBe(1);
    expect(s.lines[0]).toMatch(/not found/i);
  });
});

describe('a server too slow to answer', () => {
  it('gets each command its own timeout hint, saying whether a rerun is safe', async () => {
    const { createServer } = await import('node:http');
    const slow = createServer((req) => req.resume());
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    try {
      const slowConn = { baseUrl: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`, token: 't', timeoutMs: 200 };
      const { ASK_TIMEOUT_HINT, CLAIM_TIMEOUT_HINT, ORCHESTRATE_TIMEOUT_HINT } = await import('../../src/cli/claim');
      await expect(runClaim(['4', '--session', 's1'], () => {}, slowConn)).rejects.toMatchObject({ code: 'TIMEOUT', hint: CLAIM_TIMEOUT_HINT });
      await expect(runAsk(['4', '--session', 's1', '--question', 'x'], () => {}, slowConn)).rejects.toMatchObject({ code: 'TIMEOUT', hint: ASK_TIMEOUT_HINT });
      await expect(runOrchestrate(['--session', 's1'], () => {}, slowConn)).rejects.toMatchObject({ code: 'TIMEOUT', hint: ORCHESTRATE_TIMEOUT_HINT });
      expect(ORCHESTRATE_TIMEOUT_HINT).toContain('records another');
      expect(CLAIM_TIMEOUT_HINT + ASK_TIMEOUT_HINT).not.toContain('replaced whole');
    } finally {
      slow.closeAllConnections();
      slow.close();
    }
  });
});
