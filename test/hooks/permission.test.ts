import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runHandler, type HookDeps } from '../../src/hooks/handlers';
import { createClient } from '../../src/lib/client';

/** A stub InProgress: records each request and answers what the test sets, after `delayMs` (the long poll). */
const requests: { path: string; body: Record<string, unknown> }[] = [];
let reply: (path: string) => unknown = () => ({ say: 'nothing' });
let delayMs = 0;
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') as Record<string, unknown> });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply(req.url ?? '')));
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  requests.length = 0;
  reply = () => ({ say: 'nothing' });
  delayMs = 0;
});

const deps = (url = base): HookDeps => ({
  post: async () => ({ tracked: false }),
  ensureServer: async () => true,
  lead: { post: (path, body, timeoutMs) => createClient({ baseUrl: url, token: 'tok', timeoutMs }).post(path, body), heldLines: () => [] },
});
const request = (tool_name: string, tool_input: unknown) => ({ session_id: 's1', cwd: 'C:/repo', hook_event_name: 'PermissionRequest', tool_name, tool_input });
const decision = (d: object) => ({ json: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } } });

describe('the permission hook', () => {
  it('puts any other request on the desk and prints the lead\'s allow after the long poll', async () => {
    delayMs = 300;
    reply = () => ({ behavior: 'allow', message: 'reading the tests is the step' });
    expect(await runHandler('permission', request('Read', { file_path: 'C:/repo/x.ts' }), deps())).toStrictEqual(decision({ behavior: 'allow' }));
    expect(requests).toEqual([{ path: '/api/lead/stuck', body: { sessionId: 's1', cwd: 'C:/repo', toolName: 'Read', toolInput: { file_path: 'C:/repo/x.ts' } } }]);
  });

  it("prints the lead's deny with his reason", async () => {
    reply = () => ({ behavior: 'deny', message: 'that folder is another project' });
    expect(await runHandler('permission', request('Edit', { file_path: 'C:/other/a.ts' }), deps())).toStrictEqual(decision({ behavior: 'deny', message: 'that folder is another project' }));
  });

  it('prints nothing when the lead says nothing, or the server is down: the prompt shows as today', async () => {
    expect(await runHandler('permission', request('WebFetch', { url: 'https://x' }), deps())).toBeUndefined();
    expect(await runHandler('permission', request('WebFetch', { url: 'https://x' }), deps('http://127.0.0.1:9'))).toBeUndefined();
  });

  it('refuses a command on the hold list the way the hold hook does, without a stuck item', async () => {
    reply = (path) => (path === '/api/lead/hold' ? { held: true, text: 'a publish of feature' } : { behavior: 'allow' });
    expect(await runHandler('permission', request('Bash', { command: 'npm publish' }), deps())).toStrictEqual(
      decision({ behavior: 'deny', message: 'Held for Aiden before it runs: a publish of feature. It waits for his word. Do not retry it and do not try another way.' }),
    );
    expect(requests.map((r) => r.path)).toEqual(['/api/lead/hold']);
  });

  it('a held command fails closed when the server is down', async () => {
    const out = await runHandler('permission', request('PowerShell', { command: 'git push' }), deps('http://127.0.0.1:9'));
    expect(out).toStrictEqual(decision({ behavior: 'deny', message: expect.stringContaining('InProgress is not answering') }));
  });

  it('a command on the list that the check clears is left to the prompt', async () => {
    expect(await runHandler('permission', request('Bash', { command: 'git push' }), deps())).toBeUndefined();
    expect(requests.map((r) => r.path)).toEqual(['/api/lead/hold']);
  });

  it('an ordinary command goes to the desk as any other request', async () => {
    await runHandler('permission', request('Bash', { command: 'npm install left-pad' }), deps());
    expect(requests.map((r) => r.path)).toEqual(['/api/lead/stuck']);
  });

  it('prints nothing for an answer it cannot read', async () => {
    reply = () => ({ behavior: 'maybe' });
    expect(await runHandler('permission', request('Read', {}), deps())).toBeUndefined();
  });
});
