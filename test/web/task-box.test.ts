import { describe, expect, it } from 'vitest';
import type { BoardRow } from '../../src/core/board';
import type { TaskBox, TaskState } from '../../src/core/taskState';
import { TASK_STATES } from '../../src/core/taskState';
import { boxSince, hueStyle, PILLS } from '../../web/src/board/boxState';

const node = (over: Record<string, unknown> = {}) => ({ id: 7, boardState: null, stateSince: null, hue: null, completedAt: null, updatedAt: '2026-10-10T00:00:00Z', ...over });
const box = (state: TaskState, nodeOver: Record<string, unknown> = {}, asks: { raisedAt: string }[] = []): TaskBox =>
  ({ row: { node: node(nodeOver), asks } as unknown as BoardRow, session: null, cell: 'now', state });

describe('PILLS', () => {
  it('has a label and class for every state', () => {
    for (const s of TASK_STATES) {
      expect(PILLS[s].label, s).toBeTruthy();
      expect(PILLS[s].cls, s).toBeTruthy();
    }
  });
});

describe('boxSince', () => {
  it('uses the stored time only while the stored state is the one shown', () => {
    expect(boxSince(box('working', { boardState: 'working', stateSince: '2026-10-14T00:00:00Z' }))).toBe('2026-10-14T00:00:00Z');
    expect(boxSince(box('idle', { boardState: 'working', stateSince: '2026-10-14T00:00:00Z' }))).toBe('2026-10-10T00:00:00Z');
  });
  it('falls back per state: completedAt for done, the oldest ask for an ask state, updatedAt otherwise', () => {
    expect(boxSince(box('done', { completedAt: '2026-10-12T00:00:00Z' }))).toBe('2026-10-12T00:00:00Z');
    expect(boxSince(box('question', {}, [{ raisedAt: '2026-10-11T00:00:00Z' }, { raisedAt: '2026-10-13T00:00:00Z' }]))).toBe('2026-10-11T00:00:00Z');
    expect(boxSince(box('ready'))).toBe('2026-10-10T00:00:00Z');
  });
  it('counts a focusless permission wait from its session', () => {
    const b = { row: null, session: { lastSeenAt: '2026-10-15T01:00:00Z' }, cell: 'needs', state: 'permission' } as unknown as TaskBox;
    expect(boxSince(b)).toBe('2026-10-15T01:00:00Z');
  });
});

describe('hueStyle', () => {
  it('gives the hue to coloured states', () => {
    expect(hueStyle(box('working', { hue: 3 }))).toEqual({ '--hue': 'var(--hue-3)' });
    expect(hueStyle(box('blocked', { hue: 0 }))).toEqual({ '--hue': 'var(--hue-0)' });
  });
  it('gives none for a hue out of range or not a whole number', () => {
    for (const hue of [-1, 7, 3.5, Number.NaN]) expect(hueStyle(box('working', { hue })), String(hue)).toBeUndefined();
  });
  it('gives none for done, backlog, a null hue or no step', () => {
    expect(hueStyle(box('done', { hue: 3 }))).toBeUndefined();
    expect(hueStyle(box('backlog', { hue: 3 }))).toBeUndefined();
    expect(hueStyle(box('working', { hue: null }))).toBeUndefined();
    expect(hueStyle({ row: null, session: null, cell: 'needs', state: 'permission' })).toBeUndefined();
  });
});
