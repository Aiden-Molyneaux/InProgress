import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { clearFreshCache } from '../../src/server/pages';
import { addBinding, createProject } from '../../src/server/repo/projects';
import { clearSyncCache, parseCheck } from '../../src/server/sync';
import { makeCtx } from '../helpers';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clearFreshCache();
  clearSyncCache();
});

/** Every test here runs real git, which takes seconds per call on Windows under a full-suite load. */
const GIT_TIMEOUT = { timeout: 120_000 };

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const repoDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# r\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'start');
  return dir;
};

const CHECK_JSON = {
  shipwright: { head: 'abc1234', date: '2026-10-20', subject: 'x' },
  project: 'A',
  lastSync: null,
  files: [
    { template: 'agents/sev.md', local: 'agents/sev.md', base: null, state: 'behind', behind: 2, commits: [], fills: {}, detail: null },
    { template: 'agents/moh.md', local: 'agents/moh.md', base: null, state: 'current', behind: 0, commits: [], fills: {}, detail: null },
  ],
  skip: [],
  notAdopted: [],
  fills: {},
};

/** Shipwright (a git repo bound to its own project), A (manifest pointing at it), B (manifest pointing at an unbound folder), C (no manifest). */
function setup(script?: string) {
  const ctx = makeCtx();
  const shipwright = repoDir('ip-lib-sw-');
  mkdirSync(join(shipwright, 'scripts'));
  const runs = join(shipwright, 'scripts', 'runs.txt');
  writeFileSync(
    join(shipwright, 'scripts', 'template-sync.mjs'),
    script ?? `import { appendFileSync } from 'node:fs';\nappendFileSync(new URL('runs.txt', import.meta.url), 'run;');\nconsole.log(${JSON.stringify(JSON.stringify(CHECK_JSON))});\n`,
  );
  const sw = createProject(ctx, 'test', { name: 'Shipwright' });
  addBinding(ctx, 'test', sw.slug, shipwright);
  const dirA = repoDir('ip-lib-a-');
  const dirB = repoDir('ip-lib-b-');
  const dirC = repoDir('ip-lib-c-');
  const unbound = mkdtempSync(join(tmpdir(), 'ip-lib-unbound-'));
  tempDirs.push(unbound);
  // A script in the unbound folder that marks its run: a manifest must not be able to make the server run it.
  mkdirSync(join(unbound, 'scripts'));
  writeFileSync(join(unbound, 'scripts', 'template-sync.mjs'), "import { writeFileSync } from 'node:fs';writeFileSync(new URL('ran.txt', import.meta.url), 'ran');console.log('{}');");
  const manifest = (dir: string, shipwrightPath: string, adopts: string[]) => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'shipwright.json'), JSON.stringify({ shipwright: shipwrightPath, files: Object.fromEntries(adopts.map((t) => [t, {}])), skip: [] }));
  };
  manifest(dirA, shipwright, ['agents/sev.md', 'skills/sigmund/SKILL.md']);
  manifest(dirB, unbound, ['agents/moh.md']);
  const a = createProject(ctx, 'test', { name: 'Alpha' });
  addBinding(ctx, 'test', a.slug, dirA);
  const b = createProject(ctx, 'test', { name: 'Bravo' });
  addBinding(ctx, 'test', b.slug, dirB);
  const c = createProject(ctx, 'test', { name: 'Charlie' });
  addBinding(ctx, 'test', c.slug, dirC);
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test' });
  const runCount = () => {
    try {
      return readFileSync(runs, 'utf8').split(';').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const register = (project: { rootNodeId: number }, path: string, title: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: project.rootNodeId, kind: 'doc', title, path, purpose: 'library', ...extra } });
  return { ctx, app, sw, a, b, c, dirs: { shipwright, dirA, dirB, dirC, unbound }, runCount, unbound, register };
}

describe('library: sync', GIT_TIMEOUT, () => {
  it('checks each manifest, refuses an unbound Shipwright folder without running it, and lists the projects with no manifest', async () => {
    const { app, a, b, c, sw, runCount, unbound } = setup();
    const body = (await app.inject({ url: '/api/library/sync' })).json();
    expect(body.projects.map((p: { slug: string }) => p.slug)).toEqual([a.slug, b.slug]);
    const [rowA, rowB] = body.projects;
    expect(rowA.check, JSON.stringify(rowA.check)).toMatchObject({ ok: true });
    expect(rowA.check.result.files.map((f: { state: string }) => f.state)).toEqual(['behind', 'current']);
    expect(rowB.check.ok).toBe(false);
    expect(rowB.check.error).toContain(`Shipwright path ${unbound} is not a folder bound to a project`);
    expect(runCount()).toBe(1);
    expect(existsSync(join(unbound, 'scripts', 'ran.txt'))).toBe(false);
    expect(body.noManifest).toEqual([
      { projectId: sw.id, slug: sw.slug, name: 'Shipwright', source: true },
      { projectId: c.id, slug: c.slug, name: 'Charlie', source: false },
    ]);
  });

  it('runs the script once for a second load within 60 s and for two loads at once', async () => {
    const { app, runCount } = setup();
    const [one, two] = await Promise.all([app.inject({ url: '/api/library/sync' }), app.inject({ url: '/api/library/sync' })]);
    expect(one.statusCode).toBe(200);
    expect(two.statusCode).toBe(200);
    expect(runCount()).toBe(1);
    await app.inject({ url: '/api/library/sync' });
    expect(runCount()).toBe(1);
  });

  it('answers a failing script as a failed row with its stderr, and still answers the others', async () => {
    const { app } = setup("console.error('boom: bad project');\nprocess.exit(2);\n");
    const body = (await app.inject({ url: '/api/library/sync' })).json();
    expect(body.projects).toHaveLength(2);
    expect(body.projects[0].check).toEqual({ ok: false, error: 'boom: bad project' });
    expect(body.projects[1].check.ok).toBe(false);
  });
});

describe('library: pages', GIT_TIMEOUT, () => {
  it('lists library pages with their shelf and Adapted in, leaves other purposes out, and keeps a gone file as an error row', async () => {
    const { app, a, sw, dirs, register } = setup();
    writeFileSync(join(dirs.dirA, 'guide.md'), '---\ntemplates: [skills/sigmund/SKILL.md, agents/sev.md]\n---\n# Guide\n');
    writeFileSync(join(dirs.dirA, 'roster.md'), '---\nshelf: roster\n---\n# Roster\n');
    writeFileSync(join(dirs.dirA, 'plain.md'), '# Plain\n');
    writeFileSync(join(dirs.dirA, 'doomed.md'), '# Doomed\n');
    git(dirs.dirA, 'add', '.');
    git(dirs.dirA, 'commit', '-q', '-m', 'pages');
    const pages: [string, string, Record<string, unknown>][] = [
      ['Guide', 'guide.md', {}],
      ['Roster', 'roster.md', {}],
      ['Plain', 'plain.md', { purpose: 'page' }],
      ['Doomed', 'doomed.md', {}],
    ];
    for (const [title, file, extra] of pages) {
      const res = await register(a, join(dirs.dirA, file), title, extra);
      expect(res.statusCode, res.body).toBe(201);
    }
    rmSync(join(dirs.dirA, 'doomed.md'));
    const body = (await app.inject({ url: '/api/library/pages' })).json();
    expect(body.sourceProjectId).toBe(sw.id);
    expect(body.pages.map((p: { title: string }) => p.title)).toEqual(['Guide', 'Roster', 'Doomed']);
    const [guide, roster, doomed] = body.pages;
    expect(guide).toMatchObject({ shelf: 'pages', format: 'markdown', templates: ['skills/sigmund/SKILL.md', 'agents/sev.md'], projectSlug: a.slug, error: null });
    // Two of its templates adopted by one project: one chip, opening the first.
    expect(guide.adaptedIn).toEqual([{ slug: a.slug, name: 'Alpha', template: 'skills/sigmund/SKILL.md' }]);
    expect(roster).toMatchObject({ shelf: 'roster', adaptedIn: [] });
    expect(doomed.error).toContain('gone');
    expect(doomed).toMatchObject({ format: 'markdown', shelf: 'pages', templates: [] });
  });
});

describe('library: the shape of a sync check', () => {
  it('takes a check with a head and files that each have a template and state, and refuses any other shape', () => {
    const file = { template: 'agents/sev.md', local: '.claude/agents/sev.md', base: 'a', state: 'current', behind: 0, commits: [], fills: {}, detail: null };
    const good = { shipwright: { head: 'abc1234', date: '2026-10-21', subject: 's' }, project: 'P', lastSync: null, files: [file], skip: [], notAdopted: [], fills: {} };
    expect(parseCheck(JSON.stringify(good)).ok).toBe(true);
    for (const bad of [null, 3, '"x"', { files: [file] }, { ...good, files: [null] }, { ...good, files: [{ template: 'a' }] }, { ...good, shipwright: {} }]) {
      expect(parseCheck(typeof bad === 'string' ? bad : JSON.stringify(bad)).ok).toBe(false);
    }
    expect(parseCheck('not json').ok).toBe(false);
  });
});
