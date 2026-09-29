import type { FastifyInstance } from 'fastify';
import type { EventRow } from '../../core/types';
import type { Ctx } from '../db/tx';
import { listEventsSince, maxEventId } from '../repo/events';

/** Unsent bytes past which a client counts as stuck (a frozen tab, say): the server stops holding events for it. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

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
    // A dropped client reconnects with ?since and gets what it missed from the event log.
    const write = (chunk: string) => {
      if (!res.destroyed) res.write(chunk);
    };
    // Live writes only: the catch-up below is written in one synchronous burst, so its bytes always sit in the
    // buffer for a moment and would get a healthy client dropped. A client that stops reading is caught here.
    const push = (chunk: string) => {
      write(chunk);
      if (res.writableLength > MAX_BUFFERED_BYTES) res.destroy();
    };
    const frame = (e: EventRow) => `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`;
    write(': connected\n\n');
    // Everything below runs synchronously, so no event can slip between the replay query and the subscription.
    let last = maxEventId(ctx);
    if (since !== undefined && /^\d+$/.test(since)) {
      const rows = listEventsSince(ctx, Number(since), 5000);
      for (const e of rows) write(frame(e));
      last = rows.length ? rows[rows.length - 1].id : Math.min(last, Number(since));
    }
    const onEvent = (e: EventRow) => {
      if (e.id > last) {
        last = e.id;
        push(frame(e));
      }
    };
    ctx.bus.on('event', onEvent);
    const heartbeat = setInterval(() => push(': heartbeat\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      ctx.bus.off('event', onEvent);
    });
  });
}
