import type { FastifyInstance } from 'fastify';
import type { EventRow } from '../../core/types';
import type { Ctx } from '../db/tx';
import { listEventsSince, maxEventId } from '../repo/events';

export function registerSse(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/events/stream', (req, reply) => {
    const { since } = req.query as { since?: string };
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (e: EventRow) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    // Everything below runs synchronously, so no event can slip between the replay query and the subscription.
    let last = maxEventId(ctx);
    if (since !== undefined && /^\d+$/.test(since)) {
      const rows = listEventsSince(ctx, Number(since), 5000);
      rows.forEach(send);
      last = rows.length ? rows[rows.length - 1].id : Math.min(last, Number(since));
    }
    const onEvent = (e: EventRow) => {
      if (e.id > last) {
        last = e.id;
        send(e);
      }
    };
    ctx.bus.on('event', onEvent);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      ctx.bus.off('event', onEvent);
    });
  });
}
