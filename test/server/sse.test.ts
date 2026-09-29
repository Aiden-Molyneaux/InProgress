import { once } from 'node:events';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRow } from '../../src/core/types';
import { buildApp } from '../../src/server/app';
import { write } from '../../src/server/db/tx';
import { listEventsSince, maxEventId } from '../../src/server/repo/events';
import { createProject } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function listen() {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: 't', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  closers.push(() => app.close());
  const port = (app.server.address() as AddressInfo).port;
  return { ctx, port, base: `http://127.0.0.1:${port}` };
}

/** Read SSE `data:` payloads until `count` events arrive. */
async function collect(url: string, count: number, during: () => void): Promise<EventRow[]> {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: EventRow[] = [];
  let buffer = '';
  during();
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)) as EventRow);
    }
  }
  ac.abort();
  return events;
}

/** Poll until `check` passes (up to 5 s). */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const recordDemo = (ctx: ReturnType<typeof makeCtx>) => write(ctx, 'test', (record) => record({ projectId: null, type: 'demo', entity: 'demo', entityId: 1 }));

describe('SSE stream', () => {
  it('streams live events after connecting', async () => {
    const { ctx, base } = await listen();
    const events = await collect(`${base}/api/events/stream`, 2, () => {
      setTimeout(() => createProject(ctx, 'test', { name: 'Live' }), 50);
    });
    expect(events.map((e) => e.type)).toEqual(['project.created', 'node.created']);
  });

  it('replays events after ?since before going live', async () => {
    const { ctx, base } = await listen();
    createProject(ctx, 'test', { name: 'Old' });
    const events = await collect(`${base}/api/events/stream?since=1`, 1, () => undefined);
    expect(events[0]).toMatchObject({ id: 2, type: 'node.created' });
  });

  it('goes live-only when since is at or beyond the newest event', async () => {
    const { ctx, base } = await listen();
    createProject(ctx, 'test', { name: 'Old' });
    const newest = maxEventId(ctx);
    for (const since of [newest, newest + 100]) {
      const events = await collect(`${base}/api/events/stream?since=${since}`, 1, () => {
        setTimeout(() => recordDemo(ctx), 50);
      });
      expect(events.map((e) => e.id), `since=${since}`).toEqual([maxEventId(ctx)]);
    }
  });

  it('delivers each event once across the replay and live seam', async () => {
    const { ctx, base } = await listen();
    createProject(ctx, 'test', { name: 'One' });
    const replayed = listEventsSince(ctx, 0);
    const events = await collect(`${base}/api/events/stream?since=0`, 4, () => {
      setTimeout(() => {
        // Already replayed: arriving again live must not reach the client twice.
        for (const e of replayed) ctx.bus.emit('event', e);
        createProject(ctx, 'test', { name: 'Two' });
      }, 50);
    });
    expect(events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it('unsubscribes when the client disconnects', async () => {
    const { ctx, base } = await listen();
    const baseline = ctx.bus.listenerCount('event');
    const ac = new AbortController();
    await fetch(`${base}/api/events/stream`, { signal: ac.signal });
    await until(() => ctx.bus.listenerCount('event') === baseline + 1, 'the subscription');
    ac.abort();
    await until(() => ctx.bus.listenerCount('event') === baseline, 'the unsubscribe');
  });

  it('drops a client that stops reading once more than 1 MiB is waiting for it', async () => {
    const { ctx, port } = await listen();
    const baseline = ctx.bus.listenerCount('event');
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write('GET /api/events/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    // Never read: the socket buffers fill, then the server's own write buffer grows.
    socket.pause();
    try {
      await until(() => ctx.bus.listenerCount('event') === baseline + 1, 'the subscription');
      const big = 'x'.repeat(256 * 1024);
      let id = maxEventId(ctx);
      for (let i = 0; i < 64 && ctx.bus.listenerCount('event') > baseline; i++) {
        ctx.bus.emit('event', { id: ++id, ts: 't', projectId: null, actor: 'test', type: 'demo', entity: 'demo', entityId: '1', data: big } satisfies EventRow);
        await new Promise((r) => setImmediate(r));
      }
      await until(() => ctx.bus.listenerCount('event') === baseline, 'the server to drop the connection');
    } finally {
      socket.destroy();
    }
  });
});
