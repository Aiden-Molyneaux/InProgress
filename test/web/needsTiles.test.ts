import { describe, expect, it } from 'vitest';
import type { BoardRow } from '../../src/core/board';
import type { TaskBox, TaskCell } from '../../src/core/taskState';
import type { HeldCard } from '../../src/core/types';
import { heldText, needsTiles } from '../../web/src/board/needsTiles';

const box = (id: number, cell: TaskCell, raisedAt: string[] = []): TaskBox =>
  ({ row: { node: { id }, sessions: [], waiting: raisedAt.map((r) => ({ raisedAt: r })) } as unknown as BoardRow, session: null, cell, state: cell === 'needs' ? 'question' : 'working' });
const cells = (all: TaskBox[]): Record<TaskCell, TaskBox[]> => {
  const out: Record<TaskCell, TaskBox[]> = { needs: [], next: [], now: [], done: [], backlog: [] };
  for (const b of all) out[b.cell].push(b);
  return out;
};
const held = (id: number, stepId: number | null, at: string): HeldCard => ({ id, stepId, createdAt: at, what: 'a push of feature to origin', command: 'git push' });

describe('needsTiles', () => {
  it('with nothing held, is the needs boxes in their order', () => {
    const a = box(1, 'needs', ['2026-11-26T10:00:00Z']);
    const b = box(2, 'needs', ['2026-11-26T11:00:00Z']);
    expect(needsTiles(cells([a, b, box(3, 'now')])).map((t) => t.key)).toEqual(['n1', 'n2']);
  });

  it("puts a held command on a Needs me step inside that step's tile, and gives the others their own tiles, oldest first", () => {
    const asked = box(1, 'needs', ['2026-11-26T10:00:00Z']);
    const working = box(2, 'now');
    const tiles = needsTiles(cells([asked, working]), [
      held(30, 2, '2026-11-26T12:00:00Z'),
      held(31, 1, '2026-11-26T11:00:00Z'),
      held(32, null, '2026-11-26T09:00:00Z'),
      held(33, 2, '2026-11-26T09:30:00Z'),
      held(34, 99, '2026-11-26T13:00:00Z'),
    ]);
    expect(tiles.map((t) => [t.key, t.held.map((h) => h.id)])).toEqual([
      ['hi32', [32]],
      ['h2', [33, 30]],
      ['n1', [31]],
      ['h99', [34]],
    ]);
    // A step drawn elsewhere keeps its box for the tile's look; a step not on the Board has none.
    expect(tiles[1]).toMatchObject({ kind: 'held', step: working, stepId: 2 });
    expect(tiles[3]).toMatchObject({ kind: 'held', step: null, stepId: 99 });
  });

  it("an older held command moves its step's tile ahead", () => {
    const first = box(1, 'needs', ['2026-11-26T10:00:00Z']);
    const second = box(2, 'needs', ['2026-11-26T11:00:00Z']);
    expect(needsTiles(cells([first, second]), [held(40, 2, '2026-11-26T08:00:00Z')]).map((t) => t.key)).toEqual(['n2', 'n1']);
  });

  it('a held command alone still makes a tile, so the band is never empty while one waits', () => {
    expect(needsTiles(cells([box(5, 'next')]), [held(50, 5, '2026-11-26T08:00:00Z')]).map((t) => t.key)).toEqual(['h5']);
  });
});

describe('heldText', () => {
  it('says what the step wants, as the Voice does', () => {
    expect(heldText({ stepId: 747, what: 'a publish of x 1.2.0 to npm' })).toBe('#747 wants a publish of x 1.2.0 to npm.');
    expect(heldText({ stepId: null, what: 'git push.' })).toBe('A session wants git push.');
  });
});
