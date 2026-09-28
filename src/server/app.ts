import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import type { Ctx } from './db/tx';
import { ApiError } from './errors';
import { registerReadRoutes } from './routes/read';
import { registerSessionRoutes } from './routes/sessions';
import { registerUi } from './routes/ui';
import { registerWriteRoutes } from './routes/write';

export interface AppOptions {
  ctx: Ctx;
  token: string;
  uiToken: string;
  version: string;
  webDir?: string;
  logger?: FastifyServerOptions['logger'];
  onShutdown?: () => void;
  openPath?: (path: string) => Promise<void>;
}

export type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const actorOf = (req: FastifyRequest): string => String(req.headers['x-inprogress-actor'] ?? 'system').slice(0, 120);

export function buildApp(opts: AppOptions): FastifyInstance {
  // 8 MiB: a 1,000,000-character resource grows past 2 MiB once JSON-escaped and UTF-8 encoded.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 8 * 1024 * 1024, forceCloseConnections: true });

  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(host)) {
      reply.code(403).send({ error: 'Forbidden host' });
      return reply;
    }
  });

  // Fastify 5 types the handler's error as unknown unless told otherwise.
  app.setErrorHandler<Error & { statusCode?: number }>((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message, hint: err.hint });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', hint: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: err.message || 'Internal error' });
  });

  const expected = Buffer.from(`Bearer ${opts.token}`);
  const requireToken: Guard = async (req, reply) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      reply.code(401).send({ error: 'Missing or invalid InProgress token' });
      return reply;
    }
  };

  registerReadRoutes(app, opts.ctx, opts.version);
  registerWriteRoutes(app, opts.ctx, requireToken);
  registerSessionRoutes(app, opts.ctx, requireToken);
  registerUi(app, opts, requireToken);
  return app;
}
