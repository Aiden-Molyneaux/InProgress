import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventRow } from '../../src/core/types';
import { subscribe } from '../../web/src/stream';

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

const event = (id: number): EventRow => ({ id, ts: 't', projectId: 1, actor: 'system', type: 'node.updated', entity: 'node', entityId: '1', data: {} });

describe('subscribe', () => {
  beforeEach(() => {
    FakeEventSource.all = [];
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const urls = () => FakeEventSource.all.map((s) => s.url);
  const latest = () => FakeEventSource.all[FakeEventSource.all.length - 1];
  const drop = () => {
    latest().onerror?.();
    vi.advanceTimersByTime(1500);
  };

  it("opens the first stream from the snapshot's lastEventId", () => {
    subscribe(42, () => {}, () => {});
    expect(urls()).toEqual(['/api/events/stream?since=42']);
  });

  it('resumes from that id when the stream drops before any message', () => {
    const statuses: string[] = [];
    subscribe(42, () => {}, (s) => statuses.push(s));
    drop();
    expect(urls()).toEqual(['/api/events/stream?since=42', '/api/events/stream?since=42']);
    expect(statuses).toEqual(['reconnecting']);
  });

  it('resumes from the last event it delivered', () => {
    const seen: number[] = [];
    subscribe(42, (e) => seen.push(e.id), () => {});
    latest().onmessage?.({ data: JSON.stringify(event(43)) });
    drop();
    expect(seen).toEqual([43]);
    expect(urls()).toEqual(['/api/events/stream?since=42', '/api/events/stream?since=43']);
  });

  it('opens a bare stream when there is no snapshot to start from', () => {
    subscribe(undefined, () => {}, () => {});
    drop();
    expect(urls()).toEqual(['/api/events/stream', '/api/events/stream']);
  });

  it('stops reconnecting once unsubscribed', () => {
    const unsubscribe = subscribe(42, () => {}, () => {});
    latest().onerror?.();
    unsubscribe();
    vi.advanceTimersByTime(5000);
    expect(urls()).toHaveLength(1);
    expect(FakeEventSource.all[0].closed).toBe(true);
  });
});
