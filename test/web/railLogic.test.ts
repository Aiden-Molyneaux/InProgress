import { describe, expect, it } from 'vitest';
import type { LibraryPage, LibraryPages, LibrarySync, ProjectSnapshot, SyncFile, TreeNode } from '../../src/core/types';
import { footMenuAt, libraryBehind, libraryViews, MENU_MARGIN, railCodes, railStep, railViews, rowMenuAt, viewTitle } from '../../web/src/chrome/railLogic';

const NOW = Date.parse('2026-10-13T12:00:00Z');
let n = 0;
const node = (id: number, parentId: number | null, title: string, status: TreeNode['status'] = 'todo', extra: Partial<TreeNode> = {}): TreeNode => ({
  id, projectId: 1, parentId, position: ++n, kind: 'task', title, body: '', status, assignee: 'claude', outcome: '', label: null,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', completedAt: status === 'done' ? '2026-10-10T00:00:00Z' : null, driverSessionId: null, boardState: null, stateSince: null, hue: null, parkedReason: '', parkedWhere: '', parkedAt: null, rankBand: null, rank: null, ...extra,
});
const snap = (nodes: TreeNode[]): ProjectSnapshot => ({
  project: { id: 1, queue: [] } as never, nodes, resources: [], sessions: [], workItems: [], trailAgents: [], pastSessions: [], asks: [], stepTouches: [],
  stateNote: null, lastEventId: 0, lastEvent: null,
});

describe('railCodes', () => {
  it('gives each row its three-letter code by project id', () => {
    const codes = railCodes([{ id: 4, name: 'InProgress' }, { id: 9, name: 'InThink' }]);
    expect(codes.get(4)).toBe('IPR');
    expect(codes.get(9)).toBe('ITH');
  });

  it('puts the digit on the later of two rows that clash, by rail order and not by id', () => {
    const codes = railCodes([{ id: 8, name: 'InProgress' }, { id: 2, name: 'In-Progress' }, { id: 5, name: 'InProgress' }]);
    expect([codes.get(8), codes.get(2), codes.get(5)]).toEqual(['IPR', 'IP2', 'IP3']);
  });

  it('is empty for no rows', () => {
    expect(railCodes([]).size).toBe(0);
  });
});

describe('railViews', () => {
  const root = node(1, null, 'Root', 'active');
  const s = snap([
    root,
    node(2, 1, 'Alpha', 'active'),
    node(3, 2, 'a1'),
    node(4, 2, 'a2'),
    node(5, 1, 'Beta', 'active'),
    node(6, 5, 'b1'),
    node(7, 5, 'shelved', 'parked', { parkedReason: 'waiting', parkedAt: '2026-10-02T00:00:00Z' }),
    node(8, 5, 'finished', 'done'),
  ]);

  it('lists the four views in order, with their codes', () => {
    const views = railViews(s, NOW);
    expect(views.map((v) => [v.view, v.label, v.code])).toEqual([
      ['board', 'Board', 'BRD'],
      ['project', 'Project', 'PRJ'],
      ['backlog', 'Backlog', 'BKL'],
      ['done', 'All done', 'DON'],
    ]);
  });

  it('counts the phases, the open Backlog entries without the parked ones, and the done steps', () => {
    const [board, project, backlog, done] = railViews(s, NOW);
    expect(board.count).toBeUndefined();
    expect([project.count, project.unit]).toEqual([2, 'phases']);
    expect(backlog.count).toBe(3);
    expect(done.count).toBe(1);
  });

  it('titles a view with its count', () => {
    const [board, , backlog] = railViews(s, NOW);
    expect(viewTitle(board)).toBe('Board');
    expect(viewTitle(backlog)).toBe('Backlog, 3');
  });
});

describe('railViews with no snapshot', () => {
  it('still lists the four views, with no counts', () => {
    const views = railViews(null, NOW);
    expect(views.map((v) => v.view)).toEqual(['board', 'project', 'backlog', 'done']);
    expect(views.every((v) => v.count === undefined)).toBe(true);
  });
});

describe('railStep', () => {
  it('moves on with Down and Right and back with Up and Left, wrapping', () => {
    expect(railStep('ArrowDown', 0, 3)).toBe(1);
    expect(railStep('ArrowRight', 2, 3)).toBe(0);
    expect(railStep('ArrowUp', 0, 3)).toBe(2);
    expect(railStep('ArrowLeft', 1, 3)).toBe(0);
  });

  it('goes to the ends on Home and End, and leaves other keys alone', () => {
    expect(railStep('Home', 2, 3)).toBe(0);
    expect(railStep('End', 0, 3)).toBe(2);
    expect(railStep('Enter', 0, 3)).toBeNull();
    expect(railStep(' ', 0, 3)).toBeNull();
  });
});

describe('where a menu opens', () => {
  const win = { width: 1000, height: 600 };
  const menu = { width: 200, height: 120 };
  const row = { top: 100, left: 12, right: 204, bottom: 136 };

  it('is right of a row in the column, at the row top', () => {
    expect(rowMenuAt(row, menu, win, 'column')).toEqual({ top: 100, left: 208 });
  });

  it('is under a row in the strip, at the row left', () => {
    expect(rowMenuAt({ top: 4, left: 300, right: 400, bottom: 40 }, menu, win, 'strip')).toEqual({ top: 44, left: 300 });
  });

  it('stays inside the window on every side', () => {
    expect(rowMenuAt({ top: 560, left: 12, right: 204, bottom: 596 }, menu, win, 'column').top).toBe(win.height - menu.height - MENU_MARGIN);
    expect(rowMenuAt({ top: 4, left: 900, right: 990, bottom: 40 }, menu, win, 'strip').left).toBe(win.width - menu.width - MENU_MARGIN);
    expect(rowMenuAt({ top: -30, left: -50, right: 20, bottom: 6 }, menu, win, 'strip').left).toBe(MENU_MARGIN);
  });

  it('puts the foot menu above the button in the column and under the ⋯, right aligned, in the strip', () => {
    const button = { top: 500, left: 12, right: 150, bottom: 530 };
    expect(footMenuAt(button, menu, win, 'column')).toEqual({ top: 500 - 4 - menu.height, left: 12 });
    expect(footMenuAt({ top: 4, left: 940, right: 970, bottom: 34 }, menu, win, 'strip')).toEqual({ top: 38, left: 770 });
  });
});

describe('the Library on the rail', () => {
  const file = (state: SyncFile['state']): SyncFile => ({ template: 't', local: 't', base: null, state, behind: state === 'behind' ? 1 : 0, commits: [], fills: {}, detail: null });
  const row = (projectId: number, check: LibrarySync['projects'][number]['check']): LibrarySync['projects'][number] => ({ projectId, slug: `p${projectId}`, name: `P${projectId}`, dir: 'C:/x', check, syncStep: null });
  const ok = (...states: SyncFile['state'][]) => ({ ok: true as const, result: { shipwright: { head: 'h', date: 'd', subject: 's' }, project: 'x', lastSync: null, files: states.map(file), skip: [], notAdopted: [], fills: {} } });
  const sync = (...projects: LibrarySync['projects']): LibrarySync => ({ projects, noManifest: [], templates: [], source: null });
  const page = (id: number, shelf: LibraryPage['shelf']): LibraryPage => ({ id, title: 't', path: 'C:/x.md', projectId: 1, projectSlug: 'a', projectName: 'A', format: 'markdown', shelf, templates: [], error: null, adaptedIn: [] });
  const pages = (...p: LibraryPage[]): LibraryPages => ({ pages: p, sourceProjectId: null });

  it('counts the projects with a file behind, and none before the first check', () => {
    expect(libraryBehind(null)).toBeNull();
    expect(libraryBehind(sync())).toBe(0);
    expect(libraryBehind(sync(row(1, ok('current', 'behind')), row(2, ok('current')), row(3, { ok: false, error: 'x' }), row(4, ok('behind', 'behind'))))).toBe(2);
  });

  it('lists the three shelves, Pages with its pages-shelf count and Sync with N behind in warn', () => {
    const views = libraryViews(pages(page(1, 'pages'), page(2, 'roster'), page(3, 'pages')), sync(row(1, ok('behind'))));
    expect(views.map((v) => [v.shelf, v.code, v.count, v.warn])).toEqual([
      ['pages', 'PGS', '2', undefined],
      ['roster', 'RST', undefined, undefined],
      ['sync', 'SYN', '1 behind', true],
    ]);
  });

  it('shows no count before the data lands, and none on Sync when nothing is behind', () => {
    expect(libraryViews(null, null).map((v) => v.count)).toEqual([undefined, undefined, undefined]);
    expect(libraryViews(pages(), sync(row(1, ok('current')))).map((v) => v.count)).toEqual(['0', undefined, undefined]);
  });
});
