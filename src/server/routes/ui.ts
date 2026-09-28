import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { AppOptions, Guard } from '../app';
import { badRequest } from '../errors';
import { openInEditorOrReveal } from '../open-path';
import { requireResource } from '../repo/resources';
import { openBody } from '../schemas';

const TOKEN_META = /<meta name="ip-ui-token" content="[^"]*"\s*\/?>/;

export function registerUi(app: FastifyInstance, opts: AppOptions, requireToken: Guard): void {
  app.post('/api/admin/shutdown', { preHandler: requireToken }, async () => {
    setImmediate(() => opts.onShutdown?.());
    return { ok: true };
  });

  app.post('/api/ui/open', async (req, reply) => {
    if (req.headers['x-ip-ui-token'] !== opts.uiToken) {
      reply.code(401).send({ error: 'Missing or invalid UI token' });
      return reply;
    }
    const { resourceId } = openBody.parse(req.body);
    const resource = requireResource(opts.ctx, resourceId);
    if (!resource.path) throw badRequest(`r${resourceId} has no file path`);
    if (!existsSync(resource.path)) throw badRequest(`File not found: ${resource.path}`);
    await (opts.openPath ?? openInEditorOrReveal)(resource.path);
    return { ok: true };
  });

  const webDir = opts.webDir;
  if (!webDir || !existsSync(join(webDir, 'index.html'))) {
    app.get('/', async (_req, reply) => reply.code(503).type('text/plain; charset=utf-8').send('InProgress UI is not built. Run: npm run build'));
    return;
  }
  const html = readFileSync(join(webDir, 'index.html'), 'utf8').replace(TOKEN_META, `<meta name="ip-ui-token" content="${opts.uiToken}">`);
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html));
  if (existsSync(join(webDir, 'assets'))) app.register(fastifyStatic, { root: join(webDir, 'assets'), prefix: '/assets/' });
}
