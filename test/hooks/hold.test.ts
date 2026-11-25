import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runHandler, type HookDeps } from '../../src/hooks/handlers';
import { heldFile, readHeld, readHeldLines, type HeldFile } from '../../src/hooks/hold';
import { createClient } from '../../src/lib/client';

/** A stub InProgress: records each request and answers what the test sets. */
const requests: { path: string; body: Record<string, unknown> }[] = [];
let reply: (path: string, body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: { say: 'nothing' } });
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      requests.push({ path: req.url ?? '', body });
      const r = reply(req.url ?? '', body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  requests.length = 0;
  reply = () => ({ status: 200, body: { say: 'nothing' } });
});

/** held.json as the server writes it: the Held lines, and the watched folders (C:/repo, where the tests run). */
const file = (lines: string[] = [], folders: string[] | null = ['C:/repo']): HeldFile => ({ present: true, lines, folders });
const deps = (url = base, held: HeldFile = file(), fallback?: (json: object | undefined) => void): HookDeps => ({
  post: async () => ({ tracked: false }),
  ensureServer: async () => true,
  lead: { post: (path, body, timeoutMs) => createClient({ baseUrl: url, token: 'tok', timeoutMs }).post(path, body), held: () => held, fallback },
});
const bash = (command: string) => ({ session_id: 's1', cwd: 'C:/repo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const deny = (reason: string) => ({ json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } });

describe('the hold hook', () => {
  it('asks nothing and prints nothing for a command off the list', async () => {
    expect(await runHandler('hold', bash('git status && npm test'), deps())).toBeUndefined();
    expect(await runHandler('hold', { session_id: 's1', tool_name: 'Bash', tool_input: {} }, deps())).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('asks the server about a command on the list, and prints nothing when it says nothing', async () => {
    expect(await runHandler('hold', bash('npm test && git push origin feature'), deps())).toBeUndefined();
    expect(requests).toEqual([
      { path: '/api/lead/hold', body: { sessionId: 's1', cwd: 'C:/repo', command: 'npm test && git push origin feature', action: 'push', index: 1, segment: 'git push origin feature', folder: 'C:/repo' } },
    ]);
  });

  it('prints the exact PreToolUse deny when the server holds it', async () => {
    reply = () => ({ status: 200, body: { held: true, text: 'a push of lead-stage-1-desk to origin' } });
    expect(await runHandler('hold', bash('git push'), deps())).toStrictEqual(
      deny('Held for Aiden before it runs: a push of lead-stage-1-desk to origin. It waits for his word. Do not retry it and do not try another way.'),
    );
  });

  it('asks about each held command of a compound one, and the first held answers', async () => {
    reply = (_path, body) => (body.action === 'push' ? { status: 200, body: { held: true, text: 'a push of x to origin' } } : { status: 200, body: { say: 'nothing' } });
    const out = await runHandler('hold', bash('git merge x && git push'), deps());
    expect(requests.map((r) => [r.body.action, r.body.index])).toEqual([
      ['merge', 0],
      ['push', 1],
    ]);
    expect(out).toStrictEqual(deny('Held for Aiden before it runs: a push of x to origin. It waits for his word. Do not retry it and do not try another way.'));
  });

  it('with the server down, holds only in a watched folder (or one it cannot read), and says nothing with no held.json', async () => {
    const down = 'http://127.0.0.1:9';
    const at = (cwd: string, command = 'git push') => ({ ...bash(command), cwd });
    expect((await runHandler('hold', at('C:/repo/sub'), deps(down)))?.json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await runHandler('hold', at('C:/elsewhere'), deps(down))).toBeUndefined();
    expect((await runHandler('hold', at('C:/elsewhere', 'cd C:/repo && git push'), deps(down)))?.json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect((await runHandler('hold', at('C:/elsewhere', 'cd $X && git push'), deps(down)))?.json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await runHandler('hold', at('C:/repo'), deps(down, { present: false, lines: [], folders: null }))).toBeUndefined();
    // The old array form names no folders: held anywhere.
    expect((await runHandler('hold', at('C:/elsewhere'), deps(down, file([], null))))?.json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('hands main the refusal to print if it is cut off, before it asks the server; nothing for a command off the list', async () => {
    const seen: (object | undefined)[] = [];
    await runHandler('hold', bash('git push'), deps(base, file(), (json) => seen.push(json)));
    expect(seen).toEqual([{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('InProgress is not answering') } }]);
    seen.length = 0;
    await runHandler('hold', { ...bash('git push'), cwd: 'C:/elsewhere' }, deps(base, file(), (json) => seen.push(json)));
    expect(seen).toEqual([undefined]);
    seen.length = 0;
    await runHandler('hold', bash('npm test'), deps(base, file(), (json) => seen.push(json)));
    expect(seen).toEqual([]);
  });

  it('fails closed when the server is down, for a command on the list only', async () => {
    const down = deps('http://127.0.0.1:9');
    expect(await runHandler('hold', bash('npm publish'), down)).toStrictEqual(
      deny('Held for Aiden before it runs: a publish of a package for anyone to install. InProgress is not answering, so this waits for Aiden. Do not retry it and do not try another way.'),
    );
    expect(await runHandler('hold', bash('npm test'), down)).toBeUndefined();
  });

  it('fails closed on an error answer, and on an answer it cannot read', async () => {
    reply = () => ({ status: 401, body: { error: 'no token' } });
    expect((await runHandler('hold', bash('git push'), deps()))?.json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    reply = () => ({ status: 200, body: { something: 'else' } });
    expect((await runHandler('hold', bash('git push'), deps()))?.json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('holds without a session id, and fails closed without a way to reach the server', async () => {
    reply = () => ({ status: 200, body: { held: true, text: 'a deploy of main to the live build' } });
    expect((await runHandler('hold', { cwd: 'C:/repo', tool_name: 'PowerShell', tool_input: { command: 'npm run deploy' } }, deps()))?.json).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: expect.stringContaining('a deploy of main to the live build') },
    });
    expect(requests[0].body.sessionId).toBeNull();
    const none: HookDeps = { post: async () => ({ tracked: false }), ensureServer: async () => true };
    expect((await runHandler('hold', bash('git push'), none))?.json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it("asks about a playbook's Held line", async () => {
    expect(await runHandler('hold', bash('gh pr list'), deps(base))).toBeUndefined();
    expect(requests).toEqual([]);
    await runHandler('hold', bash('gh pr list'), deps(base, file(['gh pr list'])));
    expect(requests.map((r) => r.body.action)).toEqual(['playbook']);
  });
});

describe('held.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'ip-held-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('reads { lines, folders }, and the old array of lines; a missing file is not present', () => {
    expect(readHeld(home)).toEqual({ present: false, lines: [], folders: null });
    mkdirSync(join(home, 'lead'), { recursive: true });
    writeFileSync(heldFile(home), JSON.stringify({ lines: ['gh pr list', 4], folders: ['C:/repo'] }));
    expect(readHeld(home)).toEqual({ present: true, lines: ['gh pr list'], folders: ['C:/repo'] });
    writeFileSync(heldFile(home), JSON.stringify(['npm run seed']));
    expect(readHeld(home)).toEqual({ present: true, lines: ['npm run seed'], folders: null });
    writeFileSync(heldFile(home), '{not json');
    expect(readHeld(home)).toEqual({ present: true, lines: [], folders: null });
  });

  it('the lines alone: a bad file is an empty list', () => {
    rmSync(join(home, 'lead'), { recursive: true, force: true });
    expect(readHeldLines(home)).toEqual([]);
    mkdirSync(join(home, 'lead'), { recursive: true });
    writeFileSync(heldFile(home), '{not json');
    expect(readHeldLines(home)).toEqual([]);
    writeFileSync(heldFile(home), JSON.stringify({ other: ['x'] }));
    expect(readHeldLines(home)).toEqual([]);
    writeFileSync(heldFile(home), JSON.stringify(['gh pr merge', 3, 'npm run seed']));
    expect(readHeldLines(home)).toEqual(['gh pr merge', 'npm run seed']);
  });
});
