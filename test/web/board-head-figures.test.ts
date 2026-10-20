import { describe, expect, it } from 'vitest';
import type { BoardRow } from '../../src/core/board';
import type { TaskBox } from '../../src/core/taskState';
import type { Ask, Session } from '../../src/core/types';
import { boardHeadFigures } from '../../web/src/board/headFigures';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const session = (over: Partial<Session> & { id: string }): Session => ({
  projectId: 1, title: null, cwd: null, branch: null, transcriptPath: null, state: 'idle', focusNodeId: null, promptsSinceUpdate: 0,
  startedAt: '2026-10-20T09:00:00Z', lastSeenAt: '2026-10-20T11:59:00Z', endedAt: null, slot: 0, role: 'worker', lastPromptAt: null, subagents: [], commands: [], ...over,
});
const ask = (id: number): Ask => ({ id, projectId: 1, nodeId: 1, kind: 'question', text: 'q', sessionId: null, raisedAt: '2026-10-20T10:00:00Z', clearedAt: null, clearedBy: null, answer: '', answerDeliveredAt: null });
const row = (over: Partial<BoardRow>) => over as BoardRow;
const box = (r: BoardRow | null, s: Session | null = null) => ({ row: r, session: s, cell: 'needs', state: 'question' }) as TaskBox;

describe('boardHeadFigures', () => {
  it('counts the Needs me panels: asks still waiting on the user, sessions in permission, and a focusless wait as one', () => {
    const needs = [
      box(row({ asks: [ask(1), ask(2), ask(5)], waiting: [ask(1), ask(2)], sessions: [] })),
      box(row({ asks: [], waiting: [], sessions: [session({ id: 'p', state: 'permission' }), session({ id: 'i' })] })),
      box(null, session({ id: 'f', state: 'permission' })),
    ];
    const figures = boardHeadFigures({ next: [], done: [] }, { needs }, { sessions: [] }, NOW);
    expect(figures.find((f) => f.label === 'ASKS')?.value).toBe(4);
  });

  it('counts live working sessions, ready Next rows and done rows', () => {
    const sessions = [
      session({ id: 'a', state: 'working' }),
      session({ id: 'b', state: 'working', lastSeenAt: '2026-10-19T08:00:00Z' }),
      session({ id: 'c', state: 'working', endedAt: '2026-10-20T11:00:00Z' }),
      session({ id: 'd', state: 'idle' }),
    ].map((s) => (s.id === 'c' ? { ...s, state: 'ended' as const } : s));
    const next = [row({ ready: true }), row({ ready: false }), row({ ready: true })];
    const figures = boardHeadFigures({ next, done: [row({}), row({})] }, { needs: [] }, { sessions }, NOW);
    expect(figures).toEqual([
      { label: 'ASKS', value: 0 },
      { label: 'LIVE', value: 1 },
      { label: 'READY', value: 2 },
      { label: 'DONE', value: 2 },
    ]);
  });
});
