import { describe, expect, it } from 'vitest';
import { deriveBoard } from '../../src/core/board';
import type { ProjectSnapshot, TreeNode } from '../../src/core/types';
import { headMeta, projectSections, renderedRows } from '../../web/src/project/projectOutline';

const NOW = Date.parse('2026-10-13T12:00:00Z');
let n = 0;
const node = (id: number, parentId: number | null, title: string, status: TreeNode['status'] = 'todo', extra: Partial<TreeNode> = {}): TreeNode => ({
  id, projectId: 1, parentId, position: ++n, kind: 'task', title, body: '', status, assignee: 'claude', outcome: '', label: null,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', completedAt: status === 'done' ? '2026-10-10T00:00:00Z' : null, driverSessionId: null, boardState: null, stateSince: null, hue: null, parkedReason: '', parkedWhere: '', parkedAt: null, rankBand: null, rank: null, ...extra,
});

function snap(nodes: TreeNode[], extra: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    project: { id: 1, queue: [] } as never, nodes, resources: [], sessions: [], workItems: [], trailAgents: [], pastSessions: [], asks: [], stepTouches: [],
    stateNote: null, lastEventId: 0, lastEvent: null, ...extra,
  };
}
const sections = (s: ProjectSnapshot) => projectSections(s, deriveBoard(s, NOW));
const root = node(1, null, 'Root', 'active');

describe('projectSections', () => {
  it('makes a section per top-level group and gathers childless steps in "Top level"', () => {
    const s = snap([root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'a1'), node(4, 1, 'Loose'), node(5, 1, 'Beta', 'active'), node(6, 5, 'b1')]);
    expect(sections(s).map((x) => x.title)).toEqual(['Alpha', 'Beta', 'Top level']);
    expect(sections(s)[2]!.group).toBeNull();
  });

  it('counts steps below a group at every depth, and what position each is in', () => {
    const queue = [{ nodeId: 5, sessionId: null }];
    const s = snap(
      [root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'Mid'), node(4, 3, 'deep todo'), node(5, 2, 'queued'), node(6, 2, 'finished', 'done'), node(7, 3, 'gone', 'dropped')],
      { project: { id: 1, queue } as never },
    );
    const alpha = sections(s)[0]!;
    expect(alpha.total).toBe(4);
    expect(alpha.done).toBe(1);
    expect(alpha.counts).toEqual({ now: 0, next: 1, backlog: 1, done: 1 });
  });

  it('gives a section its group, descendants and nothing else for docs', () => {
    const res = (id: number, nodeId: number) => ({ id, nodeId, title: `r${id}` }) as never;
    const s = snap([root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'a1'), node(4, 1, 'Beta', 'active'), node(5, 4, 'b1')], { resources: [res(1, 2), res(2, 3), res(3, 5)] });
    expect(sections(s)[0]!.docs.map((r) => r.id)).toEqual([1, 2]);
  });

  it('starts open for a step in Now or Next, or for an open ask, and folded otherwise', () => {
    const queue = [{ nodeId: 3, sessionId: null }];
    const s = snap([root, node(2, 1, 'Queued', 'active'), node(3, 2, 'q'), node(4, 1, 'Quiet', 'active'), node(5, 4, 'z'), node(6, 1, 'Asked', 'active'), node(7, 6, 'y')], {
      project: { id: 1, queue } as never,
      asks: [{ id: 1, nodeId: 7, clearedAt: null }] as never,
    });
    expect(Object.fromEntries(sections(s).map((x) => [x.title, x.startsOpen]))).toEqual({ Queued: true, Quiet: false, Asked: true });
  });

  it('folds done children per parent into one line with the latest', () => {
    const s = snap([
      root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'old', 'done', { completedAt: '2026-10-01T00:00:00Z' }), node(4, 2, 'new', 'done', { completedAt: '2026-10-12T00:00:00Z' }),
      node(5, 2, 'Parent'), node(6, 5, 'inner done', 'done'), node(7, 5, 'inner open'),
    ]);
    const lines = sections(s)[0]!.lines;
    expect(lines.map((l) => (l.kind === 'step' ? `step ${l.node.title} @${l.depth}` : `done ${l.parentId} x${l.count} latest ${l.latest.title} @${l.depth}`))).toEqual([
      'step Parent @0',
      'step inner open @1',
      'done 5 x1 latest inner done @1',
      'done 2 x2 latest new @0',
    ]);
  });

  it('keeps a done step that still has an open step below it as a line', () => {
    const s = snap([root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'closed early', 'done'), node(4, 3, 'still open')]);
    const lines = sections(s)[0]!.lines;
    expect(lines.map((l) => (l.kind === 'step' ? l.node.title : 'fold'))).toEqual(['closed early', 'still open']);
  });

  it('puts fully done groups last, after "Top level", and leaves a finished top level out', () => {
    const s = snap([root, node(2, 1, 'Finished', 'done'), node(3, 2, 'f1', 'done'), node(4, 1, 'Open', 'active'), node(5, 4, 'o1'), node(6, 1, 'Loose')]);
    const all = sections(s);
    expect(all.map((x) => x.title)).toEqual(['Open', 'Top level', 'Finished']);
    expect(all[2]!.allDone).toBe(true);
    const finishedTop = snap([root, node(2, 1, 'Open', 'active'), node(3, 2, 'o1'), node(4, 1, 'Loose', 'done')]);
    expect(sections(finishedTop).map((x) => x.title)).toEqual(['Open']);
  });
});

describe('projectSections and parked steps', () => {
  it('shows a parked step as a line with its subtree folded, and leaves it and what is under it out of the counts', () => {
    const s = snap([root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'open'), node(4, 2, 'Shelf', 'parked'), node(5, 4, 'under shelf'), node(6, 5, 'deeper', 'active')]);
    const alpha = sections(s)[0]!;
    expect(alpha.lines.map((l) => (l.kind === 'step' ? l.node.id : 0))).toEqual([3, 4]);
    expect(alpha.total).toBe(1);
    expect(alpha.counts).toEqual({ now: 0, next: 0, backlog: 1, done: 0 });
  });
  it('a group of done steps and a parked one is not a done group', () => {
    const s = snap([root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'finished', 'done'), node(4, 2, 'Shelf', 'parked')]);
    expect(sections(s)[0]!.allDone).toBe(false);
  });
  it('a done step holding a parked one is not folded away', () => {
    const s = snap([root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'phase done', 'done'), node(4, 3, 'Shelf', 'parked'), node(5, 2, 'open')]);
    expect(sections(s)[0]!.lines.some((l) => l.kind === 'step' && l.node.id === 3)).toBe(true);
  });
});

describe('headMeta', () => {
  it('counts the phases, the steps now and next, and the done steps, with known numbers', () => {
    // Alpha is finished (its one step is done); Beta's step is active with no session on it, so it is not in Now; "Loose" is queued.
    const queue = [{ nodeId: 6, sessionId: null }];
    const s = snap([root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'a1', 'done'), node(4, 1, 'Beta', 'active'), node(5, 4, 'b1', 'active'), node(6, 1, 'Loose')], { project: { id: 1, queue } as never });
    const board = deriveBoard(s, NOW);
    expect(headMeta(board, projectSections(s, board))).toEqual([
      { label: 'PHASES', value: 2 },
      { label: 'NOW', value: 0 },
      { label: 'NEXT', value: 1 },
      { label: 'DONE', value: 1 },
    ]);
  });

  it('reads PHASE at one', () => {
    const s = snap([root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'a1')]);
    const board = deriveBoard(s, NOW);
    expect(headMeta(board, projectSections(s, board))[0]).toEqual({ label: 'PHASE', value: 1 });
  });
});

describe('renderedRows', () => {
  const s = snap([root, node(2, 1, 'Alpha', 'active'), node(3, 2, 'open one'), node(4, 2, 'done one', 'done'), node(5, 2, 'done two', 'done')]);
  const lines = sections(s)[0]!.lines;

  it('gives the steps and a fold line, and the done children only while the fold is open', () => {
    expect(renderedRows(lines, () => false).map((r) => r.key)).toEqual(['s3', 'd2']);
    expect(renderedRows(lines, () => true).map((r) => `${r.kind}:${r.key}`)).toEqual(['step:s3', 'fold:d2', 'child:o5', 'child:o4']);
  });
});
