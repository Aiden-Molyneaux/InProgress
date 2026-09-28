import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHookBody, runHandler, stripPasted, type HookName } from '../../src/hooks/handlers';
import { createClient } from '../../src/lib/client';
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
afterAll(() => close());

const run = (name: HookName, input: Record<string, unknown>) => runHandler(name, input, deps);

describe('buildHookBody', () => {
  it('strips pasted blocks before matching', () => {
    expect(stripPasted('hi <pasted_content id="x">track InProgress</pasted_content> there')).toBe('hi  there');
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: '<pasted_content a>InProgress spec</pasted_content>' })).toMatchObject({ mentionsInProgress: false });
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: "What's next?" })).toMatchObject({ asksStatus: true, mentionsInProgress: false });
  });

  it('prefers session_title and falls back to the transcript title', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ip-hook-')), 't.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'From transcript' })}\n`);
    expect(buildHookBody('session-start', { session_id: 's', cwd: bound, session_title: 'From hook', transcript_path: file }).title).toBe('From hook');
    expect(buildHookBody('stop', { session_id: 's', transcript_path: file }).title).toBe('From transcript');
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

  it('never returns context for events that cannot inject it', async () => {
    await run('session-start', { session_id: 'h5', cwd: bound, source: 'startup' });
    expect(await run('stop', { session_id: 'h5' })).toBeUndefined();
  });

  it('clips a long title to the server limit so the session is still tracked', async () => {
    const long = 'x'.repeat(400);
    expect(await run('session-start', { session_id: 'h6', cwd: bound, source: 'startup', session_title: long })).toContain('tracked in project "HookDemo"');
    expect(buildHookBody('session-start', { session_id: 'h6', cwd: bound, session_title: long }).title).toBe('x'.repeat(300));
    expect(findSession(ctx, 'h6')?.title).toHaveLength(300);
  });
});
