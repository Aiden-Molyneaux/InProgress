import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postEvent = vi.hoisted(() => vi.fn());
import { GAP_MS, noteAction, noteHidden, noteShown, resetMeasure, setPoster } from '../../web/src/measure';

const T0 = Date.parse('2026-10-13T09:00:00.000Z');

beforeEach(() => {
  postEvent.mockClear();
  setPoster(postEvent);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetMeasure(T0);
});
afterEach(() => vi.useRealTimers());

describe('noteShown', () => {
  it('posts nothing when the window was seen less than an hour ago', () => {
    noteShown(1, 'board', 2, T0 + GAP_MS - 1);
    expect(postEvent).not.toHaveBeenCalled();
  });

  it('posts shown with the view, the gap and the mark count at an hour', () => {
    noteShown(7, 'project', 3, T0 + GAP_MS);
    expect(postEvent).toHaveBeenCalledOnce();
    expect(postEvent).toHaveBeenCalledWith('shown', 7, { view: 'project', gapMs: GAP_MS, marks: 3 });
  });

  it('counts each call as seen, so repeated focus events do not add up to a gap', () => {
    noteShown(1, 'board', 0, T0 + GAP_MS - 1);
    noteShown(1, 'board', 0, T0 + 2 * GAP_MS - 2);
    expect(postEvent).not.toHaveBeenCalled();
    noteShown(1, 'board', 0, T0 + 3 * GAP_MS);
    expect(postEvent).toHaveBeenCalledOnce();
  });

  it('measures the gap from when the window was hidden, not from when it was last focused', () => {
    noteHidden(T0 + 2 * GAP_MS);
    noteShown(1, 'board', 0, T0 + 2 * GAP_MS + 10 * 60 * 1000);
    expect(postEvent).not.toHaveBeenCalled();
  });
});

describe('noteAction', () => {
  it('posts nothing without a gap', () => {
    noteAction('now', 'open');
    expect(postEvent).not.toHaveBeenCalled();
  });

  it('posts first_action once after a gap, with the project the shown named', () => {
    noteShown(4, 'board', 1, T0 + GAP_MS);
    postEvent.mockClear();
    vi.setSystemTime(T0 + GAP_MS + 1000);
    noteAction('needs_me', 'open');
    noteAction('next', 'open');
    expect(postEvent).toHaveBeenCalledOnce();
    expect(postEvent).toHaveBeenCalledWith('first_action', 4, { area: 'needs_me', action: 'open' });
  });

  it('posts again after the next gap', () => {
    noteShown(4, 'board', 0, T0 + GAP_MS);
    vi.setSystemTime(T0 + GAP_MS + 1000);
    noteAction('now', 'open');
    noteShown(4, 'board', 0, T0 + 2 * GAP_MS + 1000);
    vi.setSystemTime(T0 + 2 * GAP_MS + 2000);
    noteAction('done', 'open');
    expect(postEvent.mock.calls.map((c) => c[0])).toEqual(['shown', 'first_action', 'shown', 'first_action']);
  });

  it('counts a click as seen, so working in the window does not make the next focus a return', () => {
    vi.setSystemTime(T0 + GAP_MS - 1000);
    noteAction('now', 'open');
    noteShown(1, 'board', 0, T0 + 2 * GAP_MS - 2000);
    expect(postEvent).not.toHaveBeenCalled();
  });
});

describe('areas', () => {
  it('passes the Details area through to first_action', () => {
    noteShown(2, 'board', 0, T0 + GAP_MS);
    vi.setSystemTime(T0 + GAP_MS + 1000);
    noteAction('details', 'clear');
    expect(postEvent).toHaveBeenLastCalledWith('first_action', 2, { area: 'details', action: 'clear' });
  });
});
