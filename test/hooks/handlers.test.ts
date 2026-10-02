import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHookBody, HOOK_NAMES, hookErrorLine, parseHookInput, runHandler, stripPasted, type HookName } from '../../src/hooks/handlers';
import { ApiClientError, createClient } from '../../src/lib/client';
import { buildApp } from '../../src/server/app';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject } from '../../src/server/repo/projects';
import { findSession } from '../../src/server/repo/sessions';
import type { Ctx } from '../../src/server/db/tx';
import { makeCtx } from '../helpers';

let ctx: Ctx;
let close: () => Promise<unknown>;
let deps: Parameters<typeof runHandler>[2];
const bound = 'C:/personal/HookDemo';
const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

beforeAll(async () => {
  ctx = makeCtx();
  const p = createProject(ctx, 'test', { name: 'HookDemo' });
  addBinding(ctx, 'test', p.slug, bound);
  addNodes(ctx, 'test', { parentId: p.rootNodeId, nodes: [{ title: 'Step one', status: 'active' }, { title: 'Run the tests', assignee: 'me' }] });
  const app = buildApp({ ctx, token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const client = createClient({ baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, token: 'tok' });
  deps = { post: (path, body) => client.post(path, body), ensureServer: async () => true };
  close = () => app.close();
});
afterAll(async () => {
  await close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const run = (name: HookName, input: Record<string, unknown>) => runHandler(name, input, deps);

describe('parseHookInput', () => {
  it('ignores a UTF-8 BOM (PowerShell pipes add one) and reads empty input as {}', () => {
    expect(parseHookInput('\uFEFF{"session_id":"s1","cwd":"C:/x"}\r\n')).toEqual({ session_id: 's1', cwd: 'C:/x' });
    expect(parseHookInput('')).toEqual({});
    expect(parseHookInput(' \r\n')).toEqual({});
  });
});

describe('hookErrorLine', () => {
  it('appends a string hint and never throws on odd errors', () => {
    expect(hookErrorLine('stop', new ApiClientError(400, 'Invalid body', 'title: too long'))).toBe('stop: Invalid body (title: too long)');
    // A foreign server's 4xx can carry any JSON as its hint; one with no prototype cannot even become a string.
    expect(hookErrorLine('stop', new ApiClientError(418, 'HTTP 418', Object.create(null) as string))).toBe('stop: HTTP 418');
    expect(hookErrorLine('stop', 'plain text')).toBe('stop: plain text');
    expect(hookErrorLine('stop', null)).toBe('stop: null');
  });
});

describe('buildHookBody', () => {
  it('strips pasted blocks before matching', () => {
    expect(stripPasted('hi <pasted_content id="x">track InProgress</pasted_content> there')).toBe('hi  there');
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: '<pasted_content a>InProgress spec</pasted_content>' })).toMatchObject({ mentionsInProgress: false });
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: "What's next?" })).toMatchObject({ asksStatus: true, mentionsInProgress: false });
  });

  it.each<[string, boolean]>([
    ['where are we?', true],
    ['What’s next?', true],
    ["what's the status?", true],
    ['status?', true],
    ['status', true],
    ['  Status ?  ', true],
    ['status check please', true],
    ['run git status', false],
    ['the HTTP status code is 500', false],
    ['update the status field', false],
    ['status??', false],
  ])('treats %j as a status question: %s', (prompt, asks) => {
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt }).asksStatus).toBe(asks);
  });

  it('checks a long whitespace run in linear time', () => {
    const prompt = `status${' '.repeat(50_000)}x`;
    const started = performance.now();
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt }).asksStatus).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('marks background-task notices, which reach UserPromptSubmit like typed prompts', () => {
    const notices = [
      'Another Claude session sent a message:\n<agent-message from="a1">done</agent-message>',
      '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>',
      '  [SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.',
    ];
    for (const prompt of notices) {
      expect(buildHookBody('prompt-submit', { session_id: 's', prompt }), prompt).toMatchObject({ notice: true, mentionsInProgress: false, asksStatus: false });
    }
    for (const prompt of ['where are we?', 'Explain this <task-notification> tag in InProgress']) {
      expect(buildHookBody('prompt-submit', { session_id: 's', prompt }), prompt).not.toHaveProperty('notice');
    }
  });

  it('sends cwd and branch with prompts, as session-start does, so a missed start can self-heal', () => {
    const repo = tempDir('ip-hook-git-');
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/VCAD-978\n');
    const cwd = join(repo, 'src');
    expect(buildHookBody('prompt-submit', { session_id: 's', cwd, prompt: 'hi' })).toMatchObject({ event: 'prompt', cwd, branch: 'feature/VCAD-978' });
    const outside = tempDir('ip-hook-plain-');
    const pick = ({ cwd: c, branch }: Record<string, unknown>) => ({ cwd: c, branch });
    expect(pick(buildHookBody('prompt-submit', { session_id: 's', cwd: outside, prompt: 'hi' }))).toEqual(pick(buildHookBody('session-start', { session_id: 's', cwd: outside })));
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: 'hi' })).not.toHaveProperty('cwd');
    expect(buildHookBody('stop', { session_id: 's', cwd })).not.toHaveProperty('cwd');
  });

  it('leaves out a folder or branch longer than the server accepts, so the prompt still posts', () => {
    const long = `C:/${'x'.repeat(1_000)}`;
    expect(buildHookBody('prompt-submit', { session_id: 's', cwd: long, prompt: 'hi' })).not.toHaveProperty('cwd');
    const repo = tempDir('ip-hook-git-');
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), `ref: refs/heads/${'b'.repeat(301)}\n`);
    expect(buildHookBody('prompt-submit', { session_id: 's', cwd: repo, prompt: 'hi' })).toMatchObject({ cwd: repo, branch: null });
  });

  it('prefers session_title and falls back to the transcript title', () => {
    const file = join(tempDir('ip-hook-'), 't.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'From transcript' })}\n`);
    expect(buildHookBody('session-start', { session_id: 's', cwd: bound, session_title: 'From hook', transcript_path: file }).title).toBe('From hook');
    expect(buildHookBody('stop', { session_id: 's', transcript_path: file }).title).toBe('From transcript');
  });

  it('omits an empty source so the server treats the start as a startup', () => {
    expect(buildHookBody('session-start', { session_id: 's', source: '' })).not.toHaveProperty('source');
  });
});

describe('runHandler', () => {
  it('briefs a session started in a bound folder and ignores others', async () => {
    const brief = await run('session-start', { session_id: 'h1', cwd: `${bound}/src`, source: 'startup', session_title: 'Hook session' });
    expect(brief).toContain('tracked in project "HookDemo"');
    expect(brief).toContain('Session id: h1');
    expect(findSession(ctx, 'h1')?.title).toBe('Hook session');
    expect(await run('session-start', { session_id: 'h2', cwd: 'C:/elsewhere', source: 'startup' })).toBeUndefined();
    expect(findSession(ctx, 'h2')).toBeUndefined();
  });

  it('hints untracked sessions only on a direct mention', async () => {
    expect(await run('prompt-submit', { session_id: 'h3', prompt: '<pasted_content>InProgress</pasted_content>' })).toBeUndefined();
    expect(await run('prompt-submit', { session_id: 'h3', prompt: 'track this in InProgress please' })).toContain('Session id: h3');
  });

  it('answers status questions and updates states', async () => {
    await run('session-start', { session_id: 'h4', cwd: bound, source: 'startup' });
    expect(await run('prompt-submit', { session_id: 'h4', prompt: 'where are we?' })).toContain('Where things stand in HookDemo');
    await run('notification', { session_id: 'h4' });
    expect(findSession(ctx, 'h4')?.state).toBe('permission');
    await run('subagent-start', { session_id: 'h4', agent_id: 'ag1', agent_type: 'Explore' });
    expect(findSession(ctx, 'h4')).toMatchObject({ state: 'working', subagents: [{ agentId: 'ag1', agentType: 'Explore' }] });
    await run('subagent-stop', { session_id: 'h4', agent_id: 'ag1', agent_type: 'Explore' });
    await run('stop', { session_id: 'h4' });
    await run('session-end', { session_id: 'h4' });
    expect(findSession(ctx, 'h4')).toMatchObject({ state: 'ended', subagents: [] });
  });

  it('does nothing without a session id', async () => {
    let posted = false;
    const r = await runHandler('stop', {}, { post: async () => { posted = true; return { tracked: false }; }, ensureServer: async () => true });
    expect(r).toBeUndefined();
    expect(posted).toBe(false);
  });

  it('returns context only for events that can inject it', async () => {
    const stub: Parameters<typeof runHandler>[2] = { post: async () => ({ tracked: true, context: 'x' }), ensureServer: async () => true };
    const got: Record<string, string | undefined> = {};
    for (const name of HOOK_NAMES) got[name] = await runHandler(name, { session_id: 's' }, stub);
    expect(got).toStrictEqual({ 'session-start': 'x', 'prompt-submit': 'x', stop: undefined, notification: undefined, 'subagent-start': undefined, 'subagent-stop': undefined, 'session-end': undefined });
  });

  it('clips a long title to the server limit so the session is still tracked', async () => {
    const long = 'x'.repeat(400);
    expect(await run('session-start', { session_id: 'h6', cwd: bound, source: 'startup', session_title: long })).toContain('tracked in project "HookDemo"');
    expect(buildHookBody('session-start', { session_id: 'h6', cwd: bound, session_title: long }).title).toBe('x'.repeat(300));
    expect(findSession(ctx, 'h6')?.title).toHaveLength(300);
  });
});
