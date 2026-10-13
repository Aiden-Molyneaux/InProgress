import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadView, saveView } from '../../web/src/views/view';

/** A localStorage that holds its keys in a map: the node test environment has none. */
function stubStorage(): Map<string, string> {
  const held = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
  });
  return held;
}

describe('the remembered view', () => {
  let held: Map<string, string>;
  beforeEach(() => {
    held = stubStorage();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is the Board until a pick is saved', () => {
    expect(loadView()).toBe('board');
  });

  it('loads what was saved, under ip.view', () => {
    saveView('project');
    expect(held.get('ip.view')).toBe('project');
    expect(loadView()).toBe('project');
    saveView('board');
    expect(loadView()).toBe('board');
  });

  it('reads a stored value that is neither view as the Board', () => {
    held.set('ip.view', 'canvas');
    expect(loadView()).toBe('board');
    held.set('ip.view', '');
    expect(loadView()).toBe('board');
  });

  it('is the Board when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadView()).toBe('board');
    expect(() => saveView('project')).not.toThrow();
  });
});
