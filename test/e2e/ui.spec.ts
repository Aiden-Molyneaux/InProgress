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
  await expect(page).toHaveTitle('(1) InProgress · E2E Demo');
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
  // Quiet: an opaque sheet with an 8 px top radius, the title in L ink, 24 px hairline buttons.
  await expect(details).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(details).toHaveCSS('border-top-left-radius', '8px');
  const title = details.locator('header b');
  await expect(title).toHaveCSS('font-size', '15px');
  await expect(title).toHaveCSS('font-weight', '900');
  await expect(title).toHaveCSS('color', 'rgb(15, 23, 42)');
  await expect(details.getByRole('button', { name: 'Close' })).toHaveCSS('height', '24px');
  // Its steps draw the canvas's marker: a ✓ when done, a still orange dot when active, the needs-you mark and YOU.
  await details.getByRole('button', { name: /2 Android signing/ }).click();
  await expect(details).toContainText(`#${demo.ids['2 Android signing']} 2 Android signing`);
  const steps = details.locator('.ip-kids li');
  await expect(steps).toHaveText([/Upload keystore$/, /Play app signing$/, /Run signing tests\s*YOU$/]);
  // The stylesheet draws the ✓, so the marker holds no text and the step's name starts with its #id.
  await expect(steps.nth(0).locator('.ip-marker.m-done')).toHaveText('');
  expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.ip-kids .ip-marker.m-done'), '::before').content`)).toMatch(/^"✓"/);
  await expect(steps.nth(0).getByRole('button')).toHaveAccessibleName(`#${demo.ids['Upload keystore']} Upload keystore`);
  const active = steps.nth(1).locator('.ip-marker.m-active');
  await expect(active).toHaveCSS('background-color', 'rgb(194, 65, 12)');
  await expect(active).toHaveCSS('animation-name', 'none');
  await expect(steps.nth(2).locator('.ip-marker.m-you')).toHaveCount(1);
  // Its YOU is the card's tag: amber ink on the amber tint, 18 px tall, S at 900.
  const you = steps.nth(2).locator('.ip-you');
  await expect(you).toHaveCSS('color', 'rgb(146, 64, 14)');
  await expect(you).toHaveCSS('background-color', 'rgba(251, 191, 36, 0.18)');
  await expect(you).toHaveCSS('height', '18px');
  await expect(you).toHaveCSS('font-weight', '900');
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
  // Quiet: the status is the shared marker and a muted word, in place of a filled pill.
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
  // The frame draws the flash: under reduced motion, a static amber ring.
  await expect(frameOf(flashed)).toHaveCSS('animation-name', 'none');
  await expect(frameOf(flashed)).not.toHaveCSS('box-shadow', 'none');
  // No dot grid, so the night ground is --bg itself.
  await expect(page.locator('.react-flow__background')).toHaveCount(0);
  // Section labels in Details are readable on the dark panel.
  await flashed.click();
  await expect(page.getByRole('complementary').locator('.ip-label').first()).toHaveCSS('color', 'rgb(148, 163, 184)');
  // Inter is in use: a face that loaded, not only a family name that matched nothing (document.fonts.check() can't tell).
  const loadedFaces = `(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replace(/["']/g, ''));
  })()`;
  await expect.poll(() => page.evaluate<string[]>(loadedFaces)).toContain('Inter');
  // The canvas's counts, tags and times bring DM Mono in.
  await expect.poll(() => page.evaluate<string[]>(loadedFaces)).toContain('DM Mono');
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
  // Anchor on the title, so this fails if the run never folded, whatever else a header holds.
  await expect(page.locator('.ip-node .ip-title', { hasText: /^Milestone 1$/ })).toHaveCount(0);
  await expect(page.locator('.ip-more.ip-more-done')).toHaveCount(2);
  // A click opens the run and hands focus to its first step.
  await oldRun.click();
  await expect(page.locator('.ip-node', { hasText: 'Old step 4' })).toBeVisible();
  await expect(firstOld).toBeFocused();
  // A done card's ✓ comes from the stylesheet, so its header's text and name are its title alone.
  await expect(firstOld).toHaveText('Old step 1');
  await expect(firstOld).toHaveAccessibleName('Old step 1');
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
  // Quiet: a resource is a muted row, no purple: its title in ink at 500, its summary in DM Mono.
  const resource = details.locator('.ip-res').first();
  await expect(resource).toHaveCSS('color', 'rgb(71, 85, 105)');
  await expect(resource).toHaveCSS('border-top-style', 'none');
  await expect(resource.locator('b')).toHaveCSS('color', 'rgb(30, 41, 59)');
  await expect(resource.locator('b')).toHaveCSS('font-weight', '500');
  await expect(resource.locator('.sub')).toHaveCSS('font-family', /DM Mono/);
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
  // Details draws the same ring, with the same tooltip, for the step and in its parent's list of steps.
  await milestones.focus();
  await page.keyboard.press('Enter');
  const details = page.getByRole('complementary');
  const own = details.locator('.ip-meta .ip-marker');
  await expect(own).toHaveClass(/\bm-paused\b/);
  await expect(own).toHaveAttribute('title', 'Nobody is on this. Last change 4 d ago');
  await expect(own).toHaveCSS('border-top-color', 'rgb(2, 132, 199)');
  await details.locator('.ip-link').click();
  const steps = details.locator('.ip-kids li');
  await expect(steps.filter({ hasText: 'Milestones' }).locator('.ip-marker')).toHaveClass(/\bm-paused\b/);
  await expect(steps.filter({ hasText: 'Road to market' }).locator('.ip-marker')).not.toHaveClass(/\bm-paused\b/);
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
  await expect(page).toHaveTitle('(1) InProgress · E2E Demo');
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
  await expect(page).toHaveTitle(`(1) InProgress · ${newerName}`);
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
  const more = page.getByRole('button', { name: 'Archived and deleted projects' });
  const item = page.getByRole('menu').getByRole('menuitem', { name: shelvedName, exact: true });
  const details = page.getByRole('complementary');
  await page.locator('.ip-node.root').click();
  await expect(details).toContainText(keptName);
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
  await expect(page).toHaveTitle(`InProgress · ${quietName}`);
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
  await expect(items).toHaveCount(1);
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
  for (const label of ['Keys shelf A', 'Keys shelf B']) await archiveByScribe(api, (await bare(api, unique(label))).slug);
  await page.goto(`/#/p/${kept.slug}`);
  const details = page.getByRole('complementary');
  await page.locator('.ip-node.root').click();
  await expect(details).toContainText(keptName);
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
  await expect(menu.getByRole('menuitem')).toHaveText(['Unarchive', 'Delete…']);
  await page.keyboard.press('ArrowDown');
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

test("a scribe's archive of the open project keeps it open as the end tab, and its sessions and Up next go", async ({ page, api, fresh }) => {
  await setQueue(api, fresh, [fresh.ids['3 RevenueCat']], fresh.session);
  await open(page, fresh);
  const chips = page.locator('.ip-sessions .ip-chip-s');
  await expect(chips).toHaveCount(1);
  await expect(page.locator('.ip-upnext')).toBeVisible();
  await write(api, fresh.session, 'patch', `/api/projects/${fresh.slug}`, { status: 'archived' });
  const tab = page.getByRole('tab', { selected: true });
  await expect(tab).toHaveAccessibleName(/, archived$/);
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(hereIs(fresh.slug));
  await expect(chips).toHaveCount(0);
  await expect(page.locator('.ip-upnext')).toHaveCount(0);
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
    await expect(menu.getByRole('menuitem')).toHaveCSS('font-size', '12.5px');
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

test('a session chip is its character and letter: its name carries the title, and waiting for permission rings it in amber', async ({ page, api, fresh }) => {
  const title = 'A session title long enough to run on well past the edge of a narrow window';
  const second = `e2e-${randomUUID()}`;
  await write(api, second, 'post', `/api/sessions/${second}/enroll`, { project: fresh.slug, title });
  await open(page, fresh);
  const row = page.locator('.ip-sessions');
  const chips = row.locator('.ip-chip-s');
  const chipA = row.getByRole('button', { name: /^A · / });
  const chipB = row.getByRole('button', { name: /^B · / });
  // Letter order, though the server lists B first: it was seen last.
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toHaveAccessibleName('A · E2E session');
  await expect(chips.nth(1)).toHaveAccessibleName(`B · ${title}`);
  // The chip shows its character and its letter in its family's hue. The title is in its name and its popover, with
  // no native tooltip, which would never show on keyboard focus.
  await expect(chipB).toHaveText('B');
  await expect(chipB).not.toHaveAttribute('title');
  await expect(chipB.locator('.ip-char')).toHaveAttribute('data-state', 'work');
  await expect(chipB.locator('.ip-tag')).toHaveCSS('color', 'rgb(180, 83, 47)');
  expect((await row.boundingBox())!.height, 'one line').toBeLessThanOrEqual(40);
  // Its popover opens on keyboard focus: Tab from the tab strip reaches A, then B.
  const popB = page.locator(`[id="${await chipB.getAttribute('aria-describedby')}"]`);
  await expect(popB).toBeHidden();
  await page.getByRole('tab', { selected: true }).focus();
  await expect(async () => {
    await page.keyboard.press('Tab');
    await expect(chipA).toBeFocused({ timeout: 200 });
  }).toPass({ timeout: 3000 });
  await page.keyboard.press('Tab');
  await expect(chipB).toBeFocused();
  await expect(popB).toBeVisible();
  await expect(popB).toHaveText(`B · ${title} · no focus set yet`);
  await expect(chipB).toHaveAccessibleDescription(`B · ${title} · no focus set yet`);
  // Waiting for permission: the word shows in amber, and the character wears the amber ring, the outer one running.
  await write(api, second, 'post', `/api/sessions/${second}/hook`, { event: 'permission' });
  await expect(chipB).toHaveAccessibleName(`B · ${title} · needs permission`);
  await expect(chipB).toHaveText('B · needs permission');
  await expect(chipB.locator('.ip-chip-word')).toHaveCSS('color', 'rgb(146, 64, 14)');
  await expect(chipB.locator('.ip-char')).toHaveAttribute('data-state', 'wait');
  const ring2 = chipB.locator('.ip-char-ring2');
  await expect(ring2).toHaveCSS('animation-name', 'ip-ring');
  // Under reduced motion the outer ring stops, and the solid ring stays.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(ring2).toHaveCSS('animation-name', 'none');
  await expect(chipB.locator('.ip-char-ring')).toBeVisible();
  // Five more sessions overflow the first line. The chips wrap, still in letter order, and the pill and Follow stay at
  // the right end of the first line.
  for (let i = 1; i <= 5; i++) {
    const extra = `e2e-${randomUUID()}`;
    await write(api, extra, 'post', `/api/sessions/${extra}/enroll`, { project: fresh.slug, title: `Extra session ${i}` });
  }
  await expect(chips).toHaveCount(7);
  for (const [i, letter] of [...'ABCDEFG'].entries()) await expect(chips.nth(i)).toHaveAccessibleName(new RegExp(`^${letter} · `));
  const pill = row.getByRole('button', { name: /need you/ });
  const follow = row.getByRole('button', { name: /Follow/ });
  const [rowBox, chipsBox, pillBox, followBox] = await Promise.all([row, row.locator('.ip-chips'), pill, follow].map(async (l) => (await l.boundingBox())!));
  expect(rowBox.height, 'two lines').toBeGreaterThan(40);
  expect(chipsBox.x + chipsBox.width).toBeLessThanOrEqual(pillBox.x);
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

/** A running kin's run time on the canvas (runTime): under a minute, or whole minutes. */
const RUN_TIME = '(<1m|\\d+m)';

/** A card's frame: the `.ip-card` around its header (`.ip-node`) and its lines. */
const frameOf = (header: Locator) => header.locator('xpath=..');

type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

/** The box lies inside the frame's box, give or take half a pixel of rounding. */
function expectInside(box: Box, frame: Box, what = 'inside the frame'): void {
  expect(box.x, what).toBeGreaterThanOrEqual(frame.x - 0.5);
  expect(box.y, what).toBeGreaterThanOrEqual(frame.y - 0.5);
  expect(box.x + box.width, what).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
  expect(box.y + box.height, what).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
}

/**
 * The rail into a child: where its path starts and ends, its parent's frame and the child's frame and header, in page
 * coordinates and all from one frame, since the camera may be gliding. A path's bounding box would not do for its
 * ends: the miter at each bend pokes past the line.
 */
const railInto = (page: Page, parentId: number, childId: number) =>
  page.evaluate<{ from: Point; to: Point; parentFrame: Box; childFrame: Box; header: Box }>(`(() => {
    const box = (selector) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    const path = document.querySelector('.react-flow__edge[data-id="e-n${childId}"] .react-flow__edge-path');
    const toPage = path.getScreenCTM();
    const at = (length) => {
      const { x, y } = path.getPointAtLength(length).matrixTransform(toPage);
      return { x, y };
    };
    return {
      from: at(0),
      to: at(path.getTotalLength()),
      parentFrame: box('.react-flow__node[data-id="n${parentId}"] .ip-card'),
      childFrame: box('.react-flow__node[data-id="n${childId}"] .ip-card'),
      header: box('.react-flow__node[data-id="n${childId}"] .ip-node'),
    };
  })()`);

/** Records in `window.__railsLost` the id of every edge that leaves the canvas from now on. */
const WATCH_RAILS = `(() => {
  window.__railsLost = [];
  new MutationObserver((records) => {
    for (const { removedNodes } of records) {
      for (const n of removedNodes) {
        if (n.nodeType !== 1) continue;
        for (const e of n.matches('.react-flow__edge') ? [n] : n.querySelectorAll('.react-flow__edge')) window.__railsLost.push(e.dataset.id);
      }
    }
  }).observe(document.querySelector('.react-flow__edges'), { subtree: true, childList: true });
})()`;

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
    // Inside the card, under its header: the done row at the end of the session's line, then the open tasks in order.
    const [cardBox, doneBox, uploadBox, checkBox, nextBox] = await Promise.all([card, done, upload, check, next].map(boxOf));
    expect(doneBox.y).toBeGreaterThanOrEqual(cardBox.y + cardBox.height);
    expect(uploadBox.y).toBeGreaterThan(doneBox.y);
    expect(checkBox.y).toBeGreaterThan(uploadBox.y);
    expect(nextBox.y).toBeGreaterThanOrEqual(checkBox.y + checkBox.height);
    const frameBox = await boxOf(frameOf(card));
    for (const box of [doneBox, uploadBox, checkBox]) expectInside(box, frameBox);
    expect(uploadBox.height, 'a compact row').toBeLessThanOrEqual(22);
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
    // The rail into its children draws: down from its frame's foot, 18 px in, then a 10 px stub to the child's header.
    const keystore = fresh.ids['Upload keystore'];
    const rail = page.locator(`.react-flow__edge[data-id="e-n${keystore}"] .react-flow__edge-path`);
    const near = (a: number, b: number, what: string) => expect(Math.abs(a - b), what).toBeLessThanOrEqual(1);
    const expectRail = async () => {
      await expect(rail).toBeVisible();
      await expect(async () => {
        const { from, to, parentFrame, childFrame, header } = await railInto(page, android, keystore);
        near(from.x, parentFrame.x + 18, '18 px in from the frame');
        near(from.y, parentFrame.y + parentFrame.height, "from the frame's foot");
        near(to.x, childFrame.x, "to the child's frame");
        near(to.y, header.y + header.height / 2, "at the header's middle");
      }).toPass();
    };
    await expectRail();
    // It stays drawn while the canvas rebuilds: the card grows by a task, and the rail starts at its new foot.
    await page.evaluate(WATCH_RAILS);
    await task(api, fresh, '6', `#${android} Archive the old key`);
    await expect(page.locator('.ip-work', { hasText: 'Archive the old key' })).toBeVisible();
    await expectRail();
    expect(await page.evaluate<string[]>('window.__railsLost'), 'no rail drops out').toEqual([]);
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
    const wire = page.getByRole('img', { name: /^a1 · Wire up RevenueCat/ });
    const review = page.getByRole('img', { name: /^a2 · Review the signing config/ });
    // A kin shows its tag and its run time; its name and tooltip carry its description, model and elapsed time.
    await expect(wire).toHaveText(new RegExp(`^a1${RUN_TIME}$`));
    await expect(wire).toHaveAccessibleName(new RegExp(`^a1 · Wire up RevenueCat · sonnet · ${RUNNING}$`));
    await expect(review).toHaveText(new RegExp(`^a2${RUN_TIME}$`));
    await expect(review).toHaveAccessibleName(new RegExp(`^a2 · Review the signing config · haiku · ${RUNNING}$`));
    const revenueHeader = page.locator('.ip-node', { hasText: '3 RevenueCat' });
    const [revenue, build, play, own, run, wireBox, reviewBox, revenueFrame] = await Promise.all(
      [
        revenueHeader,
        page.locator('.ip-node', { hasText: '4 Build to GitHub' }),
        page.locator('.ip-node', { hasText: 'Play app signing' }),
        page.locator('.ip-badge', { hasText: 'E2E session' }),
        page.locator('.ip-node', { hasText: 'Run signing tests' }),
        wire,
        review,
        frameOf(revenueHeader),
      ].map(boxOf),
    );
    // One inside 3 RevenueCat's frame, under its header; the other a kin on the session's own line, on its focus.
    expect(wireBox.y).toBeGreaterThanOrEqual(revenue.y + revenue.height);
    expect(build.y).toBeGreaterThanOrEqual(wireBox.y + wireBox.height);
    expectInside(wireBox, revenueFrame);
    expect(own.y).toBeGreaterThanOrEqual(play.y + play.height);
    expectInside(reviewBox, own, "on the session's line");
    expect(run.y).toBeGreaterThanOrEqual(reviewBox.y + reviewBox.height);
    const tiers = page.locator('.ip-work', { hasText: 'Compare the tiers' });
    const upload = page.locator('.ip-work', { hasText: 'Upload the key' });
    // A subagent's task carries its tag in the card's left column and no bar; the session's own carries the bar.
    await expect(tiers.locator('.ip-work-agent')).toHaveCount(0);
    await expect(tiers.locator('.ip-work-tag')).toHaveText('a1');
    await expect(upload.locator('.ip-work-agent')).toBeVisible();
    await expect(upload.locator('.ip-work-tag')).toHaveCount(0);
    // One family, one hue: the session's letter and character, the kin's tags and characters, the subagent's task tag
    // and the session's task bar.
    const colours = await page.evaluate<Record<string, string>>(`(() => {
      const find = (sel, text) => [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(text));
      const kin = (tag) => document.querySelector('.ip-agent[aria-label^="' + tag + ' · "]');
      const color = (n) => getComputedStyle(n).color;
      return {
        own: color(find('.ip-badge', 'E2E session').querySelector('.ip-badge-label .ip-tag')),
        lead: color(find('.ip-badge', 'E2E session').querySelector(':scope > .ip-char svg')),
        wire: color(kin('a1').querySelector('.ip-agent-tag')),
        wireCharacter: color(kin('a1').querySelector('.ip-char svg')),
        review: color(kin('a2').querySelector('.ip-agent-tag')),
        tag: color(find('.ip-work', 'Compare the tiers').querySelector('.ip-work-tag')),
        ownMarker: getComputedStyle(find('.ip-work', 'Upload the key').querySelector('.ip-work-agent')).backgroundColor,
      };
    })()`);
    expect(colours.own).toBe('rgb(11, 107, 125)');
    for (const part of ['lead', 'wire', 'wireCharacter', 'review', 'tag', 'ownMarker']) expect(colours[part], part).toBe(colours.own);
    await hook(api, fresh.session, { event: 'subagent-stop', agentId: 'agent-1' });
    // Stopped, it keeps its tag, loses its time and goes grey; its name says when it finished.
    await expect(wire).toHaveText('a1');
    await expect(wire).toHaveAccessibleName('a1 · Wire up RevenueCat · sonnet · done just now');
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
    const wire = page.getByRole('img', { name: /^a1 · Wire up RevenueCat/ });
    const readers = page.locator('.ip-readers');
    // A kin's tooltip is its line, then what it was asked to do.
    await expect(wire).toHaveAttribute('title', new RegExp(`^a1 · Wire up RevenueCat · sonnet · ${RUNNING}\\nWire the paywall to RevenueCat and report the tiers\\.$`));
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
    await expect(readers.locator('.ip-tag')).toHaveCSS('color', 'rgb(11, 107, 125)');
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
    // Quiet: a reader's ◇ is muted in Details, not in the session's hue.
    await expect(details.locator('.ip-dagent .ip-reader-mark').first()).toHaveCSS('color', 'rgb(71, 85, 105)');
    // Play app signing's card now holds its lines, so 3 RevenueCat sits under the open sheet: close it, then click.
    await details.getByRole('button', { name: 'Close' }).click();
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
    // The numeral sits in the gutter, left of its card's header.
    const [aMark, aCard] = await Promise.all([marker('3 RevenueCat'), page.locator('.ip-node', { hasText: '3 RevenueCat' })].map(boxOf));
    expect(aMark.x + aMark.width).toBeLessThanOrEqual(aCard.x);
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
    // Each agent line's name leads with its letter: no ◆, no count.
    await expect(page.locator('.ip-badge', { hasText: 'E2E session' })).toHaveAccessibleName('A · E2E session · working');
    await expect(page.locator('.ip-badge', { hasText: 'Second session' })).toHaveAccessibleName('B · Second session · working');
    // B's subagent is a kin led by b1, and so is its task.
    const agent = page.getByRole('img', { name: /^b1 · Price the tiers/ });
    await expect(agent).toHaveText(new RegExp(`^b1${RUN_TIME}$`));
    await expect(agent).toHaveAccessibleName(new RegExp(`^b1 · Price the tiers · sonnet · ${RUNNING}$`));
    await expect(page.locator('.ip-work', { hasText: 'Compare the plans' }).locator('.ip-work-tag')).toHaveText('b1');
    // Inside the step it names, under its header, before the next step.
    const revenueHeader = page.locator('.ip-node', { hasText: '3 RevenueCat' });
    const [revenue, build, agentBox, revenueFrame] = await Promise.all(
      [revenueHeader, page.locator('.ip-node', { hasText: '4 Build to GitHub' }), agent, frameOf(revenueHeader)].map(boxOf),
    );
    expect(agentBox.y).toBeGreaterThanOrEqual(revenue.y + revenue.height);
    expect(build.y).toBeGreaterThanOrEqual(agentBox.y + agentBox.height);
    expectInside(agentBox, revenueFrame);
    // A wears teal and B another hue, on its chip, its badge, its subagent and its subagent's task.
    const hues = await page.evaluate<Record<string, string>>(`(() => {
      const find = (sel, text) => [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(text));
      const bg = (n) => getComputedStyle(n).backgroundColor;
      const row = find('.ip-work', 'Compare the plans');
      return {
        chipA: getComputedStyle(document.querySelector('.ip-chip-s[aria-label^="A · "] .ip-tag')).color,
        badgeA: getComputedStyle(find('.ip-badge', 'E2E session').querySelector('.ip-badge-label .ip-tag')).color,
        chipB: getComputedStyle(document.querySelector('.ip-chip-s[aria-label^="B · "] .ip-tag')).color,
        badgeB: getComputedStyle(find('.ip-badge', 'Second session').querySelector('.ip-badge-label .ip-tag')).color,
        agentB: getComputedStyle(document.querySelector('.ip-agent[aria-label^="b1 · "] .ip-agent-tag')).color,
        characterB: getComputedStyle(document.querySelector('.ip-agent[aria-label^="b1 · "] .ip-char svg')).color,
        tagB: getComputedStyle(row.querySelector('.ip-work-tag')).color,
      };
    })()`);
    expect(hues.chipA).toBe('rgb(11, 107, 125)');
    expect(hues.badgeA).toBe(hues.chipA);
    expect(hues.chipB).not.toBe(hues.chipA);
    expect(hues.chipB).not.toBe('rgba(0, 0, 0, 0)');
    for (const part of ['badgeB', 'agentB', 'characterB', 'tagB']) expect(hues[part], part).toBe(hues.chipB);
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
    await expect(details.locator('.ip-wt', { hasText: /^◐ Upload the key/ })).toHaveText('◐ Upload the key · E2E session');
    await expect(details.locator('.ip-wt', { hasText: 'Check the release track' })).toHaveText('○ Check the release track · E2E session · after Upload the key');
    await expect(details.locator('.ip-wt', { hasText: 'Collect the screenshots' })).toHaveText('a1 ○ Collect the screenshots · Draft the store notes');
    await expect(details.locator('.ip-dagent')).toHaveText(new RegExp(`^a1 · Draft the store notes · sonnet · ${RUNNING}$`));
    // Quiet: the rows read as the canvas's. ◐ in the active ink and still, the hue bar on the session's own task only,
    // the tags in DM Mono in the session's hue.
    const upload = details.locator('.ip-wt', { hasText: /^◐ Upload the key/ });
    const screenshots = details.locator('.ip-wt', { hasText: 'Collect the screenshots' });
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('color', 'rgb(194, 65, 12)');
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('animation-name', 'none');
    await expect(upload.locator('.ip-work-agent')).toHaveCSS('background-color', 'rgb(11, 107, 125)');
    await expect(screenshots.locator('.ip-work-agent')).toHaveCount(0);
    for (const tag of [screenshots.locator('.ip-work-tag'), details.locator('.ip-dagent .ip-agent-tag')]) {
      await expect(tag).toHaveCSS('font-family', /DM Mono/);
      await expect(tag).toHaveCSS('color', 'rgb(11, 107, 125)');
    }
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
    expectInside(rowBox, await boxOf(frameOf(card)));
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
    await expect(group.locator('.ip-wt.stale')).toHaveText('○ Compare the keystores · Check the keystore');
    await expect(group.locator('.ip-dtrail')).toHaveText(new RegExp(`^◆ Check the keystore · sonnet · ran ${RUNNING} · stopped just now$`));
    // Quiet: the trail's ◆ is muted, and its open task a faint ○.
    await expect(group.locator('.ip-dtrail .ip-agent-dot')).toHaveCSS('color', 'rgb(71, 85, 105)');
    await expect(group.locator('.ip-wt.stale .ip-work-mark')).toHaveCSS('color', 'rgb(100, 116, 139)');
    await expect(details.locator('.ip-wt:not(.stale)')).toHaveCount(0);
  });

  test("a step's agents and tasks sit inside its card: one line per session with its character and kin, the done row at the line's end, a lane per phase", async ({ page, api, fresh }) => {
    const revenue = fresh.ids['3 RevenueCat'];
    // On the session's focus: a running worker, a worker that has just stopped, a reader and three tasks, one done.
    await subagent(api, fresh, 'agent-1', 'Review the signing config', 'haiku');
    await subagent(api, fresh, 'agent-2', 'Check the keystore', 'sonnet');
    await hook(api, fresh.session, { event: 'subagent-stop', agentId: 'agent-2' });
    await subagent(api, fresh, 'reader-1', 'Map the signing config', 'haiku', { agentType: 'Explore' });
    await task(api, fresh, '1', 'Upload the key', 'in_progress');
    await task(api, fresh, '2', 'Check the release track');
    await task(api, fresh, '3', 'Read the signing guide', 'completed');
    // Away from it, on 3 RevenueCat: a worker, and a done task of its own.
    await subagent(api, fresh, 'agent-3', `#${revenue} Wire up RevenueCat`, 'sonnet');
    await task(api, fresh, '4', `#${revenue} Price the tiers`, 'completed');
    // On the stack head Road to market: a worker, so its line holds kin, and a done task, whose row then takes a line
    // of its own.
    const road = fresh.ids['Road to market'];
    await subagent(api, fresh, 'agent-4', `#${road} Survey the store listings`, 'haiku');
    await task(api, fresh, '5', `#${road} Draft the store notes`, 'completed');
    await open(page, fresh);

    const header = page.locator('.ip-node', { hasText: 'Play app signing' });
    const frame = frameOf(header);
    await expect(header).toBeInViewport();
    const line = page.getByRole('group', { name: 'A · E2E session · working', exact: true });
    const lead = line.locator(':scope > .ip-char');
    const running = page.getByRole('img', { name: /^a1 · Review the signing config/ });
    const stopped = page.getByRole('img', { name: /^a2 · Check the keystore/ });
    const readers = frame.locator('.ip-readers');
    const done = frame.locator('.ip-work-done');
    await expect(done).toHaveText('✓ 1 done');

    // Everything the session does on its focus sits inside the card's frame, and the next card starts below it.
    const [frameBox, lineBox, leadBox, runningBox, readersBox, doneBox, uploadBox, checkBox, letterBox, nextBox] = await Promise.all(
      [
        frame,
        line,
        lead,
        running,
        readers,
        done,
        page.locator('.ip-work', { hasText: 'Upload the key' }),
        page.locator('.ip-work', { hasText: 'Check the release track' }),
        line.locator('.ip-badge-label .ip-tag'),
        frameOf(page.locator('.ip-node', { hasText: 'Run signing tests' })),
      ].map(boxOf),
    );
    const parts = { line: lineBox, lead: leadBox, kin: runningBox, readers: readersBox, done: doneBox, upload: uploadBox, check: checkBox };
    for (const [what, box] of Object.entries(parts)) expectInside(box, frameBox, what);
    expect(nextBox.y - (frameBox.y + frameBox.height), 'the next card, at least 10 px below').toBeGreaterThanOrEqual(9.5);
    // Kin with the lead: the lead, then the kin, then the label, whose letter also leads the line's name.
    expect(leadBox.x + leadBox.width).toBeLessThanOrEqual(runningBox.x);
    expect(runningBox.x + runningBox.width).toBeLessThanOrEqual(letterBox.x);
    // The done row shares the readers line, the card's last, at its right end inside the frame's padding.
    expect(Math.abs(doneBox.y + doneBox.height / 2 - (readersBox.y + readersBox.height / 2)), 'on the readers line').toBeLessThanOrEqual(1);
    expect(frameBox.x + frameBox.width - (doneBox.x + doneBox.width), "at the frame's right padding").toBeCloseTo(13, 0);
    // On a card whose last line holds kin, the done row takes a line of its own below it.
    const revenueFrame = frameOf(page.locator('.ip-node', { hasText: '3 RevenueCat' }));
    const away = revenueFrame.locator('.ip-badge');
    await expect(away).toHaveAccessibleName('A · subagents of E2E session');
    await expect(away.getByRole('img', { name: /^a4 · Wire up RevenueCat/ })).toHaveCount(1);
    const [awayBox, ownLineDone, revenueFrameBox] = await Promise.all([away, revenueFrame.locator('.ip-work-done'), revenueFrame].map(boxOf));
    expect(ownLineDone.y, 'below the line with kin').toBeGreaterThanOrEqual(awayBox.y + awayBox.height - 0.5);
    expectInside(ownLineDone, revenueFrameBox, 'its own line');

    // A running kin shows its run time in DM Mono after its tag; a stopped one shows none, ended and grey.
    await expect(running).toHaveText(new RegExp(`^a1${RUN_TIME}$`));
    const time = running.locator('.ip-agent-time');
    await expect(time).toHaveCSS('font-family', /DM Mono/);
    const [tagBox, timeBox] = await Promise.all([running.locator('.ip-agent-tag'), time].map(boxOf));
    expect(timeBox.x).toBeGreaterThanOrEqual(tagBox.x + tagBox.width);
    await expect(stopped).toHaveText('a2');
    await expect(stopped.locator('.ip-agent-time')).toHaveCount(0);
    await expect(stopped.locator('.ip-char')).toHaveAttribute('data-state', 'ended');
    await expect(stopped.locator('.ip-agent-tag')).toHaveCSS('color', 'rgb(71, 85, 105)');
    await expect(lead).toHaveAttribute('data-state', 'work');

    // A lane per phase: Road to market's holds its stack head and children, 18 px below Milestones'. Clicks pass through.
    const laneOf = (title: string) => page.locator(`.react-flow__node-ipLane[data-id="lane${fresh.ids[title]}"]`);
    const [roadLane, milestonesLane] = await Promise.all([laneOf('Road to market'), laneOf('Milestones')].map(boxOf));
    for (const title of ['Road to market', '1 iOS certificate', '2 Android signing', 'Run signing tests']) {
      expectInside(await boxOf(page.locator('.ip-node', { hasText: title })), roadLane, title);
    }
    // 3 RevenueCat's worker pins it, so 4 and 5 show after it and only 6 Beta and 7 Launch fold.
    expectInside(await boxOf(page.locator('.ip-more', { hasText: '+2 more' })), roadLane, '+2 more');
    expect(roadLane.y - (milestonesLane.y + milestonesLane.height), 'apart').toBeCloseTo(18, 0);
    await expect(laneOf('Road to market')).toHaveCSS('pointer-events', 'none');
    // The stack head's track fills to done / total: 1 of Road to market's 7 steps is done.
    const head = page.locator('.ip-node.stack', { hasText: 'Road to market' });
    await expect(head.locator('.ip-progress')).toHaveText('1/7');
    const track = frameOf(head).locator('.ip-track');
    const [trackBox, fillBox] = await Promise.all([track, track.locator('.ip-track-fill')].map(boxOf));
    expect(fillBox.width / trackBox.width).toBeCloseTo(1 / 7, 2);
    // Its line and the done row on a line of its own both start at flow x 56, where its children's frames start.
    await expect(frameOf(head).getByRole('img', { name: /Survey the store listings/ })).toHaveCount(1);
    const [headLetter, headDone, childFrame] = await Promise.all(
      [frameOf(head).locator('.ip-badge > .ip-tag'), frameOf(head).locator('.ip-work-done'), frameOf(page.locator('.ip-node', { hasText: '1 iOS certificate' }))].map(boxOf),
    );
    expect(Math.abs(headLetter.x - childFrame.x), "the line's letter, at x 56").toBeLessThanOrEqual(1);
    expect(Math.abs(headDone.x - childFrame.x), 'the done row, at x 56').toBeLessThanOrEqual(1);
    // The zoom buttons: one row, at the canvas's top right.
    const canvas = await boxOf(page.locator('.react-flow'));
    const zoom = await Promise.all(['zoomin', 'zoomout', 'fitview'].map((b) => boxOf(page.locator(`.react-flow__controls-${b}`))));
    for (const b of zoom) expect(Math.abs(b.y - zoom[0].y), 'one row').toBeLessThanOrEqual(0.5);
    expect(zoom[0].x + zoom[0].width).toBeLessThanOrEqual(zoom[1].x);
    expect(zoom[1].x + zoom[1].width).toBeLessThanOrEqual(zoom[2].x);
    expect(canvas.x + canvas.width - (zoom[2].x + zoom[2].width), 'at the right').toBeLessThanOrEqual(13);
    expect(zoom[0].y - canvas.y, 'at the top').toBeLessThanOrEqual(9);

    // A click anywhere on the card opens Details, and the frame draws the selected ring.
    await readers.locator('.ip-readers-text').click();
    await expect(page.getByRole('complementary')).toContainText(`#${fresh.ids['Play app signing']} Play app signing`);
    await expect(frame).toHaveClass(/\bselected\b/);
    await expect(frame).not.toHaveCSS('box-shadow', 'none');

    // The working lead bobs and blinks; under reduced motion it holds still.
    const body = lead.locator('.ip-char-body');
    const eyes = lead.locator('g.ip-char-eyes');
    await expect(body).toHaveCSS('animation-name', 'ip-bob');
    await expect(eyes).toHaveCSS('animation-name', 'ip-blink');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(body).toHaveCSS('animation-name', 'none');
    await expect(eyes).toHaveCSS('animation-name', 'none');
  });
});
