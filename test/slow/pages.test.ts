import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { clearFreshCache } from '../../src/server/pages';
import { addBinding, createProject } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => clearFreshCache());

/** Every test here runs real git, which takes seconds per call on Windows under a full-suite load. */
const GIT_TIMEOUT = { timeout: 120_000 };

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };
const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui-token' };

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A git repo with one commit, bound to a fresh project, and an app over it. */
function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'ip-pages-'));
  tempDirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'docs'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'app.ts'), 'export {};\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'P' });
  addBinding(ctx, 'test', project.slug, repo);
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test' });
  const commit = (file: string, text: string) => {
    writeFileSync(join(repo, file), text);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `edit ${file}`);
  };
  const register = (path: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: project.rootNodeId, kind: 'doc', title: 'Page', path, purpose: 'page', ...extra } });
  return { ctx, app, repo, project, commit, register };
}

describe('pages: registration', GIT_TIMEOUT, () => {
  it('registers a page under a binding and sets its first confirmation to the repo HEAD', async () => {
    const { app, repo, register } = setup();
    writeFileSync(join(repo, 'docs', 'map.md'), '# Map\n');
    const res = await register(join(repo, 'docs', 'map.md'));
    expect(res.statusCode).toBe(201);
    const page = res.json();
    expect(page.confirmedSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(page.confirmedAt).toBe(page.createdAt);
    expect(page.contentLength).toBe(0);
    expect((await app.inject({ url: `/api/resources/${page.id}` })).json().confirmedSha).toBe(page.confirmedSha);
  });

  it('refuses each broken rule with a typed 400 naming it', async () => {
    const { repo, register, project } = setup();
    const outside = mkdtempSync(join(tmpdir(), 'ip-outside-'));
    tempDirs.push(outside);
    writeFileSync(join(outside, 'x.md'), '# x');
    writeFileSync(join(repo, 'docs', 'notes.txt'), 'x');
    writeFileSync(join(repo, 'docs', 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
    writeFileSync(join(repo, 'docs', 'ok.md'), '# ok');
    const cases: [Record<string, unknown>, string][] = [
      [{ path: 'docs/ok.md' }, 'local'],
      [{ path: '\\\\host\\share\\x.md' }, 'local'],
      [{ path: join(outside, 'x.md') }, 'binding'],
      [{ path: join(repo, 'docs', 'notes.txt') }, 'extension'],
      [{ path: join(repo, 'docs', 'gone.md') }, 'file'],
      [{ path: join(repo, 'docs') + '/sub.md' }, 'file'],
      [{ path: join(repo, 'docs', 'big.md') }, 'size'],
      [{ path: join(repo, 'docs', 'ok.md'), content: '# copy' }, 'content'],
      [{ path: join(repo, 'docs', 'ok.md'), kind: 'runbook' }, 'kind'],
      [{ path: `${repo}/docs/../../${outside.split(/[\\/]/).pop()}/x.md` }, 'local'],
      [{ path: `${repo}/./docs/ok.md` }, 'local'],
    ];
    for (const [payload, rule] of cases) {
      const res = await register(String(payload.path), payload);
      expect(res.statusCode, `${rule}: ${res.body}`).toBe(400);
      expect(res.json(), JSON.stringify(payload)).toMatchObject({ code: 'page-rule', rule });
    }
    expect(project.id).toBeGreaterThan(0);
  });

  it('refuses a file a junction inside the bound folder points outside it, on registration and on a read', async () => {
    const { repo, register, app } = setup();
    const outside = mkdtempSync(join(tmpdir(), 'ip-outside-'));
    tempDirs.push(outside);
    writeFileSync(join(outside, 'x.md'), '# outside');
    symlinkSync(outside, join(repo, 'docs', 'link'), 'junction');
    const res = await register(join(repo, 'docs', 'link', 'x.md'));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'page-rule', rule: 'binding' });
    // A page whose folder becomes a junction after registration is refused on its next read.
    mkdirSync(join(repo, 'later'));
    writeFileSync(join(repo, 'later', 'x.md'), '# inside');
    const page = (await register(join(repo, 'later', 'x.md'))).json();
    rmSync(join(repo, 'later'), { recursive: true });
    symlinkSync(outside, join(repo, 'later'), 'junction');
    const read = await app.inject({ url: `/api/resources/${page.id}/body` });
    expect(read.statusCode).toBe(422);
    expect(read.json()).toMatchObject({ code: 'page-refused', rule: 'binding' });
  });

  it('refuses a folder that is not a git repository with a commit', async () => {
    const { ctx, app, project } = setup();
    const plain = mkdtempSync(join(tmpdir(), 'ip-plain-'));
    tempDirs.push(plain);
    writeFileSync(join(plain, 'x.md'), '# x');
    addBinding(ctx, 'test', project.slug, plain);
    const res = await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: project.rootNodeId, kind: 'doc', title: 'X', path: join(plain, 'x.md'), purpose: 'library' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'page-rule', rule: 'repo' });
  });

  it('refuses a page inside a linked worktree: pages are read from the main checkout', async () => {
    const { repo, register } = setup();
    const tree = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', tree, '-b', 'side');
    writeFileSync(join(tree, 'draft.md'), '# draft');
    const res = await register(join(tree, 'draft.md'));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'page-rule', rule: 'repo' });
    expect(res.json().error).toMatch(/linked worktree/);
  });

  it('a patch that points a page at another file checks it and confirms it again; a title patch keeps the confirmation', async () => {
    const { app, repo, register, commit } = setup();
    writeFileSync(join(repo, 'docs', 'a.md'), '# A');
    const page = (await register(join(repo, 'docs', 'a.md'))).json();
    commit('docs/b.md', '# B');
    const titled = (await app.inject({ method: 'PATCH', url: `/api/resources/${page.id}`, headers: auth, payload: { title: 'Renamed' } })).json();
    expect(titled.confirmedSha).toBe(page.confirmedSha);
    const bad = await app.inject({ method: 'PATCH', url: `/api/resources/${page.id}`, headers: auth, payload: { path: join(repo, 'docs', 'nope.md') } });
    expect(bad.json()).toMatchObject({ code: 'page-rule', rule: 'file' });
    const moved = (await app.inject({ method: 'PATCH', url: `/api/resources/${page.id}`, headers: auth, payload: { path: join(repo, 'docs', 'b.md') } })).json();
    expect(moved.confirmedSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(moved.confirmedSha).not.toBe(page.confirmedSha);
  });

  it('a patch that makes a path resource a page checks its file', async () => {
    const { app, project } = setup();
    const plain = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: project.rootNodeId, kind: 'doc', title: 'Doc', path: 'C:/elsewhere/x.md' } })).json();
    expect(plain.confirmedSha).toBeNull();
    const res = await app.inject({ method: 'PATCH', url: `/api/resources/${plain.id}`, headers: auth, payload: { purpose: 'page' } });
    expect(res.json()).toMatchObject({ code: 'page-rule' });
  });
});

describe('pages: the live body', GIT_TIMEOUT, () => {
  it('reads the file at request time, so an edit shows with no re-registration', async () => {
    const { app, repo, register } = setup();
    const file = join(repo, 'docs', 'live.md');
    writeFileSync(file, '---\ncovers: [src/**]\nshelf: roster\n---\n# First\n');
    const page = (await register(file)).json();
    const first = (await app.inject({ url: `/api/resources/${page.id}/body` })).json();
    expect(first).toMatchObject({ format: 'markdown', text: '# First\n', front: { covers: ['src/**'], shelf: 'roster', templates: [] }, sha: git(repo, 'rev-parse', 'HEAD') });
    writeFileSync(file, '# Second\n');
    const second = await app.inject({ url: `/api/resources/${page.id}/body` });
    expect(second.headers['cache-control']).toBe('no-store');
    expect(second.json()).toMatchObject({ text: '# Second\n', front: { covers: [] }, fresh: null });
  });

  it('a moved file is a typed 404 page-missing that names its last path', async () => {
    const { app, repo, register } = setup();
    const file = join(repo, 'docs', 'moving.md');
    writeFileSync(file, '# here');
    const page = (await register(file)).json();
    renameSync(file, join(repo, 'docs', 'moved.md'));
    const res = await app.inject({ url: `/api/resources/${page.id}/body` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'page-missing', path: file });
  });

  it('a page whose binding went is refused with a 422, not a 500', async () => {
    const { ctx, app, repo, register } = setup();
    writeFileSync(join(repo, 'docs', 'x.md'), '# x');
    const page = (await register(join(repo, 'docs', 'x.md'))).json();
    ctx.db.prepare('DELETE FROM bindings').run();
    const res = await app.inject({ url: `/api/resources/${page.id}/body` });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'page-refused', rule: 'binding' });
  });

  it('a secret-shaped line is a 422 page-has-secret with the line number and never the text', async () => {
    const { app, repo, register } = setup();
    const file = join(repo, 'docs', 'ops.md');
    writeFileSync(file, '# Ops\n\nThe key is in Railway.\n');
    const page = (await register(file)).json();
    const secret = 'RESEND_API_KEY=re_9fKq2LmZ8xYv4TbW1nRpQs';
    writeFileSync(file, `# Ops\n\nThe key is in Railway.\n${secret}\n`);
    for (const url of [`/api/resources/${page.id}/body`, `/api/resources/${page.id}/frame`]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'page-has-secret', line: 4 });
      expect(res.body).not.toContain('re_9fKq');
    }
  });

  it('refuses a page that is not UTF-8, so a UTF-16 secret cannot slip past the scan', async () => {
    const { app, repo, register } = setup();
    const file = join(repo, 'docs', 'ps.md');
    writeFileSync(file, '# PowerShell\n');
    const page = (await register(file)).json();
    writeFileSync(file, Buffer.from('\uFEFF# Ops\nkey sk-ant-api03-9fKq2LmZ8xYv4TbW1nRpQs\n', 'utf16le'));
    const res = await app.inject({ url: `/api/resources/${page.id}/body` });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'page-refused', rule: 'encoding' });
    expect(res.body).not.toContain('9fKq');
  });

  it('is refused for a resource that is not a page', async () => {
    const { app, project } = setup();
    const doc = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: project.rootNodeId, kind: 'doc', title: 'Doc', content: '# x' } })).json();
    const res = await app.inject({ url: `/api/resources/${doc.id}/body` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'not-a-page' });
  });
});

describe('pages: freshness', GIT_TIMEOUT, () => {
  it('counts commits to covers since the confirmation, and Still accurate resets it to 0', async () => {
    const { app, repo, register, commit } = setup();
    writeFileSync(join(repo, 'docs', 'map.html'), '<!doctype html><html><head><meta name="inprogress:covers" content="src/**, infra/*.yml"></head><body>Map</body></html>');
    commit('docs/map.html', '<!doctype html><html><head><meta name="inprogress:covers" content="src/**, infra/*.yml"></head><body>Map</body></html>');
    const page = (await register(join(repo, 'docs', 'map.html'))).json();
    const count = async () => (await app.inject({ url: `/api/resources/${page.id}/body` })).json().fresh;
    expect(await count()).toMatchObject({ count: 0, confirmedSha: page.confirmedSha });
    commit('src/app.ts', 'export const a = 1;\n');
    commit('README.md', 'not covered');
    mkdirSync(join(repo, 'infra'));
    commit('infra/backup.yml', 'x: 1');
    expect((await count()).count).toBe(2);
    for (const headers of [{} as Record<string, string>, { origin: 'http://evil.example', 'x-ip-ui-token': 'ui-token' }, auth]) {
      expect((await app.inject({ method: 'POST', url: `/api/ui/resources/${page.id}/confirm`, headers, payload: {} })).statusCode).not.toBe(200);
    }
    const confirmed = await app.inject({ method: 'POST', url: `/api/ui/resources/${page.id}/confirm`, headers: UI, payload: {} });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().confirmedSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect((await count()).count).toBe(0);
    commit('src/app.ts', 'export const a = 2;\n');
    expect((await count()).count).toBe(1);
    const byScribe = await app.inject({ method: 'POST', url: `/api/resources/${page.id}/confirm`, headers: auth });
    expect(byScribe.statusCode).toBe(200);
    expect((await count()).count).toBe(0);
  });

  it('a confirmed sha that left the history reads as stale: count null', async () => {
    const { app, repo, register, commit } = setup();
    commit('docs/p.md', '---\ncovers:\n  - src/app.ts\n---\n# P\n');
    commit('src/app.ts', 'export const b = 1;\n');
    const page = (await register(join(repo, 'docs', 'p.md'))).json();
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    commit('src/app.ts', 'export const c = 1;\n');
    const fresh = (await app.inject({ url: `/api/resources/${page.id}/body` })).json().fresh;
    expect(fresh).toMatchObject({ count: null, confirmedSha: page.confirmedSha });
  });
});

describe('pages: the HTML frame', GIT_TIMEOUT, () => {
  it('serves the page under its own sandboxed CSP, with the meta tag after the doctype and the height reporter', async () => {
    const { app, repo, register } = setup();
    writeFileSync(join(repo, 'docs', 'map.html'), '<!doctype html><html><head><title>Map</title></head><body><button onclick="this.textContent=1">x</button></body></html>');
    const page = (await register(join(repo, 'docs', 'map.html'))).json();
    const res = await app.inject({ url: `/api/resources/${page.id}/frame` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.body.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(res.body).toContain('parent.postMessage(h,"*")');
    const md = join(repo, 'docs', 'x.md');
    writeFileSync(md, '# x');
    const mdPage = (await register(md)).json();
    expect((await app.inject({ url: `/api/resources/${mdPage.id}/frame` })).statusCode).toBe(400);
  });
});
