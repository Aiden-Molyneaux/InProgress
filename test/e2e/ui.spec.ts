import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';

const headers = () => ({ authorization: `Bearer ${readFileSync('.e2e-home/token', 'utf8').trim()}`, 'x-inprogress-actor': 'scribe:e2e-session' });
const ids: Record<string, number> = {};
let api: APIRequestContext;

// Everything here is something the viewer's sanitiser must neutralise.
const UNSAFE_MARKDOWN = [
  '# Unsafe Markdown',
  '[Run me](javascript:alert(1))',
  `<img src=x onerror="document.title = 'XSS'">`,
  '<style>.ip-app{display:none}</style>',
  '<div class="ip-viewer" style="position:fixed">x</div>',
  '[Signing docs](https://example.com/signing)',
].join('\n\n');

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4399' });
  const project = await (await api.post('/api/projects', { headers: headers(), data: { name: 'E2E Demo', description: 'Seeded by Playwright' } })).json();
  const milestones = Array.from({ length: 25 }, (_, i) => ({ title: `Milestone ${i + 1}`, status: 'done' as const }));
  const created = await (
    await api.post('/api/nodes', {
      headers: headers(),
      data: {
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
      },
    })
  ).json();
  for (const n of created as { id: number; title: string }[]) ids[n.title] = n.id;
  await api.post('/api/resources', { headers: headers(), data: { nodeId: ids['Run signing tests'], kind: 'test-suite', title: 'Signing test suite', content: '# Signing tests\n\n- [ ] Upload key accepted' } });
  await api.post('/api/resources', { headers: headers(), data: { nodeId: ids['Upload keystore'], kind: 'doc', title: 'Unsafe Markdown', content: UNSAFE_MARKDOWN } });
  await api.post('/api/sessions/e2e-session/enroll', { headers: headers(), data: { project: project.slug, title: 'E2E session' } });
  await api.post('/api/sessions/e2e-session/focus', { headers: headers(), data: { nodeId: ids['Play app signing'] } });
  await api.post('/api/sessions/e2e-session/hook', { headers: headers(), data: { event: 'prompt' } });
});

test.afterAll(async () => {
  await api.dispose();
});

// Every test must end with no console error and no uncaught exception. Warnings are kept as annotations.
test.afterEach(async ({ page }, testInfo) => {
  const messages = await page.consoleMessages({ filter: 'all' });
  for (const m of messages) if (m.type() === 'warning') testInfo.annotations.push({ type: 'console warning', description: m.text() });
  const errors = messages.filter((m) => m.type() === 'error').map((m) => m.text());
  for (const e of await page.pageErrors({ filter: 'all' })) errors.push(`Uncaught: ${e.message}`);
  expect(errors).toEqual([]);
});

test('opens on the current work with folding, needs-you and the session badge', async ({ page }) => {
  await page.goto('/');
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

test('shows live changes and follows them', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeVisible();
  await api.patch(`/api/nodes/${ids['Play app signing']}`, { headers: headers(), data: { status: 'done', outcome: 'Configured' } });
  await expect(page.locator('.ip-node.st-done', { hasText: 'Play app signing' })).toBeVisible({ timeout: 5000 });
  // Let the follow move for that status change finish before moving the camera ourselves.
  await page.waitForTimeout(1600);
  await page.keyboard.press('Home');
  await expect(page.locator('.ip-node.root')).toBeInViewport();
  await api.post('/api/nodes', { headers: headers(), data: { parentId: ids['Road to market'], nodes: [{ title: 'Launch checklist', status: 'active' }] } });
  await expect(page.locator('.ip-node', { hasText: 'Launch checklist' })).toBeInViewport({ timeout: 6000 });
  await expect(page.locator('.ip-activity')).toContainText('Launch checklist');
});

test('the needs-you pill jumps to and highlights the item', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: /need you/ }).click();
  await expect(page.locator('.ip-node.flash', { hasText: 'Run signing tests' })).toBeInViewport();
});

test('clicking a node opens its details and copies a reference', async ({ page }) => {
  await page.goto('/');
  const id = ids['Run signing tests'];
  await page.locator('.ip-node', { hasText: 'Run signing tests' }).click();
  const details = page.getByRole('complementary');
  await expect(details).toContainText(`#${id} Run signing tests`);
  await details.getByRole('button', { name: `Copy #${id}` }).click();
  // String form: the root tsconfig has no DOM lib, so `navigator` must not appear in test code.
  expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`#${id} Run signing tests`);
});

test('a resource chip opens the rendered resource', async ({ page }) => {
  await page.goto('/');
  await page.locator('.ip-chip', { hasText: 'Signing test suite' }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.locator('h1')).toHaveText('Signing tests');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});

test('the resource viewer neutralises unsafe Markdown', async ({ page }) => {
  // The sample's <img src=x> would 404 and log a console error. An empty 204 still fails to load, so an onerror would fire.
  await page.route('**/x', (route) => route.fulfill({ status: 204 }));
  await page.goto('/');
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
});
