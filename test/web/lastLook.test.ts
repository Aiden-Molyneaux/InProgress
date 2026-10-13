import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLastLook, saveLastLook } from '../../web/src/board/lastLook';

/** A localStorage that holds its keys in a map: the node test environment has none. */
function stubStorage(): Map<string, string> {
  const held = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
  });
  return held;
}

describe('the last look', () => {
  let held: Map<string, string>;
  beforeEach(() => {
    held = stubStorage();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is null when the project was never left', () => {
    expect(loadLastLook(7)).toBeNull();
  });

  it('loads what was saved, under ip.look.<project id>, one time per project', () => {
    saveLastLook(7, '2026-10-13T08:00:00.000Z');
    saveLastLook(8, '2026-10-12T08:00:00.000Z');
    expect(held.get('ip.look.7')).toBe('2026-10-13T08:00:00.000Z');
    expect(loadLastLook(7)).toBe('2026-10-13T08:00:00.000Z');
    expect(loadLastLook(8)).toBe('2026-10-12T08:00:00.000Z');
  });

  it('reads junk in storage as never', () => {
    held.set('ip.look.7', 'yesterday-ish');
    expect(loadLastLook(7)).toBeNull();
    held.set('ip.look.7', '');
    expect(loadLastLook(7)).toBeNull();
  });
});
