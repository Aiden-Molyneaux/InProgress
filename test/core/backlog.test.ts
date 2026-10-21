import { describe, expect, it } from 'vitest';
import { deriveBacklog } from '../../src/core/backlog';
import { deriveBoard, type BoardInput } from '../../src/core/board';
import { STALE_STEP_MS, type Session, type StepTouch, type TreeNode } from '../../src/core/types';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const T = '2026-10-20T11:00:00.000Z';
const DAYS = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function n(id: number, parentId: number | null, o: Partial<TreeNode> = {}): TreeNode {
  return { id, projectId: 1, parentId, position: id, kind: 'task', title: `S${id}`, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null, createdAt: T, updatedAt: T, completedAt: null, driverSessionId: null, boardState: null, stateSince: null, hue: null, parkedReason: '', parkedWhere: '', parkedAt: null, rankBand: null, rank: null, ...o };
}
function s(id: string, o: Partial<Session> = {}): Session {
  return { id, projectId: 1, title: id, cwd: null, branch: null, transcriptPath: null, state: 'idle', focusNodeId: null, promptsSinceUpdate: 0, startedAt: T, lastSeenAt: T, lastPromptAt: null, endedAt: null, slot: 0, subagents: [], commands: [], role: 'worker', titleAsked: null, ...o };
}
function input(nodes: TreeNode[], queue: { nodeId: number; sessionId: string | null }[] = [], sessions: Session[] = []): BoardInput {
  return {
    project: { id: 1, slug: 'p', name: 'P', description: '', playbook: '', status: 'active', rootNodeId: 1, createdAt: T, updatedAt: T, queue, briefingMode: 'full', titleChannel: 'nudge' },
    nodes, sessions, pastSessions: [], resources: [], asks: [],
  };
}
const backlog = (b: BoardInput, touches: StepTouch[] = [], match?: Parameters<typeof deriveBacklog>[3]) => deriveBacklog(deriveBoard(b, NOW), { stepTouches: touches }, NOW, match);
const ids = (rows: { row: { node: TreeNode } }[]) => rows.map((r) => r.row.node.id);
const nums = (rows: { number: number | null }[]) => rows.map((r) => r.number);

describe('deriveBacklog', () => {
  it('numbers run on across bands: unowned Next up, then Soon, then Someday; own queues and triage get none', () => {
    const b = backlog(
      input(
        [n(1, null), n(2, 1, { rankBand: 'soon' }), n(3, 1), n(4, 1, { rankBand: 'soon', rank: 2 }), n(5, 1, { rankBand: 'soon', rank: 1 }), n(6, 1, { rankBand: 'someday', rank: 1 }), n(7, 1), n(8, 1)],
        [{ nodeId: 7, sessionId: 'own' }, { nodeId: 2, sessionId: null }, { nodeId: 3, sessionId: null }],
        [s('own')],
      ),
    );
    // Queue membership wins over the band: #2 is in Soon but shows in Next up.
    expect(ids(b.next)).toEqual([2, 3, 7]);
    expect(nums(b.next)).toEqual([1, 2, null]);
    expect(b.next.map((r) => r.band)).toEqual(['next', 'next', 'next']);
    expect(ids(b.soon)).toEqual([5, 4]);
    expect(nums(b.soon)).toEqual([3, 4]);
    expect(ids(b.someday)).toEqual([6]);
    expect(nums(b.someday)).toEqual([5]);
    expect(ids(b.triage)).toEqual([8]);
    expect(nums(b.triage)).toEqual([null]);
  });

  it('unranked steps of a band sit after the ranked ones, in tree order', () => {
    const b = backlog(input([
      n(1, null), n(2, 1, { kind: 'phase' }), n(3, 2, { rankBand: 'soon', position: 2 }), n(4, 2, { rankBand: 'soon', position: 1 }),
      n(5, 1, { rankBand: 'soon', rank: 7 }), n(6, 2, { rankBand: 'soon', rank: 3, position: 3 }),
    ]));
    expect(ids(b.soon)).toEqual([6, 5, 4, 3]);
  });

  it('a group (a step with open children) is no row; its children are ranked on their own', () => {
    const b = backlog(input([n(1, null), n(2, 1, { rankBand: 'soon', rank: 1 }), n(3, 2, { rankBand: 'someday' }), n(4, 2)]));
    expect(ids(b.soon)).toEqual([]);
    expect(ids(b.someday)).toEqual([3]);
    expect(ids(b.triage)).toEqual([4]);
  });

  it('Needs Triage is unranked rows newest first, ties by the higher id', () => {
    const b = backlog(input([n(1, null), n(2, 1, { createdAt: DAYS(3) }), n(3, 1, { createdAt: DAYS(1) }), n(4, 1, { createdAt: DAYS(1) }), n(5, 1, { createdAt: DAYS(2), rankBand: 'soon' })]));
    expect(ids(b.triage)).toEqual([4, 3, 2]);
  });

  it('Stale reads the newest of updatedAt, the last focusing session and the last ask, in Soon and Someday only', () => {
    const old = DAYS(20);
    const b = backlog(
      input([
        n(1, null),
        n(2, 1, { rankBand: 'soon', rank: 1, updatedAt: old }),
        n(3, 1, { rankBand: 'soon', rank: 2, updatedAt: old }),
        n(4, 1, { rankBand: 'someday', rank: 1, updatedAt: old }),
        n(5, 1, { rankBand: 'someday', rank: 2, updatedAt: DAYS(30) }),
        n(6, 1, { updatedAt: old }),
        n(7, 1, { rankBand: 'soon', rank: 3, updatedAt: old }),
        n(8, 1, { rankBand: 'soon', rank: 4, updatedAt: DAYS(13) }),
      ], [{ nodeId: 7, sessionId: null }]),
      [
        { nodeId: 3, sessionAt: DAYS(2), askAt: null },
        { nodeId: 4, sessionAt: DAYS(16), askAt: DAYS(15) },
      ],
    );
    // #3 had a session 2 days ago; #6 is unranked; #7 is queued; #8 was edited 13 days ago.
    expect(ids(b.stale)).toEqual([5, 2, 4]);
    expect(b.stale.find((r) => r.row.node.id === 4)!.touchedAt).toBe(DAYS(15));
    expect(Date.parse(DAYS(15)) < NOW - STALE_STEP_MS).toBe(true);
  });

  it('Parked is newest parked first; By Phase holds every open row in rank order', () => {
    const b = backlog(
      input(
        [n(1, null), n(2, 1, { status: 'parked', parkedAt: DAYS(5) }), n(3, 1, { status: 'parked', parkedAt: DAYS(1) }), n(4, 1, { rankBand: 'someday' }), n(5, 1, { rankBand: 'soon' }), n(6, 1), n(7, 1)],
        [{ nodeId: 7, sessionId: null }],
      ),
    );
    expect(b.parked.map((p) => p.node.id)).toEqual([3, 2]);
    expect(ids(b.phase)).toEqual([7, 5, 4, 6]);
    expect(b.counts).toEqual({
      ranked: { all: 3, shown: 3 },
      phase: { all: 4, shown: 4 },
      triage: { all: 1, shown: 1 },
      stale: { all: 0, shown: 0 },
      parked: { all: 2, shown: 2 },
    });
  });

  it('a filter keeps the rows it passes, counts both, and leaves the numbers as they were', () => {
    const b = backlog(
      input([n(1, null), n(2, 1, { rankBand: 'soon', rank: 1 }), n(3, 1, { rankBand: 'soon', rank: 2, title: 'match me' }), n(4, 1, { title: 'match me too' }), n(5, 1, { status: 'parked', parkedAt: T })]),
      [],
      ({ node }) => node.title.startsWith('match'),
    );
    expect(ids(b.soon)).toEqual([3]);
    expect(nums(b.soon)).toEqual([2]);
    expect(ids(b.triage)).toEqual([4]);
    expect(b.parked).toEqual([]);
    expect(b.counts.ranked).toEqual({ all: 2, shown: 1 });
    expect(b.counts.phase).toEqual({ all: 3, shown: 2 });
    expect(b.counts.parked).toEqual({ all: 1, shown: 0 });
  });
});
