import { existsSync, readFileSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { isLocalAbsolutePath } from '../../lib/paths';
import type { AppOptions, Guard } from '../app';
import { badRequest } from '../errors';
import { openInDefaultBrowser, openInEditorOrReveal } from '../open-path';
import { pageHead } from '../pages';
import { confirmPage, requireResource } from '../repo/resources';
import { addSyncStep, librarySync, openCopy, syncDiff } from '../sync';
import { idParam, openBody, openUrlBody, syncBody, syncStepBody, syncTemplateBody } from '../schemas';

const TOKEN_META = /<meta name="ip-ui-token" content="[^"]*"\s*\/?>/;

/**
 * Backstops the Markdown sanitiser (no inline or foreign scripts), keeps the loopback UI out of other
 * pages' frames, and stops resource Markdown from loading remote images (tracking pixels).
 */
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function registerUi(app: FastifyInstance, opts: AppOptions, requireToken: Guard, requireUi: Guard): void {
  app.post('/api/admin/shutdown', { preHandler: requireToken }, async () => {
    setImmediate(() => opts.onShutdown?.());
    return { ok: true };
  });

  // The window's launches, behind the same guard as its other writes (requireUi: Origin, JSON, UI token).
  app.post('/api/ui/open', { onRequest: requireUi }, async (req) => {
    const { resourceId } = openBody.parse(req.body);
    const resource = requireResource(opts.ctx, resourceId);
    if (!resource.path) throw badRequest(`r${resourceId} has no file path`);
    if (!isLocalAbsolutePath(resource.path)) throw badRequest(`Not a local absolute path: ${resource.path}`);
    // Asynchronous: a stalled mapped drive must not block the event loop (and with it every hook).
    let info: Stats;
    try {
      info = await stat(resource.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw badRequest(`File not found: ${resource.path}`);
      throw badRequest(`Cannot open ${resource.path}: ${(err as Error).message}`);
    }
    if (!info.isFile()) throw badRequest(`Not a file: ${resource.path}`);
    await (opts.openPath ?? openInEditorOrReveal)(resource.path);
    return { ok: true };
  });

  // The Library's Sync check runs Shipwright's script, so it is the window's own POST, never a GET another page could fire.
  // The routes after it run the script too, so each is a UI-token POST: the diff, the sync step and the copy's open.
  app.post('/api/ui/library/sync', { onRequest: requireUi }, async (req, reply) => reply.header('cache-control', 'no-store').send(await librarySync(opts.ctx, syncBody.parse(req.body ?? {}))));
  app.post('/api/ui/library/sync/diff', { onRequest: requireUi }, async (req, reply) => {
    const { slug, template } = syncTemplateBody.parse(req.body);
    return reply.header('cache-control', 'no-store').send(await syncDiff(opts.ctx, slug, template));
  });
  app.post('/api/ui/library/sync/step', { onRequest: requireUi }, async (req, reply) => {
    return reply.code(201).send({ node: await addSyncStep(opts.ctx, syncStepBody.parse(req.body).slug) });
  });
  app.post('/api/ui/library/sync/open', { onRequest: requireUi }, async (req) => {
    const { slug, template } = syncTemplateBody.parse(req.body);
    await openCopy(opts.ctx, slug, template, opts.openPath ?? openInEditorOrReveal);
    return { ok: true };
  });

  // The viewer's Still accurate: the page's claim holds at its repo's HEAD now.
  app.post('/api/ui/resources/:id/confirm', { onRequest: requireUi }, async (req) => {
    const id = idParam.parse(req.params).id;
    return confirmPage(opts.ctx, 'window', id, await pageHead(opts.ctx, requireResource(opts.ctx, id)));
  });

  // The UI runs in an Edge app window, where a plain link opens in Edge: links go through here to the default browser.
  app.post('/api/ui/open-url', { onRequest: requireUi }, async (req) => {
    const { url } = openUrlBody.parse(req.body);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest(`Not a link: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw badRequest(`Only http and https links open: ${parsed.protocol}`);
    await (opts.openUrl ?? openInDefaultBrowser)(parsed.href);
    return { ok: true };
  });

  const webDir = opts.webDir;
  if (!webDir || !existsSync(join(webDir, 'index.html'))) {
    app.get('/', async (_req, reply) => reply.code(503).type('text/plain; charset=utf-8').send('InProgress UI is not built. Run: npm run deploy'));
    return;
  }
  const index = readFileSync(join(webDir, 'index.html'), 'utf8');
  if (!TOKEN_META.test(index)) throw new Error('index.html has no ip-ui-token meta tag');
  // A function replacer inserts the token as is; a string replacer would expand $& and the like.
  const html = index.replace(TOKEN_META, () => `<meta name="ip-ui-token" content="${opts.uiToken}">`);
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', CSP).send(html));
  if (existsSync(join(webDir, 'assets'))) app.register(fastifyStatic, { root: join(webDir, 'assets'), prefix: '/assets/' });
}
