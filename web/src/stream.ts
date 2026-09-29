import type { EventRow } from '../../src/core/types';

/**
 * Live events after `since`, the loaded snapshot's lastEventId (spec §7.6), so nothing between the snapshot and the
 * stream is missed. Reconnects after errors and replays what was missed via ?since: from the last event delivered,
 * or from `since` when none has arrived yet. No DOM beyond EventSource, so it runs under the unit tests too.
 */
export function subscribe(since: number | undefined, onEvent: (e: EventRow) => void, onStatus: (s: 'open' | 'reconnecting') => void): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let lastId = since;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    source = new EventSource(lastId === undefined ? '/api/events/stream' : `/api/events/stream?since=${lastId}`);
    source.onopen = () => onStatus('open');
    source.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as EventRow;
      lastId = e.id;
      onEvent(e);
    };
    source.onerror = () => {
      onStatus('reconnecting');
      source?.close();
      if (!closed) timer = setTimeout(connect, 1500);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}
