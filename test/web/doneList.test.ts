import { describe, expect, it } from 'vitest';
import type { BoardRow } from '../../src/core/board';
import type { TreeNode } from '../../src/core/types';
import { byPhase, byTime, clock, shortDate } from '../../web/src/done/doneGroups';

/** Local-time ISO strings, so the tests hold in any timezone. */
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const NOW = new Date(2026, 9, 13, 15, 0).getTime();

const node = (id: number, title: string, completedAt: string | null) => ({ id, title, completedAt }) as unknown as TreeNode;
const row = (id: number, completedAt: string | null, crumb: TreeNode[] = []) => ({ node: node(id, `Step ${id}`, completedAt), crumb }) as unknown as BoardRow;
const ids = (rows: BoardRow[]) => rows.map((r) => r.node.id);

describe('clock and shortDate', () => {
  it('clock is HH:MM local', () => expect(clock(at(2026, 10, 13, 9, 5))).toBe('09:05'));
  it('shortDate omits the current year and adds another', () => {
    expect(shortDate(at(2026, 10, 12), NOW)).toBe('Oct 12');
    expect(shortDate(at(2025, 10, 12), NOW)).toBe('Oct 12, 2025');
  });
});

describe('byTime', () => {
  it('groups consecutive rows by local day with Today, Yesterday and dates', () => {
    const rows = [row(1, at(2026, 10, 13, 14)), row(2, at(2026, 10, 13, 8)), row(3, at(2026, 10, 12, 23)), row(4, at(2026, 10, 9)), row(5, at(2025, 12, 31))];
    const groups = byTime(rows, NOW);
    expect(groups.map((g) => g.heading)).toEqual(['Today', 'Yesterday', 'Oct 9', 'Dec 31, 2025']);
    expect(groups.map((g) => ids(g.rows))).toEqual([[1, 2], [3], [4], [5]]);
  });
  it('puts undated rows last', () => {
    const groups = byTime([row(1, null), row(2, at(2026, 10, 13))], NOW);
    expect(groups.map((g) => g.heading)).toEqual(['Today', 'Undated']);
    expect(ids(groups[1].rows)).toEqual([1]);
  });
  it('is empty for no rows', () => expect(byTime([], NOW)).toEqual([]));
});

describe('byPhase', () => {
  const root = node(9, 'Project', null);
  const phase = node(10, 'Phase A', null);
  const sub = node(11, 'Sub', null);
  const other = node(12, 'Phase B', null);
  it('groups by immediate parent, newest group first, with the crumb path', () => {
    const rows = [
      row(1, at(2026, 10, 13), [other]),
      row(2, at(2026, 10, 12), [phase, sub]),
      row(3, at(2026, 10, 11), [other]),
      row(4, at(2026, 10, 10)),
    ];
    const groups = byPhase(rows, root);
    expect(groups.map((g) => g.path)).toEqual(['#9 Project › #12 Phase B', '#9 Project › #10 Phase A › #11 Sub', '#9 Project']);
    expect(groups.map((g) => g.parent?.id ?? null)).toEqual([12, 11, null]);
    expect(groups.map((g) => ids(g.rows))).toEqual([[1, 3], [2], [4]]);
  });
  it('names just the crumb when the project has no root node', () => {
    expect(byPhase([row(1, at(2026, 10, 13), [phase])], null).map((g) => g.path)).toEqual(['#10 Phase A']);
  });
});
