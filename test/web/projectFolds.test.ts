import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFolds, saveFolds } from '../../web/src/project/projectFolds';

const data = new Map<string, string>();
beforeEach(() => {
  data.clear();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
});
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

describe('project folds', () => {
  it('round-trips per project', () => {
    saveFolds(1, { 'section:5': true, 'done:7': false });
    expect(loadFolds(1)).toEqual({ 'section:5': true, 'done:7': false });
    expect(loadFolds(2)).toEqual({});
  });

  it('keeps the someday fold of the Backlog', () => {
    saveFolds(1, { someday: true });
    expect(loadFolds(1)).toEqual({ someday: true });
  });

  it('ignores the old overrides and anything not a boolean', () => {
    data.set('ip.folds.1', JSON.stringify({ '12': 'open', '13': 'closed', 'section:5': 'open', 'done:x': true, 'section:6': false, 'done:0': true }));
    expect(loadFolds(1)).toEqual({ 'section:6': false, 'done:0': true });
  });

  it('survives storage that holds garbage', () => {
    data.set('ip.folds.1', '[1,2');
    expect(loadFolds(1)).toEqual({});
    data.set('ip.folds.1', '[true]');
    expect(loadFolds(1)).toEqual({});
  });
});
