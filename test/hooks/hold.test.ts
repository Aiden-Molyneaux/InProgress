import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runHandler, type HookDeps } from '../../src/hooks/handlers';
import { heldFile, readHeldLines } from '../../src/hooks/hold';
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

const deps = (url = base, heldLines: string[] = []): HookDeps => ({
  post: async () => ({ tracked: false }),
  ensureServer: async () => true,
  lead: { post: (path, body, timeoutMs) => createClient({ baseUrl: url, token: 'tok', timeoutMs }).post(path, body), heldLines: () => heldLines },
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
    expect(requests).toEqual([{ path: '/api/lead/hold', body: { sessionId: 's1', cwd: 'C:/repo', command: 'npm test && git push origin feature', action: 'push' } }]);
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
    expect(requests.map((r) => r.body.action)).toEqual(['merge', 'push']);
    expect(out).toStrictEqual(deny('Held for Aiden before it runs: a push of x to origin. It waits for his word. Do not retry it and do not try another way.'));
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
    expect(await runHandler('hold', bash('gh pr merge 12'), deps(base))).toBeUndefined();
    expect(requests).toEqual([]);
    await runHandler('hold', bash('gh pr merge 12'), deps(base, ['gh pr merge']));
    expect(requests.map((r) => r.body.action)).toEqual(['playbook']);
  });
});

describe('held.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'ip-held-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('reads an array of strings; a missing or bad file is an empty list', () => {
    expect(readHeldLines(home)).toEqual([]);
    mkdirSync(join(home, 'lead'), { recursive: true });
    writeFileSync(heldFile(home), '{not json');
    expect(readHeldLines(home)).toEqual([]);
    writeFileSync(heldFile(home), JSON.stringify({ lines: ['x'] }));
    expect(readHeldLines(home)).toEqual([]);
    writeFileSync(heldFile(home), JSON.stringify(['gh pr merge', 3, 'npm run seed']));
    expect(readHeldLines(home)).toEqual(['gh pr merge', 'npm run seed']);
  });
});
