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

test('a long project name is cut short and the top bar stays on one line', async ({ page, api }) => {
  const project = await seed(api, 'A project name long enough to fill a narrow window several times over, and then some');
  await open(page, project);
  await expect(page).toHaveTitle(/A project name long enough/);
  for (const button of [page.locator('.ip-proj'), page.getByRole('button', { name: /need you/ }), page.getByRole('button', { name: /Follow/ })]) {
    await expect(button).toBeInViewport({ ratio: 1 });
  }
  expect((await page.locator('.ip-topbar').boundingBox())!.height, 'one line of controls').toBeLessThan(50);
  expect(await page.evaluate<boolean>(`(() => { const n = document.querySelector('.ip-proj-name'); return n.scrollWidth > n.clientWidth; })()`)).toBe(true);
});

test('dark mode reaches the canvas controls; reduced motion stops the pulse and flash', async ({ page, demo }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await open(page, demo);
  await expect(page.locator('.react-flow')).toHaveClass(/\bdark\b/);
  await expect(page.locator('.ip-chip-s .ip-pulse')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.ip-node.working .ip-marker.m-active').first()).toHaveCSS('animation-name', 'none');
  // Amber ink on an amber tint, like the needs-you pill.
  await expect(page.locator('.ip-node .ip-you')).toHaveCSS('color', 'rgb(255, 179, 64)');
  await page.keyboard.press('n');
  const flashed = page.locator('.ip-node.flash', { hasText: 'Run signing tests' });
  await expect(flashed).toHaveCSS('animation-name', 'none');
  await expect(flashed).not.toHaveCSS('box-shadow', 'none');
  // Section labels in Details are readable on the dark panel.
  await flashed.click();
  await expect(page.getByRole('complementary').locator('.ip-label').first()).toHaveCSS('color', 'rgb(161, 161, 166)');
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

test('a wheel tick or a minimap drag turns Follow off, a minimap click does not', async ({ page, demo }) => {
  await open(page, demo);
  const follow = page.getByRole('button', { name: /Follow/ });
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
  const minimap = page.locator('.react-flow__minimap');
  await minimap.click();
  await minimap.click({ button: 'right' });
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  const map = (await minimap.boundingBox())!;
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width / 2 + 5, map.y + map.height / 2 + 15);
  await page.mouse.up();
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await follow.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2, pane.y + 60);
  await page.mouse.wheel(0, 60);
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
});

test('a minimap drag whose first move lands outside the minimap turns Follow off', async ({ page, demo }) => {
  await open(page, demo);
  const follow = page.getByRole('button', { name: /Follow/ });
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
  const map = (await page.locator('.react-flow__minimap').boundingBox())!;
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await page.mouse.down();
  // One fast move, straight out over the canvas.
  await page.mouse.move(map.x - 100, map.y - 100);
  await page.mouse.up();
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
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

test('the resource viewer is modal and hands focus back when it closes', async ({ page, demo }) => {
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
  await open(page, demo);
  await page.locator('.ip-chip', { hasText: 'Unsafe Markdown' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Signing docs' }).click();
  await expect.poll(() => opened).toEqual(['https://example.com/signing']);
  expect(popups).toHaveLength(0);
});
