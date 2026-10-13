import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archivedProjects, loadTabOrder, moveTab, neighbourTab, pickSlug, projectLabel, projectTabs, pruneOrder, recentlyDeleted, saveTabOrder, stepTab, tabDropSlot, waitingOn } from '../../web/src/chrome/tabs';

const project = (id: number, status: 'active' | 'archived' = 'active') => ({ id, slug: `p${id}`, status });
const slugs = (list: { slug: string }[]) => list.map((p) => p.slug);

describe('projectTabs', () => {
  // The server lists working projects first, then by last activity.
  const listed = [project(3), project(1), project(4, 'archived'), project(2)];

  it('has one tab per active project, oldest first, whatever order the server lists them in', () => {
    expect(slugs(projectTabs(listed, 'p1'))).toEqual(['p1', 'p2', 'p3']);
  });

  it('adds a tab at the end for an archived project while it is open', () => {
    expect(slugs(projectTabs(listed, 'p4'))).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('has no tab for an unknown or missing project', () => {
    expect(slugs(projectTabs(listed, 'gone'))).toEqual(['p1', 'p2', 'p3']);
    expect(slugs(projectTabs(listed, null))).toEqual(['p1', 'p2', 'p3']);
  });

  it('leaves the list it was given alone', () => {
    projectTabs(listed, 'p1');
    expect(slugs(listed)).toEqual(['p3', 'p1', 'p4', 'p2']);
  });

  it('puts the stored order first and the rest oldest first', () => {
    expect(slugs(projectTabs(listed, null, [3, 1]))).toEqual(['p3', 'p1', 'p2']);
    expect(slugs(projectTabs(listed, null, [2]))).toEqual(['p2', 'p1', 'p3']);
  });

  it('keeps an open archived project last and ignores ids that are not active projects', () => {
    expect(slugs(projectTabs(listed, 'p4', [4, 99, 3, 2]))).toEqual(['p3', 'p2', 'p1', 'p4']);
  });
});

describe('moveTab', () => {
  const tabs = [project(1), project(2), project(3), project(4, 'archived')];

  it('moves a tab before another, to the front or to the end', () => {
    expect(moveTab(tabs, 3, 1)).toEqual([3, 1, 2]);
    expect(moveTab(tabs, 1, 3)).toEqual([2, 1, 3]);
    expect(moveTab(tabs, 1, null)).toEqual([2, 3, 1]);
  });

  it('leaves the order as it is for a move before itself', () => {
    expect(moveTab(tabs, 2, 2)).toEqual([1, 2, 3]);
  });

  it('ignores the archived tab', () => {
    expect(moveTab(tabs, 4, 1)).toEqual([1, 2, 3]);
  });
});

describe('tabDropSlot', () => {
  const ids = [1, 2, 3];

  it('drops before the tab in its left half, and before the next one in its right half', () => {
    expect(tabDropSlot(ids, 2, true, 1)).toBe(2);
    expect(tabDropSlot(ids, 2, false, 1)).toBe(3);
  });

  it('drops at the end from the right half of the last tab', () => {
    expect(tabDropSlot(ids, 3, false, 1)).toBeNull();
  });

  it('reads a slot that is the dragged tab as the tab after it', () => {
    expect(tabDropSlot(ids, 2, true, 2)).toBe(3);
    expect(tabDropSlot(ids, 1, false, 2)).toBe(3);
    expect(tabDropSlot(ids, 3, true, 3)).toBeNull();
  });

  it('drops at the end over a tab that is not active', () => {
    expect(tabDropSlot(ids, 9, true, 1)).toBeNull();
  });
});

describe('pruneOrder', () => {
  it('keeps only the ids of active projects: archived, deleted and purged ones lose their place', () => {
    const projects = [project(1), project(2, 'archived'), project(3)];
    expect(pruneOrder([3, 2, 1, 4, 5], projects)).toEqual([3, 1]);
  });
});

describe('the stored tab order', () => {
  const held = new Map<string, string>();
  beforeEach(() => {
    held.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips under ip.tabOrder', () => {
    saveTabOrder([3, 1, 2]);
    expect(held.get('ip.tabOrder')).toBe('[3,1,2]');
    expect(loadTabOrder()).toEqual([3, 1, 2]);
  });

  it('is empty when nothing is stored', () => {
    expect(loadTabOrder()).toEqual([]);
  });

  it('rejects junk', () => {
    held.set('ip.tabOrder', '{"a":1}');
    expect(loadTabOrder()).toEqual([]);
    held.set('ip.tabOrder', 'not json');
    expect(loadTabOrder()).toEqual([]);
    held.set('ip.tabOrder', '[2,"x",0,-1,1.5,null,2,5]');
    expect(loadTabOrder()).toEqual([2, 5]);
  });
});

describe('archivedProjects', () => {
  it('lists the archived projects, oldest first', () => {
    expect(slugs(archivedProjects([project(5, 'archived'), project(1), project(2, 'archived')]))).toEqual(['p2', 'p5']);
  });
});

describe('stepTab', () => {
  const tabs = [project(1), project(2), project(3)];

  it('goes to the next and the previous tab', () => {
    expect(stepTab(tabs, 'p2', 1)).toBe('p3');
    expect(stepTab(tabs, 'p2', -1)).toBe('p1');
  });

  it('wraps round at either end', () => {
    expect(stepTab(tabs, 'p3', 1)).toBe('p1');
    expect(stepTab(tabs, 'p1', -1)).toBe('p3');
  });

  it('starts from the first tab going right, or the last going left, when no tab is current', () => {
    expect(stepTab(tabs, null, 1)).toBe('p1');
    expect(stepTab(tabs, 'gone', -1)).toBe('p3');
  });

  it('stays put on a lone tab, and has nowhere to go without tabs', () => {
    expect(stepTab([project(7)], 'p7', 1)).toBe('p7');
    expect(stepTab([], null, 1)).toBeNull();
  });
});

describe('waitingOn', () => {
  it('is the open asks plus the permission waits', () => {
    expect(waitingOn({ openAsks: 2, permissionWaits: 1 })).toBe(3);
    expect(waitingOn({ openAsks: 0, permissionWaits: 0 })).toBe(0);
  });
});

describe('projectLabel', () => {
  const summary = { name: 'InThink: Marathon v3', openAsks: 0, permissionWaits: 0, workingSessions: 0, busySessions: 0 };

  it('is the full name when nothing needs you and nothing works', () => {
    expect(projectLabel(summary)).toBe('InThink: Marathon v3');
  });

  it('says what the badges show', () => {
    expect(projectLabel({ ...summary, openAsks: 3 })).toBe('InThink: Marathon v3, 3 need you');
    expect(projectLabel({ ...summary, workingSessions: 2, busySessions: 2 })).toBe('InThink: Marathon v3, working');
    expect(projectLabel({ ...summary, openAsks: 1, workingSessions: 1, busySessions: 1 })).toBe('InThink: Marathon v3, 1 need you, working');
  });

  it('says busy, not working, while only a command or a worker keeps a session going', () => {
    expect(projectLabel({ ...summary, busySessions: 1 })).toBe('InThink: Marathon v3, busy');
    expect(projectLabel({ ...summary, openAsks: 1, permissionWaits: 1, busySessions: 1 })).toBe('InThink: Marathon v3, 2 need you, busy');
    // Working wins when a session works and another is busy.
    expect(projectLabel({ ...summary, workingSessions: 1, busySessions: 2 })).toBe('InThink: Marathon v3, working');
  });
});

describe('neighbourTab', () => {
  const tabs = [project(1), project(2), project(3)];

  it('is the tab to the right, as a browser does when a tab closes', () => {
    expect(neighbourTab(tabs, 'p1')).toBe('p2');
    expect(neighbourTab(tabs, 'p2')).toBe('p3');
  });

  it('is the tab to the left for the last tab', () => {
    expect(neighbourTab(tabs, 'p3')).toBe('p2');
  });

  it('is nothing for a lone tab, an unknown slug or no tabs', () => {
    expect(neighbourTab([project(7)], 'p7')).toBeNull();
    expect(neighbourTab(tabs, 'gone')).toBeNull();
    expect(neighbourTab(tabs, null)).toBeNull();
    expect(neighbourTab([], 'p1')).toBeNull();
  });
});

describe('pickSlug', () => {
  const listed = [project(3, 'archived'), project(1), project(2)];

  it('keeps the current project while it is listed, archived or not', () => {
    expect(pickSlug(listed, 'p2')).toBe('p2');
    expect(pickSlug(listed, 'p3')).toBe('p3');
  });

  it("falls back to the first active project in the server's order, else the first listed", () => {
    expect(pickSlug(listed, 'gone')).toBe('p1');
    expect(pickSlug(listed, null)).toBe('p1');
    expect(pickSlug([project(5, 'archived'), project(4, 'archived')], 'gone')).toBe('p5');
  });

  it('is nothing when nothing is listed', () => {
    expect(pickSlug([], 'p1')).toBeNull();
  });
});

describe('recentlyDeleted', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-06T12:00:00Z');
  const gone = (id: number, deletedDaysAgo: number) => ({
    id,
    slug: `d${id}`,
    name: `D${id}`,
    deletedAt: new Date(now - deletedDaysAgo * day).toISOString(),
    purgeAt: new Date(now + (30 - deletedDaysAgo) * day).toISOString(),
  });

  it('lists the most recently deleted first', () => {
    expect(slugs(recentlyDeleted([gone(1, 5), gone(2, 1), gone(3, 9)], now))).toEqual(['d2', 'd1', 'd3']);
  });

  it('drops a project past its purge time, in case the purge has not run yet', () => {
    expect(slugs(recentlyDeleted([gone(1, 30), gone(2, 31), gone(3, 29)], now))).toEqual(['d3']);
  });

  it('leaves the list it was given alone', () => {
    const list = [gone(1, 5), gone(2, 1)];
    recentlyDeleted(list, now);
    expect(slugs(list)).toEqual(['d1', 'd2']);
  });
});
