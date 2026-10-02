import { describe, expect, it } from 'vitest';
import { archivedProjects, projectLabel, projectTabs, stepTab } from '../../web/src/chrome/tabs';

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

describe('projectLabel', () => {
  const summary = { name: 'InThink: Marathon v3', needsYou: 0, workingSessions: 0 };

  it('is the full name when nothing needs you and nothing works', () => {
    expect(projectLabel(summary)).toBe('InThink: Marathon v3');
  });

  it('says what the badges show', () => {
    expect(projectLabel({ ...summary, needsYou: 3 })).toBe('InThink: Marathon v3, 3 need you');
    expect(projectLabel({ ...summary, workingSessions: 2 })).toBe('InThink: Marathon v3, working');
    expect(projectLabel({ ...summary, needsYou: 1, workingSessions: 1 })).toBe('InThink: Marathon v3, 1 need you, working');
  });
});
