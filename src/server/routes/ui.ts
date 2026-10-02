import { existsSync, readFileSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { tokenMatches, type AppOptions, type Guard } from '../app';
import { badRequest } from '../errors';
import { openInEditorOrReveal } from '../open-path';
import { requireResource } from '../repo/resources';
import { openBody } from '../schemas';

const TOKEN_META = /<meta name="ip-ui-token" content="[^"]*"\s*\/?>/;

/**
 * Backstops the Markdown sanitiser (no inline or foreign scripts), keeps the loopback UI out of other
 * pages' frames, and stops resource Markdown from loading remote images (tracking pixels).
 */
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * A path on a local disk. UNC and device paths (\\host\share, //host/share, \\?\, \\.\) are refused
 * before anything touches them: Windows would open an SMB session with the user's credentials,
 * and a slow or unreachable host would stall the server.
 */
function isLocalAbsolutePath(path: string): boolean {
  if (path.startsWith('\\\\') || path.startsWith('//')) return false;
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : isAbsolute(path);
}

export function registerUi(app: FastifyInstance, opts: AppOptions, requireToken: Guard): void {
  app.post('/api/admin/shutdown', { preHandler: requireToken }, async () => {
    setImmediate(() => opts.onShutdown?.());
    return { ok: true };
  });

  app.post('/api/ui/open', async (req, reply) => {
    if (!tokenMatches(req.headers['x-ip-ui-token'], opts.uiToken)) {
      reply.code(401).send({ error: 'Missing or invalid UI token' });
      return reply;
    }
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
