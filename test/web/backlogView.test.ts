import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../../src/core/types';
import { altMove, backlogMatch, backlogMeta, moveTopBefore, nextTopBefore, openInsideIndex, optimisticRank, parseView, phaseOptions, phaseValue, viewKey, viewTabs } from '../../web/src/backlog/backlogView';

const node = (id: number, parentId: number | null, status: TreeNode['status'], kind: TreeNode['kind'] = 'task', title = `n${id}`): TreeNode =>
  ({ id, projectId: 1, parentId, position: id, kind, title, status }) as unknown as TreeNode;

describe('backlogMeta', () => {
  it('says open and parked', () => {
    expect(backlogMeta(5, 5, 2, false)).toEqual([{ value: 5, label: 'OPEN' }, { value: 2, label: 'PARKED' }]);
  });
  it('says how many of the open ones show while filtering', () => {
    expect(backlogMeta(5, 2, 2, true)).toEqual([{ value: 2, label: 'OF 5 SHOWN' }, { value: 2, label: 'PARKED' }]);
  });
});

describe('parseView and viewTabs', () => {
  it('reads a stored view, and anything unknown as ranked', () => {
    expect(parseView('stale')).toBe('stale');
    expect(parseView('parked')).toBe('parked');
    expect(parseView('nope')).toBe('ranked');
    expect(parseView(null)).toBe('ranked');
    expect(viewKey(7)).toBe('ip.backlogView.7');
  });
  it('lists the five views in order with the shown counts', () => {
    const c = (shown: number) => ({ all: shown + 1, shown });
    const tabs = viewTabs({ ranked: c(1), phase: c(2), triage: c(3), stale: c(4), parked: c(5) });
    expect(tabs.map((t) => [t.id, t.label, t.count])).toEqual([
      ['ranked', 'Ranked', 1], ['phase', 'By Phase', 2], ['triage', 'Needs Triage', 3], ['stale', 'Stale', 4], ['parked', 'Parked', 5],
    ]);
  });
});

describe('backlogMatch', () => {
  const phase = node(2, 1, 'active', 'phase', 'Road to market');
  const step = { ...node(4, 2, 'todo', 'task', 'Build to GitHub'), label: 'fix' } as TreeNode;
  const entry = { node: step, crumb: [phase] };
  it('is undefined for a blank query', () => {
    expect(backlogMatch('   ')).toBeUndefined();
  });
  it('needs every word, in any case, in the id, title, label or an ancestor title', () => {
    expect(backlogMatch('build github')!(entry)).toBe(true);
    expect(backlogMatch('#4')!(entry)).toBe(true);
    expect(backlogMatch('FIX')!(entry)).toBe(true);
    expect(backlogMatch('road market')!(entry)).toBe(true);
    expect(backlogMatch('build zzz')!(entry)).toBe(false);
  });
});

describe('optimisticRank', () => {
  const lists = { next: [1, 2], soon: [3, 4, 5], someday: [6] };
  it('takes the step out of every band and inserts it before the named step', () => {
    expect(optimisticRank(lists, { node: 4, to: 'next', before: 2 })).toEqual({ next: [1, 4, 2], soon: [3, 5], someday: [6] });
    expect(optimisticRank(lists, { node: 1, to: 'someday', before: 6 })).toEqual({ next: [2], soon: [3, 4, 5], someday: [1, 6] });
    expect(optimisticRank(lists, { node: 5, to: 'soon', before: 3 })).toEqual({ next: [1, 2], soon: [5, 3, 4], someday: [6] });
  });
  it('appends when before is null or not in the band', () => {
    expect(optimisticRank(lists, { node: 3, to: 'soon', before: null }).soon).toEqual([4, 5, 3]);
    expect(optimisticRank(lists, { node: 3, to: 'someday', before: 99 }).someday).toEqual([6, 3]);
  });
  it('does not touch the lists it was given', () => {
    optimisticRank(lists, { node: 3, to: 'next', before: null });
    expect(lists.soon).toEqual([3, 4, 5]);
  });
});

describe('altMove', () => {
  it('gives the step to go before for a one place move', () => {
    expect(altMove([1, 2, 3, 4], 3, 'up')).toBe(2);
    expect(altMove([1, 2, 3, 4], 2, 'down')).toBe(4);
    expect(altMove([1, 2, 3, 4], 3, 'down')).toBeNull();
  });
  it('is undefined at an end and for a step that is not there', () => {
    expect(altMove([1, 2, 3], 1, 'up')).toBeUndefined();
    expect(altMove([1, 2, 3], 3, 'down')).toBeUndefined();
    expect(altMove([1, 2, 3], 9, 'up')).toBeUndefined();
  });
});

describe('openInsideIndex', () => {
  const nodes = [node(1, null, 'active'), node(2, 1, 'todo'), node(3, 2, 'blocked'), node(4, 3, 'active'), node(5, 2, 'done'), node(6, 1, 'dropped'), node(7, 1, 'parked')];
  it('counts todo, active and blocked below a step at every depth', () => {
    expect(openInsideIndex(nodes)(1)).toBe(3);
    expect(openInsideIndex(nodes)(2)).toBe(2);
  });
  it('is 0 for a step with no children', () => {
    expect(openInsideIndex(nodes)(4)).toBe(0);
  });
});

describe('phaseValue and phaseOptions', () => {
  const root = node(1, null, 'active', 'goal');
  const phaseA = node(2, 1, 'active', 'phase', 'Alpha');
  const phaseB = node(3, 1, 'todo', 'phase', 'Beta');
  const doneP = node(4, 1, 'done', 'phase', 'Finished');
  const parkedP = node(5, 1, 'parked', 'phase', 'Shelved');
  const goal = node(6, 1, 'active', 'goal', 'A goal');
  const nodes = [root, phaseB, phaseA, doneP, parkedP, goal];

  it('maps the root and no parent to No phase', () => {
    expect(phaseValue(1, 1)).toBeNull();
    expect(phaseValue(1, null)).toBeNull();
    expect(phaseValue(1, 2)).toBe(2);
  });
  it('lists open unparked phases in tree order, then No phase', () => {
    expect(phaseOptions(nodes, 1, 1)).toEqual([{ value: 2, label: 'Alpha' }, { value: 3, label: 'Beta' }, { value: null, label: 'No phase' }]);
  });
  it('keeps an open phase parent in place and lists no extra option', () => {
    expect(phaseOptions(nodes, 1, 2).map((o) => o.value)).toEqual([2, 3, null]);
  });
  it('lists a goal parent first under its own title', () => {
    expect(phaseOptions(nodes, 1, 6)).toEqual([{ value: 6, label: 'A goal' }, { value: 2, label: 'Alpha' }, { value: 3, label: 'Beta' }, { value: null, label: 'No phase' }]);
  });
  it('lists a finished or shelved phase parent first, never among the choices otherwise', () => {
    expect(phaseOptions(nodes, 1, 4)[0]).toEqual({ value: 4, label: 'Finished' });
    expect(phaseOptions(nodes, 1, 5)[0]).toEqual({ value: 5, label: 'Shelved' });
    expect(phaseOptions(nodes, 1, 1).some((o) => o.value === 5 || o.value === 4)).toBe(false);
  });
});

describe('moveTopBefore and nextTopBefore', () => {
  const ranked = (id: number, band: 'soon' | 'someday', rank: number): TreeNode => ({ ...node(id, 1, 'todo'), rankBand: band, rank }) as unknown as TreeNode;
  const nodes = [node(1, null, 'active'), ranked(10, 'soon', 1), ranked(11, 'soon', 2), ranked(12, 'soon', 3), ranked(20, 'someday', 1)];

  it('goes before the first step of the band', () => {
    expect(moveTopBefore(nodes, new Set([10, 11, 12, 20]), 12, 'soon')).toBe(10);
  });
  it('hides the button for the first step', () => {
    expect(moveTopBefore(nodes, new Set([10, 11, 12, 20]), 10, 'soon')).toBeUndefined();
  });
  it('hides the button for the only step', () => {
    expect(moveTopBefore(nodes, new Set([10, 11, 12, 20]), 20, 'someday')).toBeUndefined();
  });
  it('goes before a queued first member the list does not draw', () => {
    expect(moveTopBefore(nodes, new Set([11, 12, 20]), 11, 'soon')).toBeUndefined();
    expect(moveTopBefore(nodes, new Set([11, 12, 20]), 12, 'soon')).toBe(10);
  });
  it('sends an empty band to the end', () => {
    expect(moveTopBefore([node(1, null, 'active')], new Set([5]), 5, 'soon')).toBeNull();
  });
  it('puts an unowned Next up step before the first of the queue, and hides it for the first', () => {
    expect(nextTopBefore([4, 5, 6], 6)).toBe(4);
    expect(nextTopBefore([4, 5, 6], 4)).toBeUndefined();
    expect(nextTopBefore([4, 5, 6], 9)).toBeUndefined();
    expect(nextTopBefore([], 4)).toBeUndefined();
  });
});
