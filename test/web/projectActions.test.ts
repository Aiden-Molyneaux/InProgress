import { describe, expect, it } from 'vitest';
import { DELETED_RETENTION_MS } from '../../src/core/types';
import { actionMessage, archiveNote, patchDeleted, patchName, patchProjects, renamedSnapshot, renamedTo, renameMessage, summaryOf } from '../../web/src/projectActions';

describe('actionMessage', () => {
  it("says what happened and where the project went, in the status line's words", () => {
    expect(actionMessage('archive', 'Old Site')).toBe('Archived Old Site. It is under Archived in the rail.');
    expect(actionMessage('unarchive', 'Old Site')).toBe('Old Site is back in the rail.');
    expect(actionMessage('delete', 'Old Site')).toBe('Deleted Old Site. Restore it from Archived in the rail within 30 days.');
    expect(actionMessage('restore', 'Old Site')).toBe('Restored Old Site. It is under Archived in the rail.');
  });
});

describe('renamedTo', () => {
  it('is the new name, trimmed, when it is 1 to 120 characters and differs from the current one', () => {
    expect(renamedTo('  Old Site v2 ', 'Old Site')).toBe('Old Site v2');
    expect(renamedTo('x'.repeat(120), 'Old Site')).toBe('x'.repeat(120));
    // A change of case is a change.
    expect(renamedTo('old site', 'Old Site')).toBe('old site');
  });

  it('is null for an empty, unchanged or too long name: the field does nothing then', () => {
    expect(renamedTo('', 'Old Site')).toBeNull();
    expect(renamedTo('   ', 'Old Site')).toBeNull();
    expect(renamedTo('Old Site', 'Old Site')).toBeNull();
    expect(renamedTo(' Old Site  ', 'Old Site')).toBeNull();
    expect(renamedTo('x'.repeat(121), 'Old Site')).toBeNull();
  });
});

describe('renameMessage', () => {
  it("says the new name, in the status line's words", () => {
    expect(renameMessage('Old Site v2')).toBe('Renamed to Old Site v2.');
  });
});

describe('patchName', () => {
  const list = [
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
  ];

  it('renames one project in place and leaves the list it was given alone', () => {
    expect(patchName(list, 2, 'B2')).toEqual([list[0], { id: 2, name: 'B2' }]);
    expect(list[1].name).toBe('B');
  });

  it('leaves the list as it is for a project it does not hold', () => {
    expect(patchName(list, 3, 'C')).toEqual(list);
  });
});

describe('renamedSnapshot', () => {
  const snapshot = {
    project: { id: 3, name: 'Old', rootNodeId: 9 },
    nodes: [
      { id: 9, title: 'Old' },
      { id: 10, title: 'Old' },
    ],
  };

  it("renames the open project and its root step's title, until the refresh brings them", () => {
    expect(renamedSnapshot(snapshot, 3, 'New')).toEqual({ project: { id: 3, name: 'New', rootNodeId: 9 }, nodes: [{ id: 9, title: 'New' }, snapshot.nodes[1]] });
    expect(snapshot.project.name).toBe('Old');
    expect(snapshot.nodes[0].title).toBe('Old');
  });

  it("leaves another project's snapshot, or none, as it is", () => {
    expect(renamedSnapshot(snapshot, 4, 'New')).toBe(snapshot);
    expect(renamedSnapshot(null, 3, 'New')).toBeNull();
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

  it('takes a deleted project out', () => {
    expect(patchProjects(list, 'delete', 2)).toEqual([list[0]]);
  });

  it('puts a restored project back as the server answered it, so ⋯ never empties on the way', () => {
    const back = { id: 3, slug: 'c', status: 'archived' as const };
    expect(patchProjects(list, 'restore', 3, back)).toEqual([...list, back]);
    // Already listed (a reload got there first): that row stands.
    expect(patchProjects([...list, back], 'restore', 3, { ...back, slug: 'other' })).toEqual([...list, back]);
    // No answer to add: the reload brings it.
    expect(patchProjects(list, 'restore', 3)).toBe(list);
  });

  it('leaves the list it was given alone', () => {
    patchProjects(list, 'archive', 1);
    expect(list[0].status).toBe('active');
  });
});

describe('summaryOf', () => {
  it('lists a project the server answered with, its counts at nothing until the reload brings them', () => {
    const project = { id: 3, slug: 'c', name: 'C', description: '', playbook: '', status: 'archived' as const, rootNodeId: 9, createdAt: 'x', updatedAt: 'y', queue: [], briefingMode: 'full' as const, titleChannel: 'nudge' as const };
    expect(summaryOf(project)).toEqual({ ...project, openAsks: 0, permissionWaits: 0, activeSessions: 0, workingSessions: 0, busySessions: 0, lastEventAt: null });
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
