import { describe, expect, it } from 'vitest';
import type { LibraryPage } from '../../src/core/types';
import { freshText, groupPages } from '../../web/src/library/pageGroups';

const page = (id: number, projectId: number, projectName: string): LibraryPage => ({ id, title: `t${id}`, path: 'C:/x.md', projectId, projectSlug: projectName.toLowerCase(), projectName, format: 'markdown', shelf: 'pages', templates: [], error: null, adaptedIn: [] });

describe('groupPages', () => {
  const pages = [page(1, 3, 'Gamma'), page(2, 1, 'Alpha'), page(3, 7, 'Zed'), page(4, 2, 'Shipwright'), page(5, 3, 'Gamma'), page(6, 8, 'Able')];

  it('puts the source first, then the rail order, then the others by name', () => {
    const groups = groupPages(pages, 2, [3, 1]);
    expect(groups.map((g) => g.projectName)).toEqual(['Shipwright', 'Gamma', 'Alpha', 'Able', 'Zed']);
  });

  it('keeps the server order inside a group', () => {
    expect(groupPages(pages, null, [3]).find((g) => g.projectId === 3)!.pages.map((p) => p.id)).toEqual([1, 5]);
  });
});

describe('freshText', () => {
  it('says nothing without covers, and alarms only on commits since confirmed', () => {
    expect(freshText(undefined)).toBeNull();
    expect(freshText(null)).toEqual({ text: 'confirm again', alarm: false });
    expect(freshText(0)).toEqual({ text: 'current', alarm: false });
    expect(freshText(3)).toEqual({ text: '3 since confirmed', alarm: true });
  });
});
