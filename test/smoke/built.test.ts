import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectSnapshot, TreeNode } from '../../src/core/types';
import { nodeBinary } from '../../src/cli/claude-config';
import { createClient } from '../../src/lib/client';
import { isServerUp } from '../../src/lib/ensure-server';
import { readToken } from '../../src/lib/home';

/** The tested build: `npm run test:smoke` builds into .build, so the live dist/ is never touched. */
const BUILD = process.env.INPROGRESS_BUILD_ROOT ?? '.build';
const bin = (entry: string) => join(BUILD, 'dist', entry);

const home = mkdtempSync(join(tmpdir(), 'ip-smoke-'));
const claude = mkdtempSync(join(tmpdir(), 'ip-smoke-claude-'));
/** A folder bound to the Smoke project by the first test. */
const bound = mkdtempSync(join(tmpdir(), 'ip-smoke-bound-'));
let base = '';
let env: NodeJS.ProcessEnv = {};
let server: ChildProcess | undefined;

const sessionStart = (sessionId: string) => JSON.stringify({ session_id: sessionId, cwd: bound, source: 'startup' });
const briefing = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
/** Run the built hook with this stdin payload, as Claude Code would. */
const runHook = (name: string, payload: object) => spawnSync(process.execPath, [bin('hooks/hook.js'), name], { input: JSON.stringify(payload), env, encoding: 'utf8' });
/** Run the built CLI's tasks command, as a session would. */
const runTasks = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [bin('cli/main.js'), 'tasks', ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);
/** Every row of these tables, read straight from the server's database file: what it has stored, not what it serves. */
function storedRows(...tables: string[]): Record<string, unknown>[] {
  const db = new Database(join(home, 'inprogress.db'), { readonly: true, fileMustExist: true });
  try {
    return tables.flatMap((t) => db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]);
  } finally {
    db.close();
  }
}

/** A port nothing is listening on, so a stale server from an earlier run can never answer. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env, INPROGRESS_HOME: home, INPROGRESS_PORT: String(port), INPROGRESS_CLAUDE_DIR: claude };
  server = spawn(process.execPath, [bin('server/main.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 80 && !(await isServerUp(base)); i++) await new Promise((r) => setTimeout(r, 100));
  expect(await isServerUp(base)).toBe(true);
});
afterAll(async () => {
  // No port means env is still empty, and `stop` would target port 4317 with the real ~/.inprogress token.
  if (!base) return;
  // Stop from a fresh process, once a second for up to 5 s. This one can still hold keep-alive sockets to the first
  // server, which claude-install reset while spawnSync blocked the event loop, and a request sent on one fails with
  // ECONNRESET. The pause before each probe lets the loop drop those sockets, so a probe cannot miss a live server.
  const deadline = Date.now() + 5000;
  let lastStop = 0;
  let up = true;
  while (up && Date.now() < deadline) {
    if (Date.now() - lastStop >= 1000) {
      spawnSync(process.execPath, [bin('cli/main.js'), 'stop'], { env });
      lastStop = Date.now();
    }
    await new Promise((r) => setTimeout(r, 200));
    up = await isServerUp(base, 200);
  }
  server?.kill();
  if (up) throw new Error(`An InProgress server still answers at ${base} (data dir ${home}): stop it by hand.`);
  for (const dir of [home, claude, bound]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('built artifacts', () => {
  it('session-start hook prints a briefing for a bound folder', async () => {
    const client = createClient({ baseUrl: base, token: readToken(home) });
    const p = await client.post<{ slug: string }>('/api/projects', { name: 'Smoke' });
    await client.post(`/api/projects/${p.slug}/bindings`, { path: bound });
    const r = spawnSync(process.execPath, [bin('hooks/hook.js'), 'session-start'], { input: sessionStart('smoke-1'), env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(briefing(r.stdout).hookEventName).toBe('SessionStart');
    expect(briefing(r.stdout).additionalContext).toContain('tracked in project "Smoke"');
  });

  it('hooks read stdin that starts with a UTF-8 BOM', () => {
    // PowerShell adds one when it pipes text to a program.
    const r = spawnSync(process.execPath, [bin('hooks/hook.js'), 'session-start'], { input: `\uFEFF${sessionStart('smoke-bom')}\r\n`, env, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(briefing(r.stdout).additionalContext).toContain('Session id: smoke-bom');
  });

  it('the post-tool hook mirrors a TaskCreate and a TaskUpdate, silently', async () => {
    const client = createClient({ baseUrl: base, token: readToken(home) });
    const { project } = await client.get<ProjectSnapshot>('/api/projects/smoke');
    const [step] = await client.post<TreeNode[]>('/api/nodes', { parentId: project.rootNodeId, nodes: [{ title: 'Smoke the hooks', status: 'active' }] });
    const subject = `#${step.id} Write the smoke test`;
    const created = runHook('post-tool', {
      session_id: 'smoke-1', hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_use_id: 'toolu_smoke_1',
      tool_input: { subject, description: 'A task description stays in Claude Code' }, tool_response: { task: { id: '1', subject } },
    });
    expect(created).toMatchObject({ status: 0, stdout: '', stderr: '' });
    const updated = runHook('post-tool', {
      session_id: 'smoke-1', hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_use_id: 'toolu_smoke_2',
      tool_input: { taskId: '1', status: 'in_progress' }, tool_response: { success: true, taskId: '1', updatedFields: ['status'] },
    });
    expect(updated).toMatchObject({ status: 0, stdout: '', stderr: '' });
    const { workItems } = await client.get<ProjectSnapshot>('/api/projects/smoke');
    expect(workItems).toEqual([expect.objectContaining({ nodeId: step.id, sessionId: 'smoke-1', agentId: '', subject, status: 'in_progress' })]);
  });

  it('pre-tool, subagent-start and post-tool pair a subagent with its description and node, keeping only its first sentence', async () => {
    const client = createClient({ baseUrl: base, token: readToken(home) });
    const step = (await client.get<ProjectSnapshot>('/api/projects/smoke')).nodes.find((n) => n.title === 'Smoke the hooks')!;
    // Two sentences on two lines: only "Map the smoke run." may leave Claude Code, never the rest of the prompt.
    const prompt = 'Map the smoke run. The rest of the prompt stays in Claude Code.\nMore detail.';
    const kept = ['stays in Claude Code', 'More detail'];
    const toolInput = { description: `#${step.id} Map the smoke run`, prompt, subagent_type: 'Explore', model: 'haiku' };
    const dispatch = runHook('pre-tool', { session_id: 'smoke-1', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_smoke_agent', tool_input: toolInput });
    expect(dispatch).toMatchObject({ status: 0, stdout: '', stderr: '' });
    // Read before the launch pairs it, which forgets the dispatch.
    const dispatched = storedRows('subagent_dispatches');
    expect(dispatched).toEqual([expect.objectContaining({ tool_use_id: 'toolu_smoke_agent', purpose: 'Map the smoke run.' })]);
    const started = runHook('subagent-start', { session_id: 'smoke-1', hook_event_name: 'SubagentStart', agent_id: 'a0smoke0agent0001', agent_type: 'Explore' });
    expect(started).toMatchObject({ status: 0, stdout: '', stderr: '' });
    const launched = runHook('post-tool', {
      session_id: 'smoke-1', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_smoke_agent', tool_input: toolInput,
      tool_response: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a0smoke0agent0001 (internal ID - do not mention to user.)' }],
    });
    expect(launched).toMatchObject({ status: 0, stdout: '', stderr: '' });
    const snapshot = await client.get<ProjectSnapshot>('/api/projects/smoke');
    const session = snapshot.sessions.find((s) => s.id === 'smoke-1')!;
    expect(session.subagents).toEqual([
      { agentId: 'a0smoke0agent0001', agentType: 'Explore', startedAt: expect.any(String), description: `#${step.id} Map the smoke run`, model: 'haiku', nodeId: step.id, endedAt: null, ordinal: 1, purpose: 'Map the smoke run.', endReason: null, lastActiveAt: null },
    ]);
    const stored = JSON.stringify({ dispatched, now: storedRows('subagent_dispatches', 'session_subagents', 'events') });
    for (const text of kept) {
      expect(stored, text).not.toContain(text);
      expect(JSON.stringify(snapshot), text).not.toContain(text);
    }
  });

  it("the CLI's tasks command replaces a tracked session's tasks on a step and prints the counts", async () => {
    const client = createClient({ baseUrl: base, token: readToken(home) });
    const step = (await client.get<ProjectSnapshot>('/api/projects/smoke')).nodes.find((n) => n.title === 'Smoke the hooks')!;
    const r = runTasks([String(step.id), '--session', 'smoke-1', '--done', 'Write the smoke test', '--doing', 'Run it', '--todo', 'Read the report']);
    expect(r).toMatchObject({ status: 0, stderr: '' });
    expect(lines(r.stdout)).toEqual([`#${step.id}: 1 done · 1 in progress · 1 pending`]);
    const { workItems } = await client.get<ProjectSnapshot>('/api/projects/smoke');
    expect(workItems.filter((w) => w.sessionId === 'smoke-1' && w.nodeId === step.id).map((w) => [w.subject, w.status])).toEqual([
      ['Write the smoke test', 'completed'],
      ['Run it', 'in_progress'],
      ['Read the report', 'pending'],
    ]);
  });

  it("the tasks command passes on the server's refusal and its hint when the session has no focus", () => {
    const r = runTasks(['--session', 'smoke-1', '--todo', 'Unplaced']);
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toEqual(['This session has no focus', 'Name the step: tasks <id> …']);
  });

  it('a hook whose reader has gone away exits 0 without stderr', async () => {
    const child = spawn(process.execPath, [bin('hooks/hook.js'), 'session-start'], { env, stdio: 'pipe' });
    child.stdout.destroy(); // Claude stopped reading before the briefing is written: the write fails with EPIPE.
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdin.end(sessionStart('smoke-epipe'));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('hooks exit 0 silently when the server is unreachable', () => {
    const r = spawnSync(process.execPath, [bin('hooks/hook.js'), 'stop'], { input: JSON.stringify({ session_id: 'x' }), env: { ...env, INPROGRESS_PORT: '1' }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('a backgrounded Bash call is captured, redacted, to the day file, and posts nothing', () => {
    const command = `cd /c/x && INTHINK_TOKEN=abc123 npm run test:e2e -- --grep busy 2>&1 | tail -40 ${'x'.repeat(100)}`;
    const r = runHook('post-tool', {
      session_id: 'smoke-capture', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_smoke_capture',
      tool_input: { command, description: 'Run the e2e suite', run_in_background: true },
      tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: 'bsmoke01' },
    });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
    const dir = join(home, 'capture');
    const captured = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => lines(readFileSync(join(dir, f), 'utf8')).map((l) => JSON.parse(l) as { hook: string; input: { tool_use_id?: string; tool_input: { command: string }; tool_response: { backgroundTaskId: string } } }))
      .filter((l) => l.input.tool_use_id === 'toolu_smoke_capture');
    expect(captured).toHaveLength(1);
    expect(captured[0].hook).toBe('post-tool');
    expect(captured[0].input.tool_response.backgroundTaskId).toBe('bsmoke01');
    const kept = captured[0].input.tool_input.command;
    expect(kept.startsWith('cd /c/x && INTHINK_TOKEN=[redacted] npm run test:e2e -- --grep busy')).toBe(true);
    expect(kept.endsWith(`…[${command.length} chars]`)).toBe(true);
    expect(kept.length).toBe(80 + `…[${command.length} chars]`.length);
    expect(JSON.stringify(captured)).not.toContain('abc123');
  });

  it('hooks exit 0 silently when the capture folder cannot be written, or capture is off', () => {
    const blocked = mkdtempSync(join(tmpdir(), 'ip-smoke-capture-'));
    try {
      writeFileSync(join(blocked, 'capture'), 'a file where the capture folder goes');
      const bash = { session_id: 'x', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'ls' }, tool_response: { backgroundTaskId: 'b1' } };
      for (const [name, payload] of [['stop', { session_id: 'x' }], ['prompt-submit', { session_id: 'x', prompt: '<task-notification></task-notification>' }], ['post-tool', bash]] as const) {
        const r = spawnSync(process.execPath, [bin('hooks/hook.js'), name], { input: JSON.stringify(payload), env: { ...env, INPROGRESS_HOME: blocked, INPROGRESS_PORT: '1' }, encoding: 'utf8' });
        expect(r, name).toMatchObject({ status: 0, stdout: '', stderr: '' });
      }
      rmSync(join(blocked, 'capture'));
      const off = spawnSync(process.execPath, [bin('hooks/hook.js'), 'post-tool'], { input: JSON.stringify(bash), env: { ...env, INPROGRESS_HOME: blocked, INPROGRESS_PORT: '1', INPROGRESS_HOOK_CAPTURE: '0' }, encoding: 'utf8' });
      expect(off).toMatchObject({ status: 0, stdout: '', stderr: '' });
      expect(existsSync(join(blocked, 'capture'))).toBe(false);
    } finally {
      rmSync(blocked, { recursive: true, force: true });
    }
  });

  it('CLI prints the client hint under an error', () => {
    const r = spawnSync(process.execPath, [bin('cli/main.js'), 'outline', 'smoke'], { env: { ...env, INPROGRESS_PORT: '1' }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr.split(/\r?\n/).slice(0, 2)).toEqual([
      expect.stringContaining('InProgress server unreachable at http://127.0.0.1:1'),
      'Run `inprogress start`, or `inprogress doctor` to diagnose.',
    ]);
  });

  it('the tasks command says how the server gets started when it is not running, and starts nothing itself', async () => {
    const r = runTasks(['88', '--session', 'smoke-1', '--done', 'x'], { INPROGRESS_PORT: '1' });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toEqual([
      expect.stringContaining('InProgress server unreachable at http://127.0.0.1:1'),
      'InProgress is not running. A brief to the inprogress-scribe starts it; run this command again after that.',
    ]);
    expect(await isServerUp('http://127.0.0.1:1', 300)).toBe(false);
  });

  it('MCP server answers over stdio', async () => {
    const client = new Client({ name: 'smoke', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin('mcp/main.js')], env: env as Record<string, string> }));
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
    expect(res.content[0].text).toContain('smoke');
    await client.close();
  });

  it('MCP server starts InProgress again when a call finds it stopped', async () => {
    const client = new Client({ name: 'smoke', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin('mcp/main.js')], env: env as Record<string, string> }));
    try {
      const stop = spawnSync(process.execPath, [bin('cli/main.js'), 'stop'], { env, encoding: 'utf8' });
      expect(stop.stdout).toContain('Stopped the running InProgress server.');
      const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('smoke');
    } finally {
      await client.close();
      // The tests below expect a running server, even if this one failed.
      spawnSync(process.execPath, [bin('cli/main.js'), 'start'], { env });
    }
  });

  it('CLI installs into a temp Claude dir, then a session-start hook restarts the server it stopped', async () => {
    const inst = spawnSync(process.execPath, [bin('cli/main.js'), 'claude-install'], { env, encoding: 'utf8' });
    expect(inst.stdout).toContain('Stopped the running InProgress server.');
    expect(inst.stdout).toContain(`Claude directory: ${claude}\nNode binary: ${nodeBinary()}\n`);
    // The server is stopped only once the new kit is written.
    expect(inst.stdout.indexOf('Stopped the running InProgress server.')).toBeGreaterThan(inst.stdout.indexOf('Skill: '));
    expect(inst.status).toBe(0);
    // Let this process drop its keep-alive sockets to the stopped server before probing (see afterAll).
    await new Promise((r) => setTimeout(r, 200));
    expect(await isServerUp(base, 500)).toBe(false);
    // The next session in a bound folder starts the server itself, as after a real install.
    const r = spawnSync(process.execPath, [bin('hooks/hook.js'), 'session-start'], { input: sessionStart('smoke-2'), env, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(briefing(r.stdout).additionalContext).toContain('tracked in project "Smoke"');
    // The rules install wrote allow, byte for byte, the tasks command this server prints from its own path.
    const allow: string[] = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')).permissions.allow;
    const taskRules = allow.filter((rule) => / tasks \*\)$/.test(rule));
    expect(taskRules.map((rule) => rule.slice(0, rule.indexOf('(')))).toEqual(['Bash', 'PowerShell']);
    for (const rule of taskRules) {
      const prefix = rule.slice(rule.indexOf('(') + 1, -' *)'.length);
      expect(prefix).toMatch(/^node \S+\/dist\/cli\/main\.js tasks$/);
      expect(briefing(r.stdout).additionalContext).toContain(`\`${prefix} <step id> --session smoke-2 --done "…" --doing "…" --todo "…"\``);
    }
  });

  it('doctor starts a stopped server and passes', () => {
    const stop = spawnSync(process.execPath, [bin('cli/main.js'), 'stop'], { env, encoding: 'utf8' });
    expect(stop.stdout).toContain('Stopped the running InProgress server.');
    const doc = spawnSync(process.execPath, [bin('cli/main.js'), 'doctor'], { env, encoding: 'utf8' });
    expect(doc.stdout).toContain(`Started InProgress at ${base}`);
    expect(doc.stdout).not.toContain('✗');
    expect(doc.status).toBe(0);
  });
});
