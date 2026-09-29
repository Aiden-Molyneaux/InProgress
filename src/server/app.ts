import { timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import type { Ctx } from './db/tx';
import { ApiError } from './errors';
import { registerReadRoutes } from './routes/read';
import { registerSessionRoutes } from './routes/sessions';
import { registerSse } from './routes/sse';
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

export const actorOf = (req: FastifyRequest): string => String(req.headers['x-inprogress-actor'] || 'system').slice(0, 120);

/** Compare a presented token with the expected one in constant time. timingSafeEqual throws on unequal lengths, so check those first. */
export function tokenMatches(presented: unknown, expected: string): boolean {
  const got = Buffer.from(typeof presented === 'string' ? presented : '');
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function buildApp(opts: AppOptions): FastifyInstance {
  // An empty token or UI token would accept requests that send an empty one.
  if (!opts.token || !opts.uiToken) throw new Error('buildApp needs a non-empty token and uiToken');
  const app = Fastify({
    logger: opts.logger ?? false,
    // Keep server.log for errors: no line per request. (The top-level disableRequestLogging option is deprecated in Fastify 5.)
    logController: new LogController({ disableRequestLogging: true }),
    // 8 MiB: a 1,000,000-character resource grows past 2 MiB once JSON-escaped and UTF-8 encoded.
    bodyLimit: 8 * 1024 * 1024,
    forceCloseConnections: true,
  });

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

  const requireToken: Guard = async (req, reply) => {
    if (!tokenMatches(req.headers.authorization, `Bearer ${opts.token}`)) {
      reply.code(401).send({ error: 'Missing or invalid InProgress token' });
      return reply;
    }
  };

  registerReadRoutes(app, opts.ctx, opts.version);
  registerWriteRoutes(app, opts.ctx, requireToken);
  registerSessionRoutes(app, opts.ctx, requireToken);
  registerSse(app, opts.ctx);
  registerUi(app, opts, requireToken);
  return app;
}
