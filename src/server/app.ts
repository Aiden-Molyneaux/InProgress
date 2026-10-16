import { timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import type { BuildInfo } from '../lib/version';
import type { Ctx } from './db/tx';
import { ApiError } from './errors';
import type { DesktopSession } from './open-desktop';
import { registerAskRoutes } from './routes/asks';
import { registerReadRoutes } from './routes/read';
import { registerSessionRoutes } from './routes/sessions';
import { registerSse } from './routes/sse';
import { registerUi } from './routes/ui';
import { registerWindowRoutes } from './routes/window';
import { registerWriteRoutes } from './routes/write';

export interface AppOptions {
  ctx: Ctx;
  token: string;
  uiToken: string;
  version: string;
  /** The running build (dist/build.json); null in dev and tests. */
  build?: BuildInfo | null;
  webDir?: string;
  logger?: FastifyServerOptions['logger'];
  onShutdown?: () => void;
  openPath?: (path: string) => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
  /** Runs `claude --desktop --resume <id>`; true when it exited 0 in time. Replaceable so tests never run `claude`. */
  openDesktop?: (session: DesktopSession) => Promise<boolean>;
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

  /**
   * Every write the window makes (its project actions, opening a file or a link), used as an onRequest hook so it runs
   * before the body is parsed. In this order, after the Host allow-list above: the Origin must be this server's own,
   * else 403 (Chromium sends Origin on every POST, same-origin ones too, and a page on another site can never send
   * ours); the body must be JSON, else 415, which closes the text/plain and form bodies a page can post cross-site
   * without a preflight; then the page's UI token, else 401, last, so a hostile request never trips the window's reload
   * on 401. Never register a CORS plugin: the reads stay unreadable cross-site because no answer carries CORS headers.
   */
  const requireUi: Guard = async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!host || (req.headers.origin ?? '').toLowerCase() !== `http://${host}`) {
      reply.code(403).send({ error: 'Forbidden origin' });
      return reply;
    }
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      reply.code(415).send({ error: 'Send the body as application/json' });
      return reply;
    }
    if (!tokenMatches(req.headers['x-ip-ui-token'], opts.uiToken)) {
      reply.code(401).send({ error: 'Missing or invalid UI token' });
      return reply;
    }
  };

  registerReadRoutes(app, opts.ctx, opts.version, opts.build ?? null);
  registerWriteRoutes(app, opts.ctx, requireToken);
  registerSessionRoutes(app, opts.ctx, requireToken);
  registerAskRoutes(app, opts.ctx, requireToken);
  registerSse(app, opts.ctx);
  registerWindowRoutes(app, opts.ctx, requireUi, opts.openDesktop);
  registerUi(app, opts, requireToken, requireUi);
  return app;
}
