import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { createClient } from '../../src/lib/client';
import { buildApp } from '../../src/server/app';
import { capAnswer, checkLeadToolsStart, createLeadToolsServer, TOOL_ANSWER_MAX_BYTES } from '../../src/server/lead/tools';
import { addResource } from '../../src/server/repo/resources';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject, setProjectLead } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

const V = LEAD_INSTRUCTIONS_VERSION;
const temps: string[] = [];
const closers: (() => Promise<unknown>)[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

/** A repository with main, a merged branch and an unmerged branch that changes one file. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ip-lead-tools-'));
  temps.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'checkout', '-q', '-b', 'feature/done');
  writeFileSync(join(dir, 'b.txt'), 'two\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'second');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'feature/done');
  git(dir, 'checkout', '-q', '-b', 'feature/open');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'c.txt'), 'three\nfour\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'third');
  git(dir, 'checkout', '-q', 'main');
  return dir;
}

async function connect(opts: Partial<Parameters<typeof createLeadToolsServer>[0]> & { baseUrl: string }): Promise<Client> {
  const { baseUrl, ...rest } = opts;
  const server = createLeadToolsServer({ slug: 'ingame', client: createClient({ baseUrl }), as: 'Progresser', instructions: V, ...rest });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
}

let base = '';
let stepId = 0;
let resourceId = 0;
let repo = '';
let live: Client;
let withRepo: Client;

beforeAll(async () => {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Build tabs' }] });
  stepId = step.id;
  resourceId = addResource(ctx, 'test', { nodeId: step.id, kind: 'doc', title: 'Tabs handoff', content: 'The tabs plan', purpose: 'handoff' }).id;
  const app = buildApp({ ctx, token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  closers.push(() => app.close());
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  repo = makeRepo();
  live = await connect({ baseUrl: base });
  withRepo = await connect({ baseUrl: base, repo });
});
afterAll(async () => {
  for (const close of closers) await close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const asked = `as=Progresser&instructions=${V}`;
const get = async (path: string) => ((await (await fetch(`${base}${path}`)).json()) as { text: string }).text;

describe('the lead tools', () => {
  it('offer these eight tools and no others', async () => {
    const names = (await live.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['branch_exists', 'branch_merged', 'brief', 'change_size', 'desk', 'resource', 'search', 'step'].sort());
  });

  it('read what the matching lead reads return', async () => {
    expect(await call(live, 'desk')).toEqual({ text: await get('/api/lead/ingame/desk'), isError: false });
    expect(await call(live, 'brief')).toEqual({ text: await get(`/api/lead/ingame/brief?${asked}`), isError: false });
    const step = await call(live, 'step', { id: stepId });
    expect(step).toEqual({ text: await get(`/api/lead/ingame/step/${stepId}?${asked}`), isError: false });
    expect(step.text).toContain('Build tabs');
    const resource = await call(live, 'resource', { id: resourceId });
    expect(resource).toEqual({ text: await get(`/api/lead/ingame/resource/${resourceId}?${asked}`), isError: false });
    expect(resource.text).toContain('The tabs plan');
    const search = await call(live, 'search', { query: 'tabs' });
    expect(search.isError).toBe(false);
    expect(search.text).toContain(`#${stepId} Build tabs`);
    expect(search.text).toContain(`r${resourceId} Tabs handoff`);
  });

  it('pass a server refusal on, with its own words', async () => {
    const res = await call(live, 'step', { id: 99999 });
    expect(res.isError).toBe(true);
    expect(res.text).not.toBe('InProgress is not answering');
  });

  it('answer "InProgress is not answering" when nothing listens, and start nothing', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    const down = await connect({ baseUrl: `http://127.0.0.1:${closedPort}`, repo });
    for (const [name, args] of [['desk', {}], ['brief', {}], ['step', { id: 1 }], ['resource', { id: 1 }], ['search', { query: 'x' }]] as const) {
      expect(await call(down, name, args)).toEqual({ text: 'InProgress is not answering', isError: true });
    }
    // Nothing came up in its place: the port is still closed.
    await expect(fetch(`http://127.0.0.1:${closedPort}/api/lead/ingame/desk`)).rejects.toThrow();
  });
});

describe('the cap', () => {
  it('leaves a short answer alone and cuts a long one at 40 KB with a closing line', () => {
    expect(capAnswer('short')).toBe('short');
    const cut = capAnswer('x'.repeat(TOOL_ANSWER_MAX_BYTES + 500));
    expect(cut.startsWith('x'.repeat(TOOL_ANSWER_MAX_BYTES))).toBe(true);
    expect(cut.split('\n').at(-1)).toMatch(/^\[Cut: /);
    expect(Buffer.byteLength(cut)).toBeLessThan(TOOL_ANSWER_MAX_BYTES + 200);
  });
});

describe('the start check', () => {
  const env = { INPROGRESS_HOME: 'C:/h', INPROGRESS_PORT: '4411', INPROGRESS_LEAD_AS: 'Progresser' };
  it('accepts a full environment and a slug, reading the instructions version from the code', () => {
    expect(checkLeadToolsStart(env, ['ingame'])).toEqual({ ok: true, slug: 'ingame', port: 4411, as: 'Progresser', instructions: V });
    expect(checkLeadToolsStart({ ...env, INPROGRESS_LEAD_REPO: 'C:/r' }, ['ingame'])).toMatchObject({ ok: true, repo: 'C:/r' });
  });
  it('refuses without the home, without the port, with either empty, and without a slug', () => {
    expect(checkLeadToolsStart({ ...env, INPROGRESS_HOME: undefined }, ['ingame'])).toMatchObject({ ok: false, error: expect.stringContaining('INPROGRESS_HOME') });
    expect(checkLeadToolsStart({ ...env, INPROGRESS_HOME: '  ' }, ['ingame'])).toMatchObject({ ok: false });
    expect(checkLeadToolsStart({ ...env, INPROGRESS_PORT: undefined }, ['ingame'])).toMatchObject({ ok: false, error: expect.stringContaining('INPROGRESS_PORT') });
    expect(checkLeadToolsStart({ ...env, INPROGRESS_PORT: '' }, ['ingame'])).toMatchObject({ ok: false });
    expect(checkLeadToolsStart({ ...env, INPROGRESS_PORT: 'abc' }, ['ingame'])).toMatchObject({ ok: false });
    expect(checkLeadToolsStart(env, [])).toMatchObject({ ok: false, error: expect.stringContaining('no project') });
  });
});

describe('the git tools', () => {
  it('say whether a branch is merged into main', async () => {
    expect((await call(withRepo, 'branch_merged', { branch: 'feature/done' })).text).toBe('feature/done is merged into main');
    expect((await call(withRepo, 'branch_merged', { branch: 'feature/open' })).text).toBe('feature/open is not merged into main');
    expect((await call(withRepo, 'branch_merged', { branch: 'feature/nope' })).text).toMatch(/^Could not tell/);
  });

  it('give the size of a change and its files', async () => {
    const res = await call(withRepo, 'change_size', { branch: 'feature/open' });
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/1 file changed, 2 insertions/);
    expect(res.text.split('\n')).toContain('src/c.txt');
  });

  it('say whether a branch exists', async () => {
    expect((await call(withRepo, 'branch_exists', { branch: 'feature/open' })).text).toBe('feature/open exists');
    expect((await call(withRepo, 'branch_exists', { branch: 'feature/nope' })).text).toBe('feature/nope does not exist');
  });

  it('refuse a name with "..", a leading dash or a space before git runs', async () => {
    // No repository is set here, so a name that got past the check would answer with that instead.
    for (const branch of ['a..b', '-delete', '--upstream=x', 'two words', '', 'a;rm']) {
      for (const tool of ['branch_merged', 'change_size', 'branch_exists']) {
        expect((await call(live, tool, { branch })).text).toBe(`Not a branch name: ${branch}`);
        expect((await call(withRepo, tool, { branch })).text).toBe(`Not a branch name: ${branch}`);
      }
    }
  });

  it('say there is no repository when none is set', async () => {
    for (const tool of ['branch_merged', 'change_size', 'branch_exists']) {
      expect((await call(live, tool, { branch: 'feature/open' })).text).toBe('No repository for this project');
    }
  });
});
