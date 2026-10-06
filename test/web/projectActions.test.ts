import { describe, expect, it } from 'vitest';
import { DELETED_RETENTION_MS } from '../../src/core/types';
import { actionMessage, archiveNote, patchDeleted, patchProjects } from '../../web/src/projectActions';

describe('actionMessage', () => {
  it("says what happened and where the project went, in the status line's words", () => {
    expect(actionMessage('archive', 'Old Site')).toBe('Archived Old Site. It is under ⋯.');
    expect(actionMessage('unarchive', 'Old Site')).toBe('Old Site is back in the tabs.');
    expect(actionMessage('delete', 'Old Site')).toBe('Deleted Old Site. Restore it from ⋯ within 30 days.');
    expect(actionMessage('restore', 'Old Site')).toBe('Restored Old Site. It is under Archived in ⋯.');
  });
});

describe('archiveNote', () => {
  it("says how many live sessions an archive stops tracking, and nothing when there are none", () => {
    expect(archiveNote(0)).toBeNull();
    expect(archiveNote(1)).toBe('Stops tracking 1 session');
    expect(archiveNote(2)).toBe('Stops tracking 2 sessions');
  });
});

describe('patchProjects', () => {
  const list = [
    { id: 1, slug: 'a', status: 'active' as const },
    { id: 2, slug: 'b', status: 'archived' as const },
  ];

  it('archives and unarchives in place', () => {
    expect(patchProjects(list, 'archive', 1)).toEqual([{ id: 1, slug: 'a', status: 'archived' }, list[1]]);
    expect(patchProjects(list, 'unarchive', 2)).toEqual([list[0], { id: 2, slug: 'b', status: 'active' }]);
  });

  it('takes a deleted project out, and leaves a restore to the reload', () => {
    expect(patchProjects(list, 'delete', 2)).toEqual([list[0]]);
    expect(patchProjects(list, 'restore', 3)).toBe(list);
  });

  it('leaves the list it was given alone', () => {
    patchProjects(list, 'archive', 1);
    expect(list[0].status).toBe('active');
  });
});

describe('patchDeleted', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const older = { id: 4, slug: 'd', name: 'D', deletedAt: '2026-10-01T00:00:00.000Z', purgeAt: '2026-10-31T00:00:00.000Z' };

  it('puts a deleted project first, with its 30 days from now', () => {
    expect(patchDeleted([older], 'delete', { id: 2, slug: 'b', name: 'B' }, now)).toEqual([
      { id: 2, slug: 'b', name: 'B', deletedAt: new Date(now).toISOString(), purgeAt: new Date(now + DELETED_RETENTION_MS).toISOString() },
      older,
    ]);
  });

  it('takes a restored project out, and leaves the list alone for archive and unarchive', () => {
    expect(patchDeleted([older], 'restore', older, now)).toEqual([]);
    const list = [older];
    expect(patchDeleted(list, 'archive', { id: 1, slug: 'a', name: 'A' }, now)).toBe(list);
    expect(patchDeleted(list, 'unarchive', { id: 1, slug: 'a', name: 'A' }, now)).toBe(list);
  });
});
