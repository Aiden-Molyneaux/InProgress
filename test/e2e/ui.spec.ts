import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

interface Seeded {
  slug: string;
  root: number;
  /** Node ids by title. */
  ids: Record<string, number>;
  /** The project's Claude session, which is also the actor of every write made for it. */
  session: string;
}

const headers = (session: string) => ({
  authorization: `Bearer ${readFileSync('.e2e-home/token', 'utf8').trim()}`,
  'x-inprogress-actor': `scribe:${session}`,
});

/** A write the test depends on. A failed one fails here, not later as a confusing UI assertion. */
async function write<T = unknown>(api: APIRequestContext, session: string, method: 'post' | 'patch', path: string, data: unknown): Promise<T> {
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
].join('\n\n');

/** A project of its own: every test that changes data seeds one, so tests pass alone, in any order and repeated. */
async function seed(api: APIRequestContext): Promise<Seeded> {
  const session = `e2e-${randomUUID()}`;
  const post = <T = unknown>(path: string, data: unknown) => write<T>(api, session, 'post', path, data);
  const project = await post<{ slug: string; rootNodeId: number }>('/api/projects', { name: 'E2E Demo', description: 'Seeded by Playwright' });
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
  await post(`/api/sessions/${session}/enroll`, { project: project.slug, title: 'E2E session' });
  await post(`/api/sessions/${session}/focus`, { nodeId: ids['Play app signing'] });
  await post(`/api/sessions/${session}/hook`, { event: 'prompt' });
  return { slug: project.slug, root: project.rootNodeId, ids, session };
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
      const api = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4399' });
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

test('opens on the current work with folding, needs-you and the session badge', async ({ page, demo }) => {
  await open(page, demo);
  // React Flow's warning #004 (a canvas with no width or height) is only logged by development builds: check the size.
  await expect(page.locator('.react-flow__renderer')).toBeVisible();
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
  // The minimap draws only nodes whose size it knows (Task 18's measured-size fix).
  await expect(page.locator('.react-flow__minimap-node').first()).toBeVisible();
  await expect(page.locator('.ip-node.needs-you', { hasText: 'Run signing tests' })).toBeVisible();
  await expect(page.locator('.ip-more', { hasText: '+3 more' })).toBeVisible();
  await expect(page.locator('.ip-badge', { hasText: 'E2E session' })).toBeVisible();
  await expect(page).toHaveTitle('(1) InProgress — E2E Demo');
});

test('shows live changes and follows them', async ({ page, api, fresh }) => {
  await open(page, fresh);
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeVisible();
  await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['Play app signing']}`, { status: 'done', outcome: 'Configured' });
  await expect(page.locator('.ip-node.st-done', { hasText: 'Play app signing' })).toBeVisible({ timeout: 5000 });
  // Let the follow move for that status change finish before moving the camera ourselves.
  await page.waitForTimeout(1600);
  await page.keyboard.press('Home');
  await expect(page.locator('.ip-node.root')).toBeInViewport();
  await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.ids['Road to market'], nodes: [{ title: 'Launch checklist', status: 'active' }] });
  await expect(page.locator('.ip-node', { hasText: 'Launch checklist' })).toBeInViewport({ timeout: 6000 });
  await expect(page.locator('.ip-activity')).toContainText('Launch checklist');
});

test('the needs-you pill jumps to and highlights the item', async ({ page, demo }) => {
  await open(page, demo);
  const item = page.locator('.ip-node', { hasText: 'Run signing tests' });
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
  await page.keyboard.press('Home');
  await expect(page.locator('.ip-node.root')).toBeInViewport();
  await expect(item).not.toBeInViewport();
  await page.getByRole('button', { name: /need you/ }).click();
  await expect(item).toHaveClass(/\bflash\b/);
  await expect(item).toBeInViewport();
});

test('clicking a node opens its details and copies a reference', async ({ page, demo }) => {
  await open(page, demo);
  const id = demo.ids['Run signing tests'];
  await page.locator('.ip-node', { hasText: 'Run signing tests' }).click();
  const details = page.getByRole('complementary');
  await expect(details).toContainText(`#${id} Run signing tests`);
  await details.getByRole('button', { name: `Copy #${id}` }).click();
  // The clipboard write has finished once the button says so.
  await expect(details.getByRole('button', { name: 'Copied' })).toBeVisible();
  // String form: the root tsconfig has no DOM lib, so `navigator` must not appear in test code.
  expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`#${id} Run signing tests`);
});

test('the keyboard reaches and opens cards, shows a "+n more" run and toggles Follow', async ({ page, demo }) => {
  await open(page, demo);
  const details = page.getByRole('complementary');
  const play = page.locator('.ip-node', { hasText: 'Play app signing' });
  await expect(play).toBeInViewport();
  await page.keyboard.press('Home');
  await expect(play).not.toBeInViewport();
  // Keyboard focus on a card outside the view brings it in.
  await play.focus();
  await expect(play).toBeInViewport();
  // Tab from the card above proves the card is in the tab order, not just focusable.
  await page.keyboard.press('Tab');
  await expect(page.locator('.ip-node', { hasText: 'Run signing tests' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(details).toContainText(`#${demo.ids['Run signing tests']} Run signing tests`);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  await expect(details).toContainText(`#${demo.ids['Play app signing']} Play app signing`);
  const more = page.getByRole('button', { name: 'Show 3 more' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ip-node', { hasText: '7 Launch' })).toBeVisible();
  await expect(page.locator('.ip-more')).toHaveCount(0);
  const follow = page.getByRole('button', { name: /Follow/ });
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('f');
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
});

test('a resource chip opens the rendered resource', async ({ page, demo }) => {
  await open(page, demo);
  await page.locator('.ip-chip', { hasText: 'Signing test suite' }).click();
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
  await open(page, demo);
  await expect(page).toHaveTitle('(1) InProgress — E2E Demo');
  await page.evaluate(RECORD_TITLES);
  const image = page.waitForEvent('requestfinished', (r) => r.url().endsWith('/x'));
  await page.locator('.ip-chip', { hasText: 'Unsafe Markdown' }).click();
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
  await expect(page.locator('.ip-node.root')).toBeVisible({ timeout: 10_000 });
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
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
  await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, after: 'start', nodes: [{ title: 'Hotfix', status: 'active' }] });
  // Untargeted and right behind it: the two replay in one chunk, and React renders them as one batch.
  await write(api, fresh.session, 'post', `/api/sessions/${fresh.session}/hook`, { event: 'stop' });
  release();
  await expect(page.locator('.ip-node', { hasText: 'Hotfix' })).toBeInViewport({ timeout: 6000 });
  expect(streams[0]).toMatch(/\/api\/events\/stream\?since=\d+$/);
});

test('keeps the view current under a steady stream of events', async ({ page, api, fresh }) => {
  await open(page, fresh);
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
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
    await expect(page.locator('.ip-node', { hasText: 'Play app signing, renamed' })).toBeVisible({ timeout: 2500 });
  } finally {
    steady = false;
    await events;
  }
});
