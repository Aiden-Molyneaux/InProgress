import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRow } from '../../src/core/types';
import { buildApp } from '../../src/server/app';
import { createProject } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function listen() {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: 't', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  closers.push(() => app.close());
  return { ctx, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
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
});
