import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

interface Seeded {
  slug: string;
  root: number;
  /** Node ids by title. */
  ids: Record<string, number>;
  /** The project's Claude session, which is also the actor of every write made for it. */
  session: string;
  /** The open question ask on 'Run signing tests': the one thing waiting on Aiden. */
  ask: number;
  /** The project's id. */
  id: number;
}

const headers = (session: string) => ({
  authorization: `Bearer ${readFileSync('.e2e-home/token', 'utf8').trim()}`,
  'x-inprogress-actor': `scribe:${session}`,
});

/** A write the test depends on. A failed one fails here, not later as a confusing UI assertion. */
async function write<T = unknown>(api: APIRequestContext, session: string, method: 'post' | 'patch' | 'delete', path: string, data?: unknown): Promise<T> {
  const res = await api[method](path, { headers: headers(session), data });
  expect(res.ok(), `${method.toUpperCase()} ${path} answered ${res.status()}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

// Everything here is something the viewer's sanitiser must neutralise.
const UNSAFE_MARKDOWN = [
  '# Unsafe Markdown',
  '[Run me](javascript:alert(1))',
  `<img src=x onerror="document.title = 'XSS'">`,
  '<style>.ip-app{display:none}</style>',
  '<div class="ip-viewer" style="position:fixed">x</div>',
  '[Signing docs](https://example.com/signing)',
  '<textarea>typed</textarea> <select><option>pick</option></select> <button>press</button>',
  '<input value="text"> <input type="checkbox">',
  '- [ ] Task item',
].join('\n\n');

/** A project of its own: every test that changes data seeds one, so tests pass alone, in any order and repeated. */
async function seed(api: APIRequestContext, name = 'E2E Demo'): Promise<Seeded> {
  const session = `e2e-${randomUUID()}`;
  const post = <T = unknown>(path: string, data: unknown) => write<T>(api, session, 'post', path, data);
  const project = await post<{ id: number; slug: string; rootNodeId: number }>('/api/projects', { name, description: 'Seeded by Playwright' });
  const milestones = Array.from({ length: 25 }, (_, i) => ({ title: `Milestone ${i + 1}`, status: 'done' as const }));
  const created = await post<{ id: number; title: string }[]>('/api/nodes', {
    parentId: project.rootNodeId,
    nodes: [
      { title: 'Milestones', kind: 'phase', status: 'active', children: milestones },
      {
        title: 'Road to market', kind: 'phase', status: 'active',
        children: [
          { title: '1 iOS certificate', status: 'done' },
          { title: '2 Android signing', status: 'active', children: [
            { title: 'Upload keystore', status: 'done' },
            { title: 'Play app signing', status: 'active' },
            { title: 'Run signing tests', assignee: 'me' },
          ] },
          { title: '3 RevenueCat' }, { title: '4 Build to GitHub' }, { title: '5 Store listing' }, { title: '6 Beta' }, { title: '7 Launch' },
        ],
      },
    ],
  });
  const ids = Object.fromEntries(created.map((n) => [n.title, n.id]));
  await post('/api/resources', { nodeId: ids['Run signing tests'], kind: 'test-suite', title: 'Signing test suite', content: '# Signing tests\n\n- [ ] Upload key accepted' });
  await post('/api/resources', { nodeId: ids['Upload keystore'], kind: 'doc', title: 'Unsafe Markdown', content: UNSAFE_MARKDOWN });
  const ask = await post<{ id: number }>(`/api/nodes/${ids['Run signing tests']}/asks`, { kind: 'question', text: 'Which keystore signs the release?' });
  await post(`/api/sessions/${session}/enroll`, { project: project.slug, title: 'E2E session' });
  await post(`/api/sessions/${session}/focus`, { nodeId: ids['Play app signing'] });
  await post(`/api/sessions/${session}/hook`, { event: 'prompt' });
  // Soon holds the five steps that follow the ones under way, in tree order: the Backlog preview shows Soon.
  const uiPost = await uiHeaders(api);
  for (const title of ['3 RevenueCat', '4 Build to GitHub', '5 Store listing', '6 Beta', '7 Launch']) {
    const res = await api.post(`/api/ui/projects/${project.id}/rank`, { headers: uiPost, data: { slug: project.slug, op: { node: ids[title], to: 'soon', before: null } } });
    expect(res.ok(), `rank ${title} answered ${res.status()}: ${await res.text()}`).toBe(true);
  }
  return { id: project.id, slug: project.slug, root: project.rootNodeId, ids, session, ask: ask.id };
}

/** The headers a window write needs, read once per api context from the page the server hands out. */
const uiHeaderCache = new WeakMap<APIRequestContext, Promise<Record<string, string>>>();
function uiHeaders(api: APIRequestContext): Promise<Record<string, string>> {
  let cached = uiHeaderCache.get(api);
  if (!cached) {
    cached = (async () => {
      const res = await api.get('/');
      const html = await res.text();
      const token = /<meta name="ip-ui-token" content="([^"]*)"/.exec(html)?.[1];
      expect(token, 'the page carries no ip-ui-token meta').toBeTruthy();
      const base = new URL(res.url());
      return { origin: base.origin, 'content-type': 'application/json', 'x-ip-ui-token': token! };
    })();
    uiHeaderCache.set(api, cached);
  }
  return cached;
}

interface TestFixtures {
  /** Console errors and uncaught exceptions fail the test. A test that causes one on purpose allows its pattern. */
  consoleErrors: { allow: (pattern: RegExp) => void };
  /** A project of this test's own, for tests that change data. */
  fresh: Seeded;
}

interface WorkerFixtures {
  api: APIRequestContext;
  /** A project that tests only read. */
  demo: Seeded;
}

const test = base.extend<TestFixtures, WorkerFixtures>({
  api: [
    async ({ playwright }, use) => {
      const api = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${Number(process.env.INPROGRESS_E2E_PORT) || 4399}` });
      await use(api);
      await api.dispose();
    },
    { scope: 'worker' },
  ],
  demo: [async ({ api }, use) => use(await seed(api)), { scope: 'worker' }],
  fresh: async ({ api }, use) => use(await seed(api)),
  // Context-level, so nothing is lost to a page's message buffer and popups are covered too. Warnings become annotations.
  consoleErrors: [
    async ({ context }, use, testInfo) => {
      const errors: string[] = [];
      const allowed: RegExp[] = [];
      context.on('console', (m) => {
        if (m.type() === 'warning') testInfo.annotations.push({ type: 'console warning', description: m.text() });
        if (m.type() === 'error') errors.push(m.text());
      });
      context.on('weberror', (e) => errors.push(`Uncaught: ${e.error().message}`));
      await use({ allow: (pattern) => allowed.push(pattern) });
      expect(errors.filter((text) => !allowed.some((p) => p.test(text)))).toEqual([]);
    },
    { auto: true },
  ],
});

const open = (page: Page, project: Seeded) => page.goto(`/#/p/${project.slug}`);

/** A step's row on the Board, by its title. Details lists the same steps as "#id title", so the exact name is the Board's. */
const stepRow = (page: Page, title: string) => page.getByRole('main').getByRole('button', { name: title, exact: true });

/**
 * Drags one element onto another. At 900 px the Board scrolls, and Playwright's dragTo scrolls the target into view after the
 * button is down; Chromium then starts the drag on whatever the pointer is over (seen: mousedown on 6 Beta, the Board scrolls,
 * dragstart on 4 Build). So both ends are brought into view first, and the drag itself scrolls nothing.
 */
async function drag(source: Locator, target: Locator, targetPosition?: { x: number; y: number }): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await source.scrollIntoViewIfNeeded();
  await source.dragTo(target, { targetPosition });
}

/** The preview's "Open ›" button, which opens the full Backlog view. */
const backlogAll = (page: Page) => page.locator('.ip-backlog-all');

/** Opens the full Backlog view from the preview and answers it. */
async function openFullBacklog(page: Page): Promise<Locator> {
  await backlogAll(page).click();
  const view = page.locator('.ip-backlogview');
  await expect(view).toBeVisible();
  return view;
}

/** Picks a view of the full Backlog from its strip: Ranked, By Phase, Needs Triage, Stale or Parked. */
async function pickView(view: Locator, name: string): Promise<void> {
  const tab = view.getByRole('group', { name: 'Backlog view' }).getByRole('button', { name: new RegExp(`^${name}`) });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

/** Opens the full Backlog on a view other than Ranked: By Phase lists every open step, ranked or not. */
async function openBacklogView(page: Page, name: string): Promise<Locator> {
  const view = await openFullBacklog(page);
  await pickView(view, name);
  return view;
}

/** A full-view Backlog row (open, not parked) by its title text, inside `scope`. */
const blRow = (page: Page, scope: Locator, title: string): Locator => scope.locator('li.ip-bl-row:not(.ip-bl-parkedrow)', { has: page.getByText(title, { exact: true }) });
/** Opens a full-view row's inspector with a click on its title (when it is not open already) and answers it. */
async function openInspector(row: Locator): Promise<Locator> {
  if (!((await row.getAttribute('class')) ?? '').split(' ').includes('picked')) await row.locator('.ip-bl-title').click();
  const inspector = row.getByRole('group', { name: /^Inspector for #/ });
  await expect(inspector).toBeVisible();
  return inspector;
}
/** The same for a row in the Parked group. */
const pRow = (page: Page, scope: Locator, title: string): Locator => scope.locator('li.ip-bl-parkedrow', { has: page.getByText(title, { exact: true }) });

/** Opens a step's Details from its row and answers the panel. The preview shows Soon, which holds the steps these tests open. */
async function openDetails(page: Page, title: string): Promise<Locator> {
  await stepRow(page, title).click();
  const details = page.getByRole('complementary');
  await expect(details).toContainText(title);
  return details;
}

/** Details shows this step: its head reads `#id · KIND` and its title is the heading. */
async function showsStep(details: Locator, id: number, title: string): Promise<void> {
  await expect(details.locator('.ip-dtop .p-eyebrow')).toHaveText(new RegExp(`^#${id} · `));
  await expect(details.locator('.ip-dtitle')).toHaveText(title);
}

/** A resource's row in Details, by its title. */
const resourceRow = (page: Page, title: string) => page.locator('.ip-res', { hasText: title });

test('the view switch is remembered', async ({ page, demo }) => {
  await open(page, demo);
  const board = viewButton(page, 'Board');
  const project = viewButton(page, 'Project');
  await expect(board).toHaveAttribute('aria-pressed', 'true');
  await expect(project).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
  const posted = page.waitForRequest((r) => r.url().endsWith('/api/ui/events') && (r.postDataJSON() as { name: string }).name === 'view');
  await project.click();
  expect((await posted).postDataJSON()).toMatchObject({ name: 'view', data: { view: 'project' } });
  await expect(project).toHaveAttribute('aria-pressed', 'true');
  await expect(board).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('region', { name: 'Sections' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Now', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(viewButton(page, 'Project')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Sections' })).toBeVisible();
  // Backlog is a view like the others: picked, it stays after a reload.
  await viewButton(page, 'Backlog').click();
  await expect(viewButton(page, 'Backlog')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ip-backlogview').getByRole('heading', { level: 1, name: 'BACKLOG' })).toBeVisible();
  await page.reload();
  await expect(viewButton(page, 'Backlog')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ip-backlogview').getByRole('heading', { level: 1, name: 'BACKLOG' })).toBeVisible();
  await viewButton(page, 'Board').click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
});

test('Details keeps the last good detail when a refresh fails', async ({ page, api, fresh, consoleErrors }) => {
  consoleErrors.allow(/status of 500/);
  await open(page, fresh);
  const id = fresh.ids['Run signing tests'];
  const details = await openDetails(page, 'Run signing tests');
  await showsStep(details, id, 'Run signing tests');
  await page.route(`**/api/nodes/${id}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Database is busy' }) }));
  // Any change to the project makes Details refetch.
  await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['Play app signing']}`, { outcome: 'Configured' });
  await expect(details.locator('.p-error')).toHaveText(/Couldn't refresh/);
  await showsStep(details, id, 'Run signing tests');
  await expect(details.getByRole('button', { name: `Copy #${id}` })).toBeVisible();
});

test('Details closes when its node is deleted, and stays open when another node goes', async ({ page, api, fresh }) => {
  await open(page, fresh);
  const id = fresh.ids['3 RevenueCat'];
  await expect(stepRow(page, '7 Launch')).toBeVisible();
  const details = await openDetails(page, '3 RevenueCat');
  await showsStep(details, id, '3 RevenueCat');
  await write(api, fresh.session, 'delete', `/api/nodes/${fresh.ids['7 Launch']}`);
  // 7 Launch leaving the Board shows that the snapshot without it has landed.
  await expect(stepRow(page, '7 Launch')).toHaveCount(0);
  await showsStep(details, id, '3 RevenueCat');
  await write(api, fresh.session, 'delete', `/api/nodes/${id}`);
  await expect(details).toBeHidden();
  await expect(page.getByText("Couldn't refresh")).toHaveCount(0);
});

test('a long project name is cut short in the rail, whole in its title, and the rail stays 216 px wide', async ({ page, api }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const name = 'A project name long enough to fill a narrow window several times over, and then some';
  const project = await seed(api, name);
  await open(page, project);
  await expect(page).toHaveTitle(/A project name long enough/);
  const row = railCurrent(page);
  await expect(row).toHaveAttribute('title', name);
  await expect(row).toBeInViewport({ ratio: 0.99 });
  await expect(row.locator('.ip-rail-name')).toHaveText(name);
  await expect(row.locator('.ip-rail-name')).toHaveCSS('font-size', '16px');
  expect((await page.locator('.ip-rail').boundingBox())!.width).toBe(216);
  expect(await page.evaluate<boolean>(`(() => { const n = document.querySelector('a[aria-current="page"] .ip-rail-name'); return n.scrollWidth > n.clientWidth; })()`)).toBe(true);
  expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('a[aria-current="page"] .ip-rail-name')).textOverflow`)).toBe('ellipsis');
});

/** A wider window than the default: Details sits beside the Board in it, as it does from 720 px. */
const widen = (page: Page) => page.setViewportSize({ width: 1000, height: 900 });

test('the resource viewer is modal and hands focus back when it closes', async ({ page, demo }) => {
  await widen(page);
  await open(page, demo);
  await openDetails(page, 'Run signing tests');
  const chip = resourceRow(page, 'Signing test suite');
  await chip.focus();
  await page.keyboard.press('Enter');
  const viewer = page.getByRole('dialog');
  const body = viewer.locator('.ip-viewer-body');
  await expect(viewer.locator('h1')).toHaveText('Signing tests');
  await expect(body).toBeFocused();
  await expect(page.locator('.ip-app')).toHaveJSProperty('inert', true);
  // Once focus has left the body, Tab reaches it again.
  await page.keyboard.press('Shift+Tab');
  await expect(viewer.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(body).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(page.locator('.ip-app')).toHaveJSProperty('inert', false);
  await expect(chip).toBeFocused();
});

test("a resource in a step's Details opens the rendered resource", async ({ page, demo }) => {
  await widen(page);
  await open(page, demo);
  await openDetails(page, 'Run signing tests');
  await resourceRow(page, 'Signing test suite').click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.locator('h1')).toHaveText('Signing tests');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});

// Records every title the page shows from now on, so a payload that ran and was overwritten later still fails.
const RECORD_TITLES = `(() => {
  window.__titles = [document.title];
  new MutationObserver(() => window.__titles.push(document.title)).observe(document.head, { subtree: true, childList: true, characterData: true });
})()`;

test('the resource viewer neutralises unsafe Markdown', async ({ page, demo }) => {
  // The sample's <img src=x> would 404 and log a console error. An empty 204 still fails to load, so an onerror would fire.
  await page.route('**/x', (route) => route.fulfill({ status: 204 }));
  await widen(page);
  await open(page, demo);
  await expect(page).toHaveTitle('(1) InProgress · E2E Demo');
  await page.evaluate(RECORD_TITLES);
  const image = page.waitForEvent('requestfinished', (r) => r.url().endsWith('/x'));
  await openDetails(page, 'Upload keystore');
  await resourceRow(page, 'Unsafe Markdown').click();
  // A CSS locator finds the rendered Markdown even if a leaked <style> has hidden the app.
  await expect(page.locator('[role="dialog"] h1')).toHaveText('Unsafe Markdown');
  await expect(page.locator('.ip-app')).toBeVisible();
  // Checked only now, so a viewer that has not rendered yet can't pass them.
  const viewer = page.getByRole('dialog');
  await expect(viewer.locator('[onerror]')).toHaveCount(0);
  await expect(viewer.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(viewer.locator('style')).toHaveCount(0);
  await expect(viewer.locator('.ip-md [class]')).toHaveCount(0);
  await expect(viewer.locator('.ip-md [style]')).toHaveCount(0);
  const docs = viewer.getByRole('link', { name: 'Signing docs' });
  await expect(docs).toHaveAttribute('href', 'https://example.com/signing');
  await expect(docs).toHaveAttribute('target', '_blank');
  await expect(viewer.locator('a[target="_blank"]:not([rel="noopener noreferrer"])')).toHaveCount(0);
  // No control that could take focus and keep Escape from closing the viewer. Task-list checkboxes stay, disabled.
  await expect(viewer.locator('.ip-md :is(textarea, select, button, input:not([type="checkbox"]))')).toHaveCount(0);
  await expect(viewer.locator('.ip-md input[type="checkbox"]')).toHaveCount(2);
  await expect(viewer.locator('.ip-md input:not([disabled])')).toHaveCount(0);
  // The image has failed to load by now; a short pause lets a queued error event, and any onerror, run.
  await image;
  await expect(viewer.locator('img')).toHaveJSProperty('complete', true);
  await page.evaluate('new Promise((resolve) => setTimeout(resolve, 100))');
  expect(await page.evaluate<string[]>('window.__titles')).not.toContain('XSS');
});

const pageDirs: string[] = [];
test.afterAll(() => {
  for (const dir of pageDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

/**
 * A git repo bound to the project, for its pages, in a temp folder the file's afterAll removes. A bare project (no seeded
 * steps, no session) can hold one but cannot register a page.
 */
async function pageRepo(api: APIRequestContext, project: Pick<Seeded, 'slug'> & Partial<Pick<Seeded, 'session' | 'ids'>>) {
  const session = project.session ?? `e2e-${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), 'ip-e2e-pages-'));
  pageDirs.push(dir);
  // No hooks: the user's global ones (Git LFS, an identity check) cost seconds a commit and would run the test past its timeout.
  const hooksOff = `core.hooksPath=${join(dir, '.git', 'no-hooks')}`;
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', hooksOff, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'src'));
  const commit = (file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    git('add', '.');
    git('commit', '-q', '-m', `edit ${file}`);
  };
  commit('src/app.ts', 'export {};\n');
  await write(api, session, 'post', `/api/projects/${project.slug}/bindings`, { path: dir });
  const register = (file: string, title: string, purpose = 'page') =>
    write<{ id: number }>(api, session, 'post', '/api/resources', { nodeId: project.ids!['Upload keystore'], kind: 'doc', title, path: join(dir, file), purpose });
  return { dir, commit, register };
}

/** Opens a resource on Upload keystore in the viewer and answers the dialog. Details opens first unless it already shows the step. */
async function openPage(page: Page, title: string): Promise<Locator> {
  if (!(await resourceRow(page, title).isVisible())) await openDetails(page, 'Upload keystore');
  await resourceRow(page, title).click();
  return page.getByRole('dialog');
}

test('a markdown page reads live from its file and has no strip without covers', async ({ page, fresh, api }) => {
  await widen(page);
  const repo = await pageRepo(api, fresh);
  repo.commit('docs/guide.md', '---\nshelf: pages\n---\n# First draft\n\nRead live.\n');
  await repo.register('docs/guide.md', 'Guide page');
  await open(page, fresh);
  let viewer = await openPage(page, 'Guide page');
  await expect(viewer.locator('.ip-md h1')).toHaveText('First draft');
  await expect(viewer.locator('.p-eyebrow')).toContainText('DOC · MD');
  await expect(viewer.locator('.ip-fresh')).toHaveCount(0);
  await expect(viewer.locator('.ip-md')).not.toContainText('shelf');
  writeFileSync(join(repo.dir, 'docs', 'guide.md'), '# Second draft\n');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  viewer = await openPage(page, 'Guide page');
  await expect(viewer.locator('.ip-md h1')).toHaveText('Second draft');
});

const SANDBOX_PAGE = [
  '<!doctype html>',
  '<html><head><title>Map</title><style>body { margin: 8px; } .tall { height: 1400px; }</style></head>',
  '<body>',
  `<button id="node" onclick="this.textContent = 'Picked'">API node</button>`,
  '<p id="net">checking</p>',
  '<p id="store">checking</p>',
  '<div class="tall"></div>',
  '<script>',
  "  Promise.allSettled([fetch('https://example.com/'), fetch('/api/health')]).then((r) => {",
  "    document.getElementById('net').textContent = r.every((x) => x.status === 'rejected') ? 'blocked' : 'reached';",
  '  });',
  "  try { localStorage.getItem('x'); document.getElementById('store').textContent = 'storage open'; } catch { document.getElementById('store').textContent = 'no storage'; }",
  "  setTimeout(() => { parent.postMessage('99999', '*'); parent.postMessage({ height: 99999 }, '*'); parent.postMessage(NaN, '*'); }, 300);",
  '</script>',
  '</body></html>',
].join('\n');

test('an HTML page runs in its sandboxed frame: its clicks work, it reaches no network, and it sizes the frame', async ({ page, fresh, api, consoleErrors }) => {
  // The page's own fetches are refused by its CSP, and Chromium logs each refusal.
  consoleErrors.allow(/Content Security Policy|Failed to fetch|ERR_BLOCKED|example\.com|api\/health/);
  await widen(page);
  const repo = await pageRepo(api, fresh);
  repo.commit('docs/map.html', SANDBOX_PAGE);
  await repo.register('docs/map.html', 'Services map');
  await open(page, fresh);
  const viewer = await openPage(page, 'Services map');
  const frame = viewer.locator('iframe.ip-pframe-frame');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(viewer.locator('.ip-pframe-label')).toContainText('sandboxed frame · scripts on · no network');
  const inside = page.frameLocator('iframe.ip-pframe-frame');
  await expect(inside.locator('#net')).toHaveText('blocked');
  await expect(inside.locator('#store')).toHaveText('no storage');
  await inside.getByRole('button', { name: 'API node' }).click();
  await expect(inside.locator('#node')).toHaveText('Picked');
  // The frame grows to the page (1400 px of content and more), and the non-numeric messages after it change nothing.
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(1400);
  await page.evaluate('new Promise((resolve) => setTimeout(resolve, 600))');
  const height = (await frame.boundingBox())?.height ?? 0;
  expect(height).toBeGreaterThan(1400);
  expect(height).toBeLessThan(2000);
});

test('the freshness strip counts commits to covers since the confirmation, and Still accurate resets it', async ({ page, fresh, api }) => {
  // Registering, confirming and reading the page each run git in the page's repo: seconds apiece on a busy machine.
  test.setTimeout(60_000);
  await widen(page);
  const repo = await pageRepo(api, fresh);
  repo.commit('docs/ops.md', '---\ncovers: [src/**]\n---\n# Ops\n');
  await repo.register('docs/ops.md', 'Ops page');
  repo.commit('src/app.ts', 'export const a = 1;\n');
  repo.commit('README.md', 'not covered\n');
  repo.commit('src/app.ts', 'export const a = 2;\n');
  await open(page, fresh);
  const viewer = await openPage(page, 'Ops page');
  const strip = viewer.locator('.ip-fresh');
  await expect(strip.locator('.ip-fresh-count')).toHaveText('2 commits since confirmed');
  await expect(strip).toContainText('at registration');
  await expect(strip.locator('.p-chip')).toHaveText(['src/**']);
  await strip.getByRole('button', { name: 'Still accurate' }).click();
  await expect(strip.locator('.ip-fresh-count')).toHaveText('no commits since confirmed', { timeout: 15_000 });
  await expect(strip.locator('.ip-fresh-when')).not.toContainText('at registration');
  await expect(strip.getByRole('button', { name: 'Still accurate' })).toHaveCount(0);
  // The button left with the stale count; focus stays in the dialog, on its document pane.
  await expect(viewer.locator('.ip-viewer-body')).toBeFocused();
  await expect(strip.locator('.p-chip')).toHaveCSS('text-transform', 'none');
});

test('a moved page says it is gone, and a page with a secret never shows its text', async ({ page, fresh, api, consoleErrors }) => {
  consoleErrors.allow(/status of (404|422)/);
  await widen(page);
  const repo = await pageRepo(api, fresh);
  repo.commit('docs/old.md', '# Old\n');
  repo.commit('docs/ops.md', '# Ops\n\nThe key lives in Railway.\n');
  await repo.register('docs/old.md', 'Old page');
  await repo.register('docs/ops.md', 'Secret page');
  renameSync(join(repo.dir, 'docs', 'old.md'), join(repo.dir, 'docs', 'new.md'));
  writeFileSync(join(repo.dir, 'docs', 'ops.md'), '# Ops\n\nRESEND_API_KEY=re_9fKq2LmZ8xYv4TbW1nRpQs\n');
  await open(page, fresh);
  let viewer = await openPage(page, 'Old page');
  await expect(viewer).toContainText('This page is gone');
  await expect(viewer.locator('.ip-page-path')).toHaveText(join(repo.dir, 'docs', 'old.md'));
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  viewer = await openPage(page, 'Secret page');
  await expect(viewer).toContainText('This page looks like it holds a secret on line 3; fix it in its repo');
  await expect(viewer).not.toContainText('re_9fKq');
  await expect(viewer).not.toContainText('lives in Railway');
});

/** A Shipwright folder (bound to a project of its own, with a sync script that finds one file behind) and a page repo for `project` that adopts it, holding a library page with templates and a roster page. */
async function libraryRepo(api: APIRequestContext, project: Seeded) {
  // Shipwright, as a folder bound to a project, holding a sync script that finds one file behind.
  const shipwright = await bare(api, 'Shipwright');
  const swDir = mkdtempSync(join(tmpdir(), 'ip-e2e-sw-'));
  pageDirs.push(swDir);
  mkdirSync(join(swDir, 'scripts'));
  const check = { shipwright: { head: 'abc1234def', date: '2026-10-20', subject: 'x' }, project: 'p', lastSync: null, files: [{ template: 'agents/sev.md', local: 'agents/sev.md', base: null, state: 'behind', behind: 1, commits: [], fills: { CHECKS: `npm run typecheck and npm test, then the e2e test the plan names, ${'and more words '.repeat(12)}to the end` }, detail: null }], skip: [], notAdopted: [], fills: {} };
  // --diff answers a fixed adaptation (under a heading of the project's copy) and an upstream whose only hunk conflicts. A project with .claude/fail exits 2.
  const diff = { adaptation: ['--- agents/sev.md @ b1', '+++ agents/sev.md', '@@ -1,3 +1,3 @@', ' # Sev', '-old intro', '+new intro', ' '].join('\n'), upstream: ['--- agents/sev.md @ b1', '+++ agents/sev.md @ abc1234', '@@ -3,1 +3,1 @@', '-intro', '+intro again'].join('\n'), conflicts: [{ hunks: [0] }] };
  const script = [
    "import { existsSync } from 'node:fs';",
    "const project = process.argv[process.argv.indexOf('--project') + 1];",
    "if (existsSync(project + '/.claude/fail')) { console.error('boom: bad project'); process.exit(2); }",
    `console.log(process.argv.includes('--diff') ? ${JSON.stringify(JSON.stringify(diff))} : ${JSON.stringify(JSON.stringify(check))});`,
  ].join('\n');
  writeFileSync(join(swDir, 'scripts', 'template-sync.mjs'), script);
  writeFileSync(join(swDir, 'templates.json'), JSON.stringify({ templates: ['agents/sev.md', 'agents/moh.md'] }));
  await write(api, `e2e-${randomUUID()}`, 'post', `/api/projects/${shipwright.slug}/bindings`, { path: swDir });
  const repo = await pageRepo(api, project);
  mkdirSync(join(repo.dir, '.claude'));
  mkdirSync(join(repo.dir, 'agents'));
  writeFileSync(join(repo.dir, 'agents', 'sev.md'), '# Sev\n\nintro\n');
  writeFileSync(join(repo.dir, '.claude', 'shipwright.json'), JSON.stringify({ shipwright: swDir, files: { 'agents/sev.md': {} }, skip: [] }));
  repo.commit('docs/guide.md', ['---', 'templates: [agents/sev.md]', '---', '# Guide', ''].join('\n'));
  repo.commit('docs/roster.md', ['---', 'shelf: roster', '---', '# Agent roster', '', 'Who owns what.', ''].join('\n'));
  // Titles of their own: the server is shared, and another test's library pages list beside these.
  const titles = { guide: `Agent guide ${randomUUID().slice(0, 8)}`, roster: `Agent roster ${randomUUID().slice(0, 8)}` };
  await repo.register('docs/guide.md', titles.guide, 'library');
  await repo.register('docs/roster.md', titles.roster, 'library');
  return { ...repo, titles, swDir };
}

test('the Library group lists pages by project, opens the roster in place, and keeps its route on reload', async ({ page, fresh, api }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const repo = await libraryRepo(api, fresh);
  const { guide, roster } = repo.titles;
  await open(page, fresh);
  const lib = projectRail(page).locator('a[data-lib]');
  // The server is shared, so another test's project may be behind too: at least this one is.
  await expect(lib.locator('.ip-rail-behind')).toHaveText(/^[1-9]\d*$/);
  await expect(lib).toHaveAccessibleName(/^Library, [1-9]\d* behind Shipwright$/);
  await lib.click();
  await expect(page).toHaveURL(/#\/lib\/pages$/);
  await expect(page.getByRole('heading', { level: 1, name: 'PAGES' })).toBeVisible();
  const shelves = projectRail(page).getByRole('list', { name: 'Library' });
  await expect(shelves.getByRole('button')).toHaveText([/^Pages/, /^Roster/, /^Sync/]);
  const row = page.locator('.ip-lib-row', { hasText: guide });
  await expect(row.locator('.p-chip').first()).toHaveText('MD');
  await expect(row.locator('.ip-lib-path')).toHaveText(join(repo.dir, 'docs', 'guide.md'));
  // The roster page is on its own shelf, not in Pages.
  await expect(page.locator('.ip-lib-row', { hasText: roster })).toHaveCount(0);
  await expect(row.locator(`a.ip-lib-adapt[href^="#/lib/sync/${fresh.slug}/"]`)).toHaveAttribute('href', `#/lib/sync/${fresh.slug}/agents%2Fsev.md`);
  await page.reload();
  await expect(page).toHaveURL(/#\/lib\/pages$/);
  await expect(page.locator('.ip-lib-row', { hasText: guide })).toBeVisible();
  await shelves.getByRole('button', { name: /^Roster/ }).click();
  await expect(page).toHaveURL(/#\/lib\/roster$/);
  await expect(page.locator('section.ip-viewer[data-inline] .ip-md h1')).toHaveText('Agent roster');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(shelves.locator('.ip-rail-n[data-warn]')).toHaveText(/^[1-9]\d* behind$/);
  await projectRail(page).locator(`a[href="#/p/${fresh.slug}"]`).click();
  await expect(page).toHaveURL(hereIs(fresh.slug));
  await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
});

test("Docs lists a project's pages and opens one", async ({ page, fresh, api }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const repo = await pageRepo(api, fresh);
  repo.commit('docs/ops.md', ['---', 'covers: [src/app.ts]', '---', '# Ops notes', '', 'Read from the repo.', ''].join('\n'));
  const title = `Ops notes ${randomUUID().slice(0, 8)}`;
  await repo.register('docs/ops.md', title, 'page');
  await open(page, fresh);
  // The project keeps no manifest, so its Docs figure is the page count alone.
  const docs = projectRail(page).getByRole('button', { name: /^Docs, 1$/ });
  await expect(docs.locator('.ip-rail-vcode')).toHaveText('DOC');
  await docs.click();
  await expect(page.getByRole('heading', { level: 1, name: 'DOCS' })).toBeVisible();
  await expect(page.locator('.ip-page-meta')).toContainText('1 PAGE');
  const row = page.locator('.ip-lib-row', { hasText: title });
  await expect(row.locator('.p-chip').first()).toHaveText('MD');
  await expect(row.locator('.ip-lib-path')).toHaveText(join(repo.dir, 'docs', 'ops.md'));
  await expect(row.locator('.ip-lib-fresh')).toHaveText('current');
  await expect(page.locator('.ip-docs-pick')).toHaveText('Pick a page or an adaptation.');
  const note = page.locator('.ip-docs-none');
  await expect(note).toContainText(`E2E Demo keeps no .claude/shipwright.json yet.`);
  await expect(note.getByRole('link', { name: 'Library · Sync ›' })).toHaveAttribute('href', '#/lib/sync');
  await row.getByRole('button', { name: title }).click();
  await expect(page.locator('section.ip-viewer[data-inline] .ip-md h1')).toHaveText('Ops notes');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await note.getByRole('link', { name: 'Library · Sync ›' }).click();
  await expect(page).toHaveURL(/#\/lib\/sync$/);
});

test('Docs opens an adaptation side by side, with its tags, folded sections and conflict note, and Diff shows the raw diff', async ({ page, fresh, api }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  // Shipwright: a git repo bound to a project of its own, holding the template and a sync script whose check names its HEAD as
  // the base, and whose diff matches the copy below: one line added under Rules, which the one upstream hunk conflicts with.
  const sw = await pageRepo(api, await bare(api, 'Shipwright'));
  const diff = {
    adaptation: ['--- agents/sev.md', '+++ agents/sev.md', '@@ -13,3 +13,4 @@', ' ## Rules', ' ', ' rule one', '+rule two', ''].join('\n'),
    upstream: ['--- agents/sev.md', '+++ agents/sev.md', '@@ -15 +15 @@', '-rule one', '+rule uno', ''].join('\n'),
    conflicts: [{ hunks: [0] }],
  };
  const script = [
    "import { execFileSync } from 'node:child_process';",
    "import { fileURLToPath } from 'node:url';",
    "const base = execFileSync('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
    "const file = { template: 'agents/sev.md', local: 'agents/sev.md', base, state: 'behind', behind: 1, commits: [{ sha: 'c0ffee1', date: '2026-10-21', subject: 'reword' }], fills: { TONE: 'kind' }, detail: null };",
    `const diff = ${JSON.stringify(diff)};`,
    "console.log(JSON.stringify(process.argv.includes('--diff') ? diff : { shipwright: { head: 'abc1234', date: '2026-10-21', subject: 'x' }, project: 'p', lastSync: null, files: [file], skip: [], notAdopted: [], fills: {} }));",
  ].join('\n');
  mkdirSync(join(sw.dir, 'scripts'));
  mkdirSync(join(sw.dir, 'agents'));
  writeFileSync(join(sw.dir, 'scripts', 'template-sync.mjs'), script);
  writeFileSync(join(sw.dir, 'templates.json'), JSON.stringify({ templates: ['agents/sev.md'] }));
  const template = '# Sev\n\n**Rule.** Be {{TONE}}.\n\n## Routing\n\nSame here.\n\n## Notes\n\nKeep notes.\n\n## Rules\n\nrule one\n';
  sw.commit('agents/sev.md', template);
  const repo = await pageRepo(api, fresh);
  mkdirSync(join(repo.dir, '.claude'));
  mkdirSync(join(repo.dir, 'agents'));
  writeFileSync(join(repo.dir, 'agents', 'sev.md'), `${template.replace('{{TONE}}', 'kind')}rule two\n`);
  writeFileSync(join(repo.dir, '.claude', 'shipwright.json'), JSON.stringify({ shipwright: sw.dir, files: { 'agents/sev.md': { fills: { TONE: 'kind' } } }, skip: [] }));
  await open(page, fresh);
  // No pages and one adaptation.
  await projectRail(page).getByRole('button', { name: /^Docs, 0 · 1$/ }).click();
  await expect(page.locator('.ip-page-meta')).toContainText('1 ADAPTATION');
  const row = page.locator('.ip-lib-row', { hasText: 'sev' });
  await expect(row.locator('.ip-docs-state')).toHaveText('1 behind');
  await row.getByRole('button', { name: 'sev' }).click();
  const view = page.getByRole('region', { name: 'sev in E2E Demo' });
  await expect(view.locator('.ip-adapt-strip')).toContainText("computed live from E2E Demo's copy, its manifest and Shipwright at base");
  await expect(view.locator('.ip-adapt-strip')).toContainText('Shipwright is 1 commit ahead: c0ffee1');
  await expect(view.locator('a.ip-adapt-link')).toHaveAttribute('href', `#/lib/sync/${fresh.slug}/agents%2Fsev.md`);
  // The Opening and the two untouched sections fold; the lead with a file fill and the rewritten Rules show.
  const rows = view.locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveText('1 section E2E Demo left alone: Opening');
  await expect(rows.nth(1).locator('th')).toHaveText('Rule');
  await expect(rows.nth(1).locator('.ip-adapt-tag')).toHaveText('file fill');
  await expect(rows.nth(1).locator('td').nth(0).locator('code')).toHaveText('{{TONE}}');
  await expect(rows.nth(1).locator('td').nth(1)).toContainText('Be kind.');
  await expect(rows.nth(2)).toHaveText('2 sections E2E Demo left alone: Routing, Notes');
  await expect(rows.nth(3).locator('.ip-adapt-tag')).toHaveText('rewritten');
  await expect(rows.nth(3).locator('.ip-adapt-conflict')).toHaveText('Shipwright changed this section in c0ffee1. The next sync conflicts here.');
  await rows.nth(2).getByRole('button').click();
  await expect(view.locator('tbody tr[data-tag="same"] th')).toHaveText(['Routing', 'Notes']);
  // The index now knows the local edit count.
  await expect(row.locator('.ip-lib-path')).toHaveText('1 local edit · 1 file fill');
  await view.getByRole('button', { name: 'Diff' }).click();
  await expect(view.locator('.ip-sync-dl[data-kind="add"]')).toHaveText(['+rule two']);
});

test('the Library row is one more stop in the rail: arrows reach it, Space opens it, shelves hand focus back to the project views, and a chip lands on the Sync button', async ({ page, fresh, api }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const { titles } = await libraryRepo(api, fresh);
  await open(page, fresh);
  const lib = projectRail(page).locator('a[data-lib]');
  await expect(lib.locator('.ip-rail-behind')).toHaveText(/^[1-9]\d*$/);
  const hash = () => page.evaluate('location.hash');
  // End from the last project row reaches the Library row, Up returns to it.
  const last = railRows(page).last();
  await last.focus();
  await page.keyboard.press('ArrowDown');
  await expect(lib).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(last).toBeFocused();
  await page.keyboard.press('End');
  await expect(lib).toBeFocused();
  // Alt+Down and Shift+F10 do nothing: no menu, no move, the address stays.
  const before = await hash();
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(await hash()).toBe(before);
  await expect(lib).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/#\/lib\/pages$/);
  // With focus on a shelf button, 1 opens the first project and focus lands on that project's current view.
  const shelves = projectRail(page).getByRole('list', { name: 'Library' });
  await shelves.getByRole('button', { name: /^Roster/ }).focus();
  await page.keyboard.press('1');
  await expect(page).toHaveURL(/#\/p\//);
  await expect(projectRail(page).locator('button.ip-rail-view[aria-current="page"]')).toBeFocused();
  // Enter on an Adapted in chip opens Sync, with focus on the rail's Sync button.
  await lib.click();
  const chip = page.locator('.ip-lib-row', { hasText: titles.guide }).locator(`a.ip-lib-adapt[href^="#/lib/sync/${fresh.slug}/"]`);
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/lib\/sync\//);
  await expect(shelves.getByRole('button', { name: /^Sync/ })).toBeFocused();
});

test('the Sync page draws a row of cells per project, opens a cell with its adaptation and upstream, files the sync step, and keeps the grid when one project fails', async ({ page, fresh, api }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const { swDir } = await libraryRepo(api, fresh);
  // A second project whose script exits 2.
  const broken = await bare(api, 'Broken sync');
  const brokenDir = mkdtempSync(join(tmpdir(), 'ip-e2e-broken-'));
  pageDirs.push(brokenDir);
  mkdirSync(join(brokenDir, '.claude'));
  writeFileSync(join(brokenDir, '.claude', 'shipwright.json'), JSON.stringify({ shipwright: swDir, files: { 'agents/sev.md': {} }, skip: [] }));
  writeFileSync(join(brokenDir, '.claude', 'fail'), '');
  await write(api, `e2e-${randomUUID()}`, 'post', `/api/projects/${broken.slug}/bindings`, { path: brokenDir });
  await open(page, fresh);
  await page.evaluate("location.hash = '#/lib/sync'");
  await expect(page.getByRole('heading', { level: 1, name: 'SYNC' })).toBeVisible();
  const row = page.locator(`tr[data-project="${fresh.slug}"]`);
  await expect(row.locator('.ip-sync-cell')).toHaveCount(2);
  await expect(row.locator('.ip-sync-cell').nth(0)).toHaveAttribute('aria-label', /× agents\/sev\.md, 1 commit behind$/);
  await expect(row.locator('.ip-sync-cell').nth(0)).toHaveAttribute('data-state', 'beh');
  await expect(row.locator('.ip-sync-cell').nth(1)).toHaveAttribute('data-state', 'nad');
  await expect(row.locator('.ip-sync-sum')).toContainText('1 of 1');
  // The broken project says so on its row, the other row still renders, and its name opens the stderr.
  const bad = page.locator(`tr[data-project="${broken.slug}"]`);
  await expect(bad.locator('.ip-sync-failed')).toHaveText('check failed');
  await expect(bad.locator('.ip-sync-cell')).toHaveCount(0);
  await bad.getByRole('button', { name: 'Broken sync' }).click();
  await expect(page.getByRole('region', { name: 'Open cell' })).toContainText('boom: bad project');
  // A cell opens below the grid, with the adaptation under its heading and the upstream hunk marked.
  await row.locator('.ip-sync-cell').nth(0).click();
  await expect(page).toHaveURL(new RegExp(`#/lib/sync/${fresh.slug}/agents%2Fsev\\.md$`));
  const cell = page.getByRole('region', { name: 'Open cell' });
  await expect(cell.locator('.ip-sync-hh').first()).toHaveText('Sev');
  await expect(cell.locator('.ip-sync-dl[data-kind="add"]')).toHaveText('+new intro');
  await expect(row.locator('.ip-sync-cell').nth(0)).toHaveAttribute('aria-pressed', 'true');
  // A fill's value reads on one line until it is opened in place.
  await cell.getByRole('tab', { name: /^Fills/ }).click();
  const value = cell.getByRole('button', { name: /^CHECKS, / });
  await expect(value).toHaveAttribute('aria-expanded', 'false');
  await value.click();
  await expect(value).toHaveAttribute('aria-expanded', 'true');
  await expect(value).toHaveText(/to the end$/);
  expect(await value.evaluate((el) => (el as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth <= (el as unknown as { clientWidth: number }).clientWidth)).toBe(true);
  await cell.getByRole('tab', { name: /^Upstream/ }).click();
  await expect(cell).toContainText('expect a conflict');
  // Escape closes it, and focus returns to the cell.
  await cell.getByRole('tab', { name: /^Upstream/ }).focus();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/#\/lib\/sync$/);
  await expect(cell).toHaveCount(0);
  await expect(row.locator('.ip-sync-cell').nth(0)).toBeFocused();
  // File sync step turns into the step's link.
  await row.getByRole('button', { name: 'File sync step' }).click();
  await expect(row.locator('.ip-sync-act a')).toHaveText(/^#\d+ sync step ›$/);
  // The link takes focus where the button was.
  await expect(row.locator('.ip-sync-act a')).toBeFocused();
});

test('says so when the server is unreachable at first paint, then recovers', async ({ page, demo, consoleErrors }) => {
  consoleErrors.allow(/ERR_CONNECTION_REFUSED/);
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await open(page, demo);
  await expect(page.getByText("Can't reach the InProgress server, retrying…")).toBeVisible();
  await page.unroute('**/api/**');
  await expect(page.locator('.ip-page-title')).toBeVisible({ timeout: 10_000 });
});

test('the first stream starts at the snapshot, and a batch still follows its targeted event', async ({ page, api, fresh }) => {
  // Hold the stream back, so these writes land after the snapshot was read but before the stream opens.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const streams: string[] = [];
  await page.route('**/api/events/stream**', async (route) => {
    streams.push(route.request().url());
    await held;
    await route.continue();
  });
  await open(page, fresh);
  await expect(stepRow(page, 'Play app signing')).toBeVisible();
  const [hotfix] = await write<{ id: number }[]>(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, after: 'start', nodes: [{ title: 'Hotfix', status: 'active' }] });
  await rankSoon(api, fresh, hotfix.id, fresh.ids['3 RevenueCat']);
  // Untargeted and right behind it: the two replay in one chunk, and React renders them as one batch.
  await write(api, fresh.session, 'post', `/api/sessions/${fresh.session}/hook`, { event: 'stop' });
  release();
  await expect(stepRow(page, 'Hotfix')).toBeVisible({ timeout: 6000 });
  expect(streams[0]).toMatch(/\/api\/events\/stream\?since=\d+$/);
});

test('keeps the view current under a steady stream of events', async ({ page, api, fresh }) => {
  await open(page, fresh);
  await expect(stepRow(page, 'Play app signing')).toBeVisible();
  // Snapshots now take longer than the gap between events, so a newer request is always in flight when one lands.
  await page.route(`**/api/projects/${fresh.slug}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  const node = fresh.ids['Play app signing'];
  await write(api, fresh.session, 'patch', `/api/nodes/${node}`, { title: 'Play app signing, renamed' });
  let steady = true;
  const events = (async () => {
    for (let i = 1; steady && i <= 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await write(api, fresh.session, 'post', `/api/nodes/${node}/log`, { text: `Step ${i}` });
    }
  })();
  try {
    await expect(stepRow(page, 'Play app signing, renamed')).toBeVisible({ timeout: 2500 });
  } finally {
    steady = false;
    await events;
  }
});

test('links open in the default browser through the server, not in this window', async ({ page, demo }) => {
  const opened: string[] = [];
  await page.route('**/api/ui/open-url', async (route) => {
    opened.push((route.request().postDataJSON() as { url: string }).url);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/x', (route) => route.fulfill({ status: 204 }));
  const popups: unknown[] = [];
  page.context().on('page', (p) => popups.push(p));
  await widen(page);
  await open(page, demo);
  await openDetails(page, 'Upload keystore');
  await resourceRow(page, 'Unsafe Markdown').click();
  await page.getByRole('dialog').getByRole('link', { name: 'Signing docs' }).click();
  await expect.poll(() => opened).toEqual(['https://example.com/signing']);
  expect(popups).toHaveLength(0);
});

// Project tabs. Every test here names its projects uniquely, so it finds their tabs among everyone else's.

const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;

/** A project with only its root: nothing needs you and no session works in it. */
const bare = (api: APIRequestContext, name: string) => write<{ id: number; slug: string; rootNodeId: number }>(api, `e2e-${randomUUID()}`, 'post', '/api/projects', { name });

/** One rank change as the window makes it (ranked Backlog spec section 2), sent with the window's headers. */
async function rank(api: APIRequestContext, project: { id: number; slug: string }, op: { node: number; to: 'next' | 'soon' | 'someday'; before: number | null }): Promise<void> {
  const res = await api.post(`/api/ui/projects/${project.id}/rank`, { headers: await uiHeaders(api), data: { slug: project.slug, op } });
  expect(res.ok(), `rank ${JSON.stringify(op)} answered ${res.status()}: ${await res.text()}`).toBe(true);
}

/** Ranks a step into Soon (at the bottom, or before another step), where the Board's Backlog preview shows it. */
const rankSoon = (api: APIRequestContext, project: { id: number; slug: string }, node: number, before: number | null = null) => rank(api, project, { node, to: 'soon', before });

/** A todo step under a bare project's root, ranked into Soon so its Board has a row to open. */
async function addStep(api: APIRequestContext, project: { id: number; slug: string; rootNodeId: number }, title: string): Promise<void> {
  const [node] = await write<{ id: number }[]>(api, `e2e-${randomUUID()}`, 'post', '/api/nodes', { parentId: project.rootNodeId, nodes: [{ title }] });
  await rankSoon(api, project, node.id);
}

/** A view's button in the rail (or, in a narrow window, its Views tab), named by its label. */
const viewButton = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^${label}\\b`) }).and(page.locator('.ip-rail-view, .ip-viewtabs .p-tab'));
const projectRail = (page: Page) => page.getByRole('navigation', { name: 'Projects' });
/** One project's row in the rail (a link, named as its tab was). */
const railRow = (page: Page, name: string | RegExp) => projectRail(page).getByRole('link', { name });
/** Every project row, in rail order. */
const railRows = (page: Page) => projectRail(page).locator('a[data-tab]');
/** The current project's row. */
const railCurrent = (page: Page) => projectRail(page).locator('a[aria-current="page"]');

/** The rows' titles (each project's full name), in rail order. */
async function railTitles(page: Page): Promise<(string | null)[]> {
  const rows = railRows(page);
  return Promise.all(Array.from({ length: await rows.count() }, (_, i) => rows.nth(i).getAttribute('title')));
}

const STRIP = `document.querySelector('.ip-rail')`;
const stripScroll = (page: Page) => page.evaluate<number>(`${STRIP}.scrollLeft`);

test('the tabs hold every active project, oldest first, mark the current one and switch on a click', async ({ page, api }) => {
  const olderName = unique('Tabs older');
  const newerName = unique('Tabs newer');
  const older = await seed(api, olderName);
  const newer = await seed(api, newerName);
  // The older project goes idle, so the server lists the newer, working one first. The tabs keep to age.
  await write(api, older.session, 'post', `/api/sessions/${older.session}/hook`, { event: 'stop' });
  const listed = ((await (await api.get('/api/projects')).json()) as { slug: string }[]).map((p) => p.slug);
  expect(listed.indexOf(newer.slug)).toBeLessThan(listed.indexOf(older.slug));
  await open(page, older);
  await expect(railRow(page, olderName)).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, newerName)).not.toHaveAttribute('aria-current');
  await expect(railCurrent(page)).toHaveCount(1);
  const titles = await railTitles(page);
  expect(titles.indexOf(olderName)).toBeGreaterThanOrEqual(0);
  expect(titles.indexOf(olderName)).toBeLessThan(titles.indexOf(newerName));
  await railRow(page, newerName).click();
  await expect(railRow(page, newerName)).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, olderName)).not.toHaveAttribute('aria-current');
  await expect(page).toHaveURL(new RegExp(`#/p/${newer.slug}$`));
  await expect(page).toHaveTitle(`(1) InProgress · ${newerName}`);
  await expect(page.locator('.ip-page-title')).toContainText(newerName);
  // A visit with no project in the URL opens the one picked last.
  await page.goto('/');
  await expect(railRow(page, newerName)).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(new RegExp(`#/p/${newer.slug}$`));
});

test('a tab drags to a new place, Alt+arrows move the focused tab, and the order holds across a reload', async ({ page, api }) => {
  await widen(page);
  const names = [unique('Tabs drag a'), unique('Tabs drag b'), unique('Tabs drag c')];
  await bare(api, names[0]);
  const b = await bare(api, names[1]);
  await bare(api, names[2]);
  /** Our projects' titles, in strip order, among whatever other tests left. */
  const ours = async (extra: string[] = []) => (await railTitles(page)).filter((t) => [...names, ...extra].includes(t ?? ''));
  await page.goto(`/#/p/${b.slug}`);
  await expect(railRow(page, names[2])).toBeVisible();
  expect(await ours()).toEqual(names);
  // The newest tab dragged onto the left half of the oldest lands before it.
  await railRow(page, names[2]).dragTo(railRow(page, names[0]), { targetPosition: { x: 10, y: 4 } });
  await expect.poll(() => ours()).toEqual([names[2], names[0], names[1]]);
  // The drag did not open the tab: the selection stayed on b.
  await expect(railRow(page, names[1])).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(railRow(page, names[2])).toBeVisible();
  expect(await ours()).toEqual([names[2], names[0], names[1]]);
  // Alt+Right moves the focused tab one place right and leaves focus on it. It neither selects a tab nor goes back.
  await railRow(page, names[0]).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => ours()).toEqual([names[2], names[1], names[0]]);
  await expect(railRow(page, names[0])).toBeFocused();
  await expect(railRow(page, names[1])).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(new RegExp(`#/p/${b.slug}$`));
  // A tab dragged to the right keeps the focus its press gave it, so the keys still reach the strip. Chromium keeps it
  // even without TabStrip's refocus after a drop, so this checks the outcome, not that guard.
  // Other tests' projects can push our rows to the column's foot, where a held drag scrolls it: bring the target to its middle first.
  await railRow(page, names[0]).evaluate((el) => (el as unknown as { scrollIntoView(o: { block: string }): void }).scrollIntoView({ block: 'center' }));
  const last = (await railRow(page, names[0]).boundingBox())!;
  await railRow(page, names[2]).dragTo(railRow(page, names[0]), { targetPosition: { x: 10, y: last.height - 4 } });
  await expect.poll(() => ours()).toEqual([names[1], names[0], names[2]]);
  await expect(railRow(page, names[2])).toBeFocused();
  // A project made after the move joins at the end.
  const fourth = unique('Tabs drag d');
  await bare(api, fourth);
  await expect(railRow(page, fourth)).toBeVisible();
  expect(await ours([fourth])).toEqual([names[1], names[0], names[2], fourth]);
});

test('a tab dragged near the edge of a narrow strip scrolls it', async ({ page, api }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  const names = [1, 2, 3, 4, 5].map((n) => unique(`Tabs edge ${n}`));
  for (const name of names) await bare(api, name);
  await page.goto('/');
  await expect(railRow(page, names[4])).toBeAttached();
  // The window has opened a project and revealed its tab, so nothing else scrolls the strip from here.
  await expect(railCurrent(page)).toHaveCount(1);
  expect(await page.evaluate<boolean>(`${STRIP}.scrollWidth > ${STRIP}.clientWidth`), 'the tabs overflow').toBe(true);
  await page.evaluate(`${STRIP}.scrollLeft = 0`);
  const box = (await page.locator('.ip-rail').boundingBox())!;
  expect(box.x + box.width, 'the strip ends inside the window').toBeLessThanOrEqual(420);
  const first = (await railRows(page).first().boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  for (let i = 0; i < 10; i++) await page.mouse.move(box.x + box.width / 2 - (i % 2), box.y + box.height / 2);
  expect(await stripScroll(page), 'the middle of the strip does not scroll it').toBe(0);
  // Held a few pixels inside the right edge. Chromium (Edge hosts the window) scrolls a scroll box under a drag near its
  // edge, so the strip has no code of its own for this. The test guards that the strip stays such a box.
  for (let i = 0; i < 10; i++) await page.mouse.move(box.x + box.width - 4 - (i % 2), box.y + box.height / 2);
  await expect.poll(() => stripScroll(page)).toBeGreaterThan(0);
  await page.mouse.up();
});

/** The animation the LiveDot part's blinking core runs: its ::after, which toHaveCSS cannot read. */
const dotAnimation = (row: Locator) => row.locator('.p-livedot').evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown, p: string): { animationName: string } }).getComputedStyle(el, '::after').animationName);

test('a tab shows how many items need you and, while a session works there, a pulsing dot', async ({ page, api }) => {
  const busyName = unique('Tabs busy');
  const quietName = unique('Tabs quiet');
  const busy = await seed(api, busyName);
  await bare(api, quietName);
  await open(page, busy);
  const busyTab = railRow(page, busyName);
  const quietTab = railRow(page, quietName);
  await expect(busyTab).toHaveAccessibleName(`${busyName}, 1 need you, working`);
  await expect(busyTab.locator('.ip-rail-ask')).toHaveText('1');
  await expect.poll(() => dotAnimation(busyTab)).toBe('p-blink');
  await expect(quietTab).toHaveAccessibleName(quietName);
  await expect(quietTab.locator('.ip-rail-ask, .p-livedot')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => dotAnimation(busyTab)).toBe('none');
  // Both follow the data, live.
  await write(api, busy.session, 'post', `/api/asks/${busy.ask}/clear`, {});
  await write(api, busy.session, 'post', `/api/sessions/${busy.session}/hook`, { event: 'stop' });
  await expect(busyTab).toHaveAccessibleName(busyName);
  await expect(busyTab.locator('.ip-rail-ask, .p-livedot')).toHaveCount(0);
});

test('archived projects move into the ⋯ menu, and picking one opens it', async ({ page, api }) => {
  const keptName = unique('Tabs kept');
  const shelvedName = unique('Tabs shelved');
  const kept = await bare(api, keptName);
  const shelved = await bare(api, shelvedName);
  await addStep(api, kept, 'Kept step');
  await write(api, `e2e-${randomUUID()}`, 'patch', `/api/projects/${shelved.slug}`, { status: 'archived' });
  await page.goto(`/#/p/${kept.slug}`);
  await expect(railRow(page, keptName)).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, shelvedName)).toHaveCount(0);
  const more = page.getByRole('button', { name: /^Archived · / });
  const item = page.getByRole('menu').getByRole('menuitem', { name: shelvedName, exact: true });
  const details = await openDetails(page, 'Kept step');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  // Escape closes the menu, and only the menu: Details stays open. Focus stays on ⋯.
  await page.keyboard.press('Escape');
  await expect(item).toBeHidden();
  await expect(more).toBeFocused();
  await expect(details).toBeVisible();
  // Picked from the keyboard, the project opens and focus goes back to ⋯ rather than falling to the page.
  await more.click();
  await item.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/p/${shelved.slug}$`));
  await expect(page).toHaveTitle(`InProgress · ${shelvedName}`);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
  // While it is open, the archived project has a tab of its own at the end, marked archived.
  const shelvedTab = railRow(page, shelvedName);
  await expect(shelvedTab).toHaveAttribute('aria-current', 'page');
  await expect(shelvedTab).toHaveAccessibleName(`${shelvedName}, archived`);
  await expect(railRows(page).last()).toHaveAttribute('aria-current', 'page');
  await railRow(page, keptName).click();
  await expect(shelvedTab).toHaveCount(0);
});

test('[ and ] step through the tabs, wrapping round at the ends, and 1 to 9 jump to a tab', async ({ page, api }) => {
  const firstName = unique('Tabs step 1');
  const secondName = unique('Tabs step 2');
  const first = await bare(api, firstName);
  const second = await bare(api, secondName);
  await page.goto(`/#/p/${second.slug}`);
  const tabs = railRows(page);
  await expect(railRow(page, secondName)).toHaveAttribute('aria-current', 'page');
  // The newest project has the last tab.
  await expect(tabs.last()).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('[');
  await expect(railRow(page, firstName)).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(new RegExp(`#/p/${first.slug}$`));
  await page.keyboard.press(']');
  await expect(railRow(page, secondName)).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press(']');
  await expect(tabs.first()).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('[');
  await expect(railRow(page, secondName)).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('1');
  await expect(tabs.first()).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('2');
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
});

test('the tab keys are ignored with a modifier, while typing and while the resource viewer is open', async ({ page, api, demo }) => {
  // Somewhere else for ] to go.
  await bare(api, unique('Tabs ignored'));
  await widen(page);
  await open(page, demo);
  const here = new RegExp(`#/p/${demo.slug}$`);
  await expect(railCurrent(page)).toBeVisible();
  await page.keyboard.press('Control+]');
  await page.keyboard.press('Control+[');
  await page.evaluate(`document.body.append(Object.assign(document.createElement('input'), { id: 'typing' }))`);
  const field = page.locator('#typing');
  await field.focus();
  await page.keyboard.press(']');
  await page.keyboard.press('2');
  await expect(field).toHaveValue(']2');
  await page.evaluate(`document.getElementById('typing').remove()`);
  await openDetails(page, 'Run signing tests');
  await resourceRow(page, 'Signing test suite').click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await page.keyboard.press(']');
  await page.keyboard.press('1');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(page).toHaveURL(here);
  // With nothing in the way, ] moves on.
  await page.keyboard.press(']');
  await expect(page).not.toHaveURL(here);
});

test('when the rows overflow the strip, the current row stays in view as the keys and the window change it', async ({ page, api }) => {
  const names = Array.from({ length: 6 }, (_, i) => unique(`Rows overflow ${i + 1}`));
  const made: { slug: string }[] = [];
  for (const name of names) made.push(await bare(api, name));
  // Opened on the second-to-last row: it comes into view.
  await page.goto(`/#/p/${made[4].slug}`);
  const last = railRow(page, names[5]);
  await expect(railRow(page, names[4])).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, names[4])).toBeInViewport({ ratio: 0.99 });
  expect(await page.evaluate<boolean>(`${STRIP}.scrollWidth > ${STRIP}.clientWidth`), 'the rows overflow').toBe(true);
  expect((await page.locator('.ip-rail').boundingBox())!.height, 'one row of rows').toBeLessThan(70);
  await page.keyboard.press(']');
  await expect(last).toHaveAttribute('aria-current', 'page');
  await expect(last).toBeInViewport({ ratio: 0.99 });
  // A row picked from the keyboard comes into view: ] from the last row wraps round to the first, [ goes back.
  await page.keyboard.press(']');
  await expect(railRows(page).first()).toHaveAttribute('aria-current', 'page');
  await expect(railRows(page).first()).toBeInViewport({ ratio: 0.99 });
  await page.keyboard.press('[');
  await expect(last).toHaveAttribute('aria-current', 'page');
  await expect(last).toBeInViewport({ ratio: 0.99 });
  // So does the current row when the window narrows.
  await page.evaluate(`${STRIP}.scrollLeft = 0`);
  await page.setViewportSize({ width: 420, height: 900 });
  await expect(last).toBeInViewport({ ratio: 0.99 });
});

test('the rows are one stop in the tab order: arrows move focus without opening, Enter and Space open, and the views are a second stop', async ({ page, api }) => {
  await widen(page);
  const leftName = unique('Tabs arrow left');
  const rightName = unique('Tabs arrow right');
  const left = await bare(api, leftName);
  await bare(api, rightName);
  await page.goto(`/#/p/${left.slug}`);
  await expect(railRow(page, leftName)).toHaveAttribute('aria-current', 'page');
  await expect(projectRail(page).locator('a[tabindex="0"]')).toHaveCount(1);
  await expect(railRow(page, leftName)).toHaveAttribute('tabindex', '0');
  await railRow(page, leftName).focus();
  await page.keyboard.press('ArrowDown');
  await expect(railRow(page, rightName)).toBeFocused();
  // Moving focus opened nothing.
  await expect(railRow(page, leftName)).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, rightName)).not.toHaveAttribute('aria-current');
  await page.keyboard.press('Enter');
  await expect(railRow(page, rightName)).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, rightName)).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('ArrowUp');
  await expect(railRow(page, leftName)).toBeFocused();
  await expect(railRow(page, rightName)).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Space');
  await expect(railRow(page, leftName)).toHaveAttribute('aria-current', 'page');
  // Tab leaves the rows for the views, the second stop: the current view is its one stop and Up and Down move in it.
  await page.keyboard.press('Tab');
  const views = projectRail(page).locator('.ip-rail-view');
  await expect(views.nth(0)).toBeFocused();
  await expect(projectRail(page).locator('.ip-rail-view[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(views.nth(1)).toBeFocused();
  await expect(views.nth(0)).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Enter');
  await expect(views.nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: 'Sections' })).toBeVisible();
});

// Archive and delete from the window. A project archived "elsewhere" goes through the scribe's update_project, as T930
// does. The suite's server is shared, so ⋯ also lists other tests' projects: every test finds its own by name.

const MORE = /^Archived · /;
const moreButton = (page: Page) => page.getByRole('button', { name: MORE });
const moreMenu = (page: Page) => page.getByRole('menu', { name: MORE });
const tabMenu = (page: Page, name: string) => page.getByRole('menu', { name, exact: true });
const statusLine = (page: Page) => page.getByRole('status');
const archiveByScribe = (api: APIRequestContext, slug: string) => write(api, `e2e-${randomUUID()}`, 'patch', `/api/projects/${slug}`, { status: 'archived' });
const hereIs = (slug: string) => new RegExp(`#/p/${slug}$`);

async function listedStatus(api: APIRequestContext, slug: string): Promise<string | undefined> {
  return ((await (await api.get('/api/projects')).json()) as { slug: string; status: string }[]).find((p) => p.slug === slug)?.status;
}

/** A token's value as the page resolves it, in the form a computed colour takes. */
const tokenColour = (page: Page, token: string) =>
  page.evaluate<string>(`(() => { const probe = document.createElement('i'); probe.style.color = 'var(${token})'; document.body.append(probe); const colour = getComputedStyle(probe).color; probe.remove(); return colour; })()`);

test('a right-click on a tab opens its menu under it without switching, and Archive moves the project into ⋯', async ({ page, api }) => {
  const hereName = unique('Menu here');
  const shelfName = unique('Menu shelf');
  const here = await bare(api, hereName);
  const shelf = await bare(api, shelfName);
  await page.goto(`/#/p/${here.slug}`);
  await expect(railRow(page, hereName)).toHaveAttribute('aria-current', 'page');
  // A listener after React's sees whether the browser's own menu was kept away.
  await page.evaluate(`window.__menus = []; window.addEventListener('contextmenu', (e) => window.__menus.push(e.defaultPrevented))`);
  const shelfTab = railRow(page, shelfName);
  await shelfTab.click({ button: 'right' });
  const menu = tabMenu(page, shelfName);
  const items = menu.getByRole('menuitem');
  await expect(menu).toBeVisible();
  await expect(items).toHaveText(['Archive', 'Rename…', 'Delete…']);
  await expect(items.first()).toHaveAccessibleName('Archive');
  await expect(items.first()).toBeFocused();
  // The tab says whose menu it is, and is not opened by it.
  await expect(shelfTab).toHaveClass(/\bmenu-open\b/);
  await expect(shelfTab).not.toHaveAttribute('aria-current');
  await expect(page).toHaveURL(hereIs(here.slug));
  expect(await page.evaluate<boolean[]>('window.__menus')).toEqual([true]);
  // Under its tab, and wholly in the window.
  const [menuBox, tabBox] = [(await menu.boundingBox())!, (await shelfTab.boundingBox())!];
  expect(menuBox.y).toBeGreaterThanOrEqual(tabBox.y + tabBox.height);
  await expect(menu).toBeInViewport({ ratio: 0.99 });
  await items.first().click();
  await expect(menu).toBeHidden();
  await expect(shelfTab).toHaveCount(0);
  await expect(statusLine(page)).toHaveText(`Archived ${shelfName}. It is under Archived in the rail.`);
  // The window stays where it was, and focus is on its tab.
  await expect(railRow(page, hereName)).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, hereName)).toBeFocused();
  await expect(page).toHaveURL(hereIs(here.slug));
  expect(await listedStatus(api, shelf.slug)).toBe('archived');
  await moreButton(page).click();
  await expect(moreMenu(page).getByRole('group', { name: 'Archived', exact: true }).getByRole('menuitem', { name: shelfName, exact: true })).toBeVisible();
});

test('archiving the open project opens the tab beside it, and focus lands there', async ({ page, api }) => {
  const names = [unique('Beside left'), unique('Beside middle'), unique('Beside right')];
  const made: { slug: string }[] = [];
  for (const name of names) made.push(await bare(api, name));
  await page.goto(`/#/p/${made[1].slug}`);
  const middle = railRow(page, names[1]);
  await expect(middle).toHaveAttribute('aria-current', 'page');
  await middle.focus();
  await page.keyboard.press('Shift+F10');
  await expect(tabMenu(page, names[1]).getByRole('menuitem', { name: 'Archive', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  // The tab to its right opens, as a browser does when a tab closes.
  await expect(middle).toHaveCount(0);
  await expect(railRow(page, names[2])).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, names[2])).toBeFocused();
  await expect(page).toHaveURL(hereIs(made[2].slug));
  await expect(page).toHaveTitle(`InProgress · ${names[2]}`);
  await expect(statusLine(page)).toHaveText(`Archived ${names[1]}. It is under Archived in the rail.`);
  // The newest project has the last tab, so archiving it opens the one to its left.
  await expect(railRows(page).last()).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('Enter');
  await expect(railRow(page, names[0])).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, names[0])).toBeFocused();
  await expect(page).toHaveURL(hereIs(made[0].slug));
});

test("menus keep the keys to themselves: the arrows, Home and End move in them and the app's own keys wait", async ({ page, api }) => {
  const keptName = unique('Keys kept');
  const kept = await bare(api, keptName);
  await addStep(api, kept, 'Kept step');
  for (const label of ['Keys shelf A', 'Keys shelf B']) await archiveByScribe(api, (await bare(api, unique(label))).slug);
  await page.goto(`/#/p/${kept.slug}`);
  const details = await openDetails(page, 'Kept step');
  const more = moreButton(page);
  const items = moreMenu(page).getByRole('menuitem');
  // Down on ⋯ opens it on the first item; the arrows wrap round, Home and End go to the ends.
  await more.focus();
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  // ] and 1 would switch tabs under the menu.
  await page.keyboard.press(']');
  await page.keyboard.press('1');
  await expect(page).toHaveURL(hereIs(kept.slug));
  await expect(moreMenu(page)).toBeVisible();
  // Escape closes the menu and nothing else: Details stays open, and focus goes back to ⋯.
  await page.keyboard.press('Escape');
  await expect(moreMenu(page)).toBeHidden();
  await expect(more).toBeFocused();
  await expect(details).toBeVisible();
  // Up on ⋯ opens it on the last item.
  await page.keyboard.press('ArrowUp');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Escape');
  // On a tab, the Menu key opens its menu, Escape gives focus back to the tab, and Tab leaves and closes it.
  const keptTab = railRow(page, keptName);
  const menu = tabMenu(page, keptName);
  await keptTab.focus();
  await page.keyboard.press('ContextMenu');
  await expect(menu.getByRole('menuitem', { name: 'Archive', exact: true })).toBeFocused();
  await page.keyboard.press(']');
  await expect(page).toHaveURL(hereIs(kept.slug));
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(keptTab).toBeFocused();
  await expect(details).toBeVisible();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(details).toBeVisible();
  await expect(page).toHaveURL(hereIs(kept.slug));
});

test('⋯ lists the archived projects with Unarchive and Delete, and Unarchive puts the tab back in its place', async ({ page, api }) => {
  const beforeName = unique('Groups before');
  const middleName = unique('Groups middle');
  const afterName = unique('Groups after');
  const before = await bare(api, beforeName);
  const middle = await bare(api, middleName);
  await bare(api, afterName);
  await archiveByScribe(api, middle.slug);
  // Another archived project, so ⋯ stays after the unarchive even when this test runs alone.
  await archiveByScribe(api, (await bare(api, unique('Groups stays'))).slug);
  await page.goto(`/#/p/${before.slug}`);
  await expect(railRow(page, beforeName)).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, middleName)).toHaveCount(0);
  const more = moreButton(page);
  await expect(more).toHaveAccessibleName(MORE);
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  await more.click();
  const menu = moreMenu(page);
  await expect(more).toHaveAttribute('aria-controls', (await menu.getAttribute('id'))!);
  const archived = menu.getByRole('group', { name: 'Archived', exact: true });
  await expect(archived.getByRole('menuitem', { name: middleName, exact: true })).toBeVisible();
  await expect(archived.getByRole('menuitem', { name: `Unarchive ${middleName}`, exact: true })).toHaveText('Unarchive');
  await expect(archived.getByRole('menuitem', { name: `Delete ${middleName}`, exact: true })).toHaveText('Delete…');
  await archived.getByRole('menuitem', { name: `Unarchive ${middleName}`, exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(statusLine(page)).toHaveText(`${middleName} is back in the rail.`);
  await expect(more).toBeFocused();
  // Back between the projects made before and after it, and the window stays where it was.
  await expect(railRow(page, middleName)).toBeVisible();
  const titles = await railTitles(page);
  expect(titles.indexOf(middleName)).toBe(titles.indexOf(beforeName) + 1);
  expect(titles.indexOf(afterName)).toBe(titles.indexOf(middleName) + 1);
  await expect(railRow(page, beforeName)).toHaveAttribute('aria-current', 'page');
  expect(await listedStatus(api, middle.slug)).toBe('active');
  await more.click();
  await expect(menu.getByRole('menuitem', { name: middleName, exact: true })).toHaveCount(0);
});

test('Delete asks once, the project waits under Recently deleted with its days, and Restore brings it back', async ({ page, api }) => {
  const keptName = unique('Delete kept');
  const goneName = unique('Delete gone');
  const kept = await bare(api, keptName);
  const gone = await bare(api, goneName);
  await archiveByScribe(api, gone.slug);
  // Another archived project, so both groups show even when this test runs alone.
  await archiveByScribe(api, (await bare(api, unique('Delete stays'))).slug);
  await page.goto(`/#/p/${kept.slug}`);
  const more = moreButton(page);
  const menu = moreMenu(page);
  await more.click();
  const ask = menu.getByRole('menuitem', { name: `Delete ${goneName}`, exact: true });
  await ask.click();
  const confirm = page.getByRole('group', { name: `Delete ${goneName}?` });
  const go = confirm.getByRole('button', { name: 'Delete', exact: true });
  await expect(confirm).toHaveAccessibleDescription('Hidden now, removed for good after 30 days. Restore it from Archived until then.');
  await expect(confirm.getByRole('button')).toHaveText(['Delete', 'Cancel']);
  await expect(go).toBeFocused();
  // Escape goes back one step, to the menu, on the item that asked.
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(ask).toBeFocused();
  // Asked again from the keyboard, Enter confirms.
  await page.keyboard.press('Enter');
  await expect(go).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toBeHidden();
  await expect(statusLine(page)).toHaveText(`Deleted ${goneName}. Restore it from Archived in the rail within 30 days.`);
  await expect(more).toBeFocused();
  await expect(page).toHaveURL(hereIs(kept.slug));
  expect(await listedStatus(api, gone.slug)).toBeUndefined();
  // It waits under Recently deleted, after the archived projects and a hairline.
  await page.keyboard.press('ArrowDown');
  const deleted = menu.getByRole('group', { name: 'Recently deleted', exact: true });
  const restore = deleted.getByRole('menuitem', { name: `Restore ${goneName}`, exact: true });
  await expect(menu.getByRole('separator')).toHaveCount(1);
  await expect(deleted.locator('.ip-rail-menu-row', { hasText: goneName })).toContainText('30 days left');
  await expect(restore).toHaveText('Restore');
  await expect(restore).toHaveAccessibleDescription('30 days left');
  await expect(menu.getByRole('menuitem', { name: goneName, exact: true })).toHaveCount(0);
  await restore.click();
  await expect(statusLine(page)).toHaveText(`Restored ${goneName}. It is under Archived in the rail.`);
  await expect(more).toBeFocused();
  expect(await listedStatus(api, gone.slug)).toBe('archived');
  await more.click();
  await expect(menu.getByRole('group', { name: 'Archived', exact: true }).getByRole('menuitem', { name: goneName, exact: true })).toBeVisible();
  await expect(restore).toHaveCount(0);
});

/**
 * Shows the window only the projects in `ids`, active, archived and deleted alike, so ⋯ can be down to one row: the
 * suite's server is shared, and ⋯ would otherwise list every other test's projects too. Each fetch reads `ids` as it
 * is then.
 */
async function showOnly(page: Page, ids: Set<number>): Promise<void> {
  for (const path of ['**/api/projects', '**/api/deleted-projects']) {
    await page.route(path, async (route) => {
      const response = await route.fetch();
      const rows = (await response.json()) as { id: number }[];
      await route.fulfill({ response, json: rows.filter((r) => ids.has(r.id)) });
    });
  }
}

test('⋯ keeps focus when a delete or a restore leaves it one row, and goes when Unarchive leaves it none', async ({ page, api }) => {
  const hereName = unique('Lone here');
  const goneName = unique('Lone gone');
  const here = await bare(api, hereName);
  const gone = await bare(api, goneName);
  await archiveByScribe(api, gone.slug);
  const shown = new Set([here.id, gone.id]);
  await showOnly(page, shown);
  const more = moreButton(page);
  const menu = moreMenu(page);
  const deleteGone = async () => {
    await more.click();
    await menu.getByRole('menuitem', { name: `Delete ${goneName}`, exact: true }).click();
    await page.getByRole('group', { name: `Delete ${goneName}?` }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(statusLine(page)).toHaveText(`Deleted ${goneName}. Restore it from Archived in the rail within 30 days.`);
    await expect(more).toBeFocused();
  };
  // Restored while it is ⋯'s only row, it is under Archived at once: ⋯ never leaves the page (the same element stays),
  // so focus stays on it.
  const restoreGone = async () => {
    await more.click();
    await expect(menu.getByRole('menuitem')).toHaveText(['Restore']);
    await page.evaluate(`document.querySelector('.ip-rail-foot button').setAttribute('data-probe', 'kept')`);
    await menu.getByRole('menuitem', { name: `Restore ${goneName}`, exact: true }).click();
    await expect(statusLine(page)).toHaveText(`Restored ${goneName}. It is under Archived in the rail.`);
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('data-probe', 'kept');
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('group', { name: 'Archived', exact: true }).getByRole('menuitem', { name: goneName, exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
  };
  // Deleting the open archived project from ⋯ opens the tab before it, and focus stays on ⋯, where the delete began.
  await page.goto(`/#/p/${gone.slug}`);
  await expect(railRow(page, goneName)).toHaveAttribute('aria-current', 'page');
  await deleteGone();
  await expect(railRow(page, hereName)).toHaveAttribute('aria-current', 'page');
  await restoreGone();
  await expect(page).toHaveURL(hereIs(here.slug));
  // With no tab at all: the delete leaves only ⋯ and the empty text, and the restore still keeps focus on ⋯.
  shown.delete(here.id);
  await page.goto(`/#/p/${gone.slug}`);
  await page.reload();
  await expect(railRows(page)).toHaveCount(1);
  await deleteGone();
  await expect(railRows(page)).toHaveCount(0);
  await expect(page.locator('.p-empty')).toHaveText('No projects. Restore one from Archived, or in a Claude session say "track this in InProgress".');
  await restoreGone();
  // Nothing else is listed, so it opens, as the list's fallback opens the first listed project.
  await expect(page).toHaveURL(hereIs(gone.slug));
  // Unarchive empties ⋯: ⋯ goes, and focus lands on the project's tab.
  await more.click();
  await menu.getByRole('menuitem', { name: `Unarchive ${goneName}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`${goneName} is back in the rail.`);
  await expect(more).toHaveCount(0);
  await expect(railRow(page, goneName)).toBeFocused();
});

test('deleting the open project from its tab opens the tab before it, and a link to it opens another project', async ({ page, api, consoleErrors }) => {
  // The deleted project's own address answers 404.
  consoleErrors.allow(/status of 404/);
  const prevName = unique('End prev');
  const endName = unique('End gone');
  const prev = await bare(api, prevName);
  const end = await bare(api, endName);
  await archiveByScribe(api, end.slug);
  await page.goto(`/#/p/${end.slug}`);
  const endTab = railRow(page, endName);
  await expect(endTab).toHaveAttribute('aria-current', 'page');
  await expect(endTab).toHaveAccessibleName(`${endName}, archived`);
  // The open archived project's tab offers Unarchive and Delete…, not Archive.
  await endTab.focus();
  await page.keyboard.press('Shift+F10');
  const menu = tabMenu(page, endName);
  await expect(menu.getByRole('menuitem')).toHaveText(['Unarchive', 'Rename…', 'Delete…']);
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete…' })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('group', { name: `Delete ${endName}?` });
  await expect(confirm.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  // It was the last tab: the one before it opens, and has focus.
  await expect(endTab).toHaveCount(0);
  await expect(railRow(page, prevName)).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, prevName)).toBeFocused();
  await expect(page).toHaveURL(hereIs(prev.slug));
  await expect(statusLine(page)).toHaveText(`Deleted ${endName}. Restore it from Archived in the rail within 30 days.`);
  // A link to it never paints it: another project opens.
  await page.goto(`/#/p/${end.slug}`);
  await expect(page).not.toHaveURL(hereIs(end.slug));
  await expect(railCurrent(page)).toBeVisible();
  await expect(page).not.toHaveTitle(new RegExp(endName));
  await expect(railRow(page, endName)).toHaveCount(0);
});

test('a delete slow to answer never makes the window ask for the project, still opens the tab beside it, and the project is asked for again once restored', async ({ page, api }) => {
  const keptName = unique('Slow kept');
  const goneName = unique('Slow gone');
  const busy = await bare(api, unique('Slow busy'));
  const kept = await bare(api, keptName);
  const gone = await bare(api, goneName);
  await archiveByScribe(api, gone.slug);
  // kept is the newest active project, so its tab is the one beside gone's. An event after kept's lists busy ahead of
  // it, so the list's fallback (the first active project the server lists) never opens kept: only the tab rule can.
  await write(api, `e2e-${randomUUID()}`, 'patch', `/api/projects/${busy.slug}`, { description: 'Busier than kept' });
  const listed = ((await (await api.get('/api/projects')).json()) as { slug: string }[]).map((p) => p.slug);
  expect(listed.indexOf(busy.slug)).toBeGreaterThanOrEqual(0);
  expect(listed.indexOf(busy.slug)).toBeLessThan(listed.indexOf(kept.slug));
  await page.goto(`/#/p/${gone.slug}`);
  await expect(page).toHaveTitle(`InProgress · ${goneName}`);
  // The server deletes it at once and its event arrives, but the answer is held past what the event sets off: the
  // snapshot refresh for the open project (150 ms) and the list reload (400 ms). A deleted project's address answers
  // 404, so until the answer moves the window on, nothing may ask for it. The reloaded list no longer has it, and must
  // leave the window on it for the answer to open the tab beside it.
  await page.route('**/api/ui/projects/*/delete', async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({ response });
  });
  // Counted from the delete's request on: a refresh sent before it reaches the server first, and finds the project.
  let sent = false;
  const asked: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path === `/api/ui/projects/${gone.id}/delete`) sent = true;
    else if (sent && path === `/api/projects/${gone.slug}`) asked.push(r.method());
  });
  const more = moreButton(page);
  const menu = moreMenu(page);
  await more.click();
  await menu.getByRole('menuitem', { name: `Delete ${goneName}`, exact: true }).click();
  await page.getByRole('group', { name: `Delete ${goneName}?` }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(statusLine(page)).toHaveText(`Deleted ${goneName}. Restore it from Archived in the rail within 30 days.`);
  // The tab beside it, not the list's fallback.
  await expect(page).toHaveURL(hereIs(kept.slug));
  await expect(page).toHaveTitle(`InProgress · ${keptName}`);
  expect(asked).toEqual([]);
  // Restored, it opens as any archived project does.
  await more.click();
  await menu.getByRole('menuitem', { name: `Restore ${goneName}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`Restored ${goneName}. It is under Archived in the rail.`);
  await more.click();
  await menu.getByRole('menuitem', { name: goneName, exact: true }).click();
  await expect(page).toHaveTitle(`InProgress · ${goneName}`);
});

/** The project as /api/projects lists it, or undefined once it is deleted. */
async function listed(api: APIRequestContext, slug: string): Promise<{ status: string; activeSessions: number } | undefined> {
  return ((await (await api.get('/api/projects')).json()) as { slug: string; status: string; activeSessions: number }[]).find((p) => p.slug === slug);
}

test("an active tab's Delete… says how many sessions it stops tracking, and deleting another tab leaves the window where it is", async ({ page, api }) => {
  const hereName = unique('Active here');
  const busyName = unique('Active busy');
  const here = await bare(api, hereName);
  // A session works in it.
  const busy = await seed(api, busyName);
  expect(await listed(api, busy.slug)).toMatchObject({ status: 'active', activeSessions: 1 });
  await page.goto(`/#/p/${here.slug}`);
  await expect(railRow(page, hereName)).toHaveAttribute('aria-current', 'page');
  const busyTab = railRow(page, busyName);
  await busyTab.click({ button: 'right' });
  const menu = tabMenu(page, busyName);
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAccessibleName('Archive');
  await expect(items.nth(0)).toHaveAccessibleDescription('Stops tracking 1 session');
  await expect(items.nth(1)).toHaveAccessibleName('Rename…');
  await expect(items.nth(2)).toHaveAccessibleName('Delete…');
  await items.nth(2).click();
  // The confirm Delete always asks, with Archive's line under it.
  const confirm = page.getByRole('group', { name: `Delete ${busyName}?` });
  const go = confirm.getByRole('button', { name: 'Delete', exact: true });
  await expect(confirm).toHaveAccessibleDescription('Hidden now, removed for good after 30 days. Restore it from Archived until then. Stops tracking 1 session');
  const note = confirm.getByText(/Stops tracking 1 session/);
  await expect(note).toBeVisible();
  await expect(go).toBeFocused();
  // Escape goes back to the menu, on Delete….
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(go).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(busyTab).toHaveCount(0);
  await expect(statusLine(page)).toHaveText(`Deleted ${busyName}. Restore it from Archived in the rail within 30 days.`);
  // Not the open project: the window stays where it was, and focus is on its tab.
  await expect(railRow(page, hereName)).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, hereName)).toBeFocused();
  await expect(page).toHaveURL(hereIs(here.slug));
  expect(await listed(api, busy.slug)).toBeUndefined();
  // Restore brings it back under Archived, its session no longer tracked.
  await moreButton(page).click();
  await moreMenu(page).getByRole('menuitem', { name: `Restore ${busyName}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`Restored ${busyName}. It is under Archived in the rail.`);
  await expect(busyTab).toHaveCount(0);
  expect(await listed(api, busy.slug)).toMatchObject({ status: 'archived', activeSessions: 0 });
});

test('deleting the open active project from its tab opens the tab beside it with focus there, and Unarchive after a restore puts the tab back', async ({ page, api }) => {
  const names = [unique('Active left'), unique('Active middle'), unique('Active right')];
  const made: { slug: string }[] = [];
  for (const name of names) made.push(await bare(api, name));
  await page.goto(`/#/p/${made[1].slug}`);
  const middle = railRow(page, names[1]);
  await expect(middle).toHaveAttribute('aria-current', 'page');
  await middle.focus();
  await page.keyboard.press('Shift+F10');
  const menu = tabMenu(page, names[1]);
  await expect(menu.getByRole('menuitem')).toHaveText(['Archive', 'Rename…', 'Delete…']);
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete…', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('group', { name: `Delete ${names[1]}?` });
  // No session is live there, so the confirm has no line about one.
  await expect(confirm).toHaveAccessibleDescription('Hidden now, removed for good after 30 days. Restore it from Archived until then.');
  await expect(confirm.getByText(/Stops tracking/)).toHaveCount(0);
  await page.keyboard.press('Enter');
  // The tab to its right opens and has focus, as when the open project is archived.
  await expect(middle).toHaveCount(0);
  await expect(railRow(page, names[2])).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, names[2])).toBeFocused();
  await expect(page).toHaveURL(hereIs(made[2].slug));
  await expect(page).toHaveTitle(`InProgress · ${names[2]}`);
  await expect(statusLine(page)).toHaveText(`Deleted ${names[1]}. Restore it from Archived in the rail within 30 days.`);
  expect(await listed(api, made[1].slug)).toBeUndefined();
  // The newest project has the last tab, so deleting it opens the one to its left.
  await expect(railRows(page).last()).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(railRow(page, names[2])).toHaveCount(0);
  await expect(railRow(page, names[0])).toHaveAttribute('aria-current', 'page');
  await expect(railRow(page, names[0])).toBeFocused();
  await expect(page).toHaveURL(hereIs(made[0].slug));
  // Restored, it is under Archived, not back in the tabs; Unarchive puts its tab back.
  const more = moreButton(page);
  await more.click();
  await moreMenu(page).getByRole('menuitem', { name: `Restore ${names[1]}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`Restored ${names[1]}. It is under Archived in the rail.`);
  await expect(middle).toHaveCount(0);
  expect((await listed(api, made[1].slug))?.status).toBe('archived');
  await more.click();
  await moreMenu(page).getByRole('menuitem', { name: `Unarchive ${names[1]}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`${names[1]} is back in the rail.`);
  await expect(middle).toBeVisible();
  const titles = await railTitles(page);
  expect(titles.indexOf(names[1])).toBe(titles.indexOf(names[0]) + 1);
});

/** A write as the window makes it: from the page, with its UI token and a JSON body. Answers the status and the body. */
const windowPost = (page: Page, path: string, body: unknown) =>
  page.evaluate<{ status: number; body: unknown }>(`(async () => {
    const token = document.querySelector('meta[name="ip-ui-token"]').content;
    const headers = { 'content-type': 'application/json', 'x-ip-ui-token': token };
    const res = await fetch(${JSON.stringify(path)}, { method: 'POST', headers, body: ${JSON.stringify(JSON.stringify(body))} });
    return { status: res.status, body: await res.json() };
  })()`);

/** A project as /api/projects lists it, by id. */
async function listedById(api: APIRequestContext, id: number): Promise<{ slug: string; name: string } | undefined> {
  return ((await (await api.get('/api/projects')).json()) as { id: number; slug: string; name: string }[]).find((p) => p.id === id);
}

test('Rename… turns a tab menu into a field: Escape and leaving cancel, Enter saves, and the slug and link stay', async ({ page, api, consoleErrors }) => {
  // The stale write at the end answers 409 on purpose.
  consoleErrors.allow(/status of 409/);
  const oldName = unique('Rename old');
  const newName = unique('Rename new');
  const made = await bare(api, oldName);
  await page.goto(`/#/p/${made.slug}`);
  const tab = railRow(page, oldName);
  await expect(tab).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle(`InProgress · ${oldName}`);
  await tab.focus();
  await page.keyboard.press('Shift+F10');
  const menu = tabMenu(page, oldName);
  const item = menu.getByRole('menuitem', { name: 'Rename…', exact: true });
  await page.keyboard.press('ArrowDown');
  await expect(item).toBeFocused();
  await page.keyboard.press('Enter');
  // The menu becomes the field, named for the project, holding its name, all of it selected so typing replaces it.
  const field = page.getByRole('textbox', { name: `Rename ${oldName}`, exact: true });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(oldName);
  expect(await field.evaluate((el: { selectionStart: number | null; selectionEnd: number | null }) => [el.selectionStart, el.selectionEnd])).toEqual([0, oldName.length]);
  await expect(page.locator('.ip-rail-menu')).toBeVisible();
  await expect(page.locator('.ip-rail-menu')).not.toHaveAttribute('role', /./);
  // v3's look: a body line in ink on the panel, inside a line.
  await expect(field).toHaveCSS('font-size', '15px');
  await expect(field).toHaveCSS('color', await tokenColour(page, '--text-hi'));
  await expect(field.locator('xpath=..')).toHaveCSS('border-top-color', await tokenColour(page, '--volt'));
  // Every key typed there stays there: ] 1 f n would switch tabs or move the camera, Home and End would leave the field.
  await page.keyboard.type('x]1fn');
  await page.keyboard.press('Home');
  await page.keyboard.type('y');
  await expect(field).toHaveValue('yx]1fn');
  await expect(page).toHaveURL(hereIs(made.slug));
  // Escape goes back to the menu, on Rename…, and saves nothing.
  await page.keyboard.press('Escape');
  await expect(field).toBeHidden();
  await expect(item).toBeFocused();
  // Leaving the field cancels too: Tab closes the menu, and nothing is saved.
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue(oldName);
  await page.keyboard.type('Left behind');
  await page.keyboard.press('Tab');
  await expect(page.locator('.ip-rail-menu')).toBeHidden();
  expect((await listedById(api, made.id))?.name).toBe(oldName);
  // An empty name does nothing: the field stays, and so does the name.
  await tab.click({ button: 'right' });
  await item.click();
  await field.fill('   ');
  await page.keyboard.press('Enter');
  await expect(field).toBeFocused();
  expect((await listedById(api, made.id))?.name).toBe(oldName);
  // Enter saves the new name, trimmed: the tab, the window title, the root step and the activity strip show it at once.
  await field.fill(`  ${newName}  `);
  await page.keyboard.press('Enter');
  await expect(field).toBeHidden();
  const renamed = railRow(page, newName);
  await expect(renamed).toHaveAttribute('aria-current', 'page');
  await expect(renamed).toHaveAttribute('title', newName);
  await expect(renamed).toBeFocused();
  await expect(railRow(page, oldName)).toHaveCount(0);
  await expect(page).toHaveTitle(`InProgress · ${newName}`);
  await expect(statusLine(page)).toHaveText(`Renamed to ${newName}.`);
  await expect(page.locator('.ip-page-title')).toContainText(newName);
  await expect(page.locator('.ip-act-who')).toHaveText('you');
  await expect(page.locator('.ip-act-what')).toHaveText('renamed the project');
  // Display only: the slug, so the URL and every link, stays.
  await expect(page).toHaveURL(hereIs(made.slug));
  expect(await listedById(api, made.id)).toMatchObject({ slug: made.slug, name: newName });
  await page.reload();
  await expect(railRow(page, newName)).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(hereIs(made.slug));
  // A window that holds a stale slug for this id is refused, and the name stays.
  const stale = await windowPost(page, `/api/ui/projects/${made.id}/rename`, { slug: `${made.slug}-old`, name: 'Stale rename' });
  expect(stale).toEqual({ status: 409, body: { error: 'This project changed; reload', hint: 'Reload the window: another project has this id now.' } });
  expect((await listedById(api, made.id))?.name).toBe(newName);
});

test('the open archived project can be renamed from its tab, and ⋯ shows the new name', async ({ page, api }) => {
  const keptName = unique('Rename kept');
  const oldName = unique('Rename shelved');
  const newName = unique('Rename shelf');
  await bare(api, keptName);
  const shelved = await bare(api, oldName);
  await archiveByScribe(api, shelved.slug);
  await page.goto(`/#/p/${shelved.slug}`);
  const tab = railRow(page, oldName);
  await expect(tab).toHaveAccessibleName(`${oldName}, archived`);
  await tab.click({ button: 'right' });
  const menu = tabMenu(page, oldName);
  await expect(menu.getByRole('menuitem')).toHaveText(['Unarchive', 'Rename…', 'Delete…']);
  await menu.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  await page.getByRole('textbox', { name: `Rename ${oldName}`, exact: true }).fill(newName);
  await page.keyboard.press('Enter');
  await expect(railRow(page, newName)).toHaveAccessibleName(`${newName}, archived`);
  await expect(page).toHaveTitle(`InProgress · ${newName}`);
  await expect(statusLine(page)).toHaveText(`Renamed to ${newName}.`);
  await moreButton(page).click();
  const archived = moreMenu(page).getByRole('group', { name: 'Archived', exact: true });
  await expect(archived.getByRole('menuitem', { name: newName, exact: true })).toBeVisible();
  await expect(archived.getByRole('menuitem', { name: `Unarchive ${newName}`, exact: true })).toBeVisible();
  await expect(archived.getByRole('menuitem', { name: oldName, exact: true })).toHaveCount(0);
  expect(await listedById(api, shelved.id)).toMatchObject({ slug: shelved.slug, name: newName });
});

test("a scribe's archive of the open project keeps it open as the end tab", async ({ page, api, fresh }) => {
  await open(page, fresh);
  await expect(stepRow(page, 'Play app signing')).toBeVisible();
  await write(api, fresh.session, 'patch', `/api/projects/${fresh.slug}`, { status: 'archived' });
  const tab = railCurrent(page);
  await expect(tab).toHaveAccessibleName(/, archived$/);
  await expect(railRows(page).last()).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(hereIs(fresh.slug));
  await expect(page.locator('.ip-activity')).toContainText('archived the project');
  // Not the window's own action, so no status line.
  await expect(statusLine(page)).toHaveText('');
});

test('the window is dark whatever the OS theme, and the menus and the confirm wear v3', async ({ page, api }) => {
  const keptName = unique('Look kept');
  const shelfName = unique('Look shelf');
  const kept = await bare(api, keptName);
  await archiveByScribe(api, (await bare(api, shelfName)).slug);
  await page.goto(`/#/p/${kept.slug}`);
  await expect(railRow(page, keptName)).toHaveAttribute('aria-current', 'page');
  const seen: string[][] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const colours = await Promise.all(['--canvas-2', '--canvas-1', '--line-strong', '--text', '--text-muted', '--alarm'].map((t) => tokenColour(page, t)));
    seen.push(colours);
    const [canvas2, canvas1, lineStrong, text, muted, alarm] = colours;
    // One palette: v3's canvas and text, and the browser's own controls drawn dark.
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 17, 17)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(242, 242, 242)');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    const surface = async (l: Locator, background: string) => {
      await expect(l).toHaveCSS('background-color', background);
      await expect(l).toHaveCSS('border-top-width', '1px');
      await expect(l).toHaveCSS('border-top-color', lineStrong);
      await expect(l).toHaveCSS('border-radius', '0px');
      await expect(l).toHaveCSS('box-shadow', 'none');
    };
    // A row's menu is the Menu part's surface; Delete… is its danger item.
    await railRow(page, keptName).click({ button: 'right' });
    const menu = tabMenu(page, keptName);
    await surface(menu, canvas2);
    await expect(menu.getByRole('menuitem', { name: 'Archive', exact: true })).toHaveCSS('font-size', '15px');
    await expect(menu.getByRole('menuitem', { name: 'Delete…', exact: true })).toHaveCSS('font-size', '15px');
    await expect(menu.getByRole('menuitem', { name: 'Delete…', exact: true })).toHaveCSS('color', alarm);
    await page.keyboard.press('Escape');
    // The foot menu: heads in micro caps and muted, rows at body size, actions in micro caps.
    await moreButton(page).click();
    const more = moreMenu(page);
    await surface(more, canvas2);
    const head = more.locator('.ip-rail-menu-head').first();
    await expect(head).toHaveCSS('font-size', '10px');
    await expect(head).toHaveCSS('font-weight', '700');
    await expect(head).toHaveCSS('color', muted);
    await expect(more.getByRole('menuitem', { name: shelfName, exact: true })).toHaveCSS('font-size', '15px');
    const ask = more.getByRole('menuitem', { name: `Delete ${shelfName}`, exact: true });
    await expect(ask).toHaveCSS('font-size', '10px');
    // The confirm is the Confirm part, danger: Delete in the alarm colour, never the ink.
    await ask.click();
    const confirm = page.getByRole('group', { name: `Delete ${shelfName}?` });
    await expect(confirm).toHaveCSS('background-color', canvas1);
    await expect(confirm).toHaveCSS('border-top-color', lineStrong);
    await expect(confirm.locator('.p-confirm-q')).toHaveCSS('font-weight', '600');
    await expect(confirm.locator('.p-confirm-q')).toHaveCSS('font-size', '15px');
    const go = confirm.getByRole('button', { name: 'Delete', exact: true });
    await expect(go).toHaveCSS('color', alarm);
    await expect(go).toHaveCSS('border-top-color', alarm);
    expect(text, 'the danger Delete is not the ink').not.toBe(alarm);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(more).toBeHidden();
  }
  expect(seen[1], 'a dark OS theme gives the colours a light one does').toEqual(seen[0]);
});

test("a tab's menu stays inside a narrow window, and a strip scroll closes it", async ({ page, api }) => {
  const names = Array.from({ length: 6 }, (_, i) => unique(`Narrow menu ${i + 1}`));
  const made: { slug: string }[] = [];
  for (const name of names) made.push(await bare(api, name));
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(`/#/p/${made[5].slug}`);
  // The newest project's tab is the last, at the strip's right end.
  const last = railRow(page, names[5]);
  await expect(last).toHaveAttribute('aria-current', 'page');
  await expect(last).toBeInViewport({ ratio: 0.99 });
  await last.click({ button: 'right' });
  const menu = tabMenu(page, names[5]);
  await expect(menu).toBeInViewport({ ratio: 0.99 });
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(420 - 8 + 0.5);
  // Scrolled away from its tab, it would point at nothing: it closes.
  await page.evaluate(`${STRIP}.scrollLeft = 0`);
  await expect(menu).toBeHidden();
});

// Live work: Claude's working tasks and its subagents, seeded the way the hooks send them.

/** Posts a hook event for the session, as Claude Code's hooks would. */
const hook = (api: APIRequestContext, session: string, body: Record<string, unknown>) => write(api, session, 'post', `/api/sessions/${session}/hook`, body);

/** A working task on the session's own list (or a subagent's), created and then moved to its status as the task tools do. */
async function task(api: APIRequestContext, s: Seeded, key: string, subject: string, status: 'pending' | 'in_progress' | 'completed' = 'pending', agentId?: string): Promise<void> {
  const agent = agentId ? { agentId } : {};
  await hook(api, s.session, { event: 'task-created', taskKey: key, subject, ...agent });
  if (status !== 'pending') await hook(api, s.session, { event: 'task-updated', taskKey: key, status, ...agent });
}

/**
 * A subagent dispatched, started and launched, as the Agent tool's hooks report it: a general-purpose worker unless
 * `agentType` says otherwise, with the prompt's first sentence as its `purpose` when one is given.
 */
async function subagent(
  api: APIRequestContext,
  s: Seeded,
  agentId: string,
  description: string,
  model: string,
  { agentType = 'general-purpose', purpose }: { agentType?: string; purpose?: string } = {},
): Promise<void> {
  const toolUseId = `toolu-${agentId}`;
  await hook(api, s.session, { event: 'agent-dispatch', toolUseId, agentType, description, model, ...(purpose ? { purpose } : {}) });
  await hook(api, s.session, { event: 'subagent-start', agentId, agentType });
  await hook(api, s.session, { event: 'agent-launched', toolUseId, agentId, model });
}

test("a tab's dot also shows while an idle session has a running worker, but not for a reader alone", async ({ page, api }) => {
  const name = unique('Dot worker');
  const s = await seed(api, name);
  await open(page, s);
  const tab = railRow(page, name);
  const dot = tab.locator('.p-livedot');
  const counts = async () => {
    const p = ((await (await api.get('/api/projects')).json()) as { slug: string; workingSessions: number; busySessions: number }[]).find((x) => x.slug === s.slug);
    return { workingSessions: p?.workingSessions, busySessions: p?.busySessions };
  };
  await expect(dot).toHaveCount(1);
  // A reader starts, then the session stops: idle, with only a reader running, so no dot.
  await subagent(api, s, 'reader-1', 'Look around the repo', 'haiku', { agentType: 'Explore' });
  await hook(api, s.session, { event: 'stop' });
  await expect(dot).toHaveCount(0);
  await expect(tab).toHaveAccessibleName(`${name}, 1 need you`);
  expect(await counts()).toEqual({ workingSessions: 0, busySessions: 0 });
  // A worker running on while the session is idle lights it, and the tab says so.
  await subagent(api, s, 'worker-1', 'Wire up RevenueCat', 'sonnet');
  await expect(dot).toHaveCount(1);
  await expect(tab).toHaveAccessibleName(`${name}, 1 need you, busy`);
  // Busy only: the dot is still. A working session's pulses.
  await expect(dot).toHaveAttribute('data-still', 'true');
  expect(await counts()).toEqual({ workingSessions: 0, busySessions: 1 });
  // Once the worker stops, the dot goes.
  await hook(api, s.session, { event: 'subagent-stop', agentId: 'worker-1' });
  await expect(dot).toHaveCount(0);
  await expect(tab).toHaveAccessibleName(`${name}, 1 need you`);
});

/** A running subagent's time: under a minute, or whole minutes. */
const RUNNING = '(<1 min|\\d+ min)';

test.describe('Live work', () => {
  test("Details lists the node's working tasks with who is on each, and the subagents on it, before its resources, each on its own row", async ({ page, api, fresh }) => {
    await subagent(api, fresh, 'agent-1', 'Draft the store notes', 'sonnet');
    await task(api, fresh, '1', 'Upload the key', 'in_progress');
    await task(api, fresh, '2', 'Check the release track');
    await hook(api, fresh.session, { event: 'task-updated', taskKey: '1', addBlocks: ['2'] });
    await task(api, fresh, '1', 'Collect the screenshots', 'pending', 'agent-1');
    await write(api, fresh.session, 'post', '/api/resources', { nodeId: fresh.ids['Play app signing'], kind: 'doc', title: 'Signing notes', content: '# Notes' });
    await open(page, fresh);
    const details = await openDetails(page, 'Play app signing');
    // The live work reads before the step's resources: one LIVE WORK head counts the live tasks and subagents, and its
    // sub-heads name the lists.
    await expect(details.locator('h3.p-eyebrow')).toHaveText([/LIVE WORK · 4$/, /RESOURCES · 1$/]);
    await expect(details.locator('.ip-dsub')).toHaveText(['Working tasks', 'Subagents']);
    // Each entry is its own row.
    await expect(details.locator('.ip-dagents > li')).toHaveCount(1);
    await expect(details.locator('.ip-res')).toHaveCount(1);
    // A resource's row deepens to --canvas-3 on hover, its title in body ink.
    await details.locator('.ip-res').hover();
    await expect(details.locator('.ip-res')).toHaveCSS('background-color', 'rgb(30, 30, 30)');
    await expect(details.locator('.ip-res-title')).toHaveCSS('color', 'rgb(242, 242, 242)');
    // Anchored: the next row's "after Upload the key" names it too.
    await expect(details.locator('.ip-wt', { hasText: /^◐ Upload the key/ })).toHaveText('◐ Upload the key · E2E session');
    await expect(details.locator('.ip-wt', { hasText: 'Check the release track' })).toHaveText('○ Check the release track · E2E session · after Upload the key');
    await expect(details.locator('.ip-wt', { hasText: 'Collect the screenshots' })).toHaveText('○ Collect the screenshots · Draft the store notes');
    await expect(details.locator('.ip-dagent')).toHaveText(new RegExp(`^Draft the store notes · sonnet · ${RUNNING}$`));
    // The rows read as the canvas's. ◐ in volt and still.
    const upload = details.locator('.ip-wt', { hasText: /^◐ Upload the key/ });
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('color', 'rgb(192, 254, 4)');
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('animation-name', 'none');
  });

});

test.describe('Go to', () => {
  const field = (page: Page) => page.getByRole('combobox', { name: 'Find: go to a step, a project or a view' });
  const goToButton = (page: Page) => page.getByRole('button', { name: 'Find, go to a step' });
  const options = (page: Page) => page.getByRole('group', { name: 'Steps' }).getByRole('option');

  /** A project of its own with `nodes` under its root. Answers its slug and its top steps' ids by title. */
  async function project(api: APIRequestContext, name: string, nodes: unknown[]): Promise<{ id: number; slug: string; ids: Record<string, number> }> {
    const session = `e2e-${randomUUID()}`;
    const p = await write<{ id: number; slug: string; rootNodeId: number }>(api, session, 'post', '/api/projects', { name });
    const created = await write<{ id: number; title: string }[]>(api, session, 'post', '/api/nodes', { parentId: p.rootNodeId, nodes });
    return { id: p.id, slug: p.slug, ids: Object.fromEntries(created.map((n) => [n.title, n.id])) };
  }

  test('/ and Ctrl+K open it, Escape closes it back to the opener, Tab stays in the bar, and the app keys wait while typing', async ({ page, api, demo }) => {
    // Somewhere else for ] and 1 to go.
    await bare(api, unique('Go to keys'));
    await widen(page);
    await open(page, demo);
    const here = hereIs(demo.slug);
    const tab = railCurrent(page);
    await tab.focus();
    await page.keyboard.press('/');
    await expect(field(page)).toBeFocused();
    await expect(goToButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(goToButton(page)).toHaveAttribute('aria-keyshortcuts', '/ Control+K');
    // ] and 1 would act under the field.
    await page.keyboard.type(']1');
    await expect(field(page)).toHaveValue(']1');
    await expect(page).toHaveURL(here);
    await page.keyboard.press('Escape');
    await expect(field(page)).toBeHidden();
    await expect(tab).toBeFocused();
    // Ctrl+K opens it empty, and Escape still only closes it: Details stays open.
    const details = await openDetails(page, 'Play app signing');
    await tab.focus();
    await page.keyboard.press('Control+k');
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(field(page)).toBeHidden();
    await expect(tab).toBeFocused();
    await expect(details).toBeVisible();
    // The button opens it too, and Escape gives focus back to the button. Tab stays in the bar: it has one focus stop.
    await goToButton(page).click();
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(goToButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(field(page)).toBeHidden();
    // Neither opens it from a text field.
    await page.evaluate(`document.body.append(Object.assign(document.createElement('input'), { id: 'typing' }))`);
    await page.locator('#typing').focus();
    await page.keyboard.press('/');
    await page.keyboard.press('Control+k');
    await expect(page.locator('#typing')).toHaveValue('/');
    await expect(field(page)).toBeHidden();
  });

  test('is a modal bar on the canvas surface, 640 px wide and centred near the top, over a scrim; the Find button sits at the bar\'s right end', async ({ page, demo }) => {
    await widen(page);
    await open(page, demo);
    const button = (await goToButton(page).boundingBox())!;
    const bar = (await page.locator('.ip-hud').boundingBox())!;
    // Inside the HUD's side padding (20 px here).
    expect(bar.x + bar.width - (button.x + button.width), 'at the right end').toBeLessThanOrEqual(20);
    await goToButton(page).click();
    const panel = page.locator('.ip-cmdbar');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS('background-color', await tokenColour(page, '--canvas-1'));
    await expect(panel).toHaveCSS('border-top-width', '1px');
    await expect(panel).toHaveCSS('border-top-color', await tokenColour(page, '--line-strong'));
    await expect(panel).toHaveCSS('border-radius', '0px');
    await expect(panel).toHaveCSS('box-shadow', 'none');
    await expect(field(page)).toHaveCSS('font-size', '16px');
    // The animation ends, then the box is measured: 640 wide, centred, its top near 15 % of the window.
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(640);
    const box = (await panel.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 500), 'centred').toBeLessThanOrEqual(1);
    expect(box.y).toBeGreaterThan(900 * 0.13);
    expect(box.y).toBeLessThan(900 * 0.17);
    // The scrim is the dialog's backdrop, and the window behind it is inert.
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.ip-cmdbar'), '::backdrop').backgroundColor`)).toBe('rgba(0, 0, 0, 0.65)');
    await expect(page.locator('.ip-app')).toHaveJSProperty('inert', false);
    expect(await page.evaluate<boolean>(`document.querySelector('.ip-cmdbar').matches(':modal')`)).toBe(true);
  });

  test("go-to opens the step's Details, in this project and in another", async ({ page, api, fresh }) => {
    const far = await project(api, unique('Go to elsewhere'), [{ title: 'Shipped', status: 'done', children: [{ title: 'Old release notes', status: 'done' }] }, { title: 'Open work' }]);
    // A child, so not in `ids`: the search finds it.
    const found = (await (await api.get(`/api/find?q=${encodeURIComponent('Old release notes')}`)).json()) as { id: number; projectSlug: string }[];
    const notes = found.find((h) => h.projectSlug === far.slug)!.id;
    await widen(page);
    await open(page, fresh);
    await expect(stepRow(page, 'Play app signing')).toBeVisible();
    const details = page.getByRole('complementary');
    await expect(details).toHaveCount(0);
    // A step of the open project: its Details open and the view stays.
    const launch = fresh.ids['7 Launch'];
    await page.keyboard.press('/');
    await page.keyboard.type(`#${launch}`);
    await page.keyboard.press('Enter');
    await expect(field(page)).toBeHidden();
    await showsStep(details, launch, '7 Launch');
    await expect(page).toHaveURL(hereIs(fresh.slug));
    // A step of another project: the project opens, then the step's Details.
    await page.keyboard.press('/');
    await page.keyboard.type(`#${notes}`);
    await expect(page.locator('.ip-cmdbar-note')).toHaveText('1 step');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(hereIs(far.slug));
    await expect(field(page)).toBeHidden();
    await showsStep(details, notes, 'Old release notes');
  });

  test('an unknown or deleted id says there is no such step, and the field stays open', async ({ page, api, demo }) => {
    const gone = await project(api, unique('Go to gone'), [{ title: 'Soon deleted' }, { title: 'Kept' }]);
    const deleted = gone.ids['Soon deleted'];
    await write(api, `e2e-${randomUUID()}`, 'delete', `/api/nodes/${deleted}`);
    await open(page, demo);
    await expect(railCurrent(page)).toBeVisible();
    await page.keyboard.press('/');
    await page.keyboard.type('#99999999');
    await page.keyboard.press('Enter');
    const panel = page.locator('.ip-cmdbar');
    await expect(panel).toContainText('No step #99999999');
    await expect(panel.locator('.ip-cmdbar-note')).toHaveCSS('color', await tokenColour(page, '--alarm'));
    await expect(field(page)).toBeFocused();
    await expect(page).toHaveURL(hereIs(demo.slug));
    // A deleted step says the same; typing on clears the line.
    await field(page).fill(`${deleted}`);
    await page.keyboard.press('Enter');
    await expect(panel).toContainText(`No step #${deleted}`);
    await page.keyboard.type('1');
    await expect(panel).not.toContainText('No step');
    await expect(page).toHaveURL(hereIs(demo.slug));
  });

  test('words list matching steps across projects as they are typed; the arrows move, Enter jumps, and more words narrow the list', async ({ page, api }) => {
    const word = `Quokka${randomUUID().slice(0, 6)}`;
    const homeName = unique('Go to home');
    const awayName = unique('Go to away');
    const homeTitle = `${word} home step`;
    const awayTitle = `Tidy the ${word} away step`;
    // Away's step is the newer, but home is the open project, so its step lists first.
    const home = await project(api, homeName, [{ title: homeTitle, status: 'active' }]);
    const away = await project(api, awayName, [{ title: awayTitle }, { title: 'Unrelated' }]);
    await widen(page);
    await page.goto(`/#/p/${home.slug}`);
    await expect(railRow(page, homeName)).toHaveAttribute('aria-current', 'page');
    await goToButton(page).click();
    await page.keyboard.type(`${word.toLowerCase()} step`);
    await expect(options(page)).toHaveCount(2);
    await expect(options(page).nth(0)).toHaveAccessibleName(`#${home.ids[homeTitle]} ${homeTitle}, ${homeName}`);
    await expect(options(page).nth(1)).toHaveAccessibleName(`#${away.ids[awayTitle]} ${awayTitle}, ${awayName}`);
    await expect(options(page).nth(1).locator('.ip-cmdbar-proj')).toHaveText(awayName);
    await expect(page.locator('.ip-cmdbar-note')).toHaveText('2 steps');
    await expect(options(page).nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(field(page)).toHaveAttribute('aria-activedescendant', (await options(page).nth(1).getAttribute('id'))!);
    await page.keyboard.press('ArrowDown');
    await expect(options(page).nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(hereIs(away.slug));
    await showsStep(page.getByRole('complementary'), away.ids[awayTitle], `${awayTitle}`);
    // More words narrow the list; none matching says so.
    await page.keyboard.press('/');
    await page.keyboard.type(`${word} home`);
    await expect(options(page)).toHaveCount(1);
    await page.keyboard.type(' nowhere');
    await expect(page.locator('.ip-cmdbar')).toContainText('No step titles match');
    await expect(options(page)).toHaveCount(0);
    // Away is the open project now, so its step leads. A click picks too.
    await field(page).fill(word);
    await expect(options(page)).toHaveCount(2);
    await expect(options(page).nth(0)).toContainText(awayTitle);
    await options(page).nth(1).click();
    await expect(page).toHaveURL(hereIs(home.slug));
    await showsStep(page.getByRole('complementary'), home.ids[homeTitle], `${homeTitle}`);
  });

  test('Enter straight after typing picks the first step of the new list, never the row highlighted in the old one', async ({ page, api }) => {
    const word = `Wombat${randomUUID().slice(0, 6)}`;
    const titles = ['alpha one', 'alpha two', 'beta one', 'beta two'].map((t) => `${word} ${t}`);
    const made = await project(api, unique('Go to fast'), titles.map((title) => ({ title })));
    // Touched in order, so each list runs newest first: alpha two, alpha one; beta two, beta one.
    for (const title of titles) await write(api, `e2e-${randomUUID()}`, 'patch', `/api/nodes/${made.ids[title]}`, { outcome: 'touched' });
    await widen(page);
    await page.goto(`/#/p/${made.slug}`);
    await expect(railCurrent(page)).toBeVisible();
    await page.keyboard.press('/');
    await page.keyboard.type(`${word} alpha`);
    await expect(options(page)).toHaveCount(2);
    await page.keyboard.press('ArrowDown');
    await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    // Typing clears the highlight, and Enter before the new answer is in waits for it. The answer is held back, so the
    // old list (its second row highlighted, before the fix) is still on screen when Enter lands.
    await page.route('**/api/find?q=*beta*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await field(page).fill(`${word} beta`);
    await expect(page.locator('.ip-cmdbar-row[aria-selected="true"]')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await showsStep(page.getByRole('complementary'), made.ids[titles[3]], `${titles[3]}`);
  });

  test('a picked step that went since the search is not jumped to: the status line says so and focus waits on the button', async ({ page, api, demo, consoleErrors }) => {
    consoleErrors.allow(/status of 404/);
    const word = `Numbat${randomUUID().slice(0, 6)}`;
    const far = await project(api, unique('Go to vanishing'), [{ title: `${word} step` }]);
    const gone = await project(api, unique('Go to deleted'), [{ title: `${word} lost` }]);
    const step = far.ids[`${word} step`];
    await widen(page);
    await open(page, demo);
    await expect(stepRow(page, 'Play app signing')).toBeVisible();
    // The step is deleted after the list shows it.
    await page.keyboard.press('/');
    await page.keyboard.type(`${word} step`);
    await expect(options(page)).toHaveCount(1);
    await write(api, `e2e-${randomUUID()}`, 'delete', `/api/nodes/${step}`);
    await page.keyboard.press('Enter');
    await expect(statusLine(page)).toContainText(`No step #${step}`);
    await expect(goToButton(page)).toBeFocused();
    await expect(page.getByRole('complementary')).toHaveCount(0);
    // Its whole project is deleted after the list shows it: the project's address answers 404 and the window moves on.
    await page.keyboard.press('Enter');
    await page.keyboard.type(`${word} lost`);
    await expect(options(page)).toHaveCount(1);
    expect((await windowPost(page, `/api/ui/projects/${gone.id}/delete`, { slug: gone.slug })).status).toBe(200);
    await page.keyboard.press('Enter');
    await expect(statusLine(page)).toContainText(`No step #${gone.ids[`${word} lost`]}`);
    await expect(page).not.toHaveURL(hereIs(gone.slug));
    await expect(goToButton(page)).toBeFocused();
  });
});

// The Board (spec 2.2, 2.3, 2.8): header lines, Needs me, Now and Done, at both widths.

const WIDE = { width: 1200, height: 900 };
const NARROW = { width: 800, height: 900 };
/** A page of 1160 or more beside the rail: the Board's four columns (#502). */
const WIDEST = { width: 1600, height: 900 };
/** A page under 720 beside the rail or its tabs: the Board's one column (#502). */
const NARROWEST = { width: 600, height: 900 };
const band = (page: Page, name: 'needs' | 'now' | 'next' | 'done') => page.locator(`section.ip-band-${name}`);
/** The task box with this title in a band: the older skeleton (`li.ip-card`) or, where a column has moved to it, the Tile part's `li` (#502). */
const boxIn = (page: Page, name: 'needs' | 'now' | 'next' | 'done', title: string) => band(page, name).locator('li.ip-card, li:has(> article.ip-tile)', { has: page.getByRole('button', { name: title, exact: true }) });
const nowRow = (page: Page, title: string) => boxIn(page, 'now', title);

/** A background command started for the session, as the PostToolUse hook reports one. */
const startCommand = (api: APIRequestContext, session: string, taskId: string, commandHead: string, extra: Record<string, unknown> = {}) =>
  hook(api, session, { event: 'command-started', taskId, toolUseId: `toolu-${taskId}`, kind: 'shell', commandHead, description: 'Run the e2e suite', ...extra });

/** A stop that lists the session's running background tasks, as the Stop hook reads them. */
const stopWith = (api: APIRequestContext, session: string, running: { taskId: string; commandHead?: string }[]) =>
  hook(api, session, { event: 'stop', background: running.map((r) => ({ type: 'shell', ...r })) });

test.describe('Board', () => {
  test('wide: Needs me, Next, Now and Done run left to right and show an ask, a session with its step, and a done outcome', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['Upload keystore']}`, { outcome: 'The upload key was accepted by Play' });
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    const xs = await Promise.all((['needs', 'next', 'now', 'done'] as const).map(async (b) => (await band(page, b).boundingBox())!.x));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size, 'four columns side by side').toBe(4);
    // No hazard tape on the slab and no meta line on the head.
    await expect(page.locator('.ip-comms .p-tape')).toHaveCount(0);
    await expect(page.locator('.ip-page-meta')).toHaveCount(0);
    const needs = boxIn(page, 'needs', 'Run signing tests');
    await expect(needs).toContainText('Which keystore signs the release?');
    await expect(needs.locator('.p-tile-chips .p-chip').first()).toHaveText('QUESTION');
    await expect(needs.locator('.p-tile-chips .ip-tile-age')).toHaveText(/^(now|\d+m)$/);
    await expect(needs.locator('.ip-sessline')).toHaveText('No session: raised before sessions were tracked');
    await expect(needs.getByRole('button', { name: 'Answer…' })).toBeVisible();
    await expect(needs.getByRole('button', { name: 'Clear' })).toBeVisible();
    const now = nowRow(page, 'Play app signing');
    await expect(now.locator('.p-tile-id')).toHaveText(`#${fresh.ids['Play app signing']}`);
    await expect(now.locator('.ip-sessline-title')).toHaveText('E2E session');
    await expect(now.getByRole('button', { name: 'Open session', exact: true })).toBeVisible();
    await expect(now.locator('.p-tile-chips .p-chip')).toHaveText('WORKING');
    // A Board box carries no character, session letter or breadcrumb.
    await expect(page.locator('.ip-bands .ip-char, .ip-bands .ip-crumb, .ip-bands .ip-num')).toHaveCount(0);
    const done = boxIn(page, 'done', 'Upload keystore');
    await expect(done).toContainText('The upload key was accepted by Play');
    await expect(done.locator('.p-tile-chips .p-chip')).toHaveCount(0);
    expect(await band(page, 'done').locator('li:has(> article.ip-tile)').count()).toBe(5);
    // Done steps with no outcome carry a mark, and the header counts the marked steps and names them.
    await expect(boxIn(page, 'done', '1 iOS certificate').locator('.p-tile-foot .p-chip')).toHaveText('no outcome');
    await expect(page.getByRole('button', { name: /to tidy$/ })).toHaveAttribute('title', new RegExp(`#${fresh.ids['1 iOS certificate']} no_outcome`));
    await expect(page.locator('.ip-comms')).toContainText('No state note yet');
  });

  test('the columns by page width: four at 1600 and at 1160, two by two from 720 to 1159, one at 400', async ({ page, fresh }) => {
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    const board = page.locator('.ip-board');
    await expect(board).toBeVisible();
    const boxes = async () => Promise.all((['needs', 'next', 'now', 'done'] as const).map(async (b) => (await band(page, b).boundingBox())!));
    const pageWidth = async () => (await board.boundingBox())!.width;
    // The page is the viewport less the rail: learn that offset at 1600.
    const offset = 1600 - (await pageWidth());
    // Four columns at 1600: one row, left to right needs, next, now, done.
    let [needs, next, now, done] = await boxes();
    expect(new Set([needs.y, next.y, now.y, done.y]).size, 'one row').toBe(1);
    expect(needs.x).toBeLessThan(next.x);
    expect(next.x).toBeLessThan(now.x);
    expect(now.x).toBeLessThan(done.x);
    // Four at 1160: the page is exactly 1160 wide.
    await page.setViewportSize({ width: 1160 + offset, height: 900 });
    await expect.poll(pageWidth).toBe(1160);
    [needs, next, now, done] = await boxes();
    expect(new Set([needs.y, next.y, now.y, done.y]).size, 'one row at 1160').toBe(1);
    expect(needs.x).toBeLessThan(next.x);
    expect(next.x).toBeLessThan(now.x);
    expect(now.x).toBeLessThan(done.x);
    // Two by two at a page of 720 to 1159: needs and now on top, next and done under them.
    await page.setViewportSize({ width: 900 + offset, height: 900 });
    await expect.poll(async () => (await pageWidth()) >= 720 && (await pageWidth()) < 1160).toBe(true);
    [needs, next, now, done] = await boxes();
    expect(needs.y).toBe(now.y);
    expect(next.y).toBeGreaterThan(needs.y);
    expect(next.y).toBe(done.y);
    expect(needs.x).toBeLessThan(now.x);
    expect(next.x).toBe(needs.x);
    expect(done.x).toBe(now.x);
    // One column at 400: stacked, needs, now, next, done.
    await page.setViewportSize({ width: 400, height: 900 });
    await expect.poll(pageWidth).toBeLessThan(720);
    [needs, next, now, done] = await boxes();
    expect(new Set([needs.x, next.x, now.x, done.x]).size, 'one left edge').toBe(1);
    expect(needs.y).toBeLessThan(now.y);
    expect(now.y).toBeLessThan(next.y);
    expect(next.y).toBeLessThan(done.y);
  });

  test('Board cells share one task box', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    // A step in Next: pulled up from the Backlog preview.
    const next = band(page, 'next');
    const toNext = next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) }).getByRole('button', { name: 'to Next' });
    await toNext.focus();
    await page.keyboard.press('Enter');
    await expect(boxIn(page, 'next', '3 RevenueCat')).toBeVisible();
    // One cell per task: the step pulled up has left the Backlog.
    await expect(next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) })).toHaveCount(0);
    // Next draws the Tile part (#502): the id, a READY chip and the age.
    const pulled = boxIn(page, 'next', '3 RevenueCat');
    await expect(pulled.locator('.p-tile-id')).toHaveText(`#${fresh.ids['3 RevenueCat']}`);
    await expect(pulled.locator('.p-tile-chips .p-chip')).toHaveText('READY');
    await expect(pulled.getByRole('button', { name: '3 RevenueCat', exact: true })).toBeVisible();
    await expect(pulled.locator('.p-tile-chips .ip-tile-age')).toBeVisible();
    const cells = [
      { band: 'now', title: 'Play app signing', state: 'WORKING' },
      { band: 'done', title: 'Upload keystore', state: null },
    ] as const;
    for (const c of cells) {
      const box = boxIn(page, c.band, c.title);
      await expect(box.locator('.p-tile-id'), c.band).toHaveText(`#${fresh.ids[c.title]}`);
      if (c.state) await expect(box.locator('.p-tile-chips .p-chip'), c.band).toHaveText(c.state);
      else await expect(box.locator('.p-tile-chips .p-chip'), c.band).toHaveCount(0);
      await expect(box.getByRole('button', { name: c.title, exact: true }), c.band).toBeVisible();
      await expect(box.locator('.p-tile-chips .ip-tile-age'), c.band).toBeVisible();
    }
    const needs = boxIn(page, 'needs', 'Run signing tests');
    // Needs me draws the Tile part (#502).
    await expect(needs.locator('.p-tile-id')).toHaveText(`#${fresh.ids['Run signing tests']}`);
    await expect(needs.locator('.p-tile-chips .p-chip').first()).toHaveText('QUESTION');
    await expect(needs.locator('.p-tile-chips .ip-tile-age')).toBeVisible();
    await expect(needs.getByRole('button', { name: 'Answer…' })).toBeVisible();
    await expect(needs.getByRole('button', { name: 'Clear' })).toBeVisible();
    // One cell per task: the step with the ask is in Needs me and nowhere else.
    await expect(page.locator('.ip-bands :is(li.ip-card, article.ip-tile)', { has: page.getByRole('button', { name: 'Run signing tests', exact: true }) })).toHaveCount(1);
  });

  test('Backlog preview entries are boxes with no hue', async ({ page, api, fresh }) => {
    // A Blocked step that sits in Backlog holds a hue by the state rule; the fold still shows none.
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['5 Store listing']}`, { status: 'blocked' });
    const snapshot = (await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { nodes: { id: number; hue: number | null }[] };
    expect(snapshot.nodes.find((n) => n.id === fresh.ids['5 Store listing'])?.hue).not.toBeNull();
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    const group = next.getByRole('list', { name: 'Soon' });
    const boxes = next.locator('.ip-backlog .ip-backlog-row');
    await expect(group).toBeVisible();
    await expect.poll(() => boxes.count()).toBeGreaterThan(1);
    // Each entry is its own box, a Board tile with no hue: the id, the title, the age.
    const box = group.locator('.ip-backlog-row', { has: page.getByRole('button', { name: '4 Build to GitHub', exact: true }) });
    await expect(box.locator('.p-tile-id')).toHaveText(new RegExp(`^(\\d+)Rank \\1, #${fresh.ids['4 Build to GitHub']}$`));
    await expect(box.locator('.ip-tile-age')).toBeVisible();
    await expect(box).toHaveClass(/ip-tile.*ip-backlog-row|ip-backlog-row.*ip-tile/);
    await expect(box).not.toHaveAttribute('data-hue', /.*/);
    const blocked = group.locator('.ip-backlog-row', { has: page.getByRole('button', { name: '5 Store listing', exact: true }) });
    await expect(blocked.locator('.p-chip[data-tone="blocked"]')).toHaveText('BLOCKED');
    for (const b of await boxes.all()) expect(await b.getAttribute('style')).toBeNull();
    // A click on the row opens Details; its own buttons do not.
    await box.getByRole('button', { name: 'to Next' }).focus();
    await expect(box.getByRole('button', { name: 'to Next' })).toHaveCSS('opacity', '1');
    await box.click({ position: { x: 4, y: 4 } });
    await expect(page.getByRole('complementary')).toHaveCount(1);
  });

  test('narrow: the bands stack as Needs me, Now, Next, Done, and a Now box has no breadcrumb', async ({ page, fresh }) => {
    await page.setViewportSize(NARROWEST);
    await open(page, fresh);
    await expect(page.locator('.ip-band > .ip-col-head h2')).toHaveText(['Needs me', 'Now', 'Next', 'Done']);
    const tops = await Promise.all((['needs', 'now', 'next', 'done'] as const).map(async (b) => (await band(page, b).boundingBox())!.y));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    await expect(nowRow(page, 'Play app signing')).toBeVisible();
    await expect(page.locator('.ip-crumb')).toHaveCount(0);
    // The Backlog preview sits at the foot of the Next band, under its rows and above Done.
    const preview = band(page, 'next').locator('.ip-backlog-head');
    await expect(preview).toBeVisible();
    const head = (await preview.boundingBox())!;
    const doneTop = (await band(page, 'done').boundingBox())!.y;
    expect(head.y).toBeLessThan(doneTop);
    expect(head.y).toBeGreaterThan((await band(page, 'next').locator('h2').first().boundingBox())!.y);
  });

  test('Details parks a step with a reason and Unpark brings it back to the Backlog', async ({ page, api, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const title = '4 Build to GitHub';
    const preview = band(page, 'next');
    const previewRow = preview.locator('.ip-backlog-row', { has: page.getByRole('button', { name: title, exact: true }) });
    await expect(previewRow).toBeVisible();
    const details = await openDetails(page, title);
    // Cancel puts focus back on Park…
    await details.getByRole('button', { name: 'Park…' }).click();
    await page.keyboard.press('Escape');
    await expect(details.getByRole('button', { name: 'Park…' })).toBeFocused();
    await details.getByRole('button', { name: 'Park…' }).click();
    const form = details.getByRole('dialog', { name: `Park #${fresh.ids[title]} ${title}` });
    await expect(form.getByRole('textbox', { name: 'Why is it set aside?' })).toBeFocused();
    // A reason is required.
    await expect(form.getByRole('button', { name: 'Park', exact: true })).toBeDisabled();
    await form.getByRole('textbox', { name: 'Why is it set aside?' }).fill('Waiting on the store review');
    await form.getByRole('button', { name: 'Park', exact: true }).click();
    // The panel follows: it shows the reason and Unpark, and the step leaves the Backlog preview.
    await expect(details.locator('.ip-dparked')).toContainText('Waiting on the store review');
    await expect(previewRow).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Unpark' })).toBeFocused();
    await details.getByRole('button', { name: 'Unpark' }).click();
    await expect(details.locator('.ip-dparked')).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Park…' })).toBeFocused();
    // Unpark puts it back unranked (Needs Triage), so it is not in Soon's preview; Triage › shows only on an empty Soon.
    await expect(previewRow).toHaveCount(0);
    await expect(preview.getByRole('button', { name: 'Triage' })).toBeHidden();
    // Still in the tree: todo, unranked, no longer parked.
    const snapshot = (await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { nodes: { id: number; status: string; rankBand: string | null; parkedAt: string | null }[] };
    expect(snapshot.nodes.find((n) => n.id === fresh.ids[title])).toMatchObject({ status: 'todo', rankBand: null, parkedAt: null });
    // Unpark goes to the Backlog, not to Next.
    await expect(preview.locator('.ip-next-row', { hasText: title })).toHaveCount(0);
  });

  test('the header shows the state note as the Orchestrator with no Project view button, and lists a working session with no step', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', '/api/resources', { nodeId: fresh.root, kind: 'doc', title: 'State', purpose: 'state', content: '# Where we are\n\nSigning is half done. The tests come next.' });
    const second = `e2e-${randomUUID()}`;
    await write(api, second, 'post', `/api/sessions/${second}/enroll`, { project: fresh.slug, title: 'Second session' });
    await hook(api, second, { event: 'prompt' });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const header = page.locator('.ip-comms');
    await expect(header).toContainText('COMMS // ORCHESTRATOR');
    await expect(header.locator('.ip-comms-age')).toContainText(/LOOKED (JUST NOW|\d+M AGO)/);
    await expect(header).toContainText('Signing is half done.');
    await expect(header).not.toContainText('The tests come next');
    const sessions = header.getByRole('group', { name: 'No claimed step' });
    await expect(sessions).toContainText('Second session');
    await expect(sessions).toContainText('working');
    // The first session is on a Now row, so it is not listed here.
    await expect(sessions.locator('.ip-noclaim-line')).toHaveCount(1);
    await expect(header.getByRole('button', { name: /Project view/ })).toHaveCount(0);
  });

  test('the Now row names its driver and its helper', async ({ page, api, fresh }) => {
    // The fixture session's focus on the step is its claim, so it drives; the session that claims next helps.
    const helper = `e2e-${randomUUID()}`;
    const nodeId = fresh.ids['Play app signing'];
    await write(api, helper, 'post', `/api/sessions/${helper}/enroll`, { project: fresh.slug, title: 'Helper session' });
    await hook(api, helper, { event: 'prompt' });
    await write(api, helper, 'post', `/api/sessions/${helper}/claim`, { nodeId });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    // Each session's line names it and its role on the step, the driver's first.
    const lines = nowRow(page, 'Play app signing').locator('.ip-sessline');
    await expect(lines).toHaveCount(2);
    await expect(lines.first().locator('.ip-sessline-title')).toHaveText('E2E session');
    await expect(lines.first().locator('.ip-sessline-word')).toHaveText('drives');
    await expect(lines.nth(1).locator('.ip-sessline-title')).toHaveText('Helper session');
    await expect(lines.nth(1).locator('.ip-sessline-word')).toHaveText('helping');
  });

  test('no session letter, character or session hue shows anywhere in the window', async ({ page, api, fresh }) => {
    const second = `e2e-${randomUUID()}`;
    await write(api, second, 'post', `/api/sessions/${second}/enroll`, { project: fresh.slug, title: 'Docs pass' });
    await hook(api, second, { event: 'prompt' });
    await write(api, second, 'post', `/api/projects/${fresh.slug}/queue`, { nodes: [fresh.ids['3 RevenueCat']], session: second });
    const retired = '.ip-char, .ip-tag, .ip-letter, .ip-work-tag, .ip-agent-tag';
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    await expect(page.locator(retired)).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'No claimed step' })).toContainText('Docs pass');
    await viewButton(page, 'Project').click();
    await expect(page.getByRole('region', { name: 'Sections' })).toBeVisible();
    const row = page.locator('.ip-orow', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) });
    const mark = row.getByRole('img', { name: 'next, in the own queue of "Docs pass"' });
    await expect(mark).toHaveText('◆');
    await expect(row.locator('.ip-osess')).toContainText('Docs pass');
    await expect(page.locator(retired)).toHaveCount(0);
  });

  test('a permission wait is a volt ask tile with the command and a way to open the session, and the step leaves Now while it waits', async ({ page, api, fresh }) => {
    await startCommand(api, fresh.session, 'b1', 'npm run build');
    await hook(api, fresh.session, { event: 'permission' });
    await open(page, fresh);
    const wait = boxIn(page, 'needs', 'Play app signing');
    await expect(wait.locator('.p-tile-chips .p-chip')).toHaveText('PERMISSION');
    await expect(wait.locator('.ip-ask-panel')).toContainText('Allow a shell command');
    await expect(wait.locator('.ip-ask-panel .ip-term')).toHaveText('npm run build');
    await expect(wait.getByRole('button', { name: 'Open session to allow' })).toBeVisible();
    await expect(wait.locator('.ip-sessline-title')).toHaveText('E2E session');
    // An ask tile (v3): its edge is the volt-soft line, not the old amber.
    await expect(wait.locator('article')).toHaveAttribute('data-tone', 'ask');
    const voltSoft = await page.evaluate(`(() => {
      const probe = document.createElement('div');
      probe.style.borderTop = '1px solid var(--volt-soft)';
      document.body.append(probe);
      const colour = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return colour;
    })()`) as string;
    await expect(wait.locator('article')).toHaveCSS('border-top-color', voltSoft);
    // A permission wait has no buttons of its own to clear it; the step shows in Needs me only.
    await expect(wait.getByRole('button', { name: /Answer|Clear/ })).toHaveCount(0);
    await expect(nowRow(page, 'Play app signing')).toHaveCount(0);
    // Going on ends the wait.
    await hook(api, fresh.session, { event: 'prompt' });
    await expect(wait).toHaveCount(0);
    await expect(nowRow(page, 'Play app signing').locator('.p-tile-chips .p-chip')).toHaveText('WORKING');
  });

  test('a permission wait with no running command reads Waiting for permission', async ({ page, api, fresh }) => {
    await hook(api, fresh.session, { event: 'permission' });
    await open(page, fresh);
    const wait = boxIn(page, 'needs', 'Play app signing');
    await expect(wait.locator('.ip-ask-panel')).toContainText('Waiting for permission');
    await expect(wait.locator('.ip-ask-panel .ip-term')).toHaveCount(0);
  });

  test('Open session shows the command to copy when the server cannot open it, and Copy puts it on the clipboard', async ({ page, fresh }) => {
    await page.route('**/api/ui/sessions/*/open-desktop', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, command: `claude --resume ${fresh.session}` }) }));
    await open(page, fresh);
    const box = nowRow(page, 'Play app signing');
    await box.getByRole('button', { name: 'Open session', exact: true }).click();
    await expect(box.locator('.ip-sess-cmd .ip-code')).toHaveText(`claude --resume ${fresh.session}`);
    // Opening the session did not open Details.
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await box.getByRole('button', { name: 'Copy' }).click();
    await expect(box.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`claude --resume ${fresh.session}`);
  });

  test('Open session: a refused request shows the command and why, a later success clears it, and a double click sends one request', async ({ page, fresh, consoleErrors }) => {
    consoleErrors.allow(/status of 500/);
    let calls = 0;
    let refuse = true;
    await page.route('**/api/ui/sessions/*/open-desktop', async (route) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (refuse) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Launcher unavailable' }) });
      else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await open(page, fresh);
    const box = nowRow(page, 'Play app signing');
    await box.getByRole('button', { name: 'Open session', exact: true }).dblclick();
    await expect(box.locator('.ip-sess-cmd .ip-code')).toHaveText(`claude --resume ${fresh.session}`);
    await expect(box.locator('.ip-sys')).toHaveText("Launcher unavailable. Run it in the session's folder.");
    expect(calls).toBe(1);
    await expect(page.getByRole('complementary')).toHaveCount(0);
    refuse = false;
    await box.getByRole('button', { name: 'Open session', exact: true }).click();
    await expect(box.getByRole('button', { name: 'Opening…' })).toHaveAttribute('aria-busy', 'true');
    await expect(box.locator('.ip-sess-cmd')).toHaveCount(0);
    expect(calls).toBe(2);
  });

  test('Open session: the server reason shows with its command, a null answer is a failure, and a 401 reloads the window', async ({ page, fresh, consoleErrors }) => {
    consoleErrors.allow(/status of 401/);
    let mode: 'reason' | 'null' | 'stale' = 'reason';
    await page.route('**/api/ui/sessions/*/open-desktop', async (route) => {
      if (mode === 'reason') await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, command: `claude --resume ${fresh.session}`, reason: 'Claude Code was not found on this computer' }) });
      else if (mode === 'null') await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      else await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });
    await open(page, fresh);
    const box = nowRow(page, 'Play app signing');
    await box.getByRole('button', { name: 'Open session', exact: true }).click();
    await expect(box.locator('.ip-sys')).toHaveText('Claude Code was not found on this computer');
    mode = 'null';
    await box.getByRole('button', { name: 'Open session', exact: true }).click();
    await expect(box.locator('.ip-sys')).toContainText("Run it in the session's folder.");
    await expect(box.locator('.ip-sess-cmd .ip-code')).toHaveText(`claude --resume ${fresh.session}`);
    mode = 'stale';
    const reloaded = page.waitForEvent('load');
    await box.getByRole('button', { name: 'Open session', exact: true }).click();
    await reloaded;
  });

  test('Clear on a box with two asks moves focus to the remaining ask', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Run signing tests']}/asks`, { kind: 'question', text: 'And which store account?' });
    await open(page, fresh);
    const box = boxIn(page, 'needs', 'Run signing tests');
    await expect(box.locator('[data-ask]')).toHaveCount(2);
    await box.locator('[data-ask]').first().getByRole('button', { name: 'Clear' }).click();
    await expect(box.locator('[data-ask]')).toHaveCount(1);
    await expect(box.locator('[data-ask]').getByRole('button', { name: 'Answer…' })).toBeFocused();
  });

  test('Clear in Details with two asks moves focus to the other ask, not to the page', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Run signing tests']}/asks`, { kind: 'question', text: 'And which store account?' });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const details = await openDetails(page, 'Run signing tests');
    const asks = details.locator('.ip-dask:not(.cleared)');
    await expect(asks).toHaveCount(2);
    await asks.first().getByRole('button', { name: 'Clear' }).click();
    await expect(asks).toHaveCount(1);
    await expect(asks.getByRole('button', { name: 'Answer…' })).toBeFocused();
  });

  test('a box with two waiting sessions shows a permission block for each, and Open session shares one launch per session', async ({ page, api, fresh }) => {
    const second = `e2e-${randomUUID()}`;
    await write(api, second, 'post', `/api/sessions/${second}/enroll`, { project: fresh.slug, title: 'Second session' });
    await write(api, second, 'post', `/api/sessions/${second}/focus`, { nodeId: fresh.ids['Play app signing'] });
    await hook(api, fresh.session, { event: 'permission' });
    await hook(api, second, { event: 'permission' });
    await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Play app signing']}/asks`, { kind: 'question', text: 'Same session, one launch?' });
    await write(api, second, 'post', `/api/nodes/${fresh.ids['Play app signing']}/asks`, { kind: 'question', text: 'Other session, own launch?' });
    const calls: string[] = [];
    // The launch is held until the test lets it go, so "while it runs" does not depend on timing.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/ui/sessions/*/open-desktop', async (route) => {
      calls.push(route.request().url());
      await held;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await open(page, fresh);
    const box = boxIn(page, 'needs', 'Play app signing');
    await expect(box.locator('.ip-ask-panel').filter({ hasText: 'Waiting for permission' })).toHaveCount(2);
    await expect(box.getByRole('button', { name: 'Open session to allow' })).toHaveCount(2);
    // A session shows in its line and its permission block, and again over an ask of its own when another session's block comes between: one launch, so every button of it reads Opening… and one request goes.
    await box.getByRole('button', { name: 'Open session to allow' }).first().click();
    await expect.poll(() => box.getByRole('button', { name: 'Opening…' }).count()).toBeGreaterThanOrEqual(2);
    // The other session's own button stays idle while the first launches: one read, with the launch still held.
    const other = box.locator('.ip-ask-panel').filter({ hasText: 'Waiting for permission' }).nth(1).getByRole('button', { name: /^Open session to allow$|^Opening…$/ });
    // The button's trailing glyph is part of its text (#502).
    expect(await other.textContent()).toBe('Open session to allow↗');
    // A busy Button part is aria-disabled, which Playwright will not click without force; the click must still do nothing.
    await box.getByRole('button', { name: 'Opening…' }).last().click({ force: true });
    release();
    await expect(box.getByRole('button', { name: 'Opening…' })).toHaveCount(0);
    expect(calls).toHaveLength(1);
    // The other session launches on its own.
    await other.click();
    await expect.poll(() => calls.length).toBe(2);
  });

  test('Answer… opens a field that takes focus, Escape returns to the button, and Enter clears the ask with the answer', async ({ page, api, fresh }) => {
    await open(page, fresh);
    const row = boxIn(page, 'needs', 'Run signing tests');
    const answer = row.getByRole('button', { name: 'Answer…' });
    await answer.click();
    const field = row.getByRole('textbox');
    await expect(field).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(answer).toBeFocused();
    await answer.click();
    await field.fill('Use the upload key');
    await page.keyboard.press('Enter');
    await expect(band(page, 'needs')).toContainText('Nothing needs you');
    await expect(row).toHaveCount(0);
    // The ask is cleared with the answer, by the window.
    const snapshot = (await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { asks: { id: number; answer: string; clearedBy: string | null }[] };
    expect(snapshot.asks.find((a) => a.id === fresh.ask)).toMatchObject({ answer: 'Use the upload key', clearedBy: 'window' });
  });

  test('Clear removes an ask with no answer, and an ask raised with no session names no session and shows its kind', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Play app signing']}/asks`, { kind: 'review', text: 'Is the keystore setup right?' });
    await open(page, fresh);
    const row = boxIn(page, 'needs', 'Play app signing');
    await expect(row.locator('.p-tile-chips .p-chip')).toHaveText('REVIEW');
    await expect(row.locator('.ip-sessline')).toHaveText('No session: raised before sessions were tracked');
    await expect(row).toContainText('Is the keystore setup right?');
    await row.getByRole('button', { name: 'Clear' }).click();
    await expect(row).toHaveCount(0);
    const snapshot = (await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { asks: { text: string; answer: string; clearedAt: string | null }[] };
    expect(snapshot.asks.find((a) => a.text === 'Is the keystore setup right?')).toMatchObject({ answer: '' });
    expect(snapshot.asks.find((a) => a.text === 'Is the keystore setup right?')?.clearedAt).not.toBeNull();
    // Clearing did not open Details.
    await expect(page.getByRole('complementary')).toHaveCount(0);
  });

  test('a click on a row opens its Details, and the row buttons do not', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const details = page.getByRole('complementary');
    await nowRow(page, 'Play app signing').locator('.p-tile-id').click();
    await showsStep(details, fresh.ids['Play app signing'], 'Play app signing');
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await boxIn(page, 'done', 'Upload keystore').locator('.p-tile-id').click();
    await showsStep(details, fresh.ids['Upload keystore'], 'Upload keystore');
    await page.keyboard.press('Escape');
    await boxIn(page, 'needs', 'Run signing tests').getByRole('button', { name: 'Run signing tests', exact: true }).click();
    await showsStep(details, fresh.ids['Run signing tests'], 'Run signing tests');
    await page.keyboard.press('Escape');
    // Answer… is the row's own button: it opens its field, not Details.
    await band(page, 'needs').getByRole('button', { name: 'Answer…' }).click();
    await expect(details).toHaveCount(0);
  });

  test('"New since you looked" crosses Done at the last look, and narrow folds what is older into one line', async ({ page, api, fresh }) => {
    const project = (await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { project: { id: number } };
    const done = (title: string) => write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, nodes: [{ title, status: 'done' }] });
    await done('Older step');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const look = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await done('Newer step');
    await page.addInitScript(`localStorage.setItem('ip.look.${project.project.id}', '${look}')`);
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    const rows = band(page, 'done').locator('ol.ip-list > li');
    await expect(rows.nth(0)).toContainText('Newer step');
    await expect(rows.nth(1)).toHaveAttribute('role', 'separator');
    await expect(rows.nth(1)).toHaveText(/^SINCE YOU LOOKED · \d\d:\d\d$/);
    await expect(rows.nth(2)).toContainText('Older step');
    await page.setViewportSize(NARROWEST);
    await expect(band(page, 'done').getByRole('button', { name: 'Newer step', exact: true })).toBeVisible();
    await expect(band(page, 'done').getByRole('button', { name: 'Older step', exact: true })).toHaveCount(0);
    await expect(band(page, 'done').locator('.ip-done-fold')).toHaveText('✓ 4 earlier');
  });

  test('All done opens the full list by time or by phase, a row opens Details, and Board in the rail returns to the Done column', async ({ page, api, fresh }) => {
    const titles = Array.from({ length: 7 }, (_, i) => `Listed step ${i + 1}`);
    await write(api, fresh.session, 'post', '/api/nodes', {
      parentId: fresh.root,
      nodes: [{ title: 'Release prep', children: titles.map((title) => ({ title, status: 'done' as const })) }],
    });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    await expect(band(page, 'done').locator('li:has(> article.ip-tile)')).toHaveCount(5);
    await band(page, 'done').getByRole('button', { name: /^All done · [0-9]+$/ }).click();
    await expect(viewButton(page, 'All done')).toBeFocused();
    await expect(page.locator('.ip-board')).toHaveCount(0);
    for (const title of titles) await expect(page.locator('.ip-donelist .ip-done-title', { hasText: new RegExp(`^${title}$`) })).toBeVisible();
    // Every row shows its step's #id beside the title, in both orders (#447).
    const ids = page.locator('.ip-done-row').filter({ hasText: 'Listed step' });
    const idsShown = async () => {
      await expect(ids).toHaveCount(titles.length);
      for (const row of await ids.all()) await expect(row.locator('.ip-done-id')).toHaveText(`#${await row.getAttribute('data-node')}`);
    };
    await idsShown();
    await expect(page.getByRole('heading', { name: /^TODAY · \d+$/ })).toBeVisible();
    await page.getByRole('group', { name: 'Order' }).getByRole('button', { name: 'Phase', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^#\d+ Release prep$|Release prep$/ })).toBeVisible();
    await idsShown();
    await page.locator('.ip-done-row', { hasText: 'Listed step 3' }).click();
    const details = page.getByRole('complementary');
    await expect(details).toContainText('Listed step 3');
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await viewButton(page, 'Board').click();
    await expect(band(page, 'done')).toBeVisible();
    // A reload lands on the Board, and the list opens again in the order picked last.
    await page.reload();
    await band(page, 'done').getByRole('button', { name: /^All done · [0-9]+$/ }).click();
    await expect(page.getByRole('group', { name: 'Order' }).getByRole('button', { name: 'Phase', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('leaving the window stamps the last look under ip.look.<id>', async ({ page, api, fresh }) => {
    await open(page, fresh);
    const id = ((await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { project: { id: number } }).project.id;
    await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
    expect(await page.evaluate<string | null>(`localStorage.getItem('ip.look.${id}')`)).toBeNull();
    await page.evaluate(`window.dispatchEvent(new Event('blur'))`);
    const stamped = await page.evaluate<string | null>(`localStorage.getItem('ip.look.${id}')`);
    expect(Date.now() - Date.parse(stamped!)).toBeLessThan(10_000);
  });

  test('a running subagent is a count on its session with its description and time; readers and stopped ones are not counted, and a stopped session with a worker reads Idle', async ({ page, api, fresh }) => {
    await subagent(api, fresh, 'agent-1', 'Wire up RevenueCat', 'sonnet');
    await subagent(api, fresh, 'agent-2', 'Check the paywall', 'haiku');
    await hook(api, fresh.session, { event: 'subagent-stop', agentId: 'agent-2' });
    await subagent(api, fresh, 'reader-1', 'Map the signing config', 'haiku', { agentType: 'Explore' });
    await open(page, fresh);
    const box = nowRow(page, 'Play app signing');
    const kin = box.locator('.ip-kin-count');
    await expect(kin).toHaveText('1 subagent');
    await expect(kin).toHaveAttribute('title', /^Wire up RevenueCat · (<1m|\d+m)$/);
    await expect(box.locator('.p-tile-chips .p-chip')).toHaveText('WORKING');
    // The session stops with its workers still running: the box reads Idle and still counts the worker.
    await hook(api, fresh.session, { event: 'stop' });
    await expect(box.locator('.p-tile-chips .p-chip')).toHaveText('IDLE');
    await expect(kin).toHaveText('1 subagent');
  });

  test('a session busy on a command shows a commands line, which ends with a check and then a bang when the Stop drops it', async ({ page, api, fresh }) => {
    await startCommand(api, fresh.session, 'b1', 'npm run test:e2e');
    await stopWith(api, fresh.session, [{ taskId: 'b1', commandHead: 'npm run test:e2e' }]);
    await open(page, fresh);
    const session = nowRow(page, 'Play app signing');
    const line = session.locator('.ip-cmd');
    await expect(session.locator('.p-tile-chips .p-chip')).toHaveText('IDLE');
    await expect(line).toHaveText(/^▸ npm run test:e2e · <1m$/);
    await expect(line).toHaveAttribute('title', /^npm run test:e2e · Run the e2e suite · <1m$/);
    await expect(line).toHaveRole('group');
    await hook(api, fresh.session, { event: 'prompt', notice: true, tasks: [{ taskId: 'b1', status: 'completed', exitCode: 0 }] });
    await stopWith(api, fresh.session, []);
    await expect(line).toHaveText(/^✓ npm run test:e2e$/);
    await expect(line).toHaveAttribute('title', /completed \(exit 0\)/);
    // A command the next Stop no longer lists greys with a bang.
    await startCommand(api, fresh.session, 'b4', 'npm run lint', { durationMs: 60_000 });
    await stopWith(api, fresh.session, [{ taskId: 'b4', commandHead: 'npm run lint' }]);
    await expect(line).toHaveText(/^▸ npm run lint · (<1m|1m)$/);
    await hook(api, fresh.session, { event: 'prompt' });
    await stopWith(api, fresh.session, []);
    await expect(line).toHaveText(/^! npm run lint( \+1)?$/);
    await expect(session.locator('.p-tile-chips .p-chip')).toHaveText('IDLE');
  });

  test('a command line wears no tag, and a server command reads serving', async ({ page, api, fresh }) => {
    await subagent(api, fresh, 'agent-1', `#${fresh.ids['Play app signing']} Build the app`, 'sonnet');
    await startCommand(api, fresh.session, 'b7', 'npm run build', { agentId: 'agent-1', description: 'Build the app' });
    await open(page, fresh);
    const line = nowRow(page, 'Play app signing').locator('.ip-cmd');
    await expect(line).toHaveText(/^▸ npm run build · <1m$/);
    const served = await seed(api, unique('Serving'));
    await startCommand(api, served.session, 'b9', 'npm run dev', { description: 'Dev server', durationMs: 3 * 3_600_000 });
    await stopWith(api, served.session, [{ taskId: 'b9', commandHead: 'npm run dev' }]);
    await open(page, served);
    const serving = nowRow(page, 'Play app signing').locator('.ip-cmd');
    await expect(serving).toHaveText(/^◦ npm run dev · serving (3h|2h59m)$/);
    await expect(serving).toHaveClass(/\bserving\b/);
  });

  test('a Now step with no session reads Unattended, No session is on it, and YOU', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, nodes: [{ title: 'Mine to finish', status: 'active', assignee: 'me' }] });
    await open(page, fresh);
    const row = nowRow(page, 'Mine to finish');
    await expect(row.locator('.p-tile-chips .p-chip').first()).toHaveText('UNATTENDED');
    await expect(row.locator('.p-tile-body')).toContainText('No session is on it');
    await expect(row.locator('.p-tile-chips .p-chip[data-tone="needs"]')).toHaveText('YOU');
    await expect(row.locator('.p-tile-chips .p-chip[data-tone="needs"]')).toHaveCSS('background-color', 'rgb(192, 254, 4)');
  });

  test('a label is a glyph and its word in muted ink on the row, and Details names it in its meta line; its log entries wear Quiet', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['Play app signing']}`, { label: 'ui' });
    await open(page, fresh);
    const row = nowRow(page, 'Play app signing');
    const chip = row.locator('.p-tile-foot .p-chip[data-tone="label"]');
    await expect(chip).toHaveText(/^⧉\s?ui$/);
    await expect(chip).toHaveAttribute('title', 'ui');
    await expect(chip).toHaveCSS('color', 'rgb(143, 143, 143)');
    await expect(chip).toHaveCSS('font-variant-emoji', 'text');
    await row.getByRole('button', { name: 'Play app signing', exact: true }).click();
    // The meta row: the marker, the status chip, the label chip (glyph and word), then who it is for.
    const meta = page.getByRole('complementary').locator('.ip-meta');
    await expect(meta.locator('.ip-meta-label')).toHaveText(/⧉\s*ui/);
    await expect(meta).toHaveText(/^active\s*⧉\s*ui\s*Claude/);
    await expect(meta.locator('.p-chip[data-tone="label"]')).toHaveCount(1);
    await expect(meta.locator('.p-chip[data-tone="live"]')).toHaveText('active');
    await expect(meta.locator('.ip-marker.m-active')).toHaveCount(1);
    // The log: the time in Martian Mono, the text in ink, the session muted. The entry arrives live.
    await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Play app signing']}/log`, { text: 'Uploaded the key', sessionId: fresh.session });
    const entry = page.getByRole('complementary').locator('.ip-log li');
    await expect(entry).toHaveText('just now Uploaded the key · E2E session');
    await expect(entry.locator('.ip-log-time')).toHaveCSS('font-family', /Martian Mono/);
    await expect(entry.locator('.ip-log-text')).toHaveCSS('color', 'rgb(242, 242, 242)');
    await expect(entry.locator('.ip-log-session')).toHaveCSS('color', 'rgb(143, 143, 143)');
    await expect(entry.locator('i')).toHaveCount(0);
  });

  test('a row opens Details, which copies a reference, wears v3, and lists its steps with their markers and YOU tag', async ({ page, demo }) => {
    await open(page, demo);
    const id = demo.ids['Run signing tests'];
    const details = await openDetails(page, 'Run signing tests');
    await showsStep(details, id, 'Run signing tests');
    await details.getByRole('button', { name: `Copy #${id}` }).click();
    // The clipboard write has finished once the button says so.
    await expect(details.getByRole('button', { name: 'Copied' })).toBeVisible();
    // String form: the root tsconfig has no DOM lib, so `navigator` must not appear in test code.
    expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`#${id} Run signing tests`);
    // v3: an opaque square panel on --canvas-1, the title in the body face at 600 in white, 26 px ghost buttons.
    await expect(details).toHaveCSS('background-color', 'rgb(17, 17, 17)');
    await expect(details).toHaveCSS('border-top-left-radius', '0px');
    await expect(details.locator('.ip-dtop .p-eyebrow')).toHaveText(`#${id} · TASK`);
    const title = details.locator('h2.ip-dtitle');
    // --t-h3: 1.0625rem under 720 px, which is this suite's 520 px window.
    await expect(title).toHaveCSS('font-size', '17px');
    await expect(title).toHaveCSS('font-weight', '600');
    await expect(title).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(title).toHaveCSS('font-family', /Archivo/);
    await expect(details.getByRole('button', { name: 'Close' })).toHaveCSS('min-height', '26px');
    // Its steps draw the marker: a check when done, a still volt square when active, the needs-you mark and YOU.
    await details.getByRole('button', { name: /2 Android signing/ }).click();
    await showsStep(details, demo.ids['2 Android signing'], '2 Android signing');
    const steps = details.locator('.ip-kids li');
    await expect(steps).toHaveText([/Upload keystore$/, /Play app signing$/, /Run signing tests\s*YOU$/]);
    // The stylesheet draws the check, so the marker holds no text and the step's name starts with its #id.
    await expect(steps.nth(0).locator('.ip-marker.m-done')).toHaveText('');
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.ip-kids .ip-marker.m-done'), '::before').content`)).toMatch(/^"✓"/);
    await expect(steps.nth(0).getByRole('button')).toHaveAccessibleName(`#${demo.ids['Upload keystore']} Upload keystore`);
    const active = steps.nth(1).locator('.ip-marker.m-active');
    await expect(active).toHaveCSS('background-color', 'rgb(192, 254, 4)');
    await expect(active).toHaveCSS('animation-name', 'none');
    await expect(steps.nth(2).locator('.ip-marker.m-you')).toHaveCount(1);
    // Its YOU is the needs Chip: black on volt, at 600.
    const you = steps.nth(2).locator('.p-chip[data-tone="needs"]');
    await expect(you).toHaveText('YOU');
    await expect(you).toHaveCSS('color', 'rgb(0, 0, 0)');
    await expect(you).toHaveCSS('background-color', 'rgb(192, 254, 4)');
    await expect(you).toHaveCSS('font-weight', '600');
  });

  test("the Backlog preview shows Soon's first five in rank order and + Add creates at the bottom of Soon", async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    const soon = next.getByRole('list', { name: 'Soon' });
    const titles = soon.locator('.ip-backlog-row .ip-row-title');
    const head = next.locator('.ip-backlog-name');
    // Rank 7 Launch to the top of Soon: the preview follows, numbered as the Backlog's Ranked view numbers it.
    await expect(head).toContainText('Soon · 5');
    await windowPost(page, `/api/ui/projects/${fresh.id}/rank`, { slug: fresh.slug, op: { node: fresh.ids['7 Launch'], to: 'soon', before: fresh.ids['3 RevenueCat'] } });
    await expect(titles).toHaveText(['7 Launch', '3 RevenueCat', '4 Build to GitHub', '5 Store listing', '6 Beta']);
    await expect(soon.locator('.ip-tile-num [aria-hidden]')).toHaveText(['1', '2', '3', '4', '5']);
    // A screen reader hears the rank as words of its own.
    await expect(soon.locator('.ip-tile-num-sr').first()).toHaveText('Rank 1, ');
    await expect(head).toContainText('Soon · 5');
    await expect(next.locator('.ip-backlog-more')).toHaveCount(0);
    // + Add creates at the bottom of Soon and keeps its field open.
    const field = next.getByRole('textbox', { name: 'Add a step to Soon' });
    await expect(field).toHaveCount(0);
    await next.getByRole('button', { name: '+ Add' }).click();
    await expect(field).toBeFocused();
    await page.keyboard.type('Quick soon step');
    await page.keyboard.press('Enter');
    await expect(head).toContainText('Soon · 6');
    await expect(next.locator('.ip-backlog-more')).toContainText('1 more in Soon');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(next.getByRole('button', { name: '+ Add' })).toBeFocused();
    // Sending 3 RevenueCat to Next lets the new step into the five.
    await soon.locator('.ip-backlog-row', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) }).getByRole('button', { name: 'to Next' }).click();
    await expect(titles).toHaveText(['7 Launch', '4 Build to GitHub', '5 Store listing', '6 Beta', 'Quick soon step']);
    await expect(soon.locator('.ip-tile-num [aria-hidden]')).toHaveText(['2', '3', '4', '5', '6']);
    await expect(head).toContainText('Soon · 5');
    const opened = page.waitForRequest((r) => r.url().endsWith('/api/ui/events') && (r.postDataJSON() as { name: string }).name === 'backlog_open');
    await openFullBacklog(page);
    await opened;
  });

  test('an empty Soon says so and Triage › opens the Backlog on Needs Triage', async ({ page, api, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    for (const title of ['3 RevenueCat', '4 Build to GitHub', '5 Store listing', '6 Beta', '7 Launch', 'Milestones']) {
      await rank(api, fresh, { node: fresh.ids[title], to: 'someday', before: null });
    }
    await expect(next.getByText('Nothing in Soon')).toBeVisible();
    await expect(next.getByRole('button', { name: 'Triage' })).toHaveCount(0);
    // An unranked step appears: Triage › offers itself.
    await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, nodes: [{ title: 'Unranked one' }] });
    const triage = next.getByRole('button', { name: 'Triage' });
    await expect(triage).toBeVisible();
    await triage.click();
    const view = page.locator('.ip-backlogview');
    await expect(view.getByRole('group', { name: 'Backlog view' }).getByRole('button', { name: /^Needs Triage/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(view.getByText('Unranked one', { exact: true })).toBeVisible();
  });

  test('a step parked from the full Backlog view returns to Next with to Next', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const view = await openBacklogView(page, 'By Phase');
    const meta = view.locator('.ip-page-meta');
    const total = Number((await meta.textContent())!.match(/^(\d+) OPEN/)![1]);
    const rowOf = (t: string) => blRow(page, view, t);
    // Park… opens a form in the row: the reason is required, where is optional.
    await (await openInspector(rowOf('4 Build to GitHub'))).getByRole('button', { name: 'Park…' }).click();
    const form = page.getByRole('dialog', { name: `Park #${fresh.ids['4 Build to GitHub']} 4 Build to GitHub` });
    await expect(form.getByRole('textbox', { name: 'Why is it set aside?' })).toBeFocused();
    await expect(form.getByRole('button', { name: 'Park', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    await expect(rowOf('4 Build to GitHub')).toBeVisible();
    await (await openInspector(rowOf('4 Build to GitHub'))).getByRole('button', { name: 'Park…' }).click();
    await form.getByRole('textbox', { name: 'Why is it set aside?' }).fill('Not merging this quarter');
    await form.getByRole('textbox', { name: 'Where does the work live?' }).fill('feat/build-to-github');
    await page.keyboard.press('Enter');
    // It leaves the list, the head counts one fewer open, and the Parked group holds it with its reason and where.
    await expect(rowOf('4 Build to GitHub')).toHaveCount(0);
    await expect(meta).toHaveText(`${total - 1} OPEN · 1 PARKED`);
    await pickView(view, 'Parked');
    const parked = view.getByRole('region', { name: 'Parked' });
    await expect(parked.locator('.p-eyebrow').first()).toHaveText('PARKED · 1');
    const parkedRow = pRow(page, parked, '4 Build to GitHub');
    await expect(parkedRow.locator('.ip-bl-why')).toHaveText(/^Parked .+: Not merging this quarter$/);
    await expect(parkedRow.locator('.ip-bl-where')).toHaveText('where feat/build-to-github');
    // The reason is not one of the row's controls: a click on it opens the inspector, and Open Details › opens Details.
    await parkedRow.locator('.ip-bl-why').click();
    await parkedRow.getByRole('button', { name: 'Open Details ›' }).click();
    await expect(page.getByRole('complementary')).toHaveCount(1);
    // Details took focus, so Escape closes Details and leaves the inspector open; Escape on the row would close the inspector instead.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(parkedRow.getByRole('group', { name: /^Inspector for #/ })).toBeVisible();
    // "to Next" unparks it into Next in one write.
    await parkedRow.hover();
    await parkedRow.getByRole('button', { name: 'to Next' }).click();
    await expect(parked).toHaveCount(0);
    await viewButton(page, 'Board').click();
    const nextRow = band(page, 'next').locator('.ip-next-row', { has: page.getByRole('button', { name: '4 Build to GitHub', exact: true }) });
    await expect(nextRow.locator('.p-tile-chips .p-chip')).toHaveText('READY');
    // Unpark sends a parked step back to the Backlog, not to Next.
    const again = await openBacklogView(page, 'By Phase');
    await (await openInspector(blRow(page, again, '5 Store listing'))).getByRole('button', { name: 'Park…' }).click();
    await page.getByRole('textbox', { name: 'Why is it set aside?' }).fill('Later');
    await page.getByRole('button', { name: 'Park', exact: true }).click();
    await pickView(again, 'Parked');
    const shelved = pRow(page, again.getByRole('region', { name: 'Parked' }), '5 Store listing');
    await expect(shelved).toBeVisible();
    await shelved.hover();
    await shelved.getByRole('button', { name: 'Unpark' }).click();
    await expect(again.getByRole('region', { name: 'Parked' })).toHaveCount(0);
    await pickView(again, 'By Phase');
    await expect(blRow(page, again, '5 Store listing')).toBeVisible();
    await viewButton(page, 'Board').click();
    await expect(band(page, 'next').locator('.ip-next-row', { hasText: '5 Store listing' })).toHaveCount(0);
  });

  test('the Backlog filter narrows the rows, says "X of N shown", matches id, label and phase, and clears on Escape, Clear filter and leaving the view', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['7 Launch']}`, { label: 'fix' });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = await openBacklogView(page, 'By Phase');
    const meta = next.locator('.ip-page-meta');
    const field = next.getByRole('textbox', { name: 'Filter the backlog' });
    const titles = () => next.locator('li.ip-bl-row .ip-bl-title').allInnerTexts();
    const total = (await titles()).length;
    expect(total).toBeGreaterThan(1);
    await expect(meta).toContainText(`${total} OPEN`);
    // Every word must match: here both in the title.
    await field.fill('build git');
    await expect(meta).toContainText(`1 OF ${total} SHOWN`);
    expect(await titles()).toEqual(['4 Build to GitHub']);
    // "#id", the label, and the parent title with the title.
    await field.fill(`#${fresh.ids['6 Beta']}`);
    await expect.poll(titles).toEqual(['6 Beta']);
    await field.fill('fix');
    await expect.poll(titles).toEqual(['7 Launch']);
    await field.fill('ROAD beta');
    await expect.poll(titles).toEqual(['6 Beta']);
    // Nothing matching says so; Clear filter empties the field, keeps focus in it and brings every row back.
    await field.fill('zzz');
    await expect(next.getByText('Nothing matches “zzz”')).toBeVisible();
    await expect(meta).toContainText(`0 OF ${total} SHOWN`);
    await next.getByRole('button', { name: 'Clear filter' }).click();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('');
    await expect(meta).toContainText(`${total} OPEN`);
    await expect(meta).not.toContainText('SHOWN');
    await expect.poll(async () => (await titles()).length).toBe(total);
    // Escape in the field clears it and leaves the view open.
    await field.fill('store');
    await expect.poll(titles).toEqual(['5 Store listing']);
    await page.keyboard.press('Escape');
    await expect(field).toHaveValue('');
    await expect(next).toBeVisible();
    // A new filter closes an open Delete confirm.
    const beta = blRow(page, next, '6 Beta');
    await (await openInspector(beta)).getByRole('button', { name: 'Delete…' }).click();
    await expect(next.locator('.p-confirm')).toBeVisible();
    await field.fill('beta');
    await expect(next.locator('.p-confirm')).toHaveCount(0);
    await expect.poll(titles).toEqual(['6 Beta']);
    // "to Next" still works on a filtered row: it stays in By Phase, now marked NEXT.
    await field.fill('revenuecat');
    const row = blRow(page, next, '3 RevenueCat');
    await row.hover();
    await row.getByRole('button', { name: 'to Next' }).click();
    await expect(row.locator('.p-chip')).toHaveText('NEXT');
    await expect(meta).toContainText(`1 OF ${total} SHOWN`);
    // The phase title matches too: the steps under Road to market, not Milestones (a phase of its own).
    await field.fill('road market');
    await expect.poll(titles).toContain('7 Launch');
    expect(await titles()).not.toContain('Milestones');
    // Leaving the view clears the filter.
    await field.fill('beta');
    await expect.poll(titles).toEqual(['6 Beta']);
    await viewButton(page, 'Board').click();
    await openBacklogView(page, 'By Phase');
    await expect(field).toHaveValue('');
    await expect.poll(async () => (await titles()).length).toBe(total);
  });

  test('"to Next" and "back to Backlog" are buttons Tab reaches and shows, and write the queue', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    const title = page.getByRole('button', { name: '4 Build to GitHub', exact: true });
    const toNext = next.locator('.ip-backlog-row', { has: title }).getByRole('button', { name: 'to Next' });
    await expect(toNext).toHaveCSS('opacity', '0');
    // The tile is a cursor item: Tab goes into its own buttons (to Next in the top row, then the title).
    await next.locator('.ip-backlog-row', { has: title }).focus();
    await page.keyboard.press('Tab');
    await expect(toNext).toBeFocused();
    await expect(toNext).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    const row = next.locator('.ip-next-row', { has: page.getByRole('button', { name: '4 Build to GitHub', exact: true }) });
    await expect(row.locator('.p-tile-chips .p-chip')).toHaveText('READY');
    // A button of the row's own does not open Details.
    await expect(page.getByRole('complementary')).toHaveCount(0);
    // The queue was written: the step is Ready in Next after a reload, with "back to Backlog" on it.
    await page.reload();
    await expect(row.locator('.p-tile-chips .p-chip')).toHaveText('READY');
    await row.getByRole('button', { name: 'back to Backlog' }).focus();
    await expect(row.getByRole('button', { name: 'back to Backlog' })).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(next.locator('.ip-next-row')).toHaveCount(0);
    await page.reload();
    await expect(next.locator('.ip-next-row')).toHaveCount(0);
    await expect(band(page, 'next').locator('.ip-backlog-name')).toContainText('Soon');
  });

  test('Backlog "Delete…" asks first, Escape and Cancel keep the step, Delete removes it from the tree', async ({ page, fresh, consoleErrors }) => {
    consoleErrors.allow(/status of 400/);
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = await openBacklogView(page, 'By Phase');
    const id = fresh.ids['6 Beta'];
    const row = blRow(page, next, '6 Beta');
    const acts = row.locator('.ip-bl-acts');
    const del = row.getByRole('button', { name: 'Delete…' });
    const dialog = page.getByRole('group', { name: `Delete #${id} 6 Beta?` });
    await expect(acts).toHaveCSS('opacity', '0');
    // The row is one Tab stop; Enter opens its inspector, and Delete… is among the buttons Tab reaches there.
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(del).toBeVisible();
    for (let i = 0; i < 10 && (await page.locator(':focus').getAttribute('data-delete')) === null; i++) await page.keyboard.press('Tab');
    await expect(del).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    // The confirm names the step and says it cannot be undone.
    await expect(dialog).toContainText("It can't be undone.");
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(del).toBeFocused();
    await expect(row).toBeVisible();
    // A click on the question, or on the confirming row's own padding, does not open Details.
    await page.keyboard.press('Enter');
    const inspectorOfRow = row.getByRole('group', { name: /^Inspector for #/ });
    await dialog.locator('.p-confirm-q').click();
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(inspectorOfRow).toBeVisible();
    await next.locator(`li[data-node="${id}"]`).click({ position: { x: 2, y: 2 } });
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(inspectorOfRow).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(del).toBeFocused();
    // Cancel closes the confirm, keeps the step and does not open Details.
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(del).toBeFocused();
    await expect(row).toBeVisible();
    // A refused delete keeps the row, says why, and puts focus back on its Delete button.
    const nodeDelete = '**/api/ui/projects/*/nodes/*/delete';
    await page.route(nodeDelete, (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for the test', hint: 'Reload the window.' }) }));
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Refused for the test').first()).toBeVisible();
    await expect(del).toBeFocused();
    await expect(next.locator(`li[data-node="${id}"]`)).not.toHaveClass(/pending/);
    await page.unroute(nodeDelete);
    // Details open on the step: deleting it closes Details.
    await row.getByRole('button', { name: 'Open Details ›' }).click();
    await expect(page.getByRole('complementary')).toHaveCount(1);
    await del.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    // Details covers the right of the view, so the confirm's Delete is pressed from the keyboard.
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(blRow(page, next, '6 Beta')).toHaveCount(0);
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await page.reload();
    // The view is remembered, so after a reload the full Backlog is still open: Board in the rail goes back to the preview.
    await viewButton(page, 'Board').click();
    const preview = band(page, 'next');
    await expect(preview.getByRole('button', { name: '7 Launch', exact: true })).toBeVisible();
    await expect(preview.getByRole('button', { name: '6 Beta', exact: true })).toHaveCount(0);
  });

  test('the full Backlog keeps focus on the neighbouring row after to Next, Delete, Park and Unpark, a refused Park or Unpark puts it back, and a row removed from outside hands focus on', async ({ page, api, fresh, consoleErrors }) => {
    consoleErrors.allow(/status of (400|409)/);
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const view = await openBacklogView(page, 'By Phase');
    const rowOf = (t: string) => blRow(page, view, t);
    const idsNow = async () => Promise.all((await view.locator('li.ip-bl-row').all()).map((l) => l.getAttribute('data-node')));
    /** After the row `gone` left (or moved), focus sits on the row that followed it in the list as it was, else the one before. */
    const onNeighbourOf = async (gone: number, before: (string | null)[]) => {
      const at = before.indexOf(String(gone));
      const want = before[at + 1] ?? before[at - 1];
      await expect(view.locator('li.ip-bl-row:focus')).toHaveAttribute('data-node', want!);
    };
    const revenue = fresh.ids['3 RevenueCat'];
    let before = await idsNow();
    await rowOf('3 RevenueCat').hover();
    await rowOf('3 RevenueCat').getByRole('button', { name: 'to Next' }).click();
    // By Phase keeps the row, now marked NEXT; focus has moved on to the row after it.
    await expect(rowOf('3 RevenueCat').locator('.p-chip')).toHaveText('NEXT');
    await onNeighbourOf(revenue, before);
    before = await idsNow();
    await (await openInspector(rowOf('6 Beta'))).getByRole('button', { name: 'Delete…' }).click();
    await page.getByRole('group', { name: /^Delete #\d+ 6 Beta\?$/ }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(rowOf('6 Beta')).toHaveCount(0);
    await onNeighbourOf(fresh.ids['6 Beta'], before);
    // A refused Park keeps the form and its text and puts focus back on the reason.
    const parkUrl = '**/api/ui/projects/*/nodes/*/park';
    await page.route(parkUrl, (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for the test', hint: 'Reload the window.' }) }));
    await (await openInspector(rowOf('5 Store listing'))).getByRole('button', { name: 'Park…' }).click();
    const form = page.getByRole('dialog', { name: /^Park #\d+ 5 Store listing$/ });
    await form.getByRole('textbox', { name: 'Why is it set aside?' }).fill('Later');
    await form.getByRole('button', { name: 'Park', exact: true }).click();
    await expect(page.getByText('Refused for the test').first()).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Why is it set aside?' })).toBeFocused();
    await expect(form.getByRole('textbox', { name: 'Why is it set aside?' })).toHaveValue('Later');
    await page.unroute(parkUrl);
    // What is typed survives a filter and a reorder while the row is still shown, and the form does not take focus back.
    await view.getByRole('textbox', { name: 'Filter the backlog' }).fill('store');
    await expect(form).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Why is it set aside?' })).toHaveValue('Later');
    await view.getByRole('textbox', { name: 'Filter the backlog' }).fill('');
    before = await idsNow();
    await form.getByRole('textbox', { name: 'Why is it set aside?' }).press('Enter');
    await expect(rowOf('5 Store listing')).toHaveCount(0);
    await onNeighbourOf(fresh.ids['5 Store listing'], before);
    // A refused Unpark gives focus back to the button that was pressed.
    await pickView(view, 'Parked');
    const parked = view.getByRole('region', { name: 'Parked' });
    const parkedRow = pRow(page, parked, '5 Store listing');
    const unparkUrl = '**/api/ui/projects/*/nodes/*/unpark';
    await page.route(unparkUrl, (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for the test', hint: 'Reload the window.' }) }));
    await parkedRow.hover();
    await parkedRow.getByRole('button', { name: 'Unpark' }).click();
    await expect(page.getByText('Refused for the test').first()).toBeVisible();
    await expect(parkedRow.getByRole('button', { name: 'Unpark' })).toBeFocused();
    await expect(parkedRow.getByRole('button', { name: 'Unpark' })).toBeEnabled();
    await page.unroute(unparkUrl);
    // Unpark and to Next in the Parked view move focus on too: with no row left, to the page title.
    await parkedRow.getByRole('button', { name: 'Unpark' }).click();
    await expect(parked).toHaveCount(0);
    await expect(view.getByRole('heading', { level: 1 })).toBeFocused();
    await pickView(view, 'By Phase');
    await (await openInspector(rowOf('5 Store listing'))).getByRole('button', { name: 'Park…' }).click();
    await page.getByRole('textbox', { name: 'Why is it set aside?' }).fill('Again');
    await page.keyboard.press('Enter');
    await expect(rowOf('5 Store listing')).toHaveCount(0);
    await pickView(view, 'Parked');
    await expect(parked).toBeVisible();
    await parkedRow.hover();
    await parkedRow.getByRole('button', { name: 'to Next' }).click();
    await expect(parked).toHaveCount(0);
    await expect(view.getByRole('heading', { level: 1 })).toBeFocused();
    await pickView(view, 'By Phase');
    // A row removed by another session while it has focus hands focus to the row that followed it.
    before = await idsNow();
    const victim = before[1]!;
    await view.locator(`li.ip-bl-row[data-node="${victim}"]`).focus();
    await write(api, fresh.session, 'delete', `/api/nodes/${victim}`);
    await expect(view.locator(`li.ip-bl-row[data-node="${victim}"]`)).toHaveCount(0);
    await expect(view.locator('li.ip-bl-row:focus')).toHaveAttribute('data-node', before[2]!);
  });

  test('in the full Backlog, quick-add Escape focuses the page title, Escape waits out a park in flight, and a park resolving leaves focus in a second open form', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const view = await openBacklogView(page, 'By Phase');
    const rowOf = (t: string) => blRow(page, view, t);
    // The group foot's quick-add: Escape puts focus back on its box.
    const group = view.getByRole('region', { name: 'Backlog with no phase' });
    const box = group.getByRole('button', { name: '+ Add a step' });
    await box.click();
    const add = group.getByRole('textbox', { name: 'Add a step with no phase' });
    await expect(add).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(box).toBeFocused();
    // The park is held back for a moment: Escape in its form does nothing meanwhile.
    const parkUrl = '**/api/ui/projects/*/nodes/*/park';
    await page.route(parkUrl, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await (await openInspector(rowOf('4 Build to GitHub'))).getByRole('button', { name: 'Park…' }).click();
    const first = page.getByRole('dialog', { name: /^Park #\d+ 4 Build to GitHub$/ });
    await first.getByRole('textbox', { name: 'Why is it set aside?' }).fill('Slow one');
    await page.keyboard.press('Enter');
    await expect(first.getByRole('button', { name: 'Park', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(first).toBeVisible();
    // Another row's form opened while it is in flight keeps focus when the first one resolves.
    await (await openInspector(rowOf('5 Store listing'))).getByRole('button', { name: 'Park…' }).click();
    const second = page.getByRole('dialog', { name: /^Park #\d+ 5 Store listing$/ });
    await expect(second.getByRole('textbox', { name: 'Why is it set aside?' })).toBeFocused();
    await second.getByRole('textbox', { name: 'Why is it set aside?' }).fill('Typing');
    await expect(rowOf('4 Build to GitHub')).toHaveCount(0);
    await expect(second.getByRole('textbox', { name: 'Why is it set aside?' })).toBeFocused();
    await expect(second.getByRole('textbox', { name: 'Why is it set aside?' })).toHaveValue('Typing');
    await page.unroute(parkUrl);
  });

  test('the full Backlog lists No phase last, and a parked step with no phase names it', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, nodes: [{ title: 'Loose one' }, { title: 'Loose parked' }] });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const view = await openBacklogView(page, 'By Phase');
    await expect(view.getByRole('region', { name: 'Backlog with no phase' })).toBeVisible();
    const groups = await Promise.all((await view.locator('.ip-bl-group:not(.ip-bl-parked)').all()).map((g) => g.getAttribute('aria-label')));
    expect(groups.at(-1)).toBe('Backlog with no phase');
    expect(groups.length).toBeGreaterThan(1);
    const loose = blRow(page, view, 'Loose parked');
    await (await openInspector(loose)).getByRole('button', { name: 'Park…' }).click();
    await page.getByRole('textbox', { name: 'Why is it set aside?' }).fill('Not now');
    await page.keyboard.press('Enter');
    await pickView(view, 'Parked');
    const parkedRow = pRow(page, view.getByRole('region', { name: 'Parked' }), 'Loose parked');
    await expect(parkedRow.locator('.ip-bl-phase')).toHaveText('No phase');
  });

  test('Now "Done…" takes an optional outcome, Escape keeps the step, Enter marks it done', async ({ page, api, fresh, consoleErrors }) => {
    consoleErrors.allow(/status of 400/);
    const made = await write<{ id: number; title: string }[]>(api, fresh.session, 'post', '/api/nodes', {
      parentId: fresh.root,
      nodes: [{ title: 'Mine to finish', status: 'active', assignee: 'me' }, { title: 'Mine to refuse', status: 'active', assignee: 'me' }],
    });
    const id = made.find((n) => n.title === 'Mine to finish')!.id;
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const now = band(page, 'now');
    const row = nowRow(page, 'Mine to finish');
    const dialog = page.getByRole('dialog', { name: `Mark #${id} Mine to finish done?` });
    const field = dialog.getByRole('textbox', { name: 'Outcome (optional)' });
    const doneButton = row.getByRole('button', { name: 'Done…' });
    await doneButton.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(field).toBeFocused();
    // No live driver: no driver line.
    await expect(dialog.getByText('drives it')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(doneButton).toBeFocused();
    // Reopen, type an outcome, Enter: the box leaves Now and shows in Done, and the step stores the outcome.
    await page.keyboard.press('Enter');
    await field.fill('Finished by hand');
    await page.keyboard.press('Enter');
    await expect(now.getByRole('button', { name: 'Mine to finish', exact: true })).toHaveCount(0);
    await expect(band(page, 'done').getByRole('button', { name: 'Mine to finish', exact: true })).toBeVisible();
    const stored = await api.get(`/api/nodes/${id}`, { headers: headers(fresh.session) });
    expect(await stored.json()).toMatchObject({ node: { status: 'done', outcome: 'Finished by hand' } });
    // A step a live session drives: the form names the session, and Cancel keeps the step.
    const driven = nowRow(page, 'Play app signing');
    const drivenDialog = page.getByRole('dialog', { name: `Mark #${fresh.ids['Play app signing']} Play app signing done?` });
    await driven.getByRole('button', { name: 'Done…' }).click();
    await expect(drivenDialog).toContainText('“E2E session” drives it.');
    await drivenDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(drivenDialog).toHaveCount(0);
    await expect(driven).toBeVisible();
    // A refused request keeps the form open, says why, and leaves the step in Now.
    const nodeDone = '**/api/ui/projects/*/nodes/*/done';
    await page.route(nodeDone, (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for the test', hint: 'Reload the window.' }) }));
    const refused = nowRow(page, 'Mine to refuse');
    await refused.getByRole('button', { name: 'Done…' }).click();
    await page.getByRole('button', { name: 'Mark done', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Refused for the test' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Outcome (optional)' })).toBeFocused();
    await expect(refused).not.toHaveClass(/pending/);
    await page.unroute(nodeDone);
  });

  test('drag: Backlog into Next, within Next, and Next back to Backlog, without opening Details', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    const backlogRow = (t: string) => next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: t, exact: true }) });
    const nextRow = (t: string) => next.locator('.ip-next-row', { has: page.getByRole('button', { name: t, exact: true }) });
    const order = async () => (await next.locator('.ip-next-row .ip-row-title').allTextContents()).join('|');
    // Into an empty rail.
    await drag(backlogRow('5 Store listing'), next.getByText('Nothing is queued'));
    await expect.poll(order).toBe('5 Store listing');
    // Onto the top half of a Next row: before it.
    await drag(backlogRow('6 Beta'), nextRow('5 Store listing'), { x: 40, y: 2 });
    await expect.poll(order).toBe('6 Beta|5 Store listing');
    // Within Next: the bottom half of the last row puts it last. Measured, since the row's height follows its padding.
    const last = (await nextRow('5 Store listing').boundingBox())!;
    await drag(nextRow('6 Beta'), nextRow('5 Store listing'), { x: 40, y: last.height - 6 });
    await expect.poll(order).toBe('5 Store listing|6 Beta');
    // Each box shows its step id and its state.
    await expect(nextRow('6 Beta').locator('.p-tile-id')).toHaveText(`#${fresh.ids['6 Beta']}`);
    await expect(nextRow('6 Beta').locator('.p-tile-chips .p-chip')).toHaveText('READY');
    await expect(page.getByRole('complementary')).toHaveCount(0);
    // The queue was written.
    await page.reload();
    await expect.poll(order).toBe('5 Store listing|6 Beta');
    // Back onto Backlog.
    await drag(nextRow('5 Store listing'), next.locator('.ip-backlog-head'));
    await expect(next.locator('.ip-next-row')).toHaveCount(1);
    await expect(backlogRow('5 Store listing')).toBeVisible();
    await expect.poll(order).toBe('6 Beta');
    await expect(page.getByRole('complementary')).toHaveCount(0);
  });
});

test.describe('Project view', () => {
  // 1600 wide, so the page has room for the phase index at the right.
  const projectView = async (page: Page, project: Seeded) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await open(page, project);
    await viewButton(page, 'Project').click();
    await expect(page.getByRole('region', { name: 'Sections' })).toBeVisible();
  };
  const section = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });

  test('sections fold on a click and the choice survives a reload; done children, done groups and the rail follow the spec', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, nodes: [{ title: 'Parked', kind: 'phase', children: [{ title: 'Idle thing' }] }] });
    await projectView(page, fresh);
    const road = section(page, 'Road to market');
    const parked = section(page, 'Parked');
    // A step in Now opens a section; nothing in Now or Next leaves it folded to its header and bar.
    await expect(road.getByRole('button', { name: /Road to market/, expanded: true })).toBeVisible();
    await expect(parked.getByRole('button', { name: /Parked/, expanded: false })).toBeVisible();
    await expect(parked.getByRole('img', { name: '1 backlog' })).toBeVisible();
    await expect(parked.getByRole('button', { name: 'Idle thing', exact: true })).toHaveCount(0);
    await parked.getByRole('button', { name: /Parked/ }).click();
    await expect(parked.getByRole('button', { name: 'Idle thing', exact: true })).toBeVisible();
    await page.reload();
    await expect(parked.getByRole('button', { name: /Parked/, expanded: true })).toBeVisible();
    await expect(parked.getByRole('button', { name: 'Idle thing', exact: true })).toBeVisible();
    // The rail: a session on it, backlog, and the YOU tag on a step of Aiden's.
    await expect(road.locator('.ip-orow', { has: page.getByRole('button', { name: 'Play app signing', exact: true }) }).getByRole('img', { name: 'now, a session is on it' })).toBeVisible();
    await expect(road.locator('.ip-orow', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) }).getByRole('img', { name: 'backlog' })).toBeVisible();
    await expect(road.locator('.ip-orow', { has: page.getByRole('button', { name: 'Run signing tests', exact: true }) }).locator('.ip-you')).toHaveText('YOU');
    // The key to the rail names the parked ring too.
    await expect(page.getByRole('group', { name: 'Key to the marks' })).toContainText('parked, set aside');
    // Done children fold per parent and open on a click.
    const fold = road.getByRole('button', { name: /^✓ 1 done · latest #\d+ 1 iOS certificate/ });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(road.getByRole('button', { name: '1 iOS certificate', exact: true })).toHaveCount(0);
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(road.getByRole('button', { name: '1 iOS certificate', exact: true })).toBeVisible();
    // A fully done group is not a section until it is picked from the index's Finished fold.
    await expect(section(page, 'Milestones')).toHaveCount(0);
    const index = page.getByRole('navigation', { name: 'Phases' });
    const groups = index.getByRole('button', { name: /^Finished · 1/ });
    await expect(groups).toHaveAttribute('aria-expanded', 'false');
    await groups.click();
    await index.getByRole('button', { name: /Milestones/ }).click();
    await expect(section(page, 'Milestones').getByRole('button', { name: /Milestones/, expanded: true })).toBeVisible();
    // A step opens its Details.
    await road.getByRole('button', { name: '3 RevenueCat', exact: true }).click();
    await expect(page.getByRole('complementary')).toContainText('3 RevenueCat');
  });

  test('the resource list opens from "▤ n", closes on Escape and on an outside click, returns focus, and opens the viewer', async ({ page, fresh }) => {
    await projectView(page, fresh);
    const road = section(page, 'Road to market');
    const opener = road.getByRole('button', { name: /resources? in Road to market/ });
    const menu = page.getByRole('menu', { name: 'Resources in Road to market' });
    await opener.click();
    await expect(opener).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitem')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(menu).toBeVisible();
    await page.locator('.ip-page-title').click();
    await expect(menu).toHaveCount(0);
    await expect(opener).toHaveAttribute('aria-expanded', 'false');
    await expect(opener).toBeFocused();
    // Shift+Tab from any item, not only the first, closes the menu and lands on the opener.
    await opener.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+Tab');
    await expect(menu).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute('aria-expanded', 'false');
    await opener.click();
    await menu.getByRole('menuitem', { name: /Signing test suite/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Signing tests');
  });

  test('"+ Add a step" creates in its group, keeps the field focused for the next one, and Escape returns focus to the button', async ({ page, fresh }) => {
    await projectView(page, fresh);
    const road = section(page, 'Road to market');
    const add = road.getByRole('button', { name: '+ Add a step' });
    const field = road.getByRole('textbox', { name: 'Add a step to Road to market' });
    await expect(field).toHaveCount(0);
    await add.click();
    await expect(field).toBeFocused();
    await page.keyboard.type('Quick one');
    await page.keyboard.press('Enter');
    await expect(road.getByRole('button', { name: 'Quick one', exact: true })).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('');
    await page.keyboard.type('Quick two');
    await page.keyboard.press('Enter');
    await expect(road.getByRole('button', { name: 'Quick two', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(page.getByRole('complementary')).toHaveCount(0);
    // It was written under the group, as a Backlog step.
    await page.reload();
    const row = road.locator('.ip-orow', { has: page.getByRole('button', { name: 'Quick one', exact: true }) });
    await expect(row.getByRole('img', { name: 'backlog' })).toBeVisible();
  });

  test('a phase index row opens a folded section and focuses its head; a narrow page has the jump row instead', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, nodes: [{ title: 'Parked', kind: 'phase', children: [{ title: 'Idle thing' }] }] });
    await projectView(page, fresh);
    const index = page.getByRole('navigation', { name: 'Phases' });
    const parked = section(page, 'Parked');
    const toggle = parked.getByRole('button', { name: 'Parked', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The page head: the code block, the name, and the meta line.
    await expect(page.locator('.ip-page-code')).toHaveText(/^[A-Z0-9]{3}$/);
    await expect(page.locator('.ip-page-title')).toBeVisible();
    await expect(page.locator('.ip-page-meta')).toContainText(/\d+ PHASES · \d+ NOW · \d+ NEXT · \d+ DONE/);
    await expect(page.getByRole('region', { name: 'Orchestrator note' })).toBeVisible();
    await index.getByRole('button', { name: /^Parked/ }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await expect(index.getByRole('button', { name: /^Parked/ })).toHaveAttribute('aria-current', 'location');
    // Under 1160 of page the index becomes a jump row under the slab.
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(index).toHaveCount(0);
    const jump = page.getByRole('group', { name: 'Phases' });
    await expect(jump).toBeVisible();
    await jump.getByRole('button', { name: 'Road to market' }).click();
    await expect(section(page, 'Road to market').getByRole('button', { name: 'Road to market', exact: true })).toBeFocused();
    // Nothing scrolls sideways at 400.
    await page.setViewportSize({ width: 400, height: 900 });
    await expect(page.getByRole('region', { name: 'Sections' })).toBeVisible();
    expect(await page.evaluate<boolean>(`(() => { const e = document.querySelector('.ip-project'); return e.scrollWidth <= e.clientWidth; })()`)).toBe(true);
  });

  test('the outline is one Tab stop: the arrows walk its rows across sections, and Enter opens Details', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, nodes: [{ title: 'Second phase', kind: 'phase', children: [{ title: 'Second step' }] }] });
    await projectView(page, fresh);
    await page.getByRole('navigation', { name: 'Phases' }).getByRole('button', { name: /^Second phase/ }).click();
    const rows = page.locator('.ip-orow[data-cursor]');
    const stops = page.locator('.ip-orow[data-cursor][tabindex="0"]');
    await expect(stops).toHaveCount(1);
    const count = await rows.count();
    expect(count).toBeGreaterThan(3);
    await stops.focus();
    await page.keyboard.press('End');
    await expect(rows.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(rows.first()).toBeFocused();
    await expect(stops).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('tabindex', '0');
    // The last row is in the second section: End crossed the sections. Enter on a step opens its Details.
    await page.keyboard.press('End');
    await expect(rows.last().locator('.ip-row-title')).toHaveText('Second step');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary')).toContainText('Second step');
  });
});

test.describe('Details: asks, handoff, add a step', () => {
  test("a row opens Details with the step's asks, answered ones too, and its handoff chip; opening posts details_open", async ({ page, api, fresh }) => {
    const id = fresh.ids['Run signing tests'];
    await write(api, fresh.session, 'post', '/api/resources', { nodeId: id, kind: 'doc', title: 'Session handoff', purpose: 'handoff', content: '# Handoff\n\nPick up at the upload step.' });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/ui/events') && (r.postDataJSON() as { name: string }).name === 'details_open');
    const details = await openDetails(page, 'Run signing tests');
    expect((await posted).postDataJSON()).toMatchObject({ name: 'details_open', data: { node: id } });
    // The open ask, as on the Board: kind, text, who raised it and Answer… with Clear.
    const asks = details.locator('.ip-dasks');
    const open1 = asks.locator('.ip-dask', { hasText: 'Which keystore signs the release?' });
    await expect(open1).toContainText(`a${fresh.ask}`);
    await expect(open1.locator('.ip-dask-head')).toHaveText(new RegExp(`a${fresh.ask} \\? question · (now|\\d+m)`));
    await expect(open1.locator('.ip-dask-who')).toHaveText('migrated');
    await expect(open1.getByRole('button', { name: 'Clear' })).toBeVisible();
    // Answer… takes focus; Escape closes the field only, returns focus to the button, and leaves Details open.
    const answer = open1.getByRole('button', { name: 'Answer…' });
    await answer.click();
    const field = open1.getByRole('textbox');
    await expect(field).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(answer).toBeFocused();
    await expect(details).toBeVisible();
    await answer.click();
    await field.fill('Use the upload key');
    await page.keyboard.press('Enter');
    // Cleared with its answer, it moves to the answered lines.
    const cleared = asks.locator('.ip-dask.cleared');
    await expect(cleared.locator('.ip-dask-head')).toHaveText(new RegExp(`a${fresh.ask} \\? ANSWERED · `));
    await expect(cleared.locator('.ip-dask-line')).toHaveText('"Which keystore signs the release?" · answered "Use the upload key"');
    await expect(asks.getByRole('button', { name: 'Answer…' })).toHaveCount(0);
    // The handoff chip opens the handoff in the viewer.
    await details.getByRole('button', { name: /^handoff · / }).click();
    await expect(page.getByRole('dialog', { name: 'Resource' })).toContainText('Pick up at the upload step.');
  });

  test('Add a step creates a child, keeps its field focused for the next, and Escape returns focus to the button without closing Details', async ({ page, api, fresh }) => {
    const id = fresh.ids['Play app signing'];
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const details = await openDetails(page, 'Play app signing');
    const add = details.getByRole('button', { name: `Add a step under #${id}` });
    await add.click();
    const field = details.getByRole('textbox', { name: `Add a step under #${id}` });
    await expect(field).toBeFocused();
    await field.fill('Check the upload key');
    await page.keyboard.press('Enter');
    await expect(details.locator('.ip-kids')).toContainText('Check the upload key');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('');
    await page.keyboard.press('Enter');
    await field.fill('Second child');
    await page.keyboard.press('Enter');
    await expect(details.locator('.ip-kids')).toContainText('Second child');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(details).toBeVisible();
    const detail = (await (await api.get(`/api/nodes/${id}`)).json()) as { children: { title: string }[] };
    expect(detail.children.map((c) => c.title)).toEqual(expect.arrayContaining(['Check the upload key', 'Second child']));
  });
});

test.describe('Fix round 1', () => {
  test('dropping a Next row on itself, or on the half of the row above it, leaves the order alone', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    const backlogRow = (t: string) => next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: t, exact: true }) });
    const nextRow = (t: string) => next.locator('.ip-next-row', { has: page.getByRole('button', { name: t, exact: true }) });
    const order = async () => (await next.locator('.ip-next-row .ip-row-title').allTextContents()).join('|');
    // Near the foot of a row: its bottom half, measured since the row's height follows its padding.
    const bottom = async (t: string) => ({ x: 40, y: (await nextRow(t).boundingBox())!.height - 6 });
    await drag(backlogRow('4 Build to GitHub'), next.getByText('Nothing is queued'));
    await drag(backlogRow('5 Store listing'), nextRow('4 Build to GitHub'), await bottom('4 Build to GitHub'));
    await drag(backlogRow('6 Beta'), nextRow('5 Store listing'), await bottom('5 Store listing'));
    const expected = '4 Build to GitHub|5 Store listing|6 Beta';
    await expect.poll(order).toBe(expected);
    // The middle row on its own top half, then on the bottom half of the row above it.
    await drag(nextRow('5 Store listing'), nextRow('5 Store listing'), { x: 40, y: 2 });
    await drag(nextRow('5 Store listing'), nextRow('4 Build to GitHub'), await bottom('4 Build to GitHub'));
    await expect.poll(order).toBe(expected);
    await page.reload();
    await expect.poll(order).toBe(expected);
  });

  test('Escape closes Details and returns focus to the row title that opened it', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const title = boxIn(page, 'needs', 'Run signing tests').getByRole('button', { name: 'Run signing tests', exact: true });
    await title.click();
    await expect(page.getByRole('complementary')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(title).toBeFocused();
  });

  test('"to Next" moves focus to the next Backlog row, and an empty Answer… does not clear', async ({ page, api, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    const titles = next.locator('.ip-backlog-row .ip-row-title');
    const first = await titles.nth(0).textContent();
    const second = await titles.nth(1).textContent();
    expect(first).not.toBe(second);
    await next.locator('.ip-backlog-row').first().getByRole('button', { name: 'to Next' }).click();
    // The row is a cursor item, so focus lands on the row itself.
    await expect(next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: second!, exact: true }) })).toBeFocused();
    // Enter on an empty answer field does nothing.
    const row = boxIn(page, 'needs', 'Run signing tests');
    await row.getByRole('button', { name: 'Answer…' }).click();
    await page.keyboard.press('Enter');
    await expect(row.getByRole('textbox')).toBeFocused();
    const snapshot = (await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { asks: { id: number; clearedAt: string | null }[] };
    expect(snapshot.asks.find((a) => a.id === fresh.ask)?.clearedAt).toBeNull();
  });
});

test('the parts lab opens on #/lab and walks a TabStrip with the arrow keys', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/lab');
  const sections = [
    'Tokens', 'Type ramp', 'Hues', 'Motion', 'Eyebrow', 'Readout', 'Count', 'Chip', 'Button', 'TabStrip', 'Field', 'Menu',
    'Confirm', 'Tile', 'Frame', 'LiveDot', 'Marker', 'KeyHint', 'Tape', 'Ruler', 'EmptyState', 'ErrorLine', 'Toast', 'ListCursor',
  ];
  for (const name of sections) {
    await expect(page.getByRole('heading', { level: 2, name: new RegExp('^' + name + '$', 'i') })).toBeVisible();
  }
  const tabs = page.getByRole('tablist', { name: 'Lab tabs' }).getByRole('tab');
  const count = await tabs.count();
  await tabs.first().click();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(tabs.nth(count - 1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(count - 1)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(count - 1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(count - 1)).toBeFocused();
});

test('the parts lab grid is one Tab stop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/lab');
  const grid = page.locator('.lab-grid');
  const first = grid.locator('[data-cursor]').first();
  await first.scrollIntoViewIfNeeded();
  await first.focus();
  await page.keyboard.press('ArrowRight');
  const second = grid.locator('[data-cursor]').nth(4);
  await expect(second).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(second.getByRole('button')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.lab-grid :focus')).toHaveCount(0);
  await page.keyboard.press('Shift+Tab');
  await expect(second.getByRole('button')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(second).toBeFocused();
});

test.describe('HUD bar and footer strip', () => {
  test('ASKS sums every active project and opens the first with asks; a dropped stream shows RECONNECTING and the tape', async ({ page, api, fresh, consoleErrors }) => {
    consoleErrors.allow(/ERR_CONNECTION_REFUSED/);
    const other = await seed(api, 'E2E HUD Other');
    // The open project has no ask of its own now; the other one does.
    await write(api, fresh.session, 'post', `/api/asks/${fresh.ask}/clear`, {});
    await open(page, fresh);
    const list = (await (await api.get('/api/projects')).json()) as { id: number; slug: string; name: string; status: string; openAsks: number; permissionWaits: number }[];
    const waiting = list.filter((p) => p.status === 'active' && p.openAsks + p.permissionWaits > 0).sort((a, b) => a.id - b.id);
    const total = waiting.reduce((sum, p) => sum + p.openAsks + p.permissionWaits, 0);
    expect(waiting.map((p) => p.slug), 'the other project waits on Aiden').toContain(other.slug);
    const asks = page.locator('.ip-hud-asks');
    await expect(asks.locator('.p-readout-value')).toHaveText(String(total));
    await expect(asks).toHaveAttribute('title', /E2E HUD Other: 1/);
    await asks.click();
    await expect(page).toHaveURL(hereIs(waiting[0]!.slug));
    await expect(page.locator('.ip-page-title')).toHaveText(waiting[0]!.name);
    // Now the open project has asks: a second click moves focus to its Needs me.
    await asks.click();
    await expect(page.locator('.ip-band-needs h2')).toBeFocused();

    // The stream cannot connect: the link reads RECONNECTING and the tape takes the ruler's place.
    await page.route('**/api/events/stream**', (route) => route.abort('connectionrefused'));
    await page.reload();
    const link = page.locator('.ip-hud-link');
    await expect(link).toContainText('RECONNECTING');
    await expect(page.locator('.ip-hud-edge .p-tape')).toBeVisible();
    await expect(page.locator('.ip-hud-edge .p-ruler')).toHaveCount(0);
    await expect(page.locator('.ip-banner')).toHaveCount(0);
    const under = (await page.locator('.ip-shell').boundingBox())!.y;
    await page.unroute('**/api/events/stream**');
    await expect(link).toContainText('OK', { timeout: 10_000 });
    await expect(page.locator('.ip-hud-edge .p-ruler')).toBeVisible();
    await expect(page.locator('.ip-hud-edge .p-tape')).toHaveCount(0);
    expect((await page.locator('.ip-shell').boundingBox())!.y, 'the page does not move').toBe(under);
  });
});

test.describe('Module rail', () => {
  test('Board, Backlog and All done are views in the rail, none with a "‹ Board", and the Board links open the same views with focus on the rail', async ({ page, fresh }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await open(page, fresh);
    await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
    await expect(projectRail(page)).toBeVisible();
    expect((await projectRail(page).boundingBox())!.width).toBe(216);
    await viewButton(page, 'Backlog').click();
    await expect(page.locator('.ip-backlogview').getByRole('heading', { level: 1, name: 'BACKLOG' })).toBeVisible();
    await expect(viewButton(page, 'Backlog')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: '‹ Board' })).toHaveCount(0);
    await viewButton(page, 'All done').click();
    await expect(page.locator('.ip-donelist')).toBeVisible();
    await expect(page.locator('.ip-backlogview')).toHaveCount(0);
    await expect(viewButton(page, 'All done')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: '‹ Board' })).toHaveCount(0);
    await viewButton(page, 'Board').click();
    await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
    // The Board's own links open the same views, and focus lands on the rail's row for the view.
    await backlogAll(page).click();
    await expect(page.locator('.ip-backlogview')).toBeVisible();
    await expect(viewButton(page, 'Backlog')).toBeFocused();
    await viewButton(page, 'Board').click();
    await band(page, 'done').getByRole('button', { name: /^All done · [0-9]+$/ }).click();
    await expect(page.locator('.ip-donelist')).toBeVisible();
    await expect(viewButton(page, 'All done')).toBeFocused();
  });

  test('from 720 to 1359 the rail is a column of codes, a clash gets a digit, and under 720 it is a strip with the views as tabs at the top of the page', async ({ page, api, fresh }) => {
    const stem = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
    const first = `${stem[0].toUpperCase()}${stem.slice(1)} Ledger`;
    const second = `${stem[0].toUpperCase()}${stem.slice(1)}-Ledger`;
    await bare(api, first);
    await bare(api, second);
    await page.setViewportSize({ width: 1000, height: 900 });
    await open(page, fresh);
    await expect(railRow(page, first)).toBeVisible();
    expect((await projectRail(page).boundingBox())!.width).toBe(76);
    const code = (name: string) => railRow(page, name).locator('.ip-rail-code');
    await expect(code(first)).toHaveText(/^[A-Z]{2}[A-Z]$/);
    const base = (await code(first).textContent())!;
    await expect(code(second)).toHaveText(`${base.slice(0, 2)}2`);
    await expect(railRow(page, first).locator('.ip-rail-name')).toBeHidden();
    await expect(projectRail(page).locator('.ip-rail-vcode')).toHaveText(['BRD', 'PRJ', 'BKL', 'DON', 'DOC']);
    await expect(viewButton(page, 'Backlog')).toBeVisible();
    // Under 720: one row of full names, and the views a group named Views above the page.
    await page.setViewportSize({ width: 400, height: 900 });
    await expect(railRow(page, first).locator('.ip-rail-name')).toBeVisible();
    expect((await projectRail(page).boundingBox())!.height, 'one row high').toBeLessThan(70);
    const views = page.getByRole('group', { name: 'Views' });
    await expect(views).toBeVisible();
    expect((await views.boundingBox())!.y).toBeGreaterThan((await projectRail(page).boundingBox())!.y);
    expect((await views.boundingBox())!.y).toBeLessThan((await page.locator('.ip-board').boundingBox())!.y);
    await expect(projectRail(page).locator('.ip-rail-view').first()).toBeHidden();
    await views.getByRole('button', { name: /^Backlog/ }).click();
    await expect(page.locator('.ip-backlogview').getByRole('heading', { level: 1, name: 'BACKLOG' })).toBeVisible();
    await expect(views.getByRole('button', { name: /^Backlog/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('with Backlog picked, another project picked in the rail shows its own Backlog, and the rail marks Backlog under the new row', async ({ page, api }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const aName = unique('Switch a');
    const bName = unique('Switch b');
    const a = await bare(api, aName);
    const b = await bare(api, bName);
    await addStep(api, a, 'Entry of a');
    await addStep(api, b, 'Entry of b');
    await page.goto(`/#/p/${a.slug}`);
    await viewButton(page, 'Backlog').click();
    // A new step is unranked, so By Phase (kept per project) is where it shows.
    await pickView(page.locator('.ip-backlogview'), 'By Phase');
    await expect(page.locator('.ip-backlogview').getByText('Entry of a', { exact: true })).toBeVisible();
    await railRow(page, bName).click();
    await expect(railRow(page, bName)).toHaveAttribute('aria-current', 'page');
    await pickView(page.locator('.ip-backlogview'), 'By Phase');
    await expect(page.locator('.ip-backlogview').getByText('Entry of b', { exact: true })).toBeVisible();
    await expect(page.locator('.ip-backlogview').getByText('Entry of a', { exact: true })).toHaveCount(0);
    await expect(page.locator('.ip-backlogview').getByRole('heading', { level: 1, name: 'BACKLOG' })).toBeVisible();
    // The views sit under the new row, with Backlog current.
    await expect(railRow(page, bName).locator('xpath=..').locator('.ip-rail-view[aria-current="page"]')).toHaveAccessibleName(/^Backlog/);
    await expect(railRow(page, aName).locator('xpath=..').locator('.ip-rail-view')).toHaveCount(0);
  });

  test('focus in the views list follows a project switch: ] from the rail Backlog lands on the next project\'s Backlog', async ({ page, api }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const a = await bare(api, unique('Focus a'));
    const bName = unique('Focus b');
    await bare(api, bName);
    await page.goto(`/#/p/${a.slug}`);
    await viewButton(page, 'Backlog').click();
    await viewButton(page, 'Backlog').focus();
    await page.keyboard.press(']');
    await expect(railRow(page, bName)).toHaveAttribute('aria-current', 'page');
    await expect(viewButton(page, 'Backlog')).toBeFocused();
    await expect(viewButton(page, 'Backlog')).toHaveAttribute('aria-current', 'page');
  });

  test('under 720 the Views tabs keep focus over a project switch, and the picked tab keeps its label under the pointer', async ({ page, api }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    const a = await bare(api, unique('Strip a'));
    const bName = unique('Strip b');
    await bare(api, bName);
    await page.goto(`/#/p/${a.slug}`);
    const backlog = viewButton(page, 'Backlog');
    await backlog.click();
    await expect(backlog).toHaveAttribute('aria-pressed', 'true');
    // Hovered, the picked tab is still ink on volt, not volt on volt.
    await backlog.hover();
    const [ink, fill] = await backlog.evaluate((el) => {
      const style = (globalThis as unknown as { getComputedStyle(e: unknown): { color: string; backgroundColor: string } }).getComputedStyle(el);
      return [style.color, style.backgroundColor];
    });
    expect(ink).not.toBe(fill);
    await backlog.focus();
    await page.keyboard.press(']');
    await expect(railRow(page, bName)).toHaveAttribute('aria-current', 'page');
    await expect(backlog).toBeFocused();
    await expect(backlog).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('v3 Details, viewer and command bar (#505)', () => {
  /** Opens a step's Details by id through the command bar, which works over any view. */
  async function goToStep(page: Page, id: number): Promise<Locator> {
    await page.keyboard.press('Control+k');
    await page.keyboard.type(`#${id}`);
    await page.keyboard.press('Enter');
    const details = page.getByRole('complementary');
    await expect(details.locator('.ip-dtop .p-eyebrow')).toHaveText(new RegExp(`^#${id} · `));
    return details;
  }

  test('the command bar lists views and projects, and backlog + Enter opens the Backlog view', async ({ page, api, demo }) => {
    const other = unique('Cmdbar');
    const made = await bare(api, other);
    await widen(page);
    await open(page, demo);
    await expect(railCurrent(page)).toBeVisible();
    await page.keyboard.press('Control+k');
    // Nothing typed: the views in order, then the other projects, the open one left out.
    const goTo = page.getByRole('group', { name: 'Go to' });
    await expect(goTo.getByRole('option').first()).toBeVisible();
    await expect(goTo.getByRole('option').locator('.ip-cmdbar-name').filter({ hasText: /^(Board|Project|Backlog|All done)$/ })).toHaveText(['Board', 'Project', 'Backlog', 'All done']);
    await expect(goTo.getByRole('option', { name: `Open ${other}` })).toBeVisible();
    await expect(goTo.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    // "backlog" + Enter opens the Backlog view.
    await page.keyboard.type('backlog');
    await expect(goTo.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.locator('.ip-backlogview')).toBeVisible();
    await expect(page.locator('.ip-cmdbar')).toBeHidden();
    await expect(page).toHaveURL(hereIs(demo.slug));
    // A project's name + Enter opens that project.
    await page.keyboard.press('Control+k');
    await page.keyboard.type(other.toLowerCase());
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(hereIs(made.slug));
    await expect(page.locator('.ip-cmdbar')).toBeHidden();
    // Steps still answer to #id, with the old message.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('#99999999');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ip-cmdbar-note')).toHaveText('No step #99999999');
  });

  test("Details' action strip opens Park without scrolling on a long step", async ({ page, api, fresh }) => {
    const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of a long step body.`).join('\n\n');
    const [step] = await write<{ id: number }[]>(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.ids['Road to market'], nodes: [{ title: 'A very long step', status: 'active', body }] });
    for (let i = 0; i < 30; i++) await write(api, fresh.session, 'post', `/api/nodes/${step.id}/log`, { text: `Log line ${i + 1}`, sessionId: fresh.session });
    await page.setViewportSize({ width: 1000, height: 700 });
    await open(page, fresh);
    await expect(stepRow(page, 'Play app signing')).toBeVisible();
    const details = await goToStep(page, step.id);
    // The body scrolls; the head and the strip do not.
    const scroller = details.locator('.ip-dbody');
    await expect.poll(() => page.evaluate<number>(`(() => { const e = document.querySelector('.ip-dbody'); return e.scrollHeight - e.clientHeight; })()`)).toBeGreaterThan(200);
    const park = details.getByRole('button', { name: 'Park…' });
    await expect(park).toBeInViewport({ ratio: 1 });
    const strip = (await details.locator('.ip-dstrip').boundingBox())!;
    const box = (await park.boundingBox())!;
    const frame = (await details.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(strip.y);
    expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
    expect(await page.evaluate<number>(`document.querySelector('.ip-dbody').scrollTop`)).toBe(0);
    await park.click();
    // The form opens in the strip, and the head stays on screen.
    const form = details.locator('.ip-dstrip').getByRole('dialog', { name: /^Park #/ });
    await expect(form).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Why is it set aside?' })).toBeFocused();
    await expect(details.locator('.ip-dtitle')).toBeInViewport({ ratio: 1 });
    const strip2 = (await details.locator('.ip-dstrip').boundingBox())!;
    expect(strip2.height, 'at most half the panel').toBeLessThanOrEqual(frame.height / 2 + 1);
  });

  test('at 400 px Details covers the page and Escape returns focus to its tile', async ({ page, fresh }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await open(page, fresh);
    const tile = stepRow(page, 'Play app signing');
    await tile.click();
    const details = page.getByRole('complementary');
    await expect(details.locator('.ip-dtitle')).toHaveText('Play app signing');
    await expect(details.locator('.ip-dtitle')).toBeFocused();
    // It fills .ip-main exactly: below the HUD, above the footer.
    const main = (await page.locator('.ip-main').boundingBox())!;
    const cover = (await details.boundingBox())!;
    for (const edge of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(cover[edge] - main[edge]), edge).toBeLessThanOrEqual(1);
    const hud = (await page.locator('.ip-hud').boundingBox())!;
    const footer = (await page.locator('.ip-footer').boundingBox())!;
    expect(cover.y).toBeGreaterThanOrEqual(hud.y + hud.height - 1);
    expect(cover.y + cover.height).toBeLessThanOrEqual(footer.y + 1);
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await expect(tile).toBeFocused();
  });

  // Beside the 216 px rail and the 440 px panel, the page keeps its 1160 px from a 1816 px window.
  test('on the Project view at 1900 px an open Details leaves the phase index in view beside it', async ({ page, fresh }) => {
    await page.setViewportSize({ width: 1900, height: 900 });
    await open(page, fresh);
    await viewButton(page, 'Project').click();
    const project = page.locator('.ip-project');
    await expect(project).toHaveAttribute('data-wide', 'true');
    await expect(page.locator('.ip-pside')).toBeVisible();
    await goToStep(page, fresh.ids['Play app signing']);
    const details = page.getByRole('complementary');
    // The page narrowed beside Details: 1160 px is still wide, and the index sits left of the panel.
    await expect(project).toHaveAttribute('data-wide', 'true');
    const index = (await page.locator('.ip-pside').boundingBox())!;
    const panel = (await details.boundingBox())!;
    expect(index.x + index.width).toBeLessThanOrEqual(panel.x + 1);
    const page1 = (await project.boundingBox())!;
    expect(page1.x + page1.width).toBeLessThanOrEqual(panel.x + 1);
    // Under 1160 px of remaining page the index folds into the jump row: at 1600 px, beside the rail and the panel.
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(project).not.toHaveAttribute('data-wide', 'true');
    await expect(page.locator('.ip-pside')).toHaveCount(0);
    await expect(page.locator('.ip-jump')).toBeVisible();
    // Closed, the page takes the width back and the index returns.
    await page.keyboard.press('Escape');
    await expect(project).toHaveAttribute('data-wide', 'true');
    await expect(page.locator('.ip-pside')).toBeVisible();
  });

  test('switching Details to another card from the Board makes that card the opener, so Escape returns focus to it', async ({ page, fresh }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await open(page, fresh);
    const a = stepRow(page, 'Play app signing');
    const b = stepRow(page, 'Run signing tests');
    await a.click();
    await expect(page.getByRole('complementary').locator('.ip-dtitle')).toHaveText('Play app signing');
    await b.click();
    await expect(page.getByRole('complementary').locator('.ip-dtitle')).toHaveText('Run signing tests');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(b).toBeFocused();
    // A click that leaves focus where it was (here in Details) still makes the clicked card the opener.
    await a.click();
    await expect(page.getByRole('complementary').locator('.ip-dtitle')).toBeFocused();
    await b.dispatchEvent('click');
    await expect(page.getByRole('complementary').locator('.ip-dtitle')).toHaveText('Run signing tests');
    await page.keyboard.press('Escape');
    await expect(b).toBeFocused();
  });

  test('a menu opened from the rail foot paints over an open Details', async ({ page, api }) => {
    const keptName = unique('Layer kept');
    const shelvedName = unique('Layer shelved');
    const kept = await bare(api, keptName);
    const shelved = await bare(api, shelvedName);
    await addStep(api, kept, 'Layer step');
    await write(api, `e2e-${randomUUID()}`, 'patch', `/api/projects/${shelved.slug}`, { status: 'archived' });
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto(`/#/p/${kept.slug}`);
    await openDetails(page, 'Layer step');
    await page.getByRole('button', { name: /^Archived · / }).click();
    const item = page.getByRole('menu').getByRole('menuitem', { name: shelvedName, exact: true });
    await expect(item).toBeVisible();
    const box = (await item.boundingBox())!;
    const hit = await page.evaluate<boolean>(`(() => { const item = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes(${JSON.stringify(shelvedName)})); const at = document.elementFromPoint(${box.x + box.width / 2}, ${box.y + box.height / 2}); return item === at || item.contains(at); })()`);
    expect(hit, 'the menu item is the top element at its centre').toBe(true);
  });

  test('a press on the scrim closes the command bar and returns focus to the tile', async ({ page, fresh }) => {
    await widen(page);
    await open(page, fresh);
    const tile = stepRow(page, 'Play app signing');
    await tile.focus();
    await page.keyboard.press('/');
    await expect(page.locator('.ip-cmdbar')).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(page.locator('.ip-cmdbar')).toBeHidden();
    await expect(tile).toBeFocused();
  });
});

test.describe('#504 Backlog view and All done', () => {
  /** Parks a step from the full view's row and waits for it to land in Parked. */
  async function parkFromView(page: Page, view: Locator, title: string, reason: string) {
    const row = blRow(page, view, title);
    await row.hover();
    await row.getByRole('button', { name: 'Park…' }).click();
    await page.getByRole('textbox', { name: 'Why is it set aside?' }).fill(reason);
    await page.keyboard.press('Enter');
    await expect(blRow(page, view, title)).toHaveCount(0);
  }

  test('the Backlog rows are one Tab stop: Home and End cross the groups, Enter opens the inspector and Open Details › opens Details', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const view = await openBacklogView(page, 'By Phase');
    // Exactly one row is in the Tab order.
    await expect(view.locator('li.ip-bl-row[tabindex="0"]')).toHaveCount(1);
    // Tab from the controls above lands on that row.
    await view.getByRole('textbox', { name: 'Filter the backlog' }).focus();
    for (let i = 0; i < 12; i++) {
      if ((await view.locator('li.ip-bl-row:focus').count()) > 0) break;
      await page.keyboard.press('Tab');
    }
    const landed = await view.locator('li.ip-bl-row:focus').getAttribute('data-node');
    expect(landed).toBe(await view.locator('li.ip-bl-row[tabindex="0"]').getAttribute('data-node'));
    // End goes to the last row, in the last group; Home goes back to the first row.
    await page.keyboard.press('End');
    const last = view.locator('li.ip-bl-row').last();
    await expect(last).toBeFocused();
    await page.keyboard.press('Home');
    await expect(view.locator('li.ip-bl-row').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(last).toBeFocused();
    // Enter opens the inspector on the focused row, and its Open Details › opens Details.
    const title = await last.locator('.ip-bl-title').innerText();
    await page.keyboard.press('Enter');
    await last.getByRole('button', { name: 'Open Details ›' }).click();
    await expect(page.getByRole('complementary').locator('.ip-dtitle')).toContainText(title);
  });

  test('All done reads as a log by time and by phase', async ({ page, api, fresh }) => {
    const titles = ['Log step 1', 'Log step 2', 'Log step 3'];
    await write(api, fresh.session, 'post', '/api/nodes', {
      parentId: fresh.root,
      nodes: [{ title: 'Log phase', children: titles.map((title) => ({ title, status: 'done' as const, outcome: 'Shipped it.' })) }],
    });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    await viewButton(page, 'All done').click();
    const view = page.locator('.ip-donelist');
    await expect(view.getByRole('heading', { name: 'ALL DONE', level: 1 })).toBeVisible();
    await expect(view.locator('.ip-page-meta')).toContainText(/\d+ DONE/);
    // By time: a TODAY heading with its count, an HH:MM column, the outcome on one line with its whole text in the title.
    await expect(view.getByRole('heading', { name: /^TODAY · \d+$/ })).toBeVisible();
    const rows = view.locator('.ip-done-row').filter({ hasText: 'Log step' });
    await expect(rows).toHaveCount(3);
    await expect(rows.first().locator('.ip-done-when')).toHaveText(/^\d\d:\d\d$/);
    await expect(rows.first().locator('.ip-done-outcome')).toHaveAttribute('title', 'Shipped it.');
    // By phase: the crumb path with ids under an "n DONE" eyebrow, and the short date on the left.
    await view.getByRole('group', { name: 'Order' }).getByRole('button', { name: 'Phase', exact: true }).click();
    const path = view.locator('.ip-done-path', { hasText: 'Log phase' });
    await expect(path).toHaveText(/^#\d+ .+ › #\d+ Log phase$/);
    await expect(path.locator('xpath=preceding-sibling::*[1]')).toHaveText(/^3 DONE$/);
    await expect(rows.first().locator('.ip-done-when')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}/);
    // The order is kept over a reload.
    await page.reload();
    await viewButton(page, 'All done').click();
    await expect(view.getByRole('group', { name: 'Order' }).getByRole('button', { name: 'Phase', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // The rows are one list: Down moves and Enter opens Details.
    const first = view.locator('.ip-done-row[tabindex="0"]');
    await expect(first).toHaveCount(1);
    await first.focus();
    await page.keyboard.press('ArrowDown');
    const second = view.locator('.ip-done-row:focus');
    await expect(second).toHaveCount(1);
    const title = await second.locator('.ip-done-title').innerText();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary').locator('.ip-dtitle')).toContainText(title);
  });
});

test.describe('#502 Board in v3', () => {
  test('two asks on one step read as two panels, each with its own Answer… and Clear, and Send sends the answer', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Run signing tests']}/asks`, { kind: 'review', text: 'And which store account?' });
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    const tile = boxIn(page, 'needs', 'Run signing tests');
    const panels = tile.locator('.ip-ask-panel');
    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0).locator('.p-eyebrow')).toHaveText('01 QUESTION');
    await expect(panels.nth(1).locator('.p-eyebrow')).toHaveText('02 REVIEW');
    for (const i of [0, 1]) {
      await expect(panels.nth(i).getByRole('button', { name: 'Answer…' })).toBeVisible();
      await expect(panels.nth(i).getByRole('button', { name: 'Clear' })).toBeVisible();
    }
    // Answer… becomes a Field and Send; Send with nothing typed does nothing; typed, it clears the ask with the answer.
    await panels.nth(0).getByRole('button', { name: 'Answer…' }).click();
    const send = panels.nth(0).getByRole('button', { name: 'Send' });
    await send.click();
    await expect(panels).toHaveCount(2);
    await panels.nth(0).getByRole('textbox').fill('Use the upload key');
    await send.click();
    await expect(panels).toHaveCount(1);
    const snapshot = (await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { asks: { id: number; answer: string }[] };
    expect(snapshot.asks.find((a) => a.id === fresh.ask)).toMatchObject({ answer: 'Use the upload key' });
  });

  test('an ask text longer than four lines shows Show all and Show less, and a short one shows neither', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Play app signing']}/asks`, { kind: 'question', text: Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ') });
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    const long = boxIn(page, 'needs', 'Play app signing').locator('.ip-ask-panel');
    const short = boxIn(page, 'needs', 'Run signing tests').locator('.ip-ask-panel');
    await expect(short.getByRole('button', { name: /^Show/ })).toHaveCount(0);
    const text = long.locator('.ip-ask-text');
    const folded = (await text.boundingBox())!.height;
    await long.getByRole('button', { name: 'Show all' }).click();
    expect((await text.boundingBox())!.height).toBeGreaterThan(folded);
    await long.getByRole('button', { name: 'Show less' }).click();
    expect((await text.boundingBox())!.height).toBe(folded);
  });

  test('the Board tiles are one Tab stop: arrows move between them and Enter opens Details', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Play app signing']}/asks`, { kind: 'question', text: 'A second step with an ask?' });
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    // Oldest wait first: the fixture's ask on Run signing tests, then the one just raised.
    const first = boxIn(page, 'needs', 'Run signing tests').locator('article');
    const second = boxIn(page, 'needs', 'Play app signing').locator('article');
    await expect(first).toHaveAttribute('data-cursor', '');
    // Only the cursor tile is in the Tab order; the other tile's buttons are out of it.
    const stops = await page.locator('section.ip-band-needs article[tabindex="0"]').count();
    expect(stops).toBe(1);
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(second).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary')).toBeVisible();
    await expect(page.getByRole('complementary')).toContainText('Play app signing');
    // The tile Details shows stays marked until Details closes.
    await expect(second).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(second).not.toHaveAttribute('data-selected', /.*/);
  });

  test('Alt+Down on a focused Next tile moves it one place down and Alt+Up back, the order holds after the snapshot and focus stays on it', async ({ page, api, fresh }) => {
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    const next = band(page, 'next');
    const titles = ['3 RevenueCat', '4 Build to GitHub', '5 Store listing'];
    for (const t of titles) {
      await next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: t, exact: true }) }).getByRole('button', { name: 'to Next' }).click();
      await expect(next.locator('article.ip-next-row', { has: page.getByRole('button', { name: t, exact: true }) })).toBeVisible();
    }
    const tile = (t: string) => next.locator('article.ip-next-row', { has: page.getByRole('button', { name: t, exact: true }) });
    const order = async () => (await next.locator('.ip-next-row .ip-row-title').allTextContents()).join('|');
    const stored = async () => ((await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { project: { queue: { nodeId: number }[] } }).project.queue.map((e) => e.nodeId);
    const ids = titles.map((t) => fresh.ids[t]);
    await expect.poll(order).toBe(titles.join('|'));
    await tile(titles[0]).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(order).toBe([titles[1], titles[0], titles[2]].join('|'));
    await expect(tile(titles[0])).toBeFocused();
    // The write lands: the server holds the new order, the window shows it, and focus is still on the moved tile.
    await expect.poll(stored).toEqual([ids[1], ids[0], ids[2]]);
    await expect.poll(order).toBe([titles[1], titles[0], titles[2]].join('|'));
    await expect(tile(titles[0])).toBeFocused();
    // Down from the middle puts it last; at the end nothing moves.
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(stored).toEqual([ids[1], ids[2], ids[0]]);
    await expect(tile(titles[0])).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(order).toBe([titles[1], titles[2], titles[0]].join('|'));
    // Alt+Up goes back, one place at a time.
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(stored).toEqual([ids[1], ids[0], ids[2]]);
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(stored).toEqual(ids);
    await expect.poll(order).toBe(titles.join('|'));
    await expect(tile(titles[0])).toBeFocused();
  });

  test('two by two, ArrowDown from the last Needs me tile reaches the first Next tile, and ArrowUp comes back', async ({ page, fresh }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await open(page, fresh);
    const next = band(page, 'next');
    await next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) }).getByRole('button', { name: 'to Next' }).click();
    const nextTile = next.locator('article.ip-next-row', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) });
    await expect(nextTile).toBeVisible();
    // Next sits under Needs me in the left column here.
    const needs = (await band(page, 'needs').boundingBox())!;
    const nextBox = (await nextTile.boundingBox())!;
    expect(nextBox.x).toBeLessThan(needs.x + needs.width);
    expect(nextBox.y).toBeGreaterThan(needs.y);
    const last = band(page, 'needs').locator('article.ip-tile').last();
    await last.focus();
    await page.keyboard.press('ArrowDown');
    await expect(nextTile).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(last).toBeFocused();
  });

  test('"N to tidy" lists the marked steps, an item opens its Details, and Escape closes the menu with focus on the button', async ({ page, fresh }) => {
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    const button = page.getByRole('button', { name: /to tidy$/ });
    await button.click();
    const menu = page.getByRole('menu', { name: 'Steps to tidy' });
    await expect(menu).toBeVisible();
    const marked = fresh.ids['1 iOS certificate'];
    const item = menu.getByRole('menuitem', { name: new RegExp(`^#${marked} no_outcome`) });
    await expect(item).toBeVisible();
    expect(await menu.getByRole('menuitem').count()).toBe(Number((await button.textContent())!.match(/^\d+/)![0]));
    // Escape closes the menu and puts focus on the button; Details stays shut.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(page.getByRole('complementary')).toHaveCount(0);
    // An item opens that step's Details.
    await button.click();
    await item.click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole('complementary')).toContainText('1 iOS certificate');
    // Details took the button as its opener: Escape returns there.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('More opens the whole state note and Less folds it back to the first sentence', async ({ page, api, fresh }) => {
    const content = 'The first sentence of the note. A second sentence only the open note shows.\n\n## Later\n\nA closing paragraph.';
    await write(api, fresh.session, 'post', '/api/resources', { nodeId: fresh.root, kind: 'doc', title: 'State', content, purpose: 'state' });
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    const comms = page.locator('.ip-comms');
    await expect(comms).toContainText('The first sentence of the note.');
    await expect(comms).not.toContainText('A second sentence');
    await comms.getByRole('button', { name: 'More' }).click();
    await expect(comms).toContainText('A second sentence only the open note shows.');
    await expect(comms).toContainText('A closing paragraph.');
    await comms.getByRole('button', { name: 'Less' }).click();
    await expect(comms).not.toContainText('A second sentence');
    await expect(comms).not.toContainText('A closing paragraph.');
    await expect(comms.getByRole('button', { name: 'More' })).toBeVisible();
  });

  test("a #id in the state note opens that step's Details, in the first sentence and in the open Markdown", async ({ page, api, fresh }) => {
    const first = fresh.ids['Play app signing'];
    const later = fresh.ids['3 RevenueCat'];
    const content = `Waiting on #${first} before anything ships.\n\nThen #${later} is next.`;
    await write(api, fresh.session, 'post', '/api/resources', { nodeId: fresh.root, kind: 'doc', title: 'State', content, purpose: 'state' });
    await page.setViewportSize(WIDEST);
    await open(page, fresh);
    const comms = page.locator('.ip-comms');
    const details = page.getByRole('complementary');
    await comms.getByRole('button', { name: `#${first}`, exact: true }).click();
    await expect(details).toContainText('Play app signing');
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await comms.getByRole('button', { name: 'More' }).click();
    await comms.getByRole('link', { name: `#${later}`, exact: true }).click();
    await expect(details).toContainText('3 RevenueCat');
  });
});

test.describe('#542 ranked Backlog', () => {
  /** Ranks the steps into the bottom of Soon in the order given, then opens the Ranked view. Each test ranks what it asserts on. */
  async function openRankedWith(page: Page, api: APIRequestContext, fresh: Seeded, titles: string[]): Promise<{ view: Locator; projectId: number }> {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const projectId = fresh.id;
    for (const title of titles) await rank(api, fresh, { node: fresh.ids[title], to: 'soon', before: null });
    const view = await openFullBacklog(page);
    return { view, projectId };
  }
  const handleOf = (row: Locator) => row.locator('.ip-bl-handle');
  const soonTitles = (view: Locator) => view.getByRole('region', { name: 'Soon' }).locator('.ip-bl-title').allInnerTexts();

  test('the Backlog opens on Ranked: Next up, Soon and a folded Someday, under the five views with counts', async ({ page, api, fresh }) => {
    const { view, projectId } = await openRankedWith(page, api, fresh, ['3 RevenueCat', '4 Build to GitHub']);
    await rank(api, fresh, { node: fresh.ids['5 Store listing'], to: 'someday', before: null });
    const views = view.getByRole('group', { name: 'Backlog view' });
    await expect(views.getByRole('button')).toHaveText([/^Ranked/, /^By Phase/, /^Needs Triage/, /^Stale/, /^Parked/]);
    await expect(views.getByRole('button', { name: /^Ranked/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(view.getByRole('region', { name: 'Next up' }).locator('h3')).toHaveText('Next up');
    await expect(view.getByRole('region', { name: 'Soon' }).locator('h3')).toHaveText('Soon');
    const someday = view.getByRole('region', { name: 'Someday' });
    await expect(someday.getByRole('button', { name: /^Show \d+$/ })).toBeVisible();
    await expect(someday.locator('li')).toHaveCount(0);
    // Soon's rows are numbered and carry a handle.
    await expect(blRow(page, view, '3 RevenueCat').locator('.ip-bl-num')).toHaveText(/^\d+$/);
    await expect(handleOf(blRow(page, view, '3 RevenueCat'))).toBeVisible();
    // Show opens the fold, and the choice is kept.
    await someday.getByRole('button', { name: /^Show/ }).click();
    await expect(blRow(page, someday, '5 Store listing')).toBeVisible();
    await page.reload();
    await expect(blRow(page, page.getByRole('region', { name: 'Someday' }), '5 Store listing')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Someday' }).getByRole('button', { name: 'Hide' })).toBeVisible();
  });

  test("dragging a Soon row into Next up queues it, and the Board's Next shows it", async ({ page, api, fresh }) => {
    const { view } = await openRankedWith(page, api, fresh, ['3 RevenueCat', '4 Build to GitHub']);
    const nextUp = view.getByRole('region', { name: 'Next up' });
    const row = blRow(page, view, '4 Build to GitHub');
    await drag(handleOf(row), nextUp);
    // It shows in Next up at once and stays after the snapshot has settled.
    const queued = blRow(page, nextUp, '4 Build to GitHub');
    await expect(queued).toBeVisible();
    await expect(blRow(page, view.getByRole('region', { name: 'Soon' }), '4 Build to GitHub')).toHaveCount(0);
    await page.waitForTimeout(2500);
    await expect(queued).toBeVisible();
    await expect(queued.locator('.ip-bl-num')).toHaveClass(/volt/);
    // The Board's Next lists it.
    await viewButton(page, 'Board').click();
    await expect(band(page, 'next').locator('.ip-next-row', { has: page.getByRole('button', { name: '4 Build to GitHub', exact: true }) })).toHaveCount(1);
  });

  test('dragging within Soon persists across a reload', async ({ page, api, fresh }) => {
    const mine = ['3 RevenueCat', '4 Build to GitHub', '5 Store listing'];
    const { view } = await openRankedWith(page, api, fresh, mine);
    const mineOnly = async (v: Locator) => (await soonTitles(v)).filter((t) => mine.includes(t));
    await expect.poll(() => mineOnly(view)).toEqual(mine);
    // The top half of 3 RevenueCat: 5 Store listing goes before it.
    await drag(handleOf(blRow(page, view, '5 Store listing')), blRow(page, view, '3 RevenueCat'), { x: 80, y: 4 });
    await expect.poll(() => mineOnly(view)).toEqual(['5 Store listing', '3 RevenueCat', '4 Build to GitHub']);
    await page.reload();
    const again = page.locator('.ip-backlogview');
    await expect.poll(() => mineOnly(again)).toEqual(['5 Store listing', '3 RevenueCat', '4 Build to GitHub']);
  });

  test('a queued step that is first in Someday, dragged from Next up onto the folded Someday head, lands first in Someday', async ({ page, api, fresh }) => {
    const { view, projectId } = await openRankedWith(page, api, fresh, []);
    const [first, second] = [fresh.ids['3 RevenueCat'], fresh.ids['4 Build to GitHub']];
    await rank(api, fresh, { node: first, to: 'someday', before: null });
    await rank(api, fresh, { node: second, to: 'someday', before: null });
    // Queued, it keeps its band: it is still the first member of Someday's order.
    await rank(api, fresh, { node: first, to: 'next', before: null });
    const nextUp = view.getByRole('region', { name: 'Next up' });
    const someday = view.getByRole('region', { name: 'Someday' });
    await drag(handleOf(blRow(page, nextUp, '3 RevenueCat')), someday.locator('.ip-bl-bhead'));
    await expect(blRow(page, nextUp, '3 RevenueCat')).toHaveCount(0);
    await someday.getByRole('button', { name: /^Show/ }).click();
    const mine = ['3 RevenueCat', '4 Build to GitHub'];
    await expect.poll(async () => (await someday.locator('.ip-bl-title').allInnerTexts()).filter((t) => mine.includes(t))).toEqual(mine);
  });

  test('a step a session adds shows in Needs Triage and the Ranked notice', async ({ page, api, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const view = await openFullBacklog(page);
    const triageTab = view.getByRole('group', { name: 'Backlog view' }).getByRole('button', { name: /^Needs Triage/ });
    const before = Number(await triageTab.locator('.p-tab-count').innerText());
    await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, nodes: [{ title: 'Session added step' }] });
    await expect(triageTab.locator('.p-tab-count')).toHaveText(String(before + 1));
    const notice = view.locator('.ip-bl-notice');
    await expect(notice).toContainText(before + 1 === 1 ? '1 new step to rank' : `${before + 1} new steps to rank`);
    await notice.getByRole('button', { name: 'Triage ›' }).click();
    await expect(triageTab).toHaveAttribute('aria-pressed', 'true');
    await expect(blRow(page, view, 'Session added step')).toBeVisible();
  });

  test("the filter narrows every view's count and the meta, and Escape clears it", async ({ page, api, fresh }) => {
    await openRankedWith(page, api, fresh, ['4 Build to GitHub']);
    const view = page.locator('.ip-backlogview');
    const field = view.getByRole('textbox', { name: 'Filter the backlog' });
    const meta = view.locator('.ip-page-meta');
    await field.fill('build git');
    await expect(meta).toContainText('1 OF');
    await expect(meta).toContainText('SHOWN');
    const counts = view.getByRole('group', { name: 'Backlog view' }).locator('.p-tab-count');
    await expect(counts).toHaveText(['1', '1', /^[01]$/, '0', '0']);
    await field.focus();
    await page.keyboard.press('Escape');
    await expect(field).toHaveValue('');
    await expect(meta).not.toContainText('SHOWN');
  });

  test('quick-add at the foot of Ranked creates a step at the bottom of Soon, and Escape returns focus to the box', async ({ page, api, fresh }) => {
    const { view } = await openRankedWith(page, api, fresh, ['3 RevenueCat']);
    const foot = view.getByRole('button', { name: '+ Add a step to Soon…' });
    await foot.click();
    const field = view.getByRole('textbox', { name: 'Add a step to Soon' });
    await expect(field).toBeFocused();
    await field.fill('Quick Soon step');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await soonTitles(view)).slice(-1)[0]).toBe('Quick Soon step');
    await page.keyboard.press('Escape');
    await expect(foot).toBeFocused();
  });

  test("picking Someday in the inspector's Band select moves the row to the bottom of Someday", async ({ page, api, fresh }) => {
    const mine = ['3 RevenueCat', '4 Build to GitHub', '5 Store listing'];
    const { view } = await openRankedWith(page, api, fresh, mine);
    await rank(api, fresh, { node: fresh.ids['6 Beta'], to: 'someday', before: null });
    const row = blRow(page, view, '4 Build to GitHub');
    const inspector = await openInspector(row);
    await expect(inspector).toBeVisible();
    await inspector.getByRole('combobox', { name: 'Band' }).selectOption('someday');
    await expect.poll(async () => (await soonTitles(view)).includes('4 Build to GitHub')).toBe(false);
    const someday = view.getByRole('region', { name: 'Someday' });
    await someday.getByRole('button', { name: /^Show/ }).click();
    await expect.poll(async () => (await someday.locator('.ip-bl-title').allInnerTexts()).slice(-1)[0]).toBe('4 Build to GitHub');
  });

  test('Park then Unpark from the inspector lands the step in Needs Triage', async ({ page, api, fresh }) => {
    const { view } = await openRankedWith(page, api, fresh, ['4 Build to GitHub']);
    const soon = view.getByRole('region', { name: 'Soon' });
    const inspector = await openInspector(blRow(page, soon, '4 Build to GitHub'));
    await inspector.getByRole('button', { name: 'Park…' }).click();
    // A reason of 200 characters and more reads whole as it is typed: the box spans the inspector and grows with it.
    const reason = page.getByRole('textbox', { name: 'Why is it set aside?' });
    const long = `Not this quarter: ${'waiting on the store review and the pricing call. '.repeat(28)}`.trim();
    await reason.fill(long);
    type Box = { tagName: string; clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number };
    const box = await reason.evaluate((el: Box) => ({ tag: el.tagName, width: el.clientWidth, height: el.clientHeight, hiddenX: el.scrollWidth - el.clientWidth, hiddenY: el.scrollHeight - el.clientHeight }));
    // A box across the inspector that wraps the reason and grows past its first three lines to show all of it.
    expect(box.tag).toBe('TEXTAREA');
    expect(box.width).toBeGreaterThan(400);
    expect(box.hiddenX).toBeLessThanOrEqual(1);
    expect(box.hiddenY).toBeLessThanOrEqual(1);
    expect(box.height).toBeGreaterThan(120);
    await page.getByRole('button', { name: 'Park', exact: true }).click();
    await expect(blRow(page, soon, '4 Build to GitHub')).toHaveCount(0);
    await pickView(view, 'Parked');
    const parkedRow = pRow(page, view.getByRole('region', { name: 'Parked' }), '4 Build to GitHub');
    await parkedRow.locator('.ip-bl-title').click();
    await parkedRow.getByRole('group', { name: /^Inspector for #/ }).getByRole('button', { name: 'Unpark', exact: true }).click();
    await expect(view.getByRole('region', { name: 'Parked' })).toHaveCount(0);
    await pickView(view, 'Needs Triage');
    await expect(blRow(page, view, '4 Build to GitHub')).toBeVisible();
  });

  test('the inspector shows the whole body, wrapped to its width at 400 px', async ({ page, api, fresh }) => {
    const lines = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a body long enough to have been cut at six lines before.`);
    const body = ['# A long body', '', ...lines, '', '```', `const unbroken = '${'x'.repeat(160)}';`, '```', '', 'FINAL LINE'].join('\n');
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['4 Build to GitHub']}`, { body });
    const { view } = await openRankedWith(page, api, fresh, ['4 Build to GitHub']);
    await page.setViewportSize({ width: 400, height: 900 });
    const inspector = await openInspector(blRow(page, view, '4 Build to GitHub'));
    await expect(inspector.getByText('FINAL LINE')).toBeVisible();
    await expect(inspector.getByRole('button', { name: 'Show all' })).toHaveCount(0);
    type Box = { clientWidth: number; scrollWidth: number; clientHeight: number; scrollHeight: number; getBoundingClientRect(): { right: number } };
    const fits = await inspector.evaluate((el: Box & { querySelector(s: string): Box | null }) => {
      const b = el.querySelector('.ip-insp-body')!;
      return { right: b.getBoundingClientRect().right - el.getBoundingClientRect().right, hiddenY: b.scrollHeight - b.clientHeight };
    });
    // The body ends inside the inspector (the code block scrolls in itself), and nothing is cut at the foot.
    expect(fits.right).toBeLessThanOrEqual(0);
    expect(fits.hiddenY).toBeLessThanOrEqual(1);
  });

  test('Enter opens the inspector and Escape closes it, with focus on its row', async ({ page, api, fresh }) => {
    const { view } = await openRankedWith(page, api, fresh, ['4 Build to GitHub']);
    const row = blRow(page, view, '4 Build to GitHub');
    const inspector = row.getByRole('group', { name: /^Inspector for #/ });
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(inspector).toBeVisible();
    await expect(row).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(inspector.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test("the Band select keeps focus when the row moves to another band's list", async ({ page, api, fresh }) => {
    const { view } = await openRankedWith(page, api, fresh, ['3 RevenueCat', '4 Build to GitHub']);
    await rank(api, fresh, { node: fresh.ids['5 Store listing'], to: 'someday', before: null });
    const someday = view.getByRole('region', { name: 'Someday' });
    await someday.getByRole('button', { name: /^Show/ }).click();
    const inspector = await openInspector(blRow(page, view, '4 Build to GitHub'));
    const bandSelect = inspector.getByRole('combobox', { name: 'Band' });
    await bandSelect.focus();
    await bandSelect.selectOption('someday');
    const moved = blRow(page, someday, '4 Build to GitHub');
    await expect(moved).toBeVisible();
    await expect(moved.getByRole('combobox', { name: 'Band' })).toBeFocused();
  });

  test('a refused Band change says so in the open inspector, puts the old band back and keeps focus on the select', async ({ page, api, fresh, consoleErrors }) => {
    consoleErrors.allow(/status of 409/);
    const { view } = await openRankedWith(page, api, fresh, ['3 RevenueCat', '4 Build to GitHub']);
    await rank(api, fresh, { node: fresh.ids['5 Store listing'], to: 'someday', before: null });
    const someday = view.getByRole('region', { name: 'Someday' });
    await someday.getByRole('button', { name: /^Show/ }).click();
    await page.route('**/api/ui/projects/*/rank', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for the test' }) }));
    const inspector = await openInspector(blRow(page, view, '4 Build to GitHub'));
    const bandSelect = inspector.getByRole('combobox', { name: 'Band' });
    await bandSelect.focus();
    await bandSelect.selectOption('someday');
    const back = blRow(page, view.getByRole('region', { name: 'Soon' }), '4 Build to GitHub');
    const again = back.getByRole('group', { name: /^Inspector for #/ });
    await expect(again.getByRole('alert')).toHaveText(/Refused for the test/);
    await expect(again.getByRole('combobox', { name: 'Band' })).toHaveValue('soon');
    await expect(again.getByRole('combobox', { name: 'Band' })).toBeFocused();
  });

  test('a refused Band change whose inspector has closed says so in the status line', async ({ page, api, fresh, consoleErrors }) => {
    consoleErrors.allow(/status of 409/);
    const { view } = await openRankedWith(page, api, fresh, ['3 RevenueCat', '4 Build to GitHub']);
    // Someday stays folded: the guess takes the row out of view, which closes its inspector before the answer.
    await page.route('**/api/ui/projects/*/rank', async (route) => {
      await new Promise((r) => setTimeout(r, 300));
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for the test' }) });
    });
    const inspector = await openInspector(blRow(page, view, '4 Build to GitHub'));
    await inspector.getByRole('combobox', { name: 'Band' }).selectOption('someday');
    await expect(statusLine(page).filter({ hasText: 'Refused for the test' })).toBeVisible();
    await expect(blRow(page, view.getByRole('region', { name: 'Soon' }), '4 Build to GitHub')).toBeVisible();
  });
});

test('the Backups panel shows status, backs up to a local remote and opens the folder', async ({ page, fresh }) => {
  test.setTimeout(120_000);
  const bareDir = mkdtempSync(join(tmpdir(), 'ip-e2e-remote-'));
  const bare = join(bareDir, 'remote.git');
  const clone = '.e2e-home/offsite';
  // No hooks: the user's global ones cost seconds a git call; the clone's own config makes the server's commit and push skip them too.
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare], { stdio: 'ignore' });
  execFileSync('git', ['-c', `core.hooksPath=${join(bareDir, 'no-hooks')}`, 'clone', '-q', bare, clone], { stdio: 'ignore' });
  execFileSync('git', ['-C', clone, 'config', 'core.autocrlf', 'false']);
  // A detached auto-gc or a file-system monitor daemon would hold the folder open when the test removes it.
  execFileSync('git', ['-C', clone, 'config', 'maintenance.auto', 'false']);
  execFileSync('git', ['-C', clone, 'config', 'gc.auto', '0']);
  execFileSync('git', ['-C', clone, 'config', 'core.fsmonitor', 'false']);
  execFileSync('git', ['-C', clone, 'config', 'core.hooksPath', join(clone, '.git', 'no-hooks')]);
  const lock = join(clone, '.git', 'inprogress-backup.lock');
  try {
    await open(page, fresh);
    const footerButton = page.locator('.ip-footer').getByRole('button', { name: 'Backups' });
    const panel = page.getByRole('dialog', { name: 'Backups' });
    const row = (label: string) => panel.locator('.ip-backups-row', { has: page.getByText(label, { exact: true }) });
    const backUp = panel.getByRole('button', { name: /^(Back up now|Backing up…)$/ });

    // C1: the newest snapshot (the server's start wrote one), and nothing pushed yet.
    await footerButton.click();
    await expect(panel).toBeVisible();
    // Focus starts on the dialog, not on Back up now: Enter twice from the footer must not start a backup.
    await expect(panel).toBeFocused();
    await expect(row('Snapshot')).toContainText(/inprogress-\d{8}-\d{6}\.db · /);
    await expect(row('Pushed')).toContainText('nothing pushed yet');

    // C4: Open backups folder asks the server once; the real one would open a file manager.
    let opened = 0;
    await page.route('**/api/ui/backups/open-folder', (route) => {
      opened++;
      return route.fulfill({ json: { ok: true } });
    });
    await panel.getByRole('button', { name: 'Open backups folder' }).click();
    await expect.poll(() => opened).toBe(1);

    // C5: the restore commands, the last naming the offsite clone. There is no restore button.
    await expect(panel.locator('code')).toHaveCount(3);
    await expect(panel.locator('code').nth(2)).toContainText('inprogress restore --from');
    await expect(panel.locator('code').nth(2)).toContainText('offsite');
    await expect(panel.getByRole('button', { name: /^Restore/ })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Copy inprogress stop' }).click();
    await expect(panel.getByRole('button', { name: 'Copy inprogress stop' })).toHaveText('Copied');
    expect(await page.evaluate('navigator.clipboard.readText()')).toBe('inprogress stop');

    // C2: Back up now disables itself, then reports, and the remote holds one Backup commit.
    await backUp.click();
    await expect(backUp).toBeDisabled();
    await expect(backUp).toHaveText('Backing up…');
    await expect(panel.getByRole('status')).toHaveText('Backed up and pushed.', { timeout: 60_000 });
    await expect(backUp).toHaveText('Back up now');
    await expect(backUp).toBeEnabled();
    // The run parked focus on the dialog and nothing moved it, so it returns to the button.
    await expect(backUp).toBeFocused();
    await expect(row('Pushed')).toContainText('0 h ago');
    const subjects = execFileSync('git', ['--git-dir', bare, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim().split('\n');
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatch(/^Backup /);

    // C6: Escape closes, and focus returns to the footer button.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(footerButton).toBeFocused();

    // C3: another run holds the lock.
    writeFileSync(lock, 'someone else');
    await footerButton.click();
    await expect(backUp).toBeDisabled();
    await expect(panel.getByRole('status')).toContainText('Another backup is running');
    rmSync(lock, { force: true });
    // The panel looks again every 3 s while it is busy.
    await expect(backUp).toBeEnabled({ timeout: 10_000 });
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
    await expect(footerButton).toBeFocused();
  } finally {
    // A git the panel's last status read started may still hold the folder for a moment. Windows can hold it longer
    // (docs/known-issues.md, "The first npm test run fails a file"): a leftover is harmless, since start-server.mjs
    // wipes .e2e-home on every run and no other test reads the backups, so the cleanup never fails the test.
    for (const dir of [clone, bareDir]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (err) {
        console.warn(`Left ${dir} behind: ${(err as Error).message}`);
      }
    }
  }
});
