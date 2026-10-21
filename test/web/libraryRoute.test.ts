import { describe, expect, it } from 'vitest';
import { libraryHash, parseLibraryHash } from '../../web/src/library/route';

describe('the Library hash', () => {
  it('round trips a pick whose template holds slashes', () => {
    const route = { shelf: 'sync' as const, pick: { slug: 'in-game', template: 'agents/sev.md' } };
    expect(libraryHash(route)).toBe('#/lib/sync/in-game/agents%2Fsev.md');
    expect(parseLibraryHash(libraryHash(route))).toEqual(route);
  });

  it('names each shelf without a pick', () => {
    for (const shelf of ['pages', 'roster', 'sync'] as const) expect(parseLibraryHash(libraryHash({ shelf, pick: null }))).toEqual({ shelf, pick: null });
  });

  it('is null for a project hash and for no hash', () => {
    expect(parseLibraryHash('#/p/x')).toBeNull();
    expect(parseLibraryHash('')).toBeNull();
    expect(parseLibraryHash('#/library')).toBeNull();
  });

  it('opens Pages for the bare route and for an unknown shelf', () => {
    expect(parseLibraryHash('#/lib')).toEqual({ shelf: 'pages', pick: null });
    expect(parseLibraryHash('#/lib/')).toEqual({ shelf: 'pages', pick: null });
    expect(parseLibraryHash('#/lib/nope/a/b')).toEqual({ shelf: 'pages', pick: null });
  });

  it('takes a pick only on sync, with both parts present', () => {
    expect(parseLibraryHash('#/lib/pages/a/b')).toEqual({ shelf: 'pages', pick: null });
    expect(parseLibraryHash('#/lib/sync/a')).toEqual({ shelf: 'sync', pick: null });
  });

  it('drops the pick on a broken escape', () => {
    expect(parseLibraryHash('#/lib/sync/a/%E0%A4%A')).toEqual({ shelf: 'sync', pick: null });
  });
});
