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

/** Records every transform the canvas viewport takes from now on, so a test can tell whether the camera moved. */
const RECORD_MOVES = `(() => {
  const viewport = document.querySelector('.react-flow__viewport');
  window.__moves = [];
  new MutationObserver(() => window.__moves.push(viewport.style.transform)).observe(viewport, { attributes: true, attributeFilter: ['style'] });
})()`;
const recordedMoves = (page: Page) => page.evaluate<string[]>('window.__moves');
/** Longer than the camera's 400 ms glide. */
const GLIDE_MS = 600;
/** How long the viewport must go without a style change for the camera to count as at rest. */
const CAMERA_QUIET_MS = 150;
/** True when the viewport's style, which RECORD_MOVES watches, does not change for CAMERA_QUIET_MS. */
const CAMERA_QUIET = `new Promise((resolve) => {
  const viewport = document.querySelector('.react-flow__viewport');
  let moved = false;
  const observer = new MutationObserver(() => { moved = true; });
  observer.observe(viewport, { attributes: true, attributeFilter: ['style'] });
  setTimeout(() => { observer.disconnect(); resolve(!moved); }, ${CAMERA_QUIET_MS});
})`;

/**
 * Passes once the camera is at rest. A glide's last frames move the viewport by fractions of a pixel after a card
 * already looks in place (see expectLifted), so a test that records moves waits for this first, or it records them.
 */
async function cameraSettled(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate<boolean>(CAMERA_QUIET), { message: 'the camera comes to rest', timeout: 3000, intervals: [0] })
    .toBe(true);
}

/**
 * Where a card sits against the top edge of the narrow Details sheet, 40 % of the way down the canvas, whether or not
 * the sheet is open yet: wholly above it, under it, or not wholly inside the canvas.
 */
async function sheetSide(page: Page, card: Locator): Promise<'above' | 'under' | 'outside'> {
  const canvas = (await page.locator('.react-flow').boundingBox())!;
  const box = (await card.boundingBox())!;
  if (box.y < canvas.y || box.y + box.height > canvas.y + canvas.height) return 'outside';
  return box.y + box.height <= canvas.y + canvas.height * 0.4 ? 'above' : 'under';
}

/** Passes once the card's middle sits a quarter of the way down the canvas, clear of the open Details sheet. */
async function expectLifted(page: Page, card: Locator): Promise<void> {
  await expect(async () => {
    const canvas = (await page.locator('.react-flow').boundingBox())!;
    const sheet = (await page.getByRole('complementary').boundingBox())!;
    const box = (await card.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(sheet.y);
    expect(Math.abs(box.y + box.height / 2 - (canvas.y + canvas.height / 4))).toBeLessThanOrEqual(3);
  }).toPass({ timeout: 3000 });
}

test('opens on the current work with folding, needs-you and the session badge', async ({ page, demo }) => {
  await open(page, demo);
  // React Flow's warning #004 (a canvas with no width or height) is only logged by development builds: check the size.
  await expect(page.locator('.react-flow__renderer')).toBeVisible();
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
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

test('Details keeps the last good detail when a refresh fails', async ({ page, api, fresh, consoleErrors }) => {
  consoleErrors.allow(/status of 500/);
  await open(page, fresh);
  const id = fresh.ids['Run signing tests'];
  await page.locator('.ip-node', { hasText: 'Run signing tests' }).click();
  const details = page.getByRole('complementary');
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
  const details = page.getByRole('complementary');
  const id = fresh.ids['3 RevenueCat'];
  await page.locator('.ip-node', { hasText: '3 RevenueCat' }).click();
  await expect(details).toContainText(`#${id} 3 RevenueCat`);
  await write(api, fresh.session, 'delete', `/api/nodes/${fresh.ids['7 Launch']}`);
  // "+3 more" turning into "+2 more" shows that the snapshot without 7 Launch has landed.
  await expect(page.locator('.ip-more', { hasText: '+2 more' })).toBeVisible();
  await expect(details).toContainText(`#${id} 3 RevenueCat`);
  await write(api, fresh.session, 'delete', `/api/nodes/${id}`);
  await expect(details).toBeHidden();
  await expect(page.getByText("Couldn't refresh")).toHaveCount(0);
});

test('a labelled step shows its glyph in a neutral chip named by the word, and Details shows glyph and word', async ({ page, api, fresh }) => {
  await open(page, fresh);
  const card = page.locator('.ip-node', { hasText: 'Play app signing' });
  await expect(card).toBeVisible();
  await expect(page.locator('.ip-node .ip-type')).toHaveCount(0);
  // The label arrives live, with the node's own update.
  await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['Play app signing']}`, { label: 'ui' });
  const chip = card.getByRole('img', { name: 'ui' });
  await expect(chip).toHaveText('⧉');
  await expect(chip).toHaveAttribute('title', 'ui');
  // After the title, in text ink (never a hue), and always text presentation, never an emoji.
  await expect(card.locator('.ip-title + .ip-type')).toHaveCount(1);
  await expect(chip).toHaveCSS('color', 'rgb(71, 85, 105)');
  await expect(chip).toHaveCSS('font-variant-emoji', 'text');
  await expect(page.locator('.ip-node', { hasText: 'Run signing tests' }).locator('.ip-type')).toHaveCount(0);
  await card.click();
  // Beside kind and status: "active task · ⧉ ui · Claude".
  const meta = page.getByRole('complementary').locator('.ip-meta');
  await expect(meta.locator('.ip-meta-label')).toHaveText('· ⧉ ui');
  await expect(meta).toHaveText(/^active\s*task\s*· ⧉ ui\s*· Claude/);
  await expect(meta.locator('.ip-glyph')).toHaveCSS('font-variant-emoji', 'text');
});

test('a long project name is cut short and the top bar stays on one line', async ({ page, api }) => {
  const name = 'A project name long enough to fill a narrow window several times over, and then some';
  const project = await seed(api, name);
  await open(page, project);
  await expect(page).toHaveTitle(/A project name long enough/);
  const tab = page.getByRole('tab', { selected: true });
  await expect(tab).toHaveAttribute('title', name);
  for (const control of [tab, page.getByRole('button', { name: /need you/ }), page.getByRole('button', { name: /Follow/ })]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  expect((await page.locator('.ip-topbar').boundingBox())!.height, 'one line of tabs').toBeLessThan(50);
  expect(await page.evaluate<boolean>(`(() => { const n = document.querySelector('[role="tab"][aria-selected="true"] .ip-tab-name'); return n.scrollWidth > n.clientWidth; })()`)).toBe(true);
});

test('dark mode reaches the canvas controls; reduced motion stops the pulse and flash', async ({ page, demo }) => {
  // Every font comes from the app's own server: the faces are bundled, never fetched from the network.
  const fontHosts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontHosts.push(new URL(request.url()).hostname);
  });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await open(page, demo);
  await expect(page.locator('.react-flow')).toHaveClass(/\bdark\b/);
  // The night ground is Quiet's navy.
  await expect(page.locator('.react-flow')).toHaveCSS('background-color', 'rgb(8, 13, 28)');
  // The working chip's character stands still: no bob and no blink.
  await expect(page.locator('.ip-chip-s .ip-char-body')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.ip-chip-s g.ip-char-eyes')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.ip-node.working .ip-marker.m-active').first()).toHaveCSS('animation-name', 'none');
  // Amber ink on an amber tint, like the needs-you pill.
  await expect(page.locator('.ip-node .ip-you')).toHaveCSS('color', 'rgb(252, 211, 77)');
  await page.keyboard.press('n');
  const flashed = page.locator('.ip-node.flash', { hasText: 'Run signing tests' });
  await expect(flashed).toHaveCSS('animation-name', 'none');
  await expect(flashed).not.toHaveCSS('box-shadow', 'none');
  // Section labels in Details are readable on the dark panel.
  await flashed.click();
  await expect(page.getByRole('complementary').locator('.ip-label').first()).toHaveCSS('color', 'rgb(148, 163, 184)');
  // Inter is in use: a face that loaded, not only a family name that matched nothing (document.fonts.check() can't tell).
  const loadedFaces = `(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replace(/["']/g, ''));
  })()`;
  await expect.poll(() => page.evaluate<string[]>(loadedFaces)).toContain('Inter');
  expect(fontHosts.length, 'the faces were requested').toBeGreaterThan(0);
  expect(fontHosts.filter((host) => host !== '127.0.0.1'), 'font requests that left the app').toEqual([]);
});

test('reduced motion makes camera moves instant', async ({ page, demo }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, demo);
  const play = page.locator('.ip-node', { hasText: 'Play app signing' });
  await expect(play).toBeInViewport();
  const moves = { Home: () => page.keyboard.press('Home'), End: () => page.keyboard.press('End'), 'lift above the sheet': () => play.click() };
  for (const [name, move] of Object.entries(moves)) {
    await page.evaluate(RECORD_MOVES);
    await move();
    await page.waitForTimeout(GLIDE_MS);
    // One jump. A glide would pass through a new transform every frame.
    expect(new Set(await recordedMoves(page)).size, name).toBe(1);
  }
  await expectLifted(page, play);
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
  await expect(page.locator('.ip-node', { hasText: '5 Store listing' })).toBeFocused();
  const follow = page.getByRole('button', { name: /Follow/ });
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('f');
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
});

test('Space on "+n more" hands focus to the first card it shows, and Tab carries on from there', async ({ page, demo }) => {
  await open(page, demo);
  await page.getByRole('button', { name: 'Show 3 more' }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.ip-node', { hasText: '5 Store listing' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.ip-node', { hasText: '6 Beta' })).toBeFocused();
});

test('a wheel tick turns Follow off', async ({ page, demo }) => {
  await open(page, demo);
  const follow = page.getByRole('button', { name: /Follow/ });
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2, pane.y + 60);
  await page.mouse.wheel(0, 60);
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
});

// Records, by id, every row React Flow hides from now on: it hides a row whose node object carries no measured size.
const WATCH_HIDDEN = `(() => {
  window.__hidden = [];
  new MutationObserver((records) => {
    for (const { target } of records) {
      if (target.classList.contains('react-flow__node') && target.style.visibility === 'hidden') window.__hidden.push(target.dataset.id);
    }
  }).observe(document.querySelector('.react-flow__nodes'), { subtree: true, attributes: true, attributeFilter: ['style'] });
})()`;

test('rows stay measured when the canvas rebuilds them, so none blinks out and a focused card keeps focus', async ({ page, api, fresh }) => {
  await page.clock.install();
  await open(page, fresh);
  const card = page.locator('.ip-node', { hasText: 'Play app signing' });
  await expect(card).toBeInViewport();
  await card.focus();
  await page.evaluate(WATCH_HIDDEN);
  // The 30 s clock rebuilds every row, and so does a live change.
  await page.clock.runFor(30_000);
  await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['3 RevenueCat']}`, { title: '3 RevenueCat, renamed' });
  await expect(page.locator('.ip-node', { hasText: '3 RevenueCat, renamed' })).toBeVisible();
  expect(await page.evaluate<string[]>('window.__hidden')).toEqual([]);
  await expect(card).toBeFocused();
});

test('at 520 px there is no minimap, old finished steps fold into "✓ n done", and a card counts its resources', async ({ page, api, fresh }) => {
  // Under a parent that is not done: a done parent would fold them away whole. Past two todo steps, the dropped ones
  // make a "+5 more" tail.
  const children = [
    ...[1, 2, 3, 4].map((i) => ({ title: `Old step ${i}`, status: 'done' })),
    { title: 'Next up' }, { title: 'After that' },
    ...[1, 2, 3, 4, 5].map((i) => ({ title: `Shelved ${i}`, status: 'dropped' })),
  ];
  await write(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, nodes: [{ title: 'Finished work', kind: 'phase', status: 'active', children }] });
  await write(api, fresh.session, 'post', '/api/resources', { nodeId: fresh.ids['Run signing tests'], kind: 'doc', title: 'Signing checklist', content: '# Checklist' });
  // The server stamps a step's finish time when it is made: a browser clock 25 hours ahead makes every one over a day
  // old, the seed's 25 done milestones too.
  await page.clock.install({ time: Date.now() + 25 * 3600_000 });
  await open(page, fresh);
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
  await expect(page.locator('.react-flow__minimap')).toHaveCount(0);

  const oldRun = page.getByRole('button', { name: 'Show 4 done' });
  const firstOld = page.locator('.ip-node', { hasText: 'Old step 1' });
  await expect(oldRun).toHaveClass(/\bip-more-done\b/);
  await expect(oldRun).toHaveText('✓ 4 done');
  await expect(firstOld).toHaveCount(0);
  // The seed's milestones fold too.
  await expect(page.getByRole('button', { name: 'Show 25 done' })).toHaveClass(/\bip-more-done\b/);
  await expect(page.locator('.ip-node', { hasText: /^Milestone 1$/ })).toHaveCount(0);
  await expect(page.locator('.ip-more.ip-more-done')).toHaveCount(2);
  // A click opens the run and hands focus to its first step.
  await oldRun.click();
  await expect(page.locator('.ip-node', { hasText: 'Old step 4' })).toBeVisible();
  await expect(firstOld).toBeFocused();
  await expect(page.locator('.ip-more.ip-more-done')).toHaveCount(1);
  // Folding the parent and unfolding it folds the run again.
  const parent = page.locator('.ip-node', { hasText: 'Finished work' });
  await parent.getByRole('button', { name: 'Fold' }).click();
  await parent.getByRole('button', { name: 'Unfold' }).click();
  await expect(oldRun).toBeVisible();
  await expect(firstOld).toHaveCount(0);
  // From the keyboard, a done run opens as "+n more" does, focus moving to its first step.
  await oldRun.focus();
  await page.keyboard.press('Space');
  await expect(firstOld).toBeFocused();
  // The old dropped steps "+5 more" shows never fold again into a done row; Enter focuses the first.
  await page.getByRole('button', { name: 'Show 5 more' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ip-node', { hasText: 'Shelved 1' })).toBeFocused();
  await expect(page.locator('.ip-node', { hasText: 'Shelved 5' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show 5 done' })).toHaveCount(0);

  // One count inside the card in place of the chips beside it, naming them in its tooltip; a click opens Details,
  // which lists both resources and opens either.
  const card = page.locator('.ip-node', { hasText: 'Run signing tests' });
  await page.keyboard.press('n');
  await expect(card).toBeInViewport();
  const count = card.locator('.ip-res-count');
  await expect(count).toHaveText('▤ 2');
  await expect(count).toHaveAttribute('title', /^r\d+ Signing test suite\nr\d+ Signing checklist$/);
  await expect(page.locator('.ip-chip', { hasText: 'Signing checklist' })).toBeHidden();
  await count.click();
  const details = page.getByRole('complementary');
  await expect(details).toContainText(`#${fresh.ids['Run signing tests']} Run signing tests`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(details.locator('.ip-res b')).toHaveText(['Signing test suite', 'Signing checklist']);
  await details.locator('.ip-res', { hasText: 'Signing checklist' }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.locator('h1')).toHaveText('Checklist');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  // At 720 px and wider, the chips beside the card come back.
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(count).toBeHidden();
  await expect(page.locator('.ip-chip', { hasText: 'Signing checklist' })).toBeVisible();
});

test('an active step nobody is on draws a hollow marker that says so, and a needs-you step four days old shows YOU · 4d', async ({ page, demo }) => {
  // The server stamps each change with its own clock and no route backdates one: a browser clock four days and an hour
  // ahead makes the seed four days old. (It also folds the 25 done milestones into "✓ 25 done".)
  await page.clock.install({ time: Date.now() + 4 * 86_400_000 + 3_600_000 });
  await open(page, demo);
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
  // Milestones is active and Claude's, and no session, subagent or task is on it. Its stored status stays active.
  const milestones = page.locator('.ip-node', { hasText: 'Milestones' });
  await expect(milestones).toHaveClass(/\bst-active\b.*\bpaused\b/);
  const marker = milestones.locator('.ip-marker');
  await expect(marker).toHaveAttribute('title', 'Nobody is on this. Last change 4 d ago');
  await expect(marker).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(marker).toHaveCSS('border-top-color', 'rgb(2, 132, 199)');
  // The session's focus keeps its step and every step above it unpaused, with a filled marker and no such tooltip.
  await expect(page.locator('.ip-node.paused')).toHaveCount(1);
  for (const title of ['Road to market', '2 Android signing', 'Play app signing']) {
    const card = page.locator('.ip-node', { hasText: title });
    await expect(card, title).toHaveClass(/\bst-active\b/);
    await expect(card.locator('.ip-marker'), title).not.toHaveAttribute('title', /.*/);
    await expect(card.locator('.ip-marker'), title).toHaveCSS('background-color', 'rgb(194, 65, 12)');
  }
  // The needs-you step has waited four days, and says so inside its one YOU tag.
  await expect(page.locator('.ip-node .ip-you')).toHaveText('YOU · 4d');
});

// Records whether the flash on "Run signing tests" is ever cleared from now on.
const WATCH_FLASH = `(() => {
  const el = [...document.querySelectorAll('.ip-node')].find((n) => n.textContent.includes('Run signing tests'));
  window.__flashCleared = false;
  new MutationObserver(() => { if (!el.classList.contains('flash')) window.__flashCleared = true; }).observe(el, { attributes: true, attributeFilter: ['class'] });
})()`;

test('pressing N again on the same item flashes it again', async ({ page, demo }) => {
  await open(page, demo);
  const item = page.locator('.ip-node', { hasText: 'Run signing tests' });
  await expect(item).toBeVisible();
  await page.keyboard.press('n');
  await expect(item).toHaveClass(/\bflash\b/);
  await page.evaluate(WATCH_FLASH);
  await page.keyboard.press('n');
  // Well inside the 1.5 s the first flash lasts, so only a restart can clear it this soon.
  await expect.poll(() => page.evaluate<boolean>('window.__flashCleared'), { timeout: 1000 }).toBe(true);
  await expect(item).toHaveClass(/\bflash\b/);
});

test('with Details open on a narrow window, the camera centres above the sheet', async ({ page, demo }) => {
  await open(page, demo);
  await page.locator('.ip-node', { hasText: 'Upload keystore' }).click();
  const sheet = page.getByRole('complementary');
  await expect(sheet).toContainText('Upload keystore');
  const item = page.locator('.ip-node', { hasText: 'Run signing tests' });
  await page.keyboard.press('n');
  await expect(async () => {
    const card = (await item.boundingBox())!;
    const top = (await sheet.boundingBox())!.y;
    expect(card.y + card.height).toBeLessThanOrEqual(top);
  }).toPass({ timeout: 3000 });
});

test('on a narrow window, clicking a card the sheet would cover lifts it above the sheet and keeps Follow on', async ({ page, demo }) => {
  await open(page, demo);
  const card = page.locator('.ip-node', { hasText: 'Upload keystore' });
  await expect(card).toBeInViewport();
  expect(await sheetSide(page, card)).toBe('under');
  await card.click();
  await expect(page.getByRole('complementary')).toContainText('Upload keystore');
  await expectLifted(page, card);
  await expect(page.getByRole('button', { name: /Follow/ })).toHaveAttribute('aria-pressed', 'true');
});

test('on a narrow window, Enter on a card the sheet would cover lifts it too', async ({ page, demo }) => {
  await open(page, demo);
  const card = page.locator('.ip-node', { hasText: 'Upload keystore' });
  await expect(card).toBeInViewport();
  expect(await sheetSide(page, card)).toBe('under');
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary')).toContainText('Upload keystore');
  await expectLifted(page, card);
});

test('on a wide window, where Details is a side panel, opening it leaves the camera still', async ({ page, demo }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await open(page, demo);
  const card = page.locator('.ip-node', { hasText: 'Upload keystore' });
  await expect(card).toBeInViewport();
  expect(await sheetSide(page, card)).toBe('under');
  await page.evaluate(RECORD_MOVES);
  await card.click();
  await expect(page.getByRole('complementary')).toContainText('Upload keystore');
  await page.waitForTimeout(GLIDE_MS);
  expect(await recordedMoves(page)).toEqual([]);
});

test('on a narrow window, opening Details on a card clear of the sheet leaves the camera still', async ({ page, demo }) => {
  await open(page, demo);
  const card = page.locator('.ip-node', { hasText: 'Milestone 25' });
  await expect(card).toBeInViewport();
  expect(await sheetSide(page, card)).toBe('above');
  await page.evaluate(RECORD_MOVES);
  await card.click();
  await expect(page.getByRole('complementary')).toContainText('Milestone 25');
  await page.waitForTimeout(GLIDE_MS);
  expect(await recordedMoves(page)).toEqual([]);
});

test("on a narrow window, Details' parent link moves the camera only for a row the sheet or the edge hides", async ({ page, demo }) => {
  await open(page, demo);
  const sheet = page.getByRole('complementary');
  // Milestones sits far above Milestone 25, out of view: the link brings it above the sheet.
  await page.locator('.ip-node', { hasText: 'Milestone 25' }).click();
  await sheet.getByRole('button', { name: /Milestones/ }).click();
  await expect(sheet).toContainText(`#${demo.ids['Milestones']} Milestones`);
  await expectLifted(page, page.locator('.ip-node', { hasText: 'Milestones' }));
  // Run signing tests a quarter of the way down puts its parent, 2 Android signing, in view above the sheet.
  const run = page.locator('.ip-node', { hasText: 'Run signing tests' });
  await page.keyboard.press('n');
  await expectLifted(page, run);
  await run.click();
  await expect(sheet).toContainText(`#${demo.ids['Run signing tests']} Run signing tests`);
  const parent = page.locator('.ip-node', { hasText: '2 Android signing' });
  expect(await sheetSide(page, parent)).toBe('above');
  await cameraSettled(page);
  await page.evaluate(RECORD_MOVES);
  await sheet.getByRole('button', { name: /2 Android signing/ }).click();
  await expect(sheet).toContainText(`#${demo.ids['2 Android signing']} 2 Android signing`);
  await page.waitForTimeout(GLIDE_MS);
  expect(await recordedMoves(page)).toEqual([]);
});

test('on a narrow window with Details open, a session chip moves the camera only for a row the sheet or the edge hides', async ({ page, demo }) => {
  await open(page, demo);
  const play = page.locator('.ip-node', { hasText: 'Play app signing' });
  const chip = page.getByRole('button', { name: /E2E session/ });
  await page.locator('.ip-node', { hasText: 'Milestone 25' }).click();
  await expect(page.getByRole('complementary')).toContainText('Milestone 25');
  await page.keyboard.press('Home');
  await expect(play).not.toBeInViewport();
  await chip.click();
  await expectLifted(page, play);
  // With Run signing tests a quarter of the way down, the session's row is in view above the sheet.
  await page.keyboard.press('n');
  await expectLifted(page, page.locator('.ip-node', { hasText: 'Run signing tests' }));
  expect(await sheetSide(page, play)).toBe('above');
  await cameraSettled(page);
  await page.evaluate(RECORD_MOVES);
  await chip.click();
  await page.waitForTimeout(GLIDE_MS);
  expect(await recordedMoves(page)).toEqual([]);
});

test('on a narrow window with Details open, keyboard focus on a card under the sheet brings it above the sheet', async ({ page, demo }) => {
  await open(page, demo);
  const sheet = page.getByRole('complementary');
  const clear = page.locator('.ip-node', { hasText: 'Milestone 25' });
  const covered = page.locator('.ip-node', { hasText: 'Upload keystore' });
  await expect(clear).toBeInViewport();
  // Details opens from the keyboard on a card clear of the sheet, so the camera stays where it is.
  await clear.focus();
  await page.keyboard.press('Enter');
  await expect(sheet).toContainText('Milestone 25');
  expect(await sheetSide(page, covered)).toBe('under');
  // Focus that follows a key press shows a focus ring, as Tab's does.
  await covered.focus();
  await expectLifted(page, covered);
});

/** A window wide enough for the resource chips beside the cards, which a narrow one swaps for a count. */
const widen = (page: Page) => page.setViewportSize({ width: 1000, height: 900 });

test('the resource viewer is modal and hands focus back when it closes', async ({ page, demo }) => {
  await widen(page);
  await open(page, demo);
  const chip = page.locator('.ip-chip', { hasText: 'Signing test suite' });
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

test('a resource chip opens the rendered resource', async ({ page, demo }) => {
  await widen(page);
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
  await widen(page);
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
  await page.locator('.ip-chip', { hasText: 'Unsafe Markdown' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Signing docs' }).click();
  await expect.poll(() => opened).toEqual(['https://example.com/signing']);
  expect(popups).toHaveLength(0);
});

// Project tabs. Every test here names its projects uniquely, so it finds their tabs among everyone else's.

const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;

/** A project with only its root: nothing needs you and no session works in it. */
const bare = (api: APIRequestContext, name: string) => write<{ id: number; slug: string }>(api, `e2e-${randomUUID()}`, 'post', '/api/projects', { name });

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
  await expect(page).toHaveTitle(`(1) InProgress — ${newerName}`);
  await expect(page.locator('.ip-node.root')).toContainText(newerName);
  // A visit with no project in the URL opens the one picked last.
  await page.goto('/');
  await expect(tabFor(page, newerName)).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`#/p/${newer.slug}$`));
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
  await write(api, busy.session, 'patch', `/api/nodes/${busy.ids['Run signing tests']}`, { status: 'done' });
  await write(api, busy.session, 'post', `/api/sessions/${busy.session}/hook`, { event: 'stop' });
  await expect(busyTab).toHaveAccessibleName(busyName);
  await expect(busyTab.locator('.ip-tab-count, .ip-tab-dot')).toHaveCount(0);
});

test('archived projects move into the ⋯ menu, and picking one opens it', async ({ page, api }) => {
  const keptName = unique('Tabs kept');
  const shelvedName = unique('Tabs shelved');
  const kept = await bare(api, keptName);
  const shelved = await bare(api, shelvedName);
  await write(api, `e2e-${randomUUID()}`, 'patch', `/api/projects/${shelved.slug}`, { status: 'archived' });
  await page.goto(`/#/p/${kept.slug}`);
  await expect(tabFor(page, keptName)).toHaveAttribute('aria-selected', 'true');
  await expect(tabFor(page, shelvedName)).toHaveCount(0);
  const more = page.getByRole('button', { name: 'Archived projects' });
  const item = page.getByRole('button', { name: shelvedName });
  const details = page.getByRole('complementary');
  await page.locator('.ip-node.root').click();
  await expect(details).toContainText(keptName);
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
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
  await expect(page).toHaveTitle(`InProgress — ${shelvedName}`);
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
  await page.locator('.ip-chip', { hasText: 'Signing test suite' }).click();
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

test('the needs-you pill and Follow sit at the right end of the session row, for the current project', async ({ page, api, demo }) => {
  const quietName = unique('Tabs nothing waiting');
  await bare(api, quietName);
  await open(page, demo);
  const row = page.locator('.ip-sessions');
  const chip = row.getByRole('button', { name: /E2E session/ });
  const pill = row.getByRole('button', { name: /need you/ });
  const follow = row.getByRole('button', { name: /Follow/ });
  await expect(pill).toHaveText('1 need you');
  await expect(page.locator('.ip-topbar').getByRole('button', { name: /need you|Follow/ })).toHaveCount(0);
  const [rowBox, chipBox, pillBox, followBox] = await Promise.all([row, chip, pill, follow].map(async (l) => (await l.boundingBox())!));
  // Follow ends at the row's right padding, the pill sits just before it and the chips start from the left.
  expect(rowBox.x + rowBox.width - (followBox.x + followBox.width)).toBeLessThanOrEqual(12);
  expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(followBox.x);
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(pillBox.x);
  expect(rowBox.height, 'one line').toBeLessThanOrEqual(40);
  // A project with no sessions and nothing waiting keeps Follow in the row, without the pill.
  await tabFor(page, quietName).click();
  await expect(page).toHaveTitle(`InProgress — ${quietName}`);
  await expect(pill).toHaveCount(0);
  await expect(row.locator('.ip-chip-s')).toHaveCount(0);
  await expect(follow).toBeInViewport({ ratio: 1 });
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

test('a long session title is cut short, and the pill and Follow stay at the end of the first line', async ({ page, api, fresh }) => {
  const title = 'A session title long enough to run on well past the edge of a narrow window';
  const session = `e2e-${randomUUID()}`;
  await write(api, session, 'post', `/api/sessions/${session}/enroll`, { project: fresh.slug, title });
  await open(page, fresh);
  const row = page.locator('.ip-sessions');
  const chip = row.getByRole('button', { name: title });
  await expect(chip).toHaveAttribute('title', `${title} · no focus set yet`);
  const cut = `(() => { const l = [...document.querySelectorAll('.ip-chip-label')].find((n) => n.textContent.startsWith('A session title')); return l.scrollWidth > l.clientWidth; })()`;
  expect(await page.evaluate<boolean>(cut), 'the label is cut short').toBe(true);
  const pill = row.getByRole('button', { name: /need you/ });
  const follow = row.getByRole('button', { name: /Follow/ });
  const [rowBox, chipBox, pillBox, followBox] = await Promise.all([row, chip, pill, follow].map(async (l) => (await l.boundingBox())!));
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(pillBox.x);
  for (const box of [pillBox, followBox]) expect(box.y - rowBox.y, 'on the first line').toBeLessThanOrEqual(8);
  await expect(follow).toBeInViewport({ ratio: 1 });
});

// Live work: Claude's working tasks, its subagents and the Up next queue, seeded the way the hooks and the scribe send them.

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

/** A set_queue write as the scribe makes it: `session`'s own order (a `queue:` line), or without it the unowned order. */
const setQueue = (api: APIRequestContext, s: Seeded, nodes: number[], session?: string) =>
  write(api, s.session, 'post', `/api/projects/${s.slug}/queue`, { nodes, ...(session ? { session } : {}) });

const boxOf = async (l: Locator) => (await l.boundingBox())!;

/** A running subagent's time: under a minute, or whole minutes. */
const RUNNING = '(<1 min|\\d+ min)';

test.describe('Live work', () => {
  test('working tasks sit under their node as a checklist that folds with it, the done ones in a row that opens, the one in progress pulsing', async ({ page, api, fresh }) => {
    const android = fresh.ids['2 Android signing'];
    await task(api, fresh, '1', 'Read the signing guide', 'completed');
    await task(api, fresh, '2', 'Upload the key', 'in_progress');
    await task(api, fresh, '3', 'Check the release track');
    await task(api, fresh, '4', 'Write the release notes', 'completed');
    // A subject that starts with #id goes under that node rather than the session's focus.
    await task(api, fresh, '5', `#${android} Rotate the upload key`);
    await open(page, fresh);
    const card = page.locator('.ip-node', { hasText: 'Play app signing' });
    const next = page.locator('.ip-node', { hasText: 'Run signing tests' });
    const done = page.locator('.ip-work-done');
    const upload = page.locator('.ip-work', { hasText: 'Upload the key' });
    const check = page.locator('.ip-work', { hasText: 'Check the release track' });
    const guide = page.locator('.ip-work', { hasText: 'Read the signing guide' });
    await expect(done).toHaveText('✓ 2 done');
    await expect(done).toHaveAttribute('aria-expanded', 'false');
    await expect(upload.locator('.ip-work-mark')).toHaveText('◐');
    await expect(check.locator('.ip-work-mark')).toHaveText('○');
    await expect(guide).toHaveCount(0);
    // Under the card and one level in: the done row, then the open tasks in the order they were created.
    const [cardBox, doneBox, uploadBox, checkBox, nextBox] = await Promise.all([card, done, upload, check, next].map(boxOf));
    expect(doneBox.y).toBeGreaterThanOrEqual(cardBox.y + cardBox.height);
    expect(uploadBox.y).toBeGreaterThan(doneBox.y);
    expect(checkBox.y).toBeGreaterThan(uploadBox.y);
    expect(nextBox.y).toBeGreaterThanOrEqual(checkBox.y + checkBox.height);
    for (const box of [doneBox, uploadBox, checkBox]) expect(box.x).toBeGreaterThan(cardBox.x + 20);
    expect(uploadBox.height, 'a compact row').toBeLessThanOrEqual(20);
    // In progress while the session works.
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('animation-name', 'ip-pulse');
    await done.click();
    await expect(done).toHaveAttribute('aria-expanded', 'true');
    await expect(guide.locator('.ip-work-mark')).toHaveText('✓');
    await expect(page.locator('.ip-work', { hasText: 'Write the release notes' })).toBeVisible();
    await done.click();
    await expect(guide).toHaveCount(0);
    // The #id task, under 2 Android signing: without the #id, which would only repeat the node.
    const rotate = page.locator('.ip-work', { hasText: 'Rotate the upload key' });
    const parent = page.locator('.ip-node', { hasText: '2 Android signing' });
    const child = page.locator('.ip-node', { hasText: 'Upload keystore' });
    await expect(rotate).not.toContainText(`#${android}`);
    const [parentBox, rotateBox, childBox] = await Promise.all([parent, rotate, child].map(boxOf));
    expect(rotateBox.y).toBeGreaterThanOrEqual(parentBox.y + parentBox.height);
    expect(childBox.y).toBeGreaterThanOrEqual(rotateBox.y + rotateBox.height);
    // Tasks fold with their node, like its children.
    await parent.getByRole('button', { name: 'Fold' }).click();
    await expect(child).toHaveCount(0);
    await expect(rotate).toHaveCount(0);
    await expect(upload).toHaveCount(0);
    await parent.getByRole('button', { name: 'Unfold' }).click();
    await expect(rotate).toBeVisible();
    await expect(upload).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('animation-name', 'none');
  });

  test("each subagent has a badge under its node in its session's hue, led by its tag, shared by its tasks, greyed once it ends", async ({ page, api, fresh }) => {
    const id = fresh.ids['3 RevenueCat'];
    await subagent(api, fresh, 'agent-1', `#${id} Wire up RevenueCat`, 'sonnet');
    // Without an #id it works on the session's focus.
    await subagent(api, fresh, 'agent-2', 'Review the signing config', 'haiku');
    // A subagent's task goes under its node, led by its tag; the session's own carries the session's marker, untagged.
    await task(api, fresh, '1', 'Compare the tiers', 'in_progress', 'agent-1');
    await task(api, fresh, '1', 'Upload the key', 'in_progress');
    await open(page, fresh);
    const wire = page.locator('.ip-agent', { hasText: 'Wire up RevenueCat' });
    const review = page.locator('.ip-agent', { hasText: 'Review the signing config' });
    await expect(wire).toHaveText(new RegExp(`^a1 · Wire up RevenueCat · sonnet · ${RUNNING}$`));
    await expect(review).toHaveText(new RegExp(`^a2 · Review the signing config · haiku · ${RUNNING}$`));
    const [revenue, build, play, own, run, wireBox, reviewBox] = await Promise.all(
      [
        page.locator('.ip-node', { hasText: '3 RevenueCat' }),
        page.locator('.ip-node', { hasText: '4 Build to GitHub' }),
        page.locator('.ip-node', { hasText: 'Play app signing' }),
        page.locator('.ip-badge', { hasText: 'E2E session' }),
        page.locator('.ip-node', { hasText: 'Run signing tests' }),
        wire,
        review,
      ].map(boxOf),
    );
    // One under 3 RevenueCat, one level in; the other under the session's own badge, on its focus.
    expect(wireBox.y).toBeGreaterThanOrEqual(revenue.y + revenue.height);
    expect(build.y).toBeGreaterThanOrEqual(wireBox.y + wireBox.height);
    expect(wireBox.x).toBeGreaterThan(revenue.x + 20);
    expect(own.y).toBeGreaterThanOrEqual(play.y + play.height);
    expect(reviewBox.y).toBeGreaterThanOrEqual(own.y + own.height);
    expect(run.y).toBeGreaterThanOrEqual(reviewBox.y + reviewBox.height);
    const tiers = page.locator('.ip-work', { hasText: 'Compare the tiers' });
    const upload = page.locator('.ip-work', { hasText: 'Upload the key' });
    await expect(tiers.locator('.ip-work-agent')).toBeVisible();
    await expect(tiers.locator('.ip-work-tag')).toHaveText('a1');
    await expect(upload.locator('.ip-work-agent')).toBeVisible();
    await expect(upload.locator('.ip-work-tag')).toHaveCount(0);
    // One family, one hue: the session's badge, both subagents' badges and every task's marker.
    const colours = await page.evaluate<{ own: string; wire: string; marker: string; review: string; ownMarker: string }>(`(() => {
      const find = (sel, text) => [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(text));
      const bg = (n) => getComputedStyle(n).backgroundColor;
      return {
        own: bg(find('.ip-badge', 'E2E session')),
        wire: bg(find('.ip-agent', 'Wire up RevenueCat')),
        marker: bg(find('.ip-work', 'Compare the tiers').querySelector('.ip-work-agent')),
        review: bg(find('.ip-agent', 'Review the signing config')),
        ownMarker: bg(find('.ip-work', 'Upload the key').querySelector('.ip-work-agent')),
      };
    })()`);
    expect(colours.wire).not.toBe('rgba(0, 0, 0, 0)');
    expect(colours.marker).toBe(colours.wire);
    expect(colours.review).toBe(colours.wire);
    expect(colours.own).toBe(colours.wire);
    expect(colours.ownMarker).toBe(colours.wire);
    await hook(api, fresh.session, { event: 'subagent-stop', agentId: 'agent-1' });
    await expect(wire).toHaveText('a1 · Wire up RevenueCat · sonnet · done just now');
    await expect(wire).toHaveClass(/\bended\b/);
    await expect(wire).toHaveCSS('color', 'rgb(71, 85, 105)');
    await expect(review).not.toHaveClass(/\bended\b/);
  });

  test("a worker's badge says what it was asked to do, and a session's readers on a step fold into one reading row", async ({ page, api, fresh }) => {
    const revenue = fresh.ids['3 RevenueCat'];
    const purpose = 'Wire the paywall to RevenueCat and report the tiers.';
    await subagent(api, fresh, 'agent-1', `#${revenue} Wire up RevenueCat`, 'sonnet', { purpose });
    // Two readers on the session's focus, one with a purpose and one without.
    await subagent(api, fresh, 'reader-1', 'Map the signing config', 'haiku', { agentType: 'Explore', purpose: 'Find where the keystore is configured.' });
    await subagent(api, fresh, 'reader-2', 'Read the release docs', 'haiku', { agentType: 'Explore' });
    await open(page, fresh);
    const wire = page.locator('.ip-agent', { hasText: 'Wire up RevenueCat' });
    const readers = page.locator('.ip-readers');
    await expect(wire).toHaveAttribute('title', purpose);
    // The readers take no badge of their own: one row, in the session's hue, their descriptions in its tooltip.
    await expect(page.locator('.ip-agent')).toHaveCount(1);
    await expect(readers).toHaveCount(1);
    await expect(readers).toHaveText('◇ a · 2 reading');
    await expect(readers).toHaveAttribute('title', 'a2 · Map the signing config\na3 · Read the release docs');
    const [badge, readersBox, next] = await Promise.all(
      [page.locator('.ip-badge', { hasText: 'E2E session' }), readers, page.locator('.ip-node', { hasText: 'Run signing tests' })].map(boxOf),
    );
    expect(readersBox.y).toBeGreaterThanOrEqual(badge.y + badge.height);
    expect(next.y).toBeGreaterThanOrEqual(readersBox.y + readersBox.height);
    expect(readersBox.height, 'a small row').toBeLessThanOrEqual(20);
    await expect(readers).toHaveCSS('color', 'rgb(11, 107, 125)');
    // They still count on the chip, whose list marks them.
    const chip = page.locator('.ip-sessions').getByRole('button', { name: /E2E session/ });
    await expect(chip).toHaveAccessibleName('A · E2E session · 3 subagents');
    await expect(chip).toHaveText('A');
    await chip.hover();
    const list = page.locator('.ip-chip-pop');
    await expect(list.locator('li', { hasText: 'Map the signing config' })).toHaveText(new RegExp(`^◇ a2 · Map the signing config · haiku · ${RUNNING}$`));
    await expect(list.locator('li', { hasText: 'Wire up RevenueCat' })).toHaveText(new RegExp(`^a1 · #${revenue} Wire up RevenueCat · sonnet · ${RUNNING}$`));
    await page.locator('.ip-activity').hover();
    await expect(list).toBeHidden();
    // Details: the purpose is a second line, and a reader is marked.
    await page.locator('.ip-node', { hasText: 'Play app signing' }).click();
    const details = page.getByRole('complementary');
    await expect(details.locator('.ip-dagent')).toHaveText([
      new RegExp(`^◇ a2 · Map the signing config · haiku · ${RUNNING}Find where the keystore is configured\\.$`),
      new RegExp(`^◇ a3 · Read the release docs · haiku · ${RUNNING}$`),
    ]);
    await page.locator('.ip-node', { hasText: '3 RevenueCat' }).click();
    await expect(details.locator('.ip-dagent .ip-dpurpose')).toHaveText(purpose);
    await details.getByRole('button', { name: 'Close' }).click();
    // A reader that stops leaves no greyed badge and drops out of the row; the last one takes the row with it.
    await hook(api, fresh.session, { event: 'subagent-stop', agentId: 'reader-1' });
    await expect(readers).toHaveText('◇ a · 1 reading');
    await hook(api, fresh.session, { event: 'subagent-stop', agentId: 'reader-2' });
    await expect(readers).toHaveCount(0);
    await expect(page.locator('.ip-agent')).toHaveCount(1);
    // Once the session ends, only the worker is trail, its purpose the trail row's tooltip.
    await hook(api, fresh.session, { event: 'end' });
    const trailRow = page.locator('.ip-work-done');
    await expect(trailRow).toHaveText('✓ 1 agent');
    await trailRow.click();
    await expect(page.locator('.ip-trail-agent')).toHaveAttribute('title', purpose);
  });

  test('Up next: the camera opens on its head while no session works, queued steps carry ①②③, and the line jumps to a step', async ({ page, api, fresh }) => {
    const long = 'A step title long enough to run well past the edge of a narrow window all on its own';
    const [first] = await write<{ id: number }[]>(api, fresh.session, 'post', '/api/nodes', { parentId: fresh.root, after: 'start', nodes: [{ title: 'Queued first' }] });
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['3 RevenueCat']}`, { title: long });
    await hook(api, fresh.session, { event: 'stop' });
    // The newest active node, where the camera would open without a queue.
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['Play app signing']}`, { outcome: 'Keys uploaded' });
    const order = [first.id, fresh.ids['4 Build to GitHub'], fresh.ids['3 RevenueCat']];
    await setQueue(api, fresh, order);
    await open(page, fresh);
    // Wait for the camera's first move, away from where React Flow starts.
    await expect(page.locator('.react-flow__viewport')).not.toHaveAttribute('style', /translate\(0px, 0px\)/);
    await expect(page.locator('.ip-node', { hasText: 'Queued first' })).toBeInViewport();
    await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).not.toBeInViewport();
    for (const [i, title] of ['Queued first', '4 Build to GitHub', long].entries()) await expect(page.locator('.ip-node', { hasText: title }).locator('.ip-queue')).toHaveText('①②③'[i]);
    await expect(page.locator('.ip-node', { hasText: 'Play app signing' }).locator('.ip-queue')).toHaveCount(0);
    const upNext = page.locator('.ip-upnext');
    // Unowned steps: the heading, then one neutral "later" line.
    await expect(upNext.locator('.ip-upnext-head')).toHaveText('Up next');
    const laterLine = upNext.locator('.ip-upnext-line');
    await expect(laterLine).toHaveText(`later ① #${order[0]} Queued first · ② #${order[1]} 4 Build to GitHub · ③ #${order[2]} ${long}`);
    // One line, cut short at the window's edge.
    expect((await boxOf(laterLine)).height, 'one line').toBeLessThan(30);
    await expect(laterLine).toHaveCSS('text-overflow', 'ellipsis');
    expect(await page.evaluate<boolean>(`(() => { const l = document.querySelector('.ip-upnext-line'); return l.scrollWidth > l.clientWidth; })()`), 'cut short').toBe(true);
    const build = page.locator('.ip-node', { hasText: '4 Build to GitHub' });
    await expect(build).not.toBeInViewport();
    await upNext.getByRole('button', { name: /4 Build to GitHub/ }).click();
    await expect(build).toBeInViewport();
    // An empty queue takes the line and the numbers away.
    await setQueue(api, fresh, []);
    await expect(upNext).toHaveCount(0);
    await expect(page.locator('.ip-queue')).toHaveCount(0);
  });

  test("two sessions keep their own Up next order, in their letters and hues, and an ended session's step moves to later", async ({ page, api, fresh }) => {
    const second = `e2e-${randomUUID()}`;
    await write(api, second, 'post', `/api/sessions/${second}/enroll`, { project: fresh.slug, title: 'Second session' });
    await write(api, second, 'post', `/api/sessions/${second}/focus`, { nodeId: fresh.ids['5 Store listing'] });
    const b = { ...fresh, session: second };
    const id = (title: string) => fresh.ids[title];
    await setQueue(api, fresh, [id('3 RevenueCat'), id('4 Build to GitHub')], fresh.session);
    await setQueue(api, b, [id('6 Beta')], second);
    await open(page, fresh);
    const upNext = page.locator('.ip-upnext');
    const lines = upNext.locator('.ip-upnext-line');
    const marker = (title: string) => page.locator('.ip-node', { hasText: title }).locator('.ip-queue');
    await expect(upNext.locator('.ip-upnext-head')).toHaveText('Up next');
    await expect(lines).toHaveText([
      `A ① #${id('3 RevenueCat')} 3 RevenueCat · ② #${id('4 Build to GitHub')} 4 Build to GitHub`,
      `B ① #${id('6 Beta')} 6 Beta`,
    ]);
    await expect(marker('3 RevenueCat')).toHaveText('A①');
    await expect(marker('4 Build to GitHub')).toHaveText('A②');
    await expect(marker('6 Beta')).toHaveText('B①');
    // Each line's letter and each marker wear the session's hue: A teal, B its chip's hue.
    const hues = () => page.evaluate<Record<string, string | null>>(`(() => {
      const find = (sel, text) => [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(text));
      const color = (n) => (n ? getComputedStyle(n).color : null);
      const lead = (text) => color([...document.querySelectorAll('.ip-upnext-line .ip-upnext-lead')].find((n) => n.textContent === text));
      const chipB = document.querySelector('.ip-chip-s[aria-label^="B · "] .ip-tag');
      return {
        chipB: color(chipB),
        head: color(document.querySelector('.ip-upnext-head')),
        leadA: lead('A'), leadB: lead('B'), leadLater: lead('later'),
        markerA: color(find('.ip-node', '3 RevenueCat').querySelector('.ip-queue')),
        markerB: color(find('.ip-node', '6 Beta').querySelector('.ip-queue')),
      };
    })()`);
    let seen = await hues();
    expect(seen.leadA).toBe('rgb(11, 107, 125)');
    expect(seen.markerA).toBe(seen.leadA);
    expect(seen.leadB).toBe(seen.chipB);
    expect(seen.markerB).toBe(seen.chipB);
    expect(seen.leadB).not.toBe(seen.leadA);
    // A second queue: for A replaces A's order only.
    await setQueue(api, fresh, [id('7 Launch')], fresh.session);
    await expect(lines).toHaveText([`A ① #${id('7 Launch')} 7 Launch`, `B ① #${id('6 Beta')} 6 Beta`]);
    await expect(marker('7 Launch')).toHaveText('A①');
    await expect(marker('3 RevenueCat')).toHaveCount(0);
    // B ends: its step turns unowned, on a neutral later line, with a bare numeral in ink.
    await hook(api, second, { event: 'end' });
    await expect(lines).toHaveText([`A ① #${id('7 Launch')} 7 Launch`, `later ① #${id('6 Beta')} 6 Beta`]);
    await expect(marker('6 Beta')).toHaveText('①');
    seen = await hues();
    expect(seen.leadLater).toBe(seen.head);
    expect(seen.markerB).toBe('rgb(30, 41, 59)');
    // Each step still jumps to its row: pan it out of view first.
    const beta = page.locator('.ip-node', { hasText: '6 Beta' });
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await page.mouse.wheel(0, 3000);
    await expect(beta).not.toBeInViewport();
    await lines.nth(1).getByRole('button', { name: /6 Beta/ }).click();
    await expect(beta).toBeInViewport();
  });

  test('a session chip counts only live subagents, and lists them on hover and on keyboard focus', async ({ page, api, fresh }) => {
    await subagent(api, fresh, 'agent-1', 'Wire up RevenueCat', 'sonnet');
    await subagent(api, fresh, 'agent-2', 'Check the paywall', 'haiku');
    await hook(api, fresh.session, { event: 'subagent-stop', agentId: 'agent-2' });
    await open(page, fresh);
    const chip = page.locator('.ip-sessions').getByRole('button', { name: /E2E session/ });
    await expect(chip).toHaveAccessibleName('A · E2E session · 1 subagent');
    await expect(chip).toHaveText('A');
    const list = page.locator('.ip-chip-pop');
    await expect(list).toBeHidden();
    await chip.hover();
    await expect(list).toBeVisible();
    await expect(list.locator('li', { hasText: 'Wire up RevenueCat' })).toHaveText(new RegExp(`^a1 · Wire up RevenueCat · sonnet · ${RUNNING}$`));
    await expect(list.locator('li', { hasText: 'Check the paywall' })).toHaveText('a2 · Check the paywall · haiku · done just now');
    await page.locator('.ip-activity').hover();
    await expect(list).toBeHidden();
    // Tab onto the chip from the tab strip.
    await page.getByRole('tab', { selected: true }).focus();
    await expect(async () => {
      await page.keyboard.press('Tab');
      await expect(chip).toBeFocused({ timeout: 200 });
    }).toPass({ timeout: 3000 });
    await expect(list).toBeVisible();
  });

  test("two sessions in a project show A and B in different hues, and a subagent of B shows b1 in B's hue under the step it names", async ({ page, api, fresh }) => {
    const second = `e2e-${randomUUID()}`;
    await write(api, second, 'post', `/api/sessions/${second}/enroll`, { project: fresh.slug, title: 'Second session' });
    await write(api, second, 'post', `/api/sessions/${second}/focus`, { nodeId: fresh.ids['5 Store listing'] });
    const b = { ...fresh, session: second };
    await subagent(api, b, 'agent-b', `#${fresh.ids['3 RevenueCat']} Price the tiers`, 'sonnet');
    await task(api, b, '1', 'Compare the plans', 'in_progress', 'agent-b');
    await open(page, fresh);
    // A chip shows only its letter. Its name leads with the letter and carries the title and the count.
    const chipA = page.locator('.ip-sessions').getByRole('button', { name: /^A · / });
    const chipB = page.locator('.ip-sessions').getByRole('button', { name: /^B · / });
    await expect(chipA).toHaveAccessibleName('A · E2E session');
    await expect(chipB).toHaveAccessibleName('B · Second session · 1 subagent');
    await expect(chipB).toHaveText('B');
    await expect(page.locator('.ip-badge', { hasText: 'E2E session' })).toHaveText('◆ A · E2E session · working');
    await expect(page.locator('.ip-badge', { hasText: 'Second session' })).toHaveText('◆ B · Second session · working · 1 subagent');
    // B's subagent leads with b1, and so does its task.
    const agent = page.locator('.ip-agent', { hasText: 'Price the tiers' });
    await expect(agent).toHaveText(new RegExp(`^b1 · Price the tiers · sonnet · ${RUNNING}$`));
    await expect(page.locator('.ip-work', { hasText: 'Compare the plans' }).locator('.ip-work-tag')).toHaveText('b1');
    // Under the step it names, one level in, before the next step.
    const [revenue, build, agentBox] = await Promise.all(
      [page.locator('.ip-node', { hasText: '3 RevenueCat' }), page.locator('.ip-node', { hasText: '4 Build to GitHub' }), agent].map(boxOf),
    );
    expect(agentBox.y).toBeGreaterThanOrEqual(revenue.y + revenue.height);
    expect(build.y).toBeGreaterThanOrEqual(agentBox.y + agentBox.height);
    expect(agentBox.x).toBeGreaterThan(revenue.x + 20);
    // A wears teal and B another hue, on its chip, its badge, its subagent and its subagent's task.
    const hues = await page.evaluate<Record<string, string>>(`(() => {
      const find = (sel, text) => [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(text));
      const bg = (n) => getComputedStyle(n).backgroundColor;
      const row = find('.ip-work', 'Compare the plans');
      return {
        chipA: getComputedStyle(document.querySelector('.ip-chip-s[aria-label^="A · "] .ip-tag')).color,
        badgeA: bg(find('.ip-badge', 'E2E session')),
        chipB: getComputedStyle(document.querySelector('.ip-chip-s[aria-label^="B · "] .ip-tag')).color,
        badgeB: bg(find('.ip-badge', 'Second session')),
        agentB: bg(find('.ip-agent', 'Price the tiers')),
        markerB: bg(row.querySelector('.ip-work-agent')),
        tagB: getComputedStyle(row.querySelector('.ip-work-tag')).color,
      };
    })()`);
    expect(hues.chipA).toBe('rgb(11, 107, 125)');
    expect(hues.badgeA).toBe(hues.chipA);
    expect(hues.chipB).not.toBe(hues.chipA);
    expect(hues.chipB).not.toBe('rgba(0, 0, 0, 0)');
    for (const part of ['badgeB', 'agentB', 'markerB', 'tagB']) expect(hues[part], part).toBe(hues.chipB);
  });

  test("Details lists the node's working tasks with who is on each, and the subagents on it", async ({ page, api, fresh }) => {
    await subagent(api, fresh, 'agent-1', 'Draft the store notes', 'sonnet');
    await task(api, fresh, '1', 'Upload the key', 'in_progress');
    await task(api, fresh, '2', 'Check the release track');
    await hook(api, fresh.session, { event: 'task-updated', taskKey: '1', addBlocks: ['2'] });
    await task(api, fresh, '1', 'Collect the screenshots', 'pending', 'agent-1');
    await open(page, fresh);
    await page.locator('.ip-node', { hasText: 'Play app signing' }).click();
    const details = page.getByRole('complementary');
    // Anchored: the next row's "after Upload the key" names it too.
    await expect(details.locator('.ip-wt', { hasText: /^◐ Upload the key/ })).toHaveText('◐ Upload the key — E2E session');
    await expect(details.locator('.ip-wt', { hasText: 'Check the release track' })).toHaveText('○ Check the release track — E2E session · after Upload the key');
    await expect(details.locator('.ip-wt', { hasText: 'Collect the screenshots' })).toHaveText('a1 ○ Collect the screenshots — Draft the store notes');
    await expect(details.locator('.ip-dagent')).toHaveText(new RegExp(`^a1 · Draft the store notes · sonnet · ${RUNNING}$`));
  });

  test("an ended session's tasks and subagents stay on their steps as a trail row that opens, and Details lists them under its title", async ({ page, api, fresh }) => {
    const android = fresh.ids['2 Android signing'];
    await task(api, fresh, '1', 'Read the signing guide', 'completed');
    await task(api, fresh, '2', 'Write the release notes', 'completed');
    await task(api, fresh, '3', 'Upload the key', 'in_progress');
    await subagent(api, fresh, 'agent-1', `#${android} Check the keystore`, 'sonnet');
    // On the subagent's own list, so it goes under the subagent's step.
    await task(api, fresh, '1', 'Compare the keystores', 'in_progress', 'agent-1');
    await hook(api, fresh.session, { event: 'end' });
    // The newest active step, so the camera opens on it now that no session works.
    await write(api, fresh.session, 'patch', `/api/nodes/${fresh.ids['Play app signing']}`, { outcome: 'Keys uploaded' });
    await open(page, fresh);
    const card = page.locator('.ip-node', { hasText: 'Play app signing' });
    const playRow = page.locator('.ip-work-done', { hasText: '2 done' });
    const androidRow = page.locator('.ip-work-done', { hasText: 'agent' });
    const upload = page.locator('.ip-work', { hasText: 'Upload the key' });
    await expect(card).toBeInViewport();
    await expect(page.locator('.ip-work-done')).toHaveCount(2);
    await expect(playRow).toHaveText('✓ 2 done · 1 unfinished');
    await expect(playRow).toHaveAttribute('aria-expanded', 'false');
    await expect(upload).toHaveCount(0);
    // The session's badge left with it.
    await expect(page.locator('.ip-badge')).toHaveCount(0);
    const [cardBox, rowBox] = await Promise.all([card, playRow].map(boxOf));
    expect(rowBox.y).toBeGreaterThanOrEqual(cardBox.y + cardBox.height);
    expect(rowBox.x).toBeGreaterThan(cardBox.x + 20);
    // Opened: the done tasks keep their ✓, the unfinished one is a hollow grey ○ that never pulses.
    await playRow.click();
    await expect(playRow).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.ip-work', { hasText: 'Read the signing guide' }).locator('.ip-work-mark')).toHaveText('✓');
    await expect(upload).toHaveClass(/\bstale\b/);
    await expect(upload.locator('.ip-work-mark')).toHaveText('○');
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('color', 'rgb(100, 116, 139)');
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('animation-name', 'none');
    await playRow.click();
    await expect(upload).toHaveCount(0);
    // The subagent stays on its own step with the task it left, neutral grey, saying how long it ran and when it stopped.
    await expect(androidRow).toHaveText('✓ 1 unfinished · 1 agent');
    await expect(page.locator('.ip-agent')).toHaveCount(0);
    await androidRow.click();
    const compare = page.locator('.ip-work', { hasText: 'Compare the keystores' });
    await expect(compare).toHaveClass(/\bstale\b/);
    await expect(compare.locator('.ip-work-agent')).toHaveCount(0);
    const agent = page.locator('.ip-trail-agent');
    await expect(agent).toHaveText(new RegExp(`^◆ Check the keystore · sonnet · ran ${RUNNING} · stopped just now$`));
    await expect(agent).toHaveCSS('color', 'rgb(71, 85, 105)');
    // Details lists the trail under the session's title, and nothing as live work.
    await card.click();
    const details = page.getByRole('complementary');
    await expect(details.locator('.ip-trail-head')).toHaveText('E2E session · ended just now');
    await expect(details.locator('.ip-wt.stale')).toHaveText(['✓ Read the signing guide', '✓ Write the release notes', '○ Upload the key']);
    await expect(details.locator('.ip-wt:not(.stale)')).toHaveCount(0);
    await page.locator('.ip-node', { hasText: '2 Android signing' }).click();
    await expect(details).toContainText(`#${android} 2 Android signing`);
    const group = details.locator('.ip-trail', { hasText: 'E2E session · ended just now' });
    await expect(group.locator('.ip-wt.stale')).toHaveText('○ Compare the keystores — Check the keystore');
    await expect(group.locator('.ip-dtrail')).toHaveText(new RegExp(`^◆ Check the keystore · sonnet · ran ${RUNNING} · stopped just now$`));
    await expect(details.locator('.ip-wt:not(.stale)')).toHaveCount(0);
  });
});
