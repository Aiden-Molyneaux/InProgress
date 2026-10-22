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

const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui-token' };

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

/** What the fake script answers to --diff: an adaptation of two hunks under different headings, an upstream of two with the second in conflict. */
const DIFF_JSON = {
  adaptation: ['--- agents/sev.md @ b1', '+++ agents/sev.md', '@@ -1,3 +1,3 @@', ' # Sev', '-old intro', '+new intro', ' ', '@@ -4,4 +4,5 @@', ' ', ' ## Rules', ' ', '+rule added', ' rule one', '\\ No newline at end of file', ''].join('\n'),
  // The upstream's line numbers are the filled template's, which are not the copy's: hunks are placed by their context. The third
  // has none, and the fourth's (a `---` rule) is in the copy twice, so neither is placed.
  upstream: ['--- agents/sev.md @ b1', '+++ agents/sev.md @ abc1234', '@@ -30,2 +30,2 @@', '-intro', '+intro again', ' ', '@@ -50,3 +50,3 @@', ' rule one', '-rule two', '+rule two, reworded', '@@ -90,0 +91,1 @@', '+brand new', '@@ -95,2 +96,2 @@', ' ---', '-old note', '+new note', ''].join('\n'),
  conflicts: [{ base: { start: 7, lines: 1 }, upstream: { start: 7, lines: 1 }, local: { start: 7, lines: 2 }, hunks: [1] }],
};
const SEV_LOCAL = '# Sev\n\nintro\n\n## Rules\n\nrule one\nrule two\n\n## Notes\n\n---\n\n---\n';
const TEMPLATES_JSON = { templates: ['agents/sev.md', 'agents/moh.md', 'skills/sigmund/SKILL.md'] };

/** Shipwright (a git repo bound to its own project), A (manifest pointing at it), B (manifest pointing at an unbound folder), C (no manifest). */
function setup(script?: string) {
  const ctx = makeCtx();
  const shipwright = repoDir('ip-lib-sw-');
  mkdirSync(join(shipwright, 'scripts'));
  const runs = join(shipwright, 'scripts', 'runs.txt');
  writeFileSync(
    join(shipwright, 'scripts', 'template-sync.mjs'),
    script ?? `import { appendFileSync } from 'node:fs';\nappendFileSync(new URL('runs.txt', import.meta.url), 'run;');\nconsole.log(process.argv.includes('--diff') ? ${JSON.stringify(JSON.stringify(DIFF_JSON))} : ${JSON.stringify(JSON.stringify(CHECK_JSON))});\n`,
  );
  writeFileSync(join(shipwright, 'templates.json'), JSON.stringify(TEMPLATES_JSON));
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
  mkdirSync(join(dirA, 'agents'));
  writeFileSync(join(dirA, 'agents', 'sev.md'), SEV_LOCAL);
  const opened: string[] = [];
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test', openPath: async (p) => void opened.push(p) });
  const runCount = () => {
    try {
      return readFileSync(runs, 'utf8').split(';').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const register = (project: { rootNodeId: number }, path: string, title: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: project.rootNodeId, kind: 'doc', title, path, purpose: 'library', ...extra } });
  return { ctx, app, sw, a, b, c, dirs: { shipwright, dirA, dirB, dirC, unbound }, runCount, unbound, register, opened };
}

describe('library: sync', GIT_TIMEOUT, () => {
  it('checks each manifest, refuses an unbound Shipwright folder without running it, and lists the projects with no manifest', async () => {
    const { app, a, b, c, sw, runCount, unbound } = setup();
    const body = (await app.inject({ method: 'POST', url: '/api/ui/library/sync', headers: UI, payload: {} })).json();
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
    const [one, two] = await Promise.all([app.inject({ method: 'POST', url: '/api/ui/library/sync', headers: UI, payload: {} }), app.inject({ method: 'POST', url: '/api/ui/library/sync', headers: UI, payload: {} })]);
    expect(one.statusCode).toBe(200);
    expect(two.statusCode).toBe(200);
    expect(runCount()).toBe(1);
    await app.inject({ method: 'POST', url: '/api/ui/library/sync', headers: UI, payload: {} });
    expect(runCount()).toBe(1);
  });

  it('answers a failing script as a failed row with its stderr, and still answers the others', async () => {
    const { app } = setup("console.error('boom: bad project');\nprocess.exit(2);\n");
    const body = (await app.inject({ method: 'POST', url: '/api/ui/library/sync', headers: UI, payload: {} })).json();
    expect(body.projects).toHaveLength(2);
    expect(body.projects[0].check).toEqual({ ok: false, error: 'boom: bad project' });
    expect(body.projects[1].check.ok).toBe(false);
  });

  it('runs only on the window POST, and refuses a manifest that names its own project as Shipwright without running it', async () => {
    const { ctx, app } = setup();
    expect((await app.inject({ url: '/api/library/sync' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/ui/library/sync', payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
    const self = mkdtempSync(join(tmpdir(), 'ip-lib-self-'));
    tempDirs.push(self);
    mkdirSync(join(self, 'scripts'));
    writeFileSync(join(self, 'scripts', 'template-sync.mjs'), "import { writeFileSync } from 'node:fs';writeFileSync(new URL('ran.txt', import.meta.url), 'ran');console.log('{}');");
    mkdirSync(join(self, '.claude'));
    writeFileSync(join(self, '.claude', 'shipwright.json'), JSON.stringify({ shipwright: '.', files: {} }));
    const d = createProject(ctx, 'test', { name: 'Delta' });
    addBinding(ctx, 'test', d.slug, self);
    const body = (await app.inject({ method: 'POST', url: '/api/ui/library/sync', headers: UI, payload: {} })).json();
    const rowD = body.projects.find((p: { slug: string }) => p.slug === d.slug);
    expect(rowD.check.ok).toBe(false);
    expect(rowD.check.error).toContain('keeps its own .claude/shipwright.json');
    expect(existsSync(join(self, 'scripts', 'ran.txt'))).toBe(false);
  });
});

describe('library: the sync dashboard', GIT_TIMEOUT, () => {
  const post = (app: ReturnType<typeof setup>['app'], url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: UI, payload: payload as Record<string, unknown> });

  it('answers the template list and the source, and runs the check again for force inside 60 s', async () => {
    const { app, sw, runCount } = setup();
    const body = (await post(app, '/api/ui/library/sync', {})).json();
    expect(body.templates).toEqual(TEMPLATES_JSON.templates);
    expect(body.source).toEqual({ slug: sw.slug, name: 'Shipwright', head: 'abc1234' });
    expect(body.projects.map((p: { syncStep: unknown }) => p.syncStep)).toEqual([null, null]);
    expect(runCount()).toBe(1);
    await post(app, '/api/ui/library/sync', { force: false });
    expect(runCount()).toBe(1);
    await post(app, '/api/ui/library/sync', { force: true });
    expect(runCount()).toBe(2);
    expect((await post(app, '/api/ui/library/sync', { force: 'yes' })).statusCode).toBe(400);
  });

  it('answers no templates when the source has no readable list', async () => {
    const { app, dirs } = setup();
    rmSync(join(dirs.shipwright, 'templates.json'));
    expect((await post(app, '/api/ui/library/sync', {})).json().templates).toEqual([]);
  });

  it('parses the diff into hunks with the heading above each, marks only the conflicting upstream hunk, and refuses a template outside templates.json without a run', async () => {
    const { app, a, dirs, runCount } = setup();
    const res = await post(app, '/api/ui/library/sync/diff', { slug: a.slug, template: 'agents/sev.md' });
    expect(res.statusCode, res.body).toBe(200);
    const diff = res.json();
    expect(diff.ok, JSON.stringify(diff)).toBe(true);
    // The second adaptation hunk starts above the Rules heading: its section is where its first change is, not where it starts.
    expect(diff.adaptation.map((h: { section: string; located: boolean; added: number; removed: number }) => [h.section, h.located, h.added, h.removed])).toEqual([['Sev', true, 1, 1], ['Rules', true, 1, 0]]);
    expect(diff.adaptation[1].lines.map((l: { kind: string }) => l.kind)).toEqual([' ', ' ', ' ', '+', ' ']);
    expect(diff.upstream.map((h: { section: string | null; located: boolean; conflict: boolean }) => [h.section, h.located, h.conflict])).toEqual([['Sev', true, false], ['Rules', true, true], [null, false, false], [null, false, false]]);
    expect(diff.commits).toEqual([]);
    // The same answer again inside 60 s is the kept one; Check now makes a new one.
    const kept = runCount();
    await post(app, '/api/ui/library/sync/diff', { slug: a.slug, template: 'agents/sev.md' });
    expect(runCount()).toBe(kept);
    await post(app, '/api/ui/library/sync', { force: true });
    await post(app, '/api/ui/library/sync/diff', { slug: a.slug, template: 'agents/sev.md' });
    expect(runCount()).toBe(kept + 2);
    const before = runCount();
    const refused = (await post(app, '/api/ui/library/sync/diff', { slug: a.slug, template: 'agents/other.md' })).json();
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('templates.json');
    expect(runCount()).toBe(before);
    expect((await post(app, '/api/ui/library/sync/diff', { slug: a.slug, template: 'agents/sev.md --evil' })).statusCode).toBe(400);
  });

  it('gives a diff no sections when the copy is unreadable, and a refused row its refusal', async () => {
    const { app, a, b, dirs } = setup();
    rmSync(join(dirs.dirA, 'agents', 'sev.md'));
    const diff = (await post(app, '/api/ui/library/sync/diff', { slug: a.slug, template: 'agents/sev.md' })).json();
    expect(diff.ok).toBe(true);
    expect(diff.adaptation.map((h: { located: boolean }) => h.located)).toEqual([false, false]);
    expect(diff.upstream.map((h: { located: boolean }) => h.located)).toEqual([false, false, false, false]);
    const refused = (await post(app, '/api/ui/library/sync/diff', { slug: b.slug, template: 'agents/moh.md' })).json();
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('is not a folder bound to a project');
  });

  it('files a docs-labelled sync step once, names it on the next load, and answers 409 with it the second time', async () => {
    const { app, a, b } = setup();
    const made = await post(app, '/api/ui/library/sync/step', { slug: a.slug });
    expect(made.statusCode, made.body).toBe(201);
    const { node } = made.json();
    expect(node).toMatchObject({ title: 'Sync Alpha to Shipwright abc1234', label: 'docs', parentId: a.rootNodeId });
    const rows = (await post(app, '/api/ui/library/sync', {})).json().projects;
    expect(rows[0].syncStep).toEqual({ id: node.id, title: node.title });
    const again = await post(app, '/api/ui/library/sync/step', { slug: a.slug });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('already has a sync step');
    expect(again.json().step).toEqual({ id: node.id, title: node.title });
    // A row whose check failed has nothing to file.
    expect((await post(app, '/api/ui/library/sync/step', { slug: b.slug })).statusCode).toBe(400);
  });

  it('refuses a step for a project that is not behind', async () => {
    const check = { ...CHECK_JSON, files: CHECK_JSON.files.map((f) => ({ ...f, state: 'current', behind: 0 })) };
    const { app, a } = setup(`console.log(${JSON.stringify(JSON.stringify(check))});`);
    const res = await post(app, '/api/ui/library/sync/step', { slug: a.slug });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not behind');
  });

  it('opens the project copy from the checked local path, and refuses a local path that leaves the folder', async () => {
    const { app, a, dirs, opened } = setup();
    const ok = await post(app, '/api/ui/library/sync/open', { slug: a.slug, template: 'agents/sev.md' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(opened).toEqual([join(dirs.dirA, 'agents', 'sev.md')]);
    expect((await post(app, '/api/ui/library/sync/open', { slug: a.slug, template: 'agents/moh.md-not-adopted' })).statusCode).toBe(400);
    for (const local of ['../escape.md', 'agents/../../escape.md', 'C:/Windows/win.ini']) {
      const hostile = { ...CHECK_JSON, files: [{ ...CHECK_JSON.files[0], local }] };
      const s = setup(`console.log(${JSON.stringify(JSON.stringify(hostile))});`);
      const res = await post(s.app, '/api/ui/library/sync/open', { slug: s.a.slug, template: 'agents/sev.md' });
      expect(res.statusCode, local).toBe(400);
      expect(res.json().error).toContain('not inside');
      expect(s.opened).toEqual([]);
    }
  });

  it('runs only on the window POST', async () => {
    const { app, a, runCount } = setup();
    for (const url of ['/api/ui/library/sync/diff', '/api/ui/library/sync/step', '/api/ui/library/sync/open']) {
      expect((await app.inject({ method: 'POST', url, payload: { slug: a.slug, template: 'agents/sev.md' } })).statusCode, url).toBe(403);
    }
    expect(runCount()).toBe(0);
  });

  it('refuses to open a copy Shipwright gave no local path for', async () => {
    const odd = { ...CHECK_JSON, files: [{ ...CHECK_JSON.files[0], local: 7, fills: [], commits: 'x' }] };
    const { app, a, opened } = setup(`console.log(${JSON.stringify(JSON.stringify(odd))});`);
    const res = await post(app, '/api/ui/library/sync/open', { slug: a.slug, template: 'agents/sev.md' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('no local file');
    expect(opened).toEqual([]);
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
    // A file's local, fills and commits are put right rather than trusted.
    const odd = parseCheck(JSON.stringify({ ...good, files: [{ ...file, local: 3, fills: [], commits: 'x' }] }));
    expect(odd.ok && odd.result.files[0]).toMatchObject({ local: null, fills: {}, commits: [] });
  });
});
