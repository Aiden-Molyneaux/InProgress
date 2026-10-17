import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  const project = await post<{ slug: string; rootNodeId: number }>('/api/projects', { name, description: 'Seeded by Playwright' });
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
  return { slug: project.slug, root: project.rootNodeId, ids, session, ask: ask.id };
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

/** The Backlog fold at the foot of Next. */
const backlogFold = (page: Page) => page.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ });

/** Opens the Backlog fold if it is closed: its steps are rows only while it is open. */
async function openBacklog(page: Page): Promise<void> {
  if ((await backlogFold(page).getAttribute('aria-expanded')) === 'false') await backlogFold(page).click();
}

/** Opens a step's Details from its row and answers the panel. Backlog steps need the fold open, so it opens first. */
async function openDetails(page: Page, title: string): Promise<Locator> {
  await openBacklog(page);
  await stepRow(page, title).click();
  const details = page.getByRole('complementary');
  await expect(details).toContainText(title);
  return details;
}

/** A resource's row in Details, by its title. */
const resourceRow = (page: Page, title: string) => page.locator('.ip-res', { hasText: title });

test('the view switch is remembered', async ({ page, demo }) => {
  await open(page, demo);
  const board = page.getByRole('button', { name: 'Board', exact: true });
  const project = page.getByRole('button', { name: 'Project', exact: true });
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
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Sections' })).toBeVisible();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
});

test('Details keeps the last good detail when a refresh fails', async ({ page, api, fresh, consoleErrors }) => {
  consoleErrors.allow(/status of 500/);
  await open(page, fresh);
  const id = fresh.ids['Run signing tests'];
  const details = await openDetails(page, 'Run signing tests');
  await expect(details).toContainText(`#${id} Run signing tests`);
  await page.route(`**/api/nodes/${id}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Database is busy' }) }));
  // Any change to the project makes Details refetch.
  await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['Play app signing']}`, { outcome: 'Configured' });
  await expect(details).toContainText("Couldn't refresh: Database is busy");
  await expect(details).toContainText(`#${id} Run signing tests`);
  await expect(details.getByRole('button', { name: `Copy #${id}` })).toBeVisible();
});

test('Details closes when its node is deleted, and stays open when another node goes', async ({ page, api, fresh }) => {
  await open(page, fresh);
  const id = fresh.ids['3 RevenueCat'];
  await openBacklog(page);
  await expect(stepRow(page, '7 Launch')).toBeVisible();
  const details = await openDetails(page, '3 RevenueCat');
  await expect(details).toContainText(`#${id} 3 RevenueCat`);
  await write(api, fresh.session, 'delete', `/api/nodes/${fresh.ids['7 Launch']}`);
  // 7 Launch leaving the Board shows that the snapshot without it has landed.
  await expect(stepRow(page, '7 Launch')).toHaveCount(0);
  await expect(details).toContainText(`#${id} 3 RevenueCat`);
  await write(api, fresh.session, 'delete', `/api/nodes/${id}`);
  await expect(details).toBeHidden();
  await expect(page.getByText("Couldn't refresh")).toHaveCount(0);
});

test('a long project name is cut short and the top bar stays on one line', async ({ page, api }) => {
  const name = 'A project name long enough to fill a narrow window several times over, and then some';
  const project = await seed(api, name);
  await open(page, project);
  await expect(page).toHaveTitle(/A project name long enough/);
  const tab = page.getByRole('tab', { selected: true });
  await expect(tab).toHaveAttribute('title', name);
  for (const control of [tab, page.getByRole('button', { name: 'Board', exact: true }), page.getByRole('button', { name: 'Project', exact: true })]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  expect((await page.locator('.ip-topbar').boundingBox())!.height, 'one line of tabs').toBeLessThan(50);
  expect(await page.evaluate<boolean>(`(() => { const n = document.querySelector('[role="tab"][aria-selected="true"] .ip-tab-name'); return n.scrollWidth > n.clientWidth; })()`)).toBe(true);
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

test('says so when the server is unreachable at first paint, then recovers', async ({ page, demo, consoleErrors }) => {
  consoleErrors.allow(/ERR_CONNECTION_REFUSED/);
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await open(page, demo);
  await expect(page.getByText("Can't reach the InProgress server, retrying…")).toBeVisible();
  await page.unroute('**/api/**');
  await expect(page.locator('.ip-view-name')).toBeVisible({ timeout: 10_000 });
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
  await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, after: 'start', nodes: [{ title: 'Hotfix', status: 'active' }] });
  // Untargeted and right behind it: the two replay in one chunk, and React renders them as one batch.
  await write(api, fresh.session, 'post', `/api/sessions/${fresh.session}/hook`, { event: 'stop' });
  release();
  await openBacklog(page);
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

/** A todo step under a bare project's root, so its Board has a row to open. */
const addStep = (api: APIRequestContext, project: { rootNodeId: number }, title: string) =>
  write(api, `e2e-${randomUUID()}`, 'post', '/api/nodes', { parentId: project.rootNodeId, nodes: [{ title }] });

const tabFor = (page: Page, name: string) => page.getByRole('tablist').getByRole('tab', { name });

/** The tabs' titles (each project's full name), in strip order. */
async function tabTitles(page: Page): Promise<(string | null)[]> {
  const tabs = page.getByRole('tab');
  return Promise.all(Array.from({ length: await tabs.count() }, (_, i) => tabs.nth(i).getAttribute('title')));
}

const STRIP = `document.querySelector('[role="tablist"]')`;
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
  await expect(tabFor(page, olderName)).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, newerName)).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
  const titles = await tabTitles(page);
  expect(titles.indexOf(olderName)).toBeGreaterThanOrEqual(0);
  expect(titles.indexOf(olderName)).toBeLessThan(titles.indexOf(newerName));
  await tabFor(page, newerName).click();
  await expect(tabFor(page, newerName)).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, olderName)).toHaveAttribute('aria-selected', 'false');
  await expect(page).toHaveURL(new RegExp(`#/p/${newer.slug}$`));
  await expect(page).toHaveTitle(`(1) InProgress · ${newerName}`);
  await expect(page.locator('.ip-view-name')).toContainText(newerName);
  // A visit with no project in the URL opens the one picked last.
  await page.goto('/');
  await expect(tabFor(page, newerName)).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`#/p/${newer.slug}$`));
});

test('a tab drags to a new place, Alt+arrows move the focused tab, and the order holds across a reload', async ({ page, api }) => {
  await widen(page);
  const names = [unique('Tabs drag a'), unique('Tabs drag b'), unique('Tabs drag c')];
  await bare(api, names[0]);
  const b = await bare(api, names[1]);
  await bare(api, names[2]);
  /** Our projects' titles, in strip order, among whatever other tests left. */
  const ours = async (extra: string[] = []) => (await tabTitles(page)).filter((t) => [...names, ...extra].includes(t ?? ''));
  await page.goto(`/#/p/${b.slug}`);
  await expect(tabFor(page, names[2])).toBeVisible();
  expect(await ours()).toEqual(names);
  // The newest tab dragged onto the left half of the oldest lands before it.
  await tabFor(page, names[2]).dragTo(tabFor(page, names[0]), { targetPosition: { x: 4, y: 10 } });
  await expect.poll(() => ours()).toEqual([names[2], names[0], names[1]]);
  // The drag did not open the tab: the selection stayed on b.
  await expect(tabFor(page, names[1])).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(tabFor(page, names[2])).toBeVisible();
  expect(await ours()).toEqual([names[2], names[0], names[1]]);
  // Alt+Right moves the focused tab one place right and leaves focus on it. It neither selects a tab nor goes back.
  await tabFor(page, names[0]).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => ours()).toEqual([names[2], names[1], names[0]]);
  await expect(tabFor(page, names[0])).toBeFocused();
  await expect(tabFor(page, names[1])).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`#/p/${b.slug}$`));
  // A tab dragged to the right keeps the focus its press gave it, so the keys still reach the strip. Chromium keeps it
  // even without TabStrip's refocus after a drop, so this checks the outcome, not that guard.
  const last = (await tabFor(page, names[0]).boundingBox())!;
  await tabFor(page, names[2]).dragTo(tabFor(page, names[0]), { targetPosition: { x: last.width - 4, y: 10 } });
  await expect.poll(() => ours()).toEqual([names[1], names[0], names[2]]);
  await expect(tabFor(page, names[2])).toBeFocused();
  // A project made after the move joins at the end.
  const fourth = unique('Tabs drag d');
  await bare(api, fourth);
  await expect(tabFor(page, fourth)).toBeVisible();
  expect(await ours([fourth])).toEqual([names[1], names[0], names[2], fourth]);
});

test('a tab dragged near the edge of a narrow strip scrolls it', async ({ page, api }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  const names = [1, 2, 3, 4, 5].map((n) => unique(`Tabs edge ${n}`));
  for (const name of names) await bare(api, name);
  await page.goto('/');
  await expect(tabFor(page, names[4])).toBeAttached();
  // The window has opened a project and revealed its tab, so nothing else scrolls the strip from here.
  await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
  expect(await page.evaluate<boolean>(`${STRIP}.scrollWidth > ${STRIP}.clientWidth`), 'the tabs overflow').toBe(true);
  await page.evaluate(`${STRIP}.scrollLeft = 0`);
  const box = (await page.locator('.ip-tabs').boundingBox())!;
  expect(box.x + box.width, 'the strip ends inside the window').toBeLessThanOrEqual(420);
  const first = (await page.getByRole('tab').first().boundingBox())!;
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

test('a tab shows how many items need you and, while a session works there, a pulsing dot', async ({ page, api }) => {
  const busyName = unique('Tabs busy');
  const quietName = unique('Tabs quiet');
  const busy = await seed(api, busyName);
  await bare(api, quietName);
  await open(page, busy);
  const busyTab = tabFor(page, busyName);
  const quietTab = tabFor(page, quietName);
  await expect(busyTab).toHaveAccessibleName(`${busyName}, 1 need you, working`);
  await expect(busyTab.locator('.ip-tab-count')).toHaveText('1');
  await expect(busyTab.locator('.ip-tab-dot')).toHaveCSS('animation-name', 'ip-pulse');
  await expect(quietTab).toHaveAccessibleName(quietName);
  await expect(quietTab.locator('.ip-tab-count, .ip-tab-dot')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(busyTab.locator('.ip-tab-dot')).toHaveCSS('animation-name', 'none');
  // Both follow the data, live.
  await write(api, busy.session, 'post', `/api/asks/${busy.ask}/clear`, {});
  await write(api, busy.session, 'post', `/api/sessions/${busy.session}/hook`, { event: 'stop' });
  await expect(busyTab).toHaveAccessibleName(busyName);
  await expect(busyTab.locator('.ip-tab-count, .ip-tab-dot')).toHaveCount(0);
});

test('archived projects move into the ⋯ menu, and picking one opens it', async ({ page, api }) => {
  const keptName = unique('Tabs kept');
  const shelvedName = unique('Tabs shelved');
  const kept = await bare(api, keptName);
  const shelved = await bare(api, shelvedName);
  await addStep(api, kept, 'Kept step');
  await write(api, `e2e-${randomUUID()}`, 'patch', `/api/projects/${shelved.slug}`, { status: 'archived' });
  await page.goto(`/#/p/${kept.slug}`);
  await expect(tabFor(page, keptName)).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, shelvedName)).toHaveCount(0);
  const more = page.getByRole('button', { name: 'Archived and deleted projects' });
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
  const shelvedTab = tabFor(page, shelvedName);
  await expect(shelvedTab).toHaveAttribute('aria-selected', 'true');
  await expect(shelvedTab).toHaveAccessibleName(`${shelvedName}, archived`);
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await tabFor(page, keptName).click();
  await expect(shelvedTab).toHaveCount(0);
});

test('[ and ] step through the tabs, wrapping round at the ends, and 1 to 9 jump to a tab', async ({ page, api }) => {
  const firstName = unique('Tabs step 1');
  const secondName = unique('Tabs step 2');
  const first = await bare(api, firstName);
  const second = await bare(api, secondName);
  await page.goto(`/#/p/${second.slug}`);
  const tabs = page.getByRole('tab');
  await expect(tabFor(page, secondName)).toHaveAttribute('aria-selected', 'true');
  // The newest project has the last tab.
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('[');
  await expect(tabFor(page, firstName)).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`#/p/${first.slug}$`));
  await page.keyboard.press(']');
  await expect(tabFor(page, secondName)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(']');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('[');
  await expect(tabFor(page, secondName)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('1');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('2');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('the tab keys are ignored with a modifier, while typing and while the resource viewer is open', async ({ page, api, demo }) => {
  // Somewhere else for ] to go.
  await bare(api, unique('Tabs ignored'));
  await widen(page);
  await open(page, demo);
  const here = new RegExp(`#/p/${demo.slug}$`);
  await expect(page.getByRole('tab', { selected: true })).toBeVisible();
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

test('when the tabs overflow the window, the wheel scrolls the strip and the current tab stays in view', async ({ page, api }) => {
  const names = Array.from({ length: 6 }, (_, i) => unique(`Tabs overflow ${i + 1}, a name of some length`));
  const made: { slug: string }[] = [];
  for (const name of names) made.push(await bare(api, name));
  // Opened on the second-to-last tab: it comes into view with a little of the last tab past it, a hint of more.
  await page.goto(`/#/p/${made[4].slug}`);
  const strip = page.getByRole('tablist');
  const last = tabFor(page, names[5]);
  await expect(tabFor(page, names[4])).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, names[4])).toBeInViewport({ ratio: 1 });
  const stripBox = (await strip.boundingBox())!;
  expect(stripBox.x + stripBox.width - (await last.boundingBox())!.x, 'the part of the last tab that shows').toBeGreaterThanOrEqual(16);
  await page.keyboard.press(']');
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(last).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate<boolean>(`${STRIP}.scrollWidth > ${STRIP}.clientWidth`), 'the tabs overflow').toBe(true);
  expect((await page.locator('.ip-topbar').boundingBox())!.height, 'one row of tabs').toBeLessThan(50);
  // The wheel scrolls the strip sideways.
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => stripScroll(page)).toBe(0);
  await expect(last).not.toBeInViewport();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => stripScroll(page)).toBeGreaterThan(0);
  // Ctrl+wheel is the browser's zoom, so the strip leaves it alone. Synthetic, so the test browser doesn't zoom.
  const scrolled = await stripScroll(page);
  const ctrlWheel = `${STRIP}.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, ctrlKey: true, cancelable: true }))`;
  expect(await page.evaluate<boolean>(ctrlWheel), 'Ctrl+wheel not cancelled').toBe(true);
  expect(await stripScroll(page)).toBe(scrolled);
  // A tab picked from the keyboard comes into view: ] from the last tab wraps round to the first, [ goes back.
  await page.keyboard.press(']');
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab').first()).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('[');
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(last).toBeInViewport({ ratio: 1 });
  // So does the current tab when the window narrows.
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => stripScroll(page)).toBe(0);
  await page.setViewportSize({ width: 420, height: 900 });
  await expect(last).toBeInViewport({ ratio: 1 });
});

test('the tab strip is one stop in the tab order, and the arrow keys move along it', async ({ page, api }) => {
  const leftName = unique('Tabs arrow left');
  const rightName = unique('Tabs arrow right');
  const left = await bare(api, leftName);
  await bare(api, rightName);
  await page.goto(`/#/p/${left.slug}`);
  await expect(tabFor(page, leftName)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(tabFor(page, leftName)).toHaveAttribute('tabindex', '0');
  await tabFor(page, leftName).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabFor(page, rightName)).toBeFocused();
  await expect(tabFor(page, rightName)).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, rightName)).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('ArrowLeft');
  await expect(tabFor(page, leftName)).toBeFocused();
  await expect(tabFor(page, leftName)).toHaveAttribute('aria-selected', 'true');
  // Tab leaves the strip rather than walking every tab.
  await page.keyboard.press('Tab');
  await expect(page.locator('[role="tab"]:focus')).toHaveCount(0);
});

// Archive and delete from the window. A project archived "elsewhere" goes through the scribe's update_project, as T930
// does. The suite's server is shared, so ⋯ also lists other tests' projects: every test finds its own by name.

const MORE = 'Archived and deleted projects';
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
  await expect(tabFor(page, hereName)).toHaveAttribute('aria-selected', 'true');
  // A listener after React's sees whether the browser's own menu was kept away.
  await page.evaluate(`window.__menus = []; window.addEventListener('contextmenu', (e) => window.__menus.push(e.defaultPrevented))`);
  const shelfTab = tabFor(page, shelfName);
  await shelfTab.click({ button: 'right' });
  const menu = tabMenu(page, shelfName);
  const items = menu.getByRole('menuitem');
  await expect(menu).toBeVisible();
  await expect(items).toHaveText(['Archive', 'Rename…', 'Delete…']);
  await expect(items.first()).toHaveAccessibleName('Archive');
  await expect(items.first()).toBeFocused();
  // The tab says whose menu it is, and is not opened by it.
  await expect(shelfTab).toHaveClass(/\bmenu-open\b/);
  await expect(shelfTab).toHaveAttribute('aria-selected', 'false');
  await expect(page).toHaveURL(hereIs(here.slug));
  expect(await page.evaluate<boolean[]>('window.__menus')).toEqual([true]);
  // Under its tab, and wholly in the window.
  const [menuBox, tabBox] = [(await menu.boundingBox())!, (await shelfTab.boundingBox())!];
  expect(menuBox.y).toBeGreaterThanOrEqual(tabBox.y + tabBox.height);
  await expect(menu).toBeInViewport({ ratio: 1 });
  await items.first().click();
  await expect(menu).toBeHidden();
  await expect(shelfTab).toHaveCount(0);
  await expect(statusLine(page)).toHaveText(`Archived ${shelfName}. It is under ⋯.`);
  // The window stays where it was, and focus is on its tab.
  await expect(tabFor(page, hereName)).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, hereName)).toBeFocused();
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
  const middle = tabFor(page, names[1]);
  await expect(middle).toHaveAttribute('aria-selected', 'true');
  await middle.focus();
  await page.keyboard.press('Shift+F10');
  await expect(tabMenu(page, names[1]).getByRole('menuitem', { name: 'Archive', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  // The tab to its right opens, as a browser does when a tab closes.
  await expect(middle).toHaveCount(0);
  await expect(tabFor(page, names[2])).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, names[2])).toBeFocused();
  await expect(page).toHaveURL(hereIs(made[2].slug));
  await expect(page).toHaveTitle(`InProgress · ${names[2]}`);
  await expect(statusLine(page)).toHaveText(`Archived ${names[1]}. It is under ⋯.`);
  // The newest project has the last tab, so archiving it opens the one to its left.
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('Enter');
  await expect(tabFor(page, names[0])).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, names[0])).toBeFocused();
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
  const keptTab = tabFor(page, keptName);
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
  await expect(tabFor(page, beforeName)).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, middleName)).toHaveCount(0);
  const more = moreButton(page);
  await expect(more).toHaveAttribute('title', MORE);
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
  await expect(statusLine(page)).toHaveText(`${middleName} is back in the tabs.`);
  await expect(more).toBeFocused();
  // Back between the projects made before and after it, and the window stays where it was.
  await expect(tabFor(page, middleName)).toBeVisible();
  const titles = await tabTitles(page);
  expect(titles.indexOf(middleName)).toBe(titles.indexOf(beforeName) + 1);
  expect(titles.indexOf(afterName)).toBe(titles.indexOf(middleName) + 1);
  await expect(tabFor(page, beforeName)).toHaveAttribute('aria-selected', 'true');
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
  const confirm = page.getByRole('dialog', { name: `Delete ${goneName}?` });
  const go = confirm.getByRole('button', { name: 'Delete', exact: true });
  await expect(confirm).toHaveAttribute('aria-modal', 'false');
  await expect(confirm).toHaveAccessibleDescription('Hidden now, removed for good after 30 days. Restore it from ⋯ until then.');
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
  await expect(statusLine(page)).toHaveText(`Deleted ${goneName}. Restore it from ⋯ within 30 days.`);
  await expect(more).toBeFocused();
  await expect(page).toHaveURL(hereIs(kept.slug));
  expect(await listedStatus(api, gone.slug)).toBeUndefined();
  // It waits under Recently deleted, after the archived projects and a hairline.
  await page.keyboard.press('ArrowDown');
  const deleted = menu.getByRole('group', { name: 'Recently deleted', exact: true });
  const restore = deleted.getByRole('menuitem', { name: `Restore ${goneName}`, exact: true });
  await expect(menu.getByRole('separator')).toHaveCount(1);
  await expect(deleted.locator('.ip-mi-row', { hasText: goneName })).toContainText('30 days left');
  await expect(restore).toHaveText('Restore');
  await expect(restore).toHaveAccessibleDescription('30 days left');
  await expect(menu.getByRole('menuitem', { name: goneName, exact: true })).toHaveCount(0);
  await restore.click();
  await expect(statusLine(page)).toHaveText(`Restored ${goneName}. It is under Archived in ⋯.`);
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
    await page.getByRole('dialog', { name: `Delete ${goneName}?` }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(statusLine(page)).toHaveText(`Deleted ${goneName}. Restore it from ⋯ within 30 days.`);
    await expect(more).toBeFocused();
  };
  // Restored while it is ⋯'s only row, it is under Archived at once: ⋯ never leaves the page (the same element stays),
  // so focus stays on it.
  const restoreGone = async () => {
    await more.click();
    await expect(menu.getByRole('menuitem')).toHaveText(['Restore']);
    await page.evaluate(`document.querySelector('.ip-archive-btn').setAttribute('data-probe', 'kept')`);
    await menu.getByRole('menuitem', { name: `Restore ${goneName}`, exact: true }).click();
    await expect(statusLine(page)).toHaveText(`Restored ${goneName}. It is under Archived in ⋯.`);
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('data-probe', 'kept');
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('group', { name: 'Archived', exact: true }).getByRole('menuitem', { name: goneName, exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
  };
  // Deleting the open archived project from ⋯ opens the tab before it, and focus stays on ⋯, where the delete began.
  await page.goto(`/#/p/${gone.slug}`);
  await expect(tabFor(page, goneName)).toHaveAttribute('aria-selected', 'true');
  await deleteGone();
  await expect(tabFor(page, hereName)).toHaveAttribute('aria-selected', 'true');
  await restoreGone();
  await expect(page).toHaveURL(hereIs(here.slug));
  // With no tab at all: the delete leaves only ⋯ and the empty text, and the restore still keeps focus on ⋯.
  shown.delete(here.id);
  await page.goto(`/#/p/${gone.slug}`);
  await page.reload();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await deleteGone();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.locator('.ip-empty')).toHaveText('No projects. Restore one from ⋯, or in a Claude session say "track this in InProgress".');
  await restoreGone();
  // Nothing else is listed, so it opens, as the list's fallback opens the first listed project.
  await expect(page).toHaveURL(hereIs(gone.slug));
  // Unarchive empties ⋯: ⋯ goes, and focus lands on the project's tab.
  await more.click();
  await menu.getByRole('menuitem', { name: `Unarchive ${goneName}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`${goneName} is back in the tabs.`);
  await expect(more).toHaveCount(0);
  await expect(tabFor(page, goneName)).toBeFocused();
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
  const endTab = tabFor(page, endName);
  await expect(endTab).toHaveAttribute('aria-selected', 'true');
  await expect(endTab).toHaveAccessibleName(`${endName}, archived`);
  // The open archived project's tab offers Unarchive and Delete…, not Archive.
  await endTab.focus();
  await page.keyboard.press('Shift+F10');
  const menu = tabMenu(page, endName);
  await expect(menu.getByRole('menuitem')).toHaveText(['Unarchive', 'Rename…', 'Delete…']);
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete…' })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog', { name: `Delete ${endName}?` });
  await expect(confirm.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  // It was the last tab: the one before it opens, and has focus.
  await expect(endTab).toHaveCount(0);
  await expect(tabFor(page, prevName)).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, prevName)).toBeFocused();
  await expect(page).toHaveURL(hereIs(prev.slug));
  await expect(statusLine(page)).toHaveText(`Deleted ${endName}. Restore it from ⋯ within 30 days.`);
  // A link to it never paints it: another project opens.
  await page.goto(`/#/p/${end.slug}`);
  await expect(page).not.toHaveURL(hereIs(end.slug));
  await expect(page.getByRole('tab', { selected: true })).toBeVisible();
  await expect(page).not.toHaveTitle(new RegExp(endName));
  await expect(tabFor(page, endName)).toHaveCount(0);
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
  await page.getByRole('dialog', { name: `Delete ${goneName}?` }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(statusLine(page)).toHaveText(`Deleted ${goneName}. Restore it from ⋯ within 30 days.`);
  // The tab beside it, not the list's fallback.
  await expect(page).toHaveURL(hereIs(kept.slug));
  await expect(page).toHaveTitle(`InProgress · ${keptName}`);
  expect(asked).toEqual([]);
  // Restored, it opens as any archived project does.
  await more.click();
  await menu.getByRole('menuitem', { name: `Restore ${goneName}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`Restored ${goneName}. It is under Archived in ⋯.`);
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
  await expect(tabFor(page, hereName)).toHaveAttribute('aria-selected', 'true');
  const busyTab = tabFor(page, busyName);
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
  const confirm = page.getByRole('dialog', { name: `Delete ${busyName}?` });
  const go = confirm.getByRole('button', { name: 'Delete', exact: true });
  await expect(confirm).toHaveAccessibleDescription('Hidden now, removed for good after 30 days. Restore it from ⋯ until then. Stops tracking 1 session');
  const note = confirm.getByText('Stops tracking 1 session', { exact: true });
  await expect(note).toBeVisible();
  await expect(note).toHaveCSS('color', await tokenColour(page, '--muted'));
  await expect(note).toHaveCSS('font-size', '11px');
  await expect(go).toBeFocused();
  // Escape goes back to the menu, on Delete….
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(go).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(busyTab).toHaveCount(0);
  await expect(statusLine(page)).toHaveText(`Deleted ${busyName}. Restore it from ⋯ within 30 days.`);
  // Not the open project: the window stays where it was, and focus is on its tab.
  await expect(tabFor(page, hereName)).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, hereName)).toBeFocused();
  await expect(page).toHaveURL(hereIs(here.slug));
  expect(await listed(api, busy.slug)).toBeUndefined();
  // Restore brings it back under Archived, its session no longer tracked.
  await moreButton(page).click();
  await moreMenu(page).getByRole('menuitem', { name: `Restore ${busyName}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`Restored ${busyName}. It is under Archived in ⋯.`);
  await expect(busyTab).toHaveCount(0);
  expect(await listed(api, busy.slug)).toMatchObject({ status: 'archived', activeSessions: 0 });
});

test('deleting the open active project from its tab opens the tab beside it with focus there, and Unarchive after a restore puts the tab back', async ({ page, api }) => {
  const names = [unique('Active left'), unique('Active middle'), unique('Active right')];
  const made: { slug: string }[] = [];
  for (const name of names) made.push(await bare(api, name));
  await page.goto(`/#/p/${made[1].slug}`);
  const middle = tabFor(page, names[1]);
  await expect(middle).toHaveAttribute('aria-selected', 'true');
  await middle.focus();
  await page.keyboard.press('Shift+F10');
  const menu = tabMenu(page, names[1]);
  await expect(menu.getByRole('menuitem')).toHaveText(['Archive', 'Rename…', 'Delete…']);
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete…', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog', { name: `Delete ${names[1]}?` });
  // No session is live there, so the confirm has no line about one.
  await expect(confirm).toHaveAccessibleDescription('Hidden now, removed for good after 30 days. Restore it from ⋯ until then.');
  await expect(confirm.getByText(/Stops tracking/)).toHaveCount(0);
  await page.keyboard.press('Enter');
  // The tab to its right opens and has focus, as when the open project is archived.
  await expect(middle).toHaveCount(0);
  await expect(tabFor(page, names[2])).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, names[2])).toBeFocused();
  await expect(page).toHaveURL(hereIs(made[2].slug));
  await expect(page).toHaveTitle(`InProgress · ${names[2]}`);
  await expect(statusLine(page)).toHaveText(`Deleted ${names[1]}. Restore it from ⋯ within 30 days.`);
  expect(await listed(api, made[1].slug)).toBeUndefined();
  // The newest project has the last tab, so deleting it opens the one to its left.
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(tabFor(page, names[2])).toHaveCount(0);
  await expect(tabFor(page, names[0])).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, names[0])).toBeFocused();
  await expect(page).toHaveURL(hereIs(made[0].slug));
  // Restored, it is under Archived, not back in the tabs; Unarchive puts its tab back.
  const more = moreButton(page);
  await more.click();
  await moreMenu(page).getByRole('menuitem', { name: `Restore ${names[1]}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`Restored ${names[1]}. It is under Archived in ⋯.`);
  await expect(middle).toHaveCount(0);
  expect((await listed(api, made[1].slug))?.status).toBe('archived');
  await more.click();
  await moreMenu(page).getByRole('menuitem', { name: `Unarchive ${names[1]}`, exact: true }).click();
  await expect(statusLine(page)).toHaveText(`${names[1]} is back in the tabs.`);
  await expect(middle).toBeVisible();
  const titles = await tabTitles(page);
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
  const tab = tabFor(page, oldName);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
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
  await expect(page.locator('.ip-tab-menu')).toBeVisible();
  await expect(page.locator('.ip-tab-menu')).not.toHaveAttribute('role', /./);
  // Quiet's look: an M line in ink on the panel, inside a hairline.
  await expect(field).toHaveCSS('font-size', '12.5px');
  await expect(field).toHaveCSS('color', await tokenColour(page, '--text'));
  await expect(field).toHaveCSS('border-top-color', await tokenColour(page, '--border'));
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
  await expect(page.locator('.ip-tab-menu')).toBeHidden();
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
  const renamed = tabFor(page, newName);
  await expect(renamed).toHaveAttribute('aria-selected', 'true');
  await expect(renamed).toHaveAttribute('title', newName);
  await expect(renamed).toBeFocused();
  await expect(tabFor(page, oldName)).toHaveCount(0);
  await expect(page).toHaveTitle(`InProgress · ${newName}`);
  await expect(statusLine(page)).toHaveText(`Renamed to ${newName}.`);
  await expect(page.locator('.ip-view-name')).toContainText(newName);
  await expect(page.locator('.ip-act-who')).toHaveText('you');
  await expect(page.locator('.ip-act-what')).toHaveText('renamed the project');
  // Display only: the slug, so the URL and every link, stays.
  await expect(page).toHaveURL(hereIs(made.slug));
  expect(await listedById(api, made.id)).toMatchObject({ slug: made.slug, name: newName });
  await page.reload();
  await expect(tabFor(page, newName)).toHaveAttribute('aria-selected', 'true');
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
  const tab = tabFor(page, oldName);
  await expect(tab).toHaveAccessibleName(`${oldName}, archived`);
  await tab.click({ button: 'right' });
  const menu = tabMenu(page, oldName);
  await expect(menu.getByRole('menuitem')).toHaveText(['Unarchive', 'Rename…', 'Delete…']);
  await menu.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  await page.getByRole('textbox', { name: `Rename ${oldName}`, exact: true }).fill(newName);
  await page.keyboard.press('Enter');
  await expect(tabFor(page, newName)).toHaveAccessibleName(`${newName}, archived`);
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
  const tab = page.getByRole('tab', { selected: true });
  await expect(tab).toHaveAccessibleName(/, archived$/);
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(hereIs(fresh.slug));
  await expect(page.locator('.ip-activity')).toContainText('archived the project');
  // Not the window's own action, so no status line.
  await expect(statusLine(page)).toHaveText('');
});

test('the menus and the confirm wear Quiet, by day and by night', async ({ page, api }) => {
  const keptName = unique('Look kept');
  const shelfName = unique('Look shelf');
  const kept = await bare(api, keptName);
  await archiveByScribe(api, (await bare(api, shelfName)).slug);
  await page.goto(`/#/p/${kept.slug}`);
  await expect(tabFor(page, keptName)).toHaveAttribute('aria-selected', 'true');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const [float, border, text, text2, muted, red] = await Promise.all(['--float', '--border', '--text', '--text-2', '--muted', '--red'].map((t) => tokenColour(page, t)));
    const surface = async (l: Locator) => {
      await expect(l).toHaveCSS('background-color', float);
      await expect(l).toHaveCSS('border-top-width', '1px');
      await expect(l).toHaveCSS('border-top-color', border);
      await expect(l).toHaveCSS('border-radius', '8px');
      await expect(l).toHaveCSS('box-shadow', 'none');
    };
    // A tab's menu, and its tab in ink.
    await tabFor(page, keptName).click({ button: 'right' });
    const menu = tabMenu(page, keptName);
    await surface(menu);
    await expect(menu.getByRole('menuitem', { name: 'Archive', exact: true })).toHaveCSS('font-size', '12.5px');
    await expect(menu.getByRole('menuitem', { name: 'Delete…', exact: true })).toHaveCSS('font-size', '12.5px');
    await expect(tabFor(page, keptName)).toHaveCSS('color', text);
    await page.keyboard.press('Escape');
    // ⋯: heads S at 900 in muted ink, rows M, actions S.
    await moreButton(page).click();
    const more = moreMenu(page);
    await surface(more);
    const head = more.locator('.ip-label').first();
    await expect(head).toHaveCSS('font-size', '11px');
    await expect(head).toHaveCSS('font-weight', '900');
    await expect(head).toHaveCSS('color', muted);
    await expect(more.getByRole('menuitem', { name: shelfName, exact: true })).toHaveCSS('font-size', '12.5px');
    const ask = more.getByRole('menuitem', { name: `Delete ${shelfName}`, exact: true });
    await expect(ask).toHaveCSS('font-size', '11px');
    // The confirm: the same surface, its question M at 900, and Delete in ink with an ink border, never red.
    await ask.click();
    const confirm = page.getByRole('dialog', { name: `Delete ${shelfName}?` });
    await surface(confirm);
    await expect(confirm.locator('b')).toHaveCSS('font-weight', '900');
    await expect(confirm.locator('b')).toHaveCSS('font-size', '12.5px');
    const go = confirm.getByRole('button', { name: 'Delete', exact: true });
    await expect(go).toHaveCSS('color', text2);
    await expect(go).toHaveCSS('border-top-color', text);
    expect(red, '--red differs from the ink Delete wears').not.toBe(text2);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(more).toBeHidden();
  }
});

test("a tab's menu stays inside a narrow window, and a strip scroll closes it", async ({ page, api }) => {
  const names = Array.from({ length: 3 }, (_, i) => unique(`Narrow menu ${i + 1}, a name of some length`));
  const made: { slug: string }[] = [];
  for (const name of names) made.push(await bare(api, name));
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(`/#/p/${made[2].slug}`);
  // The newest project's tab is the last, at the strip's right end.
  const last = tabFor(page, names[2]);
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(last).toBeInViewport({ ratio: 1 });
  await last.click({ button: 'right' });
  const menu = tabMenu(page, names[2]);
  await expect(menu).toBeInViewport({ ratio: 1 });
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(420 - 8 + 0.5);
  // Scrolled away from its tab, it would point at nothing: it closes.
  const strip = (await page.getByRole('tablist').boundingBox())!;
  await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2);
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => stripScroll(page)).toBe(0);
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
  const tab = tabFor(page, name);
  const dot = tab.locator('.ip-tab-dot');
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
  await expect(dot).toHaveClass(/\bstill\b/);
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
    // The live work reads before the step's resources.
    await expect(details.locator('.ip-label')).toHaveText(['Working tasks', 'Subagents', 'Resources']);
    // Each entry sits on its own soft row, and the heads read in --text-2, so sections and entries read apart.
    for (const entry of [details.locator('.ip-wt').first(), details.locator('.ip-dagent'), details.locator('.ip-res')]) {
      await expect(entry).toHaveCSS('background-color', 'rgba(15, 23, 42, 0.05)');
    }
    await expect(details.locator('.ip-label').first()).toHaveCSS('color', 'rgb(30, 41, 59)');
    // A resource's row deepens on hover and its title takes full ink.
    await details.locator('.ip-res').hover();
    await expect(details.locator('.ip-res')).toHaveCSS('background-color', 'rgba(15, 23, 42, 0.08)');
    await expect(details.locator('.ip-res b')).toHaveCSS('color', 'rgb(15, 23, 42)');
    // Anchored: the next row's "after Upload the key" names it too.
    await expect(details.locator('.ip-wt', { hasText: /^◐ Upload the key/ })).toHaveText('◐ Upload the key · E2E session');
    await expect(details.locator('.ip-wt', { hasText: 'Check the release track' })).toHaveText('○ Check the release track · E2E session · after Upload the key');
    await expect(details.locator('.ip-wt', { hasText: 'Collect the screenshots' })).toHaveText('○ Collect the screenshots · Draft the store notes');
    await expect(details.locator('.ip-dagent')).toHaveText(new RegExp(`^Draft the store notes · sonnet · ${RUNNING}$`));
    // Quiet: the rows read as the canvas's. ◐ in the active ink and still.
    const upload = details.locator('.ip-wt', { hasText: /^◐ Upload the key/ });
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('color', 'rgb(194, 65, 12)');
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('animation-name', 'none');
  });

});

test.describe('Go to', () => {
  const field = (page: Page) => page.getByRole('combobox', { name: 'Go to a step' });
  const goToButton = (page: Page) => page.getByRole('button', { name: 'Go to a step' });
  const options = (page: Page) => page.getByRole('listbox', { name: 'Steps' }).getByRole('option');

  /** A project of its own with `nodes` under its root. Answers its slug and its top steps' ids by title. */
  async function project(api: APIRequestContext, name: string, nodes: unknown[]): Promise<{ id: number; slug: string; ids: Record<string, number> }> {
    const session = `e2e-${randomUUID()}`;
    const p = await write<{ id: number; slug: string; rootNodeId: number }>(api, session, 'post', '/api/projects', { name });
    const created = await write<{ id: number; title: string }[]>(api, session, 'post', '/api/nodes', { parentId: p.rootNodeId, nodes });
    return { id: p.id, slug: p.slug, ids: Object.fromEntries(created.map((n) => [n.title, n.id])) };
  }

  test('/ and Ctrl+K open it, Escape closes it back to the opener, Tab closes it, and the app keys wait while typing', async ({ page, api, demo }) => {
    // Somewhere else for ] and 1 to go.
    await bare(api, unique('Go to keys'));
    await widen(page);
    await open(page, demo);
    const here = hereIs(demo.slug);
    const tab = page.getByRole('tab', { selected: true });
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
    // The button opens it too, and Escape gives focus back to the button. Tab leaves and closes it.
    await goToButton(page).click();
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(goToButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(field(page)).toBeHidden();
    // Neither opens it from a text field.
    await page.evaluate(`document.body.append(Object.assign(document.createElement('input'), { id: 'typing' }))`);
    await page.locator('#typing').focus();
    await page.keyboard.press('/');
    await page.keyboard.press('Control+k');
    await expect(page.locator('#typing')).toHaveValue('/');
    await expect(field(page)).toBeHidden();
  });

  test("wears the menus' surface, under the bar at its right end", async ({ page, demo }) => {
    await open(page, demo);
    const button = (await goToButton(page).boundingBox())!;
    const bar = (await page.locator('.ip-topbar').boundingBox())!;
    expect(bar.x + bar.width - (button.x + button.width), 'at the right end').toBeLessThanOrEqual(8);
    await goToButton(page).click();
    const panel = page.locator('.ip-goto-menu');
    await expect(panel).toHaveCSS('background-color', await tokenColour(page, '--float'));
    await expect(panel).toHaveCSS('border-top-width', '1px');
    await expect(panel).toHaveCSS('border-top-color', await tokenColour(page, '--border'));
    await expect(panel).toHaveCSS('border-radius', '8px');
    await expect(panel).toHaveCSS('box-shadow', 'none');
    await expect(field(page)).toHaveCSS('font-size', '12.5px');
    const box = (await panel.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(520);
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
    await expect(details).toContainText(`#${launch} 7 Launch`);
    await expect(page).toHaveURL(hereIs(fresh.slug));
    // A step of another project: the project opens, then the step's Details.
    await page.keyboard.press('/');
    await page.keyboard.type(`#${notes}`);
    await expect(page.locator('.ip-goto-note')).toHaveText('1 step');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(hereIs(far.slug));
    await expect(field(page)).toBeHidden();
    await expect(details).toContainText(`#${notes} Old release notes`);
  });

  test('an unknown or deleted id says there is no such step, and the field stays open', async ({ page, api, demo }) => {
    const gone = await project(api, unique('Go to gone'), [{ title: 'Soon deleted' }, { title: 'Kept' }]);
    const deleted = gone.ids['Soon deleted'];
    await write(api, `e2e-${randomUUID()}`, 'delete', `/api/nodes/${deleted}`);
    await open(page, demo);
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
    await page.keyboard.press('/');
    await page.keyboard.type('#99999999');
    await page.keyboard.press('Enter');
    const panel = page.locator('.ip-goto-menu');
    await expect(panel).toContainText('No step #99999999');
    await expect(panel.locator('.ip-goto-note')).toHaveCSS('color', await tokenColour(page, '--muted'));
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
    await expect(tabFor(page, homeName)).toHaveAttribute('aria-selected', 'true');
    await goToButton(page).click();
    await page.keyboard.type(`${word.toLowerCase()} step`);
    await expect(options(page)).toHaveCount(2);
    await expect(options(page).nth(0)).toHaveAccessibleName(`#${home.ids[homeTitle]} ${homeTitle}, ${homeName}`);
    await expect(options(page).nth(1)).toHaveAccessibleName(`#${away.ids[awayTitle]} ${awayTitle}, ${awayName}`);
    await expect(options(page).nth(1).locator('.ip-goto-proj')).toHaveText(awayName);
    await expect(page.locator('.ip-goto-note')).toHaveText('2 steps');
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
    await expect(page.getByRole('complementary')).toContainText(`#${away.ids[awayTitle]} ${awayTitle}`);
    // More words narrow the list; none matching says so.
    await page.keyboard.press('/');
    await page.keyboard.type(`${word} home`);
    await expect(options(page)).toHaveCount(1);
    await page.keyboard.type(' nowhere');
    await expect(page.locator('.ip-goto-menu')).toContainText('No step titles match');
    await expect(options(page)).toHaveCount(0);
    // Away is the open project now, so its step leads. A click picks too.
    await field(page).fill(word);
    await expect(options(page)).toHaveCount(2);
    await expect(options(page).nth(0)).toContainText(awayTitle);
    await options(page).nth(1).click();
    await expect(page).toHaveURL(hereIs(home.slug));
    await expect(page.getByRole('complementary')).toContainText(`#${home.ids[homeTitle]} ${homeTitle}`);
  });

  test('Enter straight after typing picks the first step of the new list, never the row highlighted in the old one', async ({ page, api }) => {
    const word = `Wombat${randomUUID().slice(0, 6)}`;
    const titles = ['alpha one', 'alpha two', 'beta one', 'beta two'].map((t) => `${word} ${t}`);
    const made = await project(api, unique('Go to fast'), titles.map((title) => ({ title })));
    // Touched in order, so each list runs newest first: alpha two, alpha one; beta two, beta one.
    for (const title of titles) await write(api, `e2e-${randomUUID()}`, 'patch', `/api/nodes/${made.ids[title]}`, { outcome: 'touched' });
    await widen(page);
    await page.goto(`/#/p/${made.slug}`);
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
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
    await expect(page.locator('.ip-goto-hit[aria-selected="true"]')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary')).toContainText(`#${made.ids[titles[3]]} ${titles[3]}`);
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
    await expect(statusLine(page)).toHaveText(`No step #${step}`);
    await expect(goToButton(page)).toBeFocused();
    await expect(page.getByRole('complementary')).toHaveCount(0);
    // Its whole project is deleted after the list shows it: the project's address answers 404 and the window moves on.
    await page.keyboard.press('Enter');
    await page.keyboard.type(`${word} lost`);
    await expect(options(page)).toHaveCount(1);
    expect((await windowPost(page, `/api/ui/projects/${gone.id}/delete`, { slug: gone.slug })).status).toBe(200);
    await page.keyboard.press('Enter');
    await expect(statusLine(page)).toHaveText(`No step #${gone.ids[`${word} lost`]}`);
    await expect(page).not.toHaveURL(hereIs(gone.slug));
    await expect(goToButton(page)).toBeFocused();
  });
});

// The Board (spec 2.2, 2.3, 2.8): header lines, Needs me, Now and Done, at both widths.

const WIDE = { width: 1200, height: 900 };
const NARROW = { width: 800, height: 900 };
const band = (page: Page, name: 'needs' | 'now' | 'next' | 'done') => page.locator(`section.ip-band-${name}`);
/** The task box with this title in a band: every cell shares the one skeleton (`li.ip-card`). */
const boxIn = (page: Page, name: 'needs' | 'now' | 'next' | 'done', title: string) => band(page, name).locator('li.ip-card', { has: page.getByRole('button', { name: title, exact: true }) });
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
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const xs = await Promise.all((['needs', 'next', 'now', 'done'] as const).map(async (b) => (await band(page, b).boundingBox())!.x));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size, 'four columns side by side').toBe(4);
    const needs = boxIn(page, 'needs', 'Run signing tests');
    await expect(needs).toContainText('Which keystore signs the release?');
    await expect(needs.locator('.ip-st')).toHaveText('Question');
    await expect(needs.locator('.ip-time')).toHaveText(/^(now|\d+m)$/);
    await expect(needs.locator('.ip-sess')).toHaveText('No session: raised before sessions were tracked');
    await expect(needs.getByRole('button', { name: 'Answer…' })).toBeVisible();
    await expect(needs.getByRole('button', { name: 'Clear' })).toBeVisible();
    const now = nowRow(page, 'Play app signing');
    await expect(now.locator('.ip-sid')).toHaveText(`#${fresh.ids['Play app signing']}`);
    await expect(now.locator('.ip-sess-name')).toHaveText('E2E session');
    await expect(now.getByRole('button', { name: 'Open session ↗' })).toBeVisible();
    await expect(now.locator('.ip-st')).toHaveText('Working');
    // A Board box carries no character, session letter or breadcrumb.
    await expect(page.locator('.ip-bands .ip-char, .ip-bands .ip-crumb, .ip-bands .ip-num')).toHaveCount(0);
    const done = boxIn(page, 'done', 'Upload keystore');
    await expect(done).toContainText('The upload key was accepted by Play');
    await expect(done.locator('.ip-st')).toHaveText('✓ Done');
    expect(await band(page, 'done').locator('li.ip-card').count()).toBe(5);
    // Done steps with no outcome carry a mark, and the header counts the marked steps and names them.
    await expect(boxIn(page, 'done', '1 iOS certificate').locator('.ip-mark')).toHaveText('no outcome');
    await expect(page.locator('.ip-hygiene')).toHaveAttribute('title', new RegExp(`#${fresh.ids['1 iOS certificate']} no_outcome`));
    await expect(page.locator('.ip-hdr')).toContainText('No state note yet');
  });

  test('Board cells share one task box', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    // A step in Next: pulled up from the Backlog.
    const next = band(page, 'next');
    await next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ }).click();
    const toNext = next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) }).getByRole('button', { name: 'to Next' });
    await toNext.focus();
    await page.keyboard.press('Enter');
    await expect(boxIn(page, 'next', '3 RevenueCat')).toBeVisible();
    // One cell per task: the step pulled up has left the Backlog.
    await expect(next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) })).toHaveCount(0);
    const cells = [
      { band: 'needs', title: 'Run signing tests', state: 'Question' },
      { band: 'next', title: '3 RevenueCat', state: 'Ready' },
      { band: 'now', title: 'Play app signing', state: 'Working' },
      { band: 'done', title: 'Upload keystore', state: '✓ Done' },
    ] as const;
    for (const c of cells) {
      const box = boxIn(page, c.band, c.title);
      await expect(box.locator('.ip-sid'), c.band).toHaveText(`#${fresh.ids[c.title]}`);
      await expect(box.locator('.ip-st'), c.band).toHaveText(c.state);
      await expect(box.getByRole('button', { name: c.title, exact: true }), c.band).toBeVisible();
      await expect(box.locator('.ip-card-top .ip-time'), c.band).toBeVisible();
    }
    const needs = boxIn(page, 'needs', 'Run signing tests');
    await expect(needs.getByRole('button', { name: 'Answer…' })).toBeVisible();
    await expect(needs.getByRole('button', { name: 'Clear' })).toBeVisible();
    // One cell per task: the step with the ask is in Needs me and nowhere else.
    await expect(page.locator('.ip-bands li.ip-card', { has: page.getByRole('button', { name: 'Run signing tests', exact: true }) })).toHaveCount(1);
  });

  test('Backlog boxes share the task box with no hue, under their parent line', async ({ page, api, fresh }) => {
    // A Blocked step that sits in Backlog holds a hue by the state rule; the fold still shows none.
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['5 Store listing']}`, { status: 'blocked' });
    const snapshot = (await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { nodes: { id: number; hue: number | null }[] };
    expect(snapshot.nodes.find((n) => n.id === fresh.ids['5 Store listing'])?.hue).not.toBeNull();
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    await next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ }).click();
    const group = next.getByRole('region', { name: 'Backlog under Road to market' });
    await expect(group.locator('.ip-group-line')).toHaveText('Road to market');
    const boxes = next.locator('.ip-backlog li.ip-card');
    expect(await boxes.count()).toBeGreaterThan(1);
    const box = group.locator('li.ip-card', { has: page.getByRole('button', { name: '4 Build to GitHub', exact: true }) });
    await expect(box.locator('.ip-sid')).toHaveText(`#${fresh.ids['4 Build to GitHub']}`);
    await expect(box.locator('.ip-st')).toHaveText('Backlog');
    await expect(box.locator('.ip-card-top .ip-time')).toBeVisible();
    await expect(box.locator('.ip-foot')).toBeVisible();
    await expect(box.locator('.ip-sess')).toHaveCount(0);
    const blocked = group.locator('li.ip-card', { has: page.getByRole('button', { name: '5 Store listing', exact: true }) });
    await expect(blocked.locator('.ip-st')).toHaveText('Blocked');
    for (const b of await boxes.all()) expect(await b.getAttribute('style')).toBeNull();
    // A click on the box opens Details; its own buttons do not.
    await box.getByRole('button', { name: 'to Next' }).focus();
    await expect(box.getByRole('button', { name: 'to Next' })).toHaveCSS('opacity', '1');
    await box.click({ position: { x: 4, y: 4 } });
    await expect(page.getByRole('complementary')).toHaveCount(1);
  });

  test('narrow: the bands stack as Needs me, Now, Next, Done, and a Now box has no breadcrumb', async ({ page, fresh }) => {
    await page.setViewportSize(NARROW);
    await open(page, fresh);
    await expect(page.locator('.ip-band > h3:first-child')).toHaveText(['Needs me', 'Now', 'Next', 'Done']);
    const tops = await Promise.all((['needs', 'now', 'next', 'done'] as const).map(async (b) => (await band(page, b).boundingBox())!.y));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    await expect(nowRow(page, 'Play app signing')).toBeVisible();
    await expect(page.locator('.ip-crumb')).toHaveCount(0);
  });

  test('the header shows the state note as the Orchestrator with no Project view button, and lists a working session with no step', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'post', '/api/resources', { nodeId: fresh.root, kind: 'doc', title: 'State', purpose: 'state', content: '# Where we are\n\nSigning is half done. The tests come next.' });
    const second = `e2e-${randomUUID()}`;
    await write(api, second, 'post', `/api/sessions/${second}/enroll`, { project: fresh.slug, title: 'Second session' });
    await hook(api, second, { event: 'prompt' });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const header = page.locator('.ip-hdr');
    await expect(header.locator('.ip-msg-head')).toContainText(/Orchestrator · (now|\d+m)/);
    await expect(header).toContainText('Signing is half done.');
    await expect(header).not.toContainText('The tests come next');
    const sessions = header.getByRole('group', { name: 'No claimed step' });
    await expect(sessions).toContainText('Second session');
    await expect(sessions).toContainText('working');
    // The first session is on a Now row, so it is not listed here.
    await expect(sessions.locator('.ip-hdr-session')).toHaveCount(1);
    await expect(header.getByRole('button')).toHaveCount(0);
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
    const lines = nowRow(page, 'Play app signing').locator('.ip-sess');
    await expect(lines).toHaveCount(2);
    await expect(lines.first().locator('.ip-sess-name')).toHaveText('E2E session');
    await expect(lines.first().locator('.ip-role')).toHaveText('· drives');
    await expect(lines.nth(1).locator('.ip-sess-name')).toHaveText('Helper session');
    await expect(lines.nth(1).locator('.ip-role')).toHaveText('· helping');
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
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Sections' })).toBeVisible();
    const row = page.locator('.ip-orow', { has: page.getByRole('button', { name: '3 RevenueCat', exact: true }) });
    const mark = row.getByRole('img', { name: 'next, in the own queue of "Docs pass"' });
    await expect(mark).toHaveText('◆');
    await expect(row.locator('.ip-osess')).toContainText('Docs pass');
    await expect(page.locator(retired)).toHaveCount(0);
  });

  test('a permission wait is an amber box with the command and a way to open the session, and the step leaves Now while it waits', async ({ page, api, fresh }) => {
    await startCommand(api, fresh.session, 'b1', 'npm run build');
    await hook(api, fresh.session, { event: 'permission' });
    await open(page, fresh);
    const wait = boxIn(page, 'needs', 'Play app signing');
    await expect(wait.locator('.ip-st')).toHaveText('Permission');
    await expect(wait.locator('.ip-block')).toContainText('Allow a shell command');
    await expect(wait.locator('.ip-block .ip-code')).toHaveText('npm run build');
    await expect(wait.getByRole('button', { name: 'Open session to allow' })).toBeVisible();
    await expect(wait.locator('.ip-sess-name')).toHaveText('E2E session');
    await expect(wait).toHaveCSS('background-color', 'rgba(251, 191, 36, 0.18)');
    // A permission wait has no buttons of its own to clear it; the step shows in Needs me only.
    await expect(wait.getByRole('button', { name: /Answer|Clear/ })).toHaveCount(0);
    await expect(nowRow(page, 'Play app signing')).toHaveCount(0);
    // Going on ends the wait.
    await hook(api, fresh.session, { event: 'prompt' });
    await expect(wait).toHaveCount(0);
    await expect(nowRow(page, 'Play app signing').locator('.ip-st')).toHaveText('Working');
  });

  test('a permission wait with no running command reads Waiting for permission', async ({ page, api, fresh }) => {
    await hook(api, fresh.session, { event: 'permission' });
    await open(page, fresh);
    const wait = boxIn(page, 'needs', 'Play app signing');
    await expect(wait.locator('.ip-block')).toContainText('Waiting for permission');
    await expect(wait.locator('.ip-block .ip-code')).toHaveCount(0);
  });

  test('Open session shows the command to copy when the server cannot open it, and Copy puts it on the clipboard', async ({ page, fresh }) => {
    await page.route('**/api/ui/sessions/*/open-desktop', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, command: `claude --desktop --resume ${fresh.session}` }) }));
    await open(page, fresh);
    const box = nowRow(page, 'Play app signing');
    await box.getByRole('button', { name: 'Open session ↗' }).click();
    await expect(box.locator('.ip-sess-cmd .ip-code')).toHaveText(`claude --desktop --resume ${fresh.session}`);
    // Opening the session did not open Details.
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await box.getByRole('button', { name: 'Copy' }).click();
    await expect(box.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`claude --desktop --resume ${fresh.session}`);
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
    await box.getByRole('button', { name: 'Open session ↗' }).dblclick();
    await expect(box.locator('.ip-sess-cmd .ip-code')).toHaveText(`claude --desktop --resume ${fresh.session}`);
    await expect(box.locator('.ip-sys')).toHaveText("Launcher unavailable. Run it in the session's folder.");
    expect(calls).toBe(1);
    await expect(page.getByRole('complementary')).toHaveCount(0);
    refuse = false;
    await box.getByRole('button', { name: 'Open session ↗' }).click();
    await expect(box.getByRole('button', { name: 'Opening…' })).toHaveAttribute('aria-busy', 'true');
    await expect(box.locator('.ip-sess-cmd')).toHaveCount(0);
    expect(calls).toBe(2);
  });

  test('Open session: the server reason shows with its command, a null answer is a failure, and a 401 reloads the window', async ({ page, fresh, consoleErrors }) => {
    consoleErrors.allow(/status of 401/);
    let mode: 'reason' | 'null' | 'stale' = 'reason';
    await page.route('**/api/ui/sessions/*/open-desktop', async (route) => {
      if (mode === 'reason') await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, command: `claude --desktop --resume ${fresh.session}`, reason: 'Claude Code was not found on this computer' }) });
      else if (mode === 'null') await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      else await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });
    await open(page, fresh);
    const box = nowRow(page, 'Play app signing');
    await box.getByRole('button', { name: 'Open session ↗' }).click();
    await expect(box.locator('.ip-sys')).toHaveText('Claude Code was not found on this computer');
    mode = 'null';
    await box.getByRole('button', { name: 'Open session ↗' }).click();
    await expect(box.locator('.ip-sys')).toContainText("Run it in the session's folder.");
    await expect(box.locator('.ip-sess-cmd .ip-code')).toHaveText(`claude --desktop --resume ${fresh.session}`);
    mode = 'stale';
    const reloaded = page.waitForEvent('load');
    await box.getByRole('button', { name: 'Open session ↗' }).click();
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
    await expect(box.locator('.ip-block').filter({ hasText: 'Waiting for permission' })).toHaveCount(2);
    await expect(box.getByRole('button', { name: 'Open session to allow' })).toHaveCount(2);
    // A session shows in its line and its permission block, and again over an ask of its own when another session's block comes between: one launch, so every button of it reads Opening… and one request goes.
    await box.getByRole('button', { name: 'Open session to allow' }).first().click();
    await expect.poll(() => box.getByRole('button', { name: 'Opening…' }).count()).toBeGreaterThanOrEqual(2);
    // The other session's own button stays idle while the first launches: one read, with the launch still held.
    const other = box.locator('.ip-block').filter({ hasText: 'Waiting for permission' }).nth(1).getByRole('button', { name: /^Open session to allow$|^Opening…$/ });
    expect(await other.textContent()).toBe('Open session to allow');
    await box.getByRole('button', { name: 'Opening…' }).last().click();
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
    await expect(row.locator('.ip-st')).toHaveText('Review');
    await expect(row.locator('.ip-sess')).toHaveText('No session: raised before sessions were tracked');
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
    await nowRow(page, 'Play app signing').locator('.ip-sid').click();
    await expect(details).toContainText(`#${fresh.ids['Play app signing']} Play app signing`);
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await boxIn(page, 'done', 'Upload keystore').locator('.ip-sid').click();
    await expect(details).toContainText(`#${fresh.ids['Upload keystore']} Upload keystore`);
    await page.keyboard.press('Escape');
    await boxIn(page, 'needs', 'Run signing tests').getByRole('button', { name: 'Run signing tests', exact: true }).click();
    await expect(details).toContainText(`#${fresh.ids['Run signing tests']} Run signing tests`);
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
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const rows = band(page, 'done').locator('ol.ip-list > li');
    await expect(rows.nth(0)).toContainText('Newer step');
    await expect(rows.nth(1)).toHaveAttribute('role', 'separator');
    await expect(rows.nth(1)).toHaveText('New since you looked');
    await expect(rows.nth(2)).toContainText('Older step');
    await page.setViewportSize(NARROW);
    await expect(band(page, 'done').getByRole('button', { name: 'Newer step', exact: true })).toBeVisible();
    await expect(band(page, 'done').getByRole('button', { name: 'Older step', exact: true })).toHaveCount(0);
    await expect(band(page, 'done').locator('.ip-done-fold')).toHaveText('✓ 4 earlier');
  });

  test('All done opens the full list by time or by phase, a row opens Details, and Back returns to the Done column', async ({ page, api, fresh }) => {
    const titles = Array.from({ length: 7 }, (_, i) => `Listed step ${i + 1}`);
    await write(api, fresh.session, 'post', '/api/nodes', {
      parentId: fresh.root,
      nodes: [{ title: 'Release prep', children: titles.map((title) => ({ title, status: 'done' as const })) }],
    });
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    await expect(band(page, 'done').locator('li.ip-card')).toHaveCount(5);
    await band(page, 'done').getByRole('button', { name: /^All done · [0-9]+ ›$/ }).click();
    await expect(page.getByRole('button', { name: '‹ Board' })).toBeFocused();
    await expect(page.locator('.ip-board')).toHaveCount(0);
    for (const title of titles) await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await page.getByRole('button', { name: 'Phase', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Release prep · 7$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Listed step 3', exact: true }).click();
    const details = page.getByRole('complementary');
    await expect(details).toContainText('Listed step 3');
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await page.getByRole('button', { name: '‹ Board' }).click();
    await expect(band(page, 'done')).toBeVisible();
    await expect(band(page, 'done').getByRole('button', { name: /^All done · [0-9]+ ›$/ })).toBeFocused();
    // A reload lands on the Board, and the list opens again in the order picked last.
    await page.reload();
    await band(page, 'done').getByRole('button', { name: /^All done · [0-9]+ ›$/ }).click();
    await expect(page.getByRole('button', { name: 'Phase', exact: true })).toHaveAttribute('aria-pressed', 'true');
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
    await expect(box.locator('.ip-st')).toHaveText('Working');
    // The session stops with its workers still running: the box reads Idle and still counts the worker.
    await hook(api, fresh.session, { event: 'stop' });
    await expect(box.locator('.ip-st')).toHaveText('Idle');
    await expect(kin).toHaveText('1 subagent');
  });

  test('a session busy on a command shows a commands line, which ends with a check and then a bang when the Stop drops it', async ({ page, api, fresh }) => {
    await startCommand(api, fresh.session, 'b1', 'npm run test:e2e');
    await stopWith(api, fresh.session, [{ taskId: 'b1', commandHead: 'npm run test:e2e' }]);
    await open(page, fresh);
    const session = nowRow(page, 'Play app signing');
    const line = session.locator('.ip-cmd');
    await expect(session.locator('.ip-st')).toHaveText('Idle');
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
    await expect(session.locator('.ip-st')).toHaveText('Idle');
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
    await expect(row.locator('.ip-st')).toHaveText('Unattended');
    await expect(row.locator('.ip-sess')).toHaveText('No session is on it');
    await expect(row.locator('.ip-you')).toHaveCSS('color', 'rgb(146, 64, 14)');
  });

  test('a label is a glyph and its word in muted ink on the row, and Details names it in its meta line; its log entries wear Quiet', async ({ page, api, fresh }) => {
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['Play app signing']}`, { label: 'ui' });
    await open(page, fresh);
    const row = nowRow(page, 'Play app signing');
    const chip = row.getByRole('img', { name: 'ui' });
    await expect(chip).toHaveText('⧉ ui');
    await expect(chip).toHaveAttribute('title', 'ui');
    await expect(chip).toHaveCSS('color', 'rgb(71, 85, 105)');
    await expect(chip).toHaveCSS('font-variant-emoji', 'text');
    await row.getByRole('button', { name: 'Play app signing', exact: true }).click();
    // Beside kind and status: "active task · ⧉ ui · Claude".
    const meta = page.getByRole('complementary').locator('.ip-meta');
    await expect(meta.locator('.ip-meta-label')).toHaveText('· ⧉ ui');
    await expect(meta).toHaveText(/^active\s*task\s*· ⧉ ui\s*· Claude/);
    await expect(meta.locator('.ip-glyph')).toHaveCSS('font-variant-emoji', 'text');
    await expect(meta.locator('.ip-marker.m-active')).toHaveCount(1);
    await expect(meta.locator('.ip-pill')).toHaveCount(0);
    await expect(meta).toHaveCSS('font-size', '11px');
    await expect(meta).toHaveCSS('color', 'rgb(71, 85, 105)');
    // The log: the time in DM Mono, the text in ink, the session muted and upright. The entry arrives live.
    await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Play app signing']}/log`, { text: 'Uploaded the key', sessionId: fresh.session });
    const entry = page.getByRole('complementary').locator('.ip-log li');
    await expect(entry).toHaveText('just now · Uploaded the key · E2E session');
    await expect(entry.locator('.ip-log-time')).toHaveCSS('font-family', /DM Mono/);
    await expect(entry.locator('.ip-log-text')).toHaveCSS('color', 'rgb(30, 41, 59)');
    await expect(entry.locator('i')).toHaveCount(0);
  });

  test('a row opens Details, which copies a reference, wears Quiet, and lists its steps with their markers and YOU tag', async ({ page, demo }) => {
    await open(page, demo);
    const id = demo.ids['Run signing tests'];
    const details = await openDetails(page, 'Run signing tests');
    await expect(details).toContainText(`#${id} Run signing tests`);
    await details.getByRole('button', { name: `Copy #${id}` }).click();
    // The clipboard write has finished once the button says so.
    await expect(details.getByRole('button', { name: 'Copied' })).toBeVisible();
    // String form: the root tsconfig has no DOM lib, so `navigator` must not appear in test code.
    expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`#${id} Run signing tests`);
    // Quiet: an opaque sheet with an 8 px top radius, the title in L ink, 24 px hairline buttons.
    await expect(details).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(details).toHaveCSS('border-top-left-radius', '8px');
    const title = details.locator('header b');
    await expect(title).toHaveCSS('font-size', '15px');
    await expect(title).toHaveCSS('font-weight', '900');
    await expect(title).toHaveCSS('color', 'rgb(15, 23, 42)');
    await expect(details.getByRole('button', { name: 'Close' })).toHaveCSS('height', '24px');
    // Its steps draw the marker: a check when done, a still orange dot when active, the needs-you mark and YOU.
    await details.getByRole('button', { name: /2 Android signing/ }).click();
    await expect(details).toContainText(`#${demo.ids['2 Android signing']} 2 Android signing`);
    const steps = details.locator('.ip-kids li');
    await expect(steps).toHaveText([/Upload keystore$/, /Play app signing$/, /Run signing tests\s*YOU$/]);
    // The stylesheet draws the check, so the marker holds no text and the step's name starts with its #id.
    await expect(steps.nth(0).locator('.ip-marker.m-done')).toHaveText('');
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.ip-kids .ip-marker.m-done'), '::before').content`)).toMatch(/^"✓"/);
    await expect(steps.nth(0).getByRole('button')).toHaveAccessibleName(`#${demo.ids['Upload keystore']} Upload keystore`);
    const active = steps.nth(1).locator('.ip-marker.m-active');
    await expect(active).toHaveCSS('background-color', 'rgb(194, 65, 12)');
    await expect(active).toHaveCSS('animation-name', 'none');
    await expect(steps.nth(2).locator('.ip-marker.m-you')).toHaveCount(1);
    // Its YOU is the tag: amber ink on the amber tint, 18 px tall, S at 900.
    const you = steps.nth(2).locator('.ip-you');
    await expect(you).toHaveCSS('color', 'rgb(146, 64, 14)');
    await expect(you).toHaveCSS('background-color', 'rgba(251, 191, 36, 0.18)');
    await expect(you).toHaveCSS('height', '18px');
    await expect(you).toHaveCSS('font-weight', '900');
  });

  test('the Backlog fold opens, groups by parent, and quick-add keeps its field open until Escape', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    const fold = next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(next.getByRole('button', { name: '3 RevenueCat', exact: true })).toHaveCount(0);
    const opened = page.waitForRequest((r) => r.url().endsWith('/api/ui/events') && (r.postDataJSON() as { name: string }).name === 'backlog_open');
    await fold.click();
    await opened;
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    // The steps of Road to market sit under its title.
    const group = next.getByRole('region', { name: 'Backlog under Road to market' });
    await expect(group.locator('.ip-group-line')).toHaveText('Road to market');
    await expect(group.getByRole('button', { name: '3 RevenueCat', exact: true })).toBeVisible();
    const field = next.getByRole('textbox', { name: 'Add a step to the backlog' });
    await expect(field).toBeVisible();
    // "+ add" focuses the field; Enter creates under the root and leaves the field open, empty and focused.
    await next.getByRole('button', { name: '+ add' }).click();
    await expect(field).toBeFocused();
    await page.keyboard.type('First quick step');
    await page.keyboard.press('Enter');
    await expect(next.getByRole('region', { name: 'Backlog at the top level' }).getByRole('button', { name: 'First quick step', exact: true })).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('');
    await page.keyboard.type('Second quick step');
    await page.keyboard.press('Enter');
    await expect(next.getByRole('button', { name: 'Second quick step', exact: true })).toBeVisible();
    await expect(field).toBeFocused();
    await expect(page.getByRole('complementary')).toHaveCount(0);
    // Escape closes the field and puts focus back on "+ add".
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(next.getByRole('button', { name: '+ add' })).toBeFocused();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
  });

  test('the Backlog orders by phase or by id, forward or reverse, and keeps the choice after a reload', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    await openBacklog(page);
    const order = next.getByRole('group', { name: 'Backlog order' });
    const attrs = async (selector: string, name: string) => Promise.all((await next.locator(selector).all()).map((l) => l.getAttribute(name)));
    const ids = async () => (await attrs('.ip-backlog-row', 'data-node')).map(Number);
    const regions = () => attrs('.ip-backlog-group', 'aria-label');
    // Phase, forward, is the default: groups under each parent.
    await expect(order.getByRole('button', { name: 'Phase' })).toHaveAttribute('aria-pressed', 'true');
    await expect(order.getByRole('button', { name: 'Reverse' })).toHaveAttribute('aria-pressed', 'false');
    const phaseRegions = await regions();
    expect(phaseRegions).toContain('Backlog under Road to market');
    const phaseIds = await ids();
    // ID: one flat list, low to high, each box naming its parent.
    await order.getByRole('button', { name: 'ID' }).click();
    await expect(next.getByRole('region', { name: 'Backlog by id' })).toBeVisible();
    expect(await regions()).toEqual(['Backlog by id']);
    const up = await ids();
    expect(up).toEqual([...phaseIds].sort((a, b) => a - b));
    await expect(next.locator('.ip-backlog-row').filter({ hasText: '3 RevenueCat' }).locator('.ip-box-parent')).toHaveText('Road to market');
    // Reverse: high to low.
    await order.getByRole('button', { name: 'Reverse' }).click();
    await expect(order.getByRole('button', { name: 'Reverse' })).toHaveAttribute('aria-pressed', 'true');
    expect(await ids()).toEqual([...up].reverse());
    // The choice survives a reload.
    await page.reload();
    await openBacklog(page);
    await expect(order.getByRole('button', { name: 'ID' })).toHaveAttribute('aria-pressed', 'true');
    await expect(order.getByRole('button', { name: 'Reverse' })).toHaveAttribute('aria-pressed', 'true');
    expect(await ids()).toEqual([...up].reverse());
    // Phase, reverse: the groups and the rows in each flip.
    await order.getByRole('button', { name: 'Phase' }).click();
    await expect(next.getByRole('region', { name: 'Backlog under Road to market' })).toBeVisible();
    expect(await regions()).toEqual([...phaseRegions].reverse());
    expect(await ids()).toEqual([...phaseIds].reverse());
  });

  test('"to Next" and "back to Backlog" are buttons Tab reaches and shows, and write the queue', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    await next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ }).click();
    const title = page.getByRole('button', { name: '4 Build to GitHub', exact: true });
    const toNext = next.locator('.ip-backlog-row', { has: title }).getByRole('button', { name: 'to Next' });
    await expect(toNext).toHaveCSS('opacity', '0');
    // The box's own buttons sit in its top line, before the title.
    await title.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(toNext).toBeFocused();
    await expect(toNext).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    const row = next.locator('.ip-next-row', { has: page.getByRole('button', { name: '4 Build to GitHub', exact: true }) });
    await expect(row.locator('.ip-st')).toHaveText('Ready');
    // A button of the row's own does not open Details.
    await expect(page.getByRole('complementary')).toHaveCount(0);
    // The queue was written: the step is Ready in Next after a reload, with "back to Backlog" on it.
    await page.reload();
    await expect(row.locator('.ip-st')).toHaveText('Ready');
    await row.getByRole('button', { name: 'back to Backlog' }).focus();
    await expect(row.getByRole('button', { name: 'back to Backlog' })).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(next.locator('.ip-next-row')).toHaveCount(0);
    await page.reload();
    await expect(next.locator('.ip-next-row')).toHaveCount(0);
    await expect(next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ })).toBeVisible();
  });

  test('Backlog "Delete…" asks first, Escape and Cancel keep the step, Delete removes it from the tree', async ({ page, fresh, consoleErrors }) => {
    consoleErrors.allow(/status of 400/);
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    const fold = next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ });
    await fold.click();
    const id = fresh.ids['6 Beta'];
    const title = next.getByRole('button', { name: '6 Beta', exact: true });
    const row = next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: '6 Beta', exact: true }) });
    const del = row.getByRole('button', { name: 'Delete…' });
    const dialog = page.getByRole('dialog', { name: `Delete #${id} 6 Beta?` });
    await expect(del).toHaveCSS('opacity', '0');
    await title.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(del).toBeFocused();
    await expect(del).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    // While the confirm is open the box's title is out of the Tab order, and Escape anywhere in the box closes the confirm.
    await expect(title).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(title).not.toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(del).toBeFocused();
    await expect(title).toBeVisible();
    // A click on the question keeps focus in the dialog, so Escape still closes it.
    await page.keyboard.press('Enter');
    await dialog.locator('b').click();
    // Nor does a click on the confirming row's own padding open Details.
    await next.locator(`li[data-node="${id}"]`).click({ position: { x: 2, y: 2 } });
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(del).toBeFocused();
    // A refused delete keeps the row, says why, and puts focus back on its Delete button.
    const nodeDelete = '**/api/ui/projects/*/nodes/*/delete';
    await page.route(nodeDelete, (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for the test', hint: 'Reload the window.' }) }));
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Refused for the test').first()).toBeVisible();
    await expect(del).toBeFocused();
    await expect(next.locator(`li[data-node="${id}"]`)).not.toHaveClass(/pending/);
    await page.unroute(nodeDelete);
    // Details open on the step: deleting it closes Details, and a click on the open confirm does not open one.
    await title.click();
    await expect(page.getByRole('complementary')).toHaveCount(1);
    await del.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(next.getByRole('button', { name: '6 Beta', exact: true })).toHaveCount(0);
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await page.reload();
    if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
    await expect(next.getByRole('button', { name: '7 Launch', exact: true })).toBeVisible();
    await expect(next.getByRole('button', { name: '6 Beta', exact: true })).toHaveCount(0);
  });

  test('drag: Backlog into Next, within Next, and Next back to Backlog, without opening Details', async ({ page, fresh }) => {
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const next = band(page, 'next');
    await next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ }).click();
    const backlogRow = (t: string) => next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: t, exact: true }) });
    const nextRow = (t: string) => next.locator('.ip-next-row', { has: page.getByRole('button', { name: t, exact: true }) });
    const order = async () => (await next.locator('.ip-next-row .ip-row-title').allTextContents()).join('|');
    // Into an empty rail.
    await backlogRow('5 Store listing').dragTo(next.getByText('Nothing is queued'));
    await expect.poll(order).toBe('5 Store listing');
    // Onto the top half of a Next row: before it.
    await backlogRow('6 Beta').dragTo(nextRow('5 Store listing'), { targetPosition: { x: 40, y: 2 } });
    await expect.poll(order).toBe('6 Beta|5 Store listing');
    // Within Next: the bottom half of the last row puts it last. Measured, since the row's height follows its padding.
    const last = (await nextRow('5 Store listing').boundingBox())!;
    await nextRow('6 Beta').dragTo(nextRow('5 Store listing'), { targetPosition: { x: 40, y: last.height - 6 } });
    await expect.poll(order).toBe('5 Store listing|6 Beta');
    // Each box shows its step id and its state.
    await expect(nextRow('6 Beta').locator('.ip-sid')).toHaveText(`#${fresh.ids['6 Beta']}`);
    await expect(nextRow('6 Beta').locator('.ip-st')).toHaveText('Ready');
    await expect(page.getByRole('complementary')).toHaveCount(0);
    // The queue was written.
    await page.reload();
    await expect.poll(order).toBe('5 Store listing|6 Beta');
    // Back onto Backlog.
    await next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ }).click();
    await nextRow('5 Store listing').dragTo(next.locator('.ip-fold'));
    await expect(next.locator('.ip-next-row')).toHaveCount(1);
    await expect(backlogRow('5 Store listing')).toBeVisible();
    await expect.poll(order).toBe('6 Beta');
    await expect(page.getByRole('complementary')).toHaveCount(0);
  });
});

test.describe('Project view', () => {
  const projectView = async (page: Page, project: Seeded) => {
    await page.setViewportSize(WIDE);
    await open(page, project);
    await page.getByRole('button', { name: 'Project', exact: true }).click();
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
    // Done children fold per parent and open on a click.
    const fold = road.getByRole('button', { name: /^✓ 1 done · latest: #\d+ 1 iOS certificate/ });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(road.getByRole('button', { name: '1 iOS certificate', exact: true })).toHaveCount(0);
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(road.getByRole('button', { name: '1 iOS certificate', exact: true })).toBeVisible();
    // A fully done group is not a section until it is picked from "Done groups".
    await expect(section(page, 'Milestones')).toHaveCount(0);
    const groups = page.getByRole('button', { name: /^Done groups · 1/ });
    await expect(groups).toHaveAttribute('aria-expanded', 'false');
    await groups.click();
    await page.getByRole('button', { name: /Milestones/ }).click();
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
    await page.locator('.ip-view-name').click();
    await expect(menu).toHaveCount(0);
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
    await expect(open1).toContainText(/\? question · migrated · (now|\d+m)/);
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
    await expect(cleared).toContainText(`a${fresh.ask} ? "Which keystore signs the release?" · answered "Use the upload key"`);
    await expect(asks.getByRole('button', { name: 'Answer…' })).toHaveCount(0);
    // The handoff chip opens the handoff in the viewer.
    await details.getByRole('button', { name: /^handoff · / }).click();
    await expect(page.getByRole('dialog', { name: 'Resource' })).toContainText('Pick up at the upload step.');
  });

  test('Add a step under this one creates a child, keeps its field focused for the next, and Escape returns focus to the button without closing Details', async ({ page, api, fresh }) => {
    const id = fresh.ids['Play app signing'];
    await page.setViewportSize(WIDE);
    await open(page, fresh);
    const details = await openDetails(page, 'Play app signing');
    const add = details.getByRole('button', { name: 'Add a step under this one' });
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
    await next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ }).click();
    const backlogRow = (t: string) => next.locator('.ip-backlog-row', { has: page.getByRole('button', { name: t, exact: true }) });
    const nextRow = (t: string) => next.locator('.ip-next-row', { has: page.getByRole('button', { name: t, exact: true }) });
    const order = async () => (await next.locator('.ip-next-row .ip-row-title').allTextContents()).join('|');
    // Near the foot of a row: its bottom half, measured since the row's height follows its padding.
    const bottom = async (t: string) => ({ x: 40, y: (await nextRow(t).boundingBox())!.height - 6 });
    await backlogRow('4 Build to GitHub').dragTo(next.getByText('Nothing is queued'));
    await backlogRow('5 Store listing').dragTo(nextRow('4 Build to GitHub'), { targetPosition: await bottom('4 Build to GitHub') });
    await backlogRow('6 Beta').dragTo(nextRow('5 Store listing'), { targetPosition: await bottom('5 Store listing') });
    const expected = '4 Build to GitHub|5 Store listing|6 Beta';
    await expect.poll(order).toBe(expected);
    // The middle row on its own top half, then on the bottom half of the row above it.
    await nextRow('5 Store listing').dragTo(nextRow('5 Store listing'), { targetPosition: { x: 40, y: 2 } });
    await nextRow('5 Store listing').dragTo(nextRow('4 Build to GitHub'), { targetPosition: await bottom('4 Build to GitHub') });
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
    await next.getByRole('button', { name: /^Backlog · \d+ [▸▾]$/ }).click();
    const titles = next.locator('.ip-backlog-row .ip-row-title');
    const first = await titles.nth(0).textContent();
    const second = await titles.nth(1).textContent();
    expect(first).not.toBe(second);
    await next.locator('.ip-backlog-row').first().getByRole('button', { name: 'to Next' }).click();
    await expect(next.getByRole('button', { name: second!, exact: true }).first()).toBeFocused();
    // Enter on an empty answer field does nothing.
    const row = boxIn(page, 'needs', 'Run signing tests');
    await row.getByRole('button', { name: 'Answer…' }).click();
    await page.keyboard.press('Enter');
    await expect(row.getByRole('textbox')).toBeFocused();
    const snapshot = (await (await api.get(`/api/projects/${fresh.slug}`)).json()) as { asks: { id: number; clearedAt: string | null }[] };
    expect(snapshot.asks.find((a) => a.id === fresh.ask)?.clearedAt).toBeNull();
  });
});
