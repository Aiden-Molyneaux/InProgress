import { describe, expect, it } from 'vitest';
import type { BoardRow } from '../../src/core/board';
import type { PastSession, Session } from '../../src/core/types';
import { headerSessions } from '../../web/src/board/headerSessions';
import { ageShort, endedLine, firstSentence, hygieneTitle } from '../../web/src/board/text';

const NOW = Date.parse('2026-10-13T12:00:00Z');

const session = (over: Partial<Session> & { id: string }): Session => ({
  projectId: 1, title: null, cwd: null, branch: null, transcriptPath: null, state: 'idle', focusNodeId: null, promptsSinceUpdate: 0,
  startedAt: '2026-10-13T09:00:00Z', lastSeenAt: '2026-10-13T11:59:00Z', endedAt: null, slot: 0, role: 'worker', subagents: [], commands: [], ...over,
});

/** Just the part of a Board that headerSessions reads: which column each focused step sits in. */
const boardWith = (columns: Record<number, 'now' | 'done' | 'next'>) => ({
  byId: new Map(Object.entries(columns).map(([id, column]) => [Number(id), { column } as BoardRow])),
});

describe('headerSessions', () => {
  const board = boardWith({ 10: 'now', 11: 'done' });

  it('shows the orchestrator while it is live, working or idle', () => {
    const idle = session({ id: 'o', role: 'orchestrator', state: 'idle', slot: 2 });
    const working = session({ id: 'o2', role: 'orchestrator', state: 'working', slot: 3 });
    expect(headerSessions(board, [idle, working]).map((s) => s.id)).toEqual(['o', 'o2']);
  });

  it('leaves out an ended orchestrator, and with now one not heard from for 12 hours', () => {
    const ended = session({ id: 'e', role: 'orchestrator', state: 'ended' });
    const stale = session({ id: 's', role: 'orchestrator', state: 'idle', lastSeenAt: '2026-10-12T20:00:00Z' });
    expect(headerSessions(board, [ended, stale])).toEqual([stale]);
    expect(headerSessions(board, [ended, stale], NOW)).toEqual([]);
  });

  it('leaves out an idle worker with no step', () => {
    expect(headerSessions(board, [session({ id: 'w', state: 'idle', focusNodeId: null })])).toEqual([]);
  });

  it('shows a working worker with no focus, and one focused on a step that is not a Now row', () => {
    const none = session({ id: 'a', state: 'working', focusNodeId: null, slot: 0 });
    const group = session({ id: 'b', state: 'working', focusNodeId: 99, slot: 1 });
    const doneStep = session({ id: 'c', state: 'working', focusNodeId: 11, slot: 2 });
    expect(headerSessions(board, [doneStep, group, none]).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves out a worker that is on a Now row, whatever its state', () => {
    expect(headerSessions(board, [session({ id: 'w', state: 'working', focusNodeId: 10 })])).toEqual([]);
  });

  it('leaves out the orchestrator when it is on a Now row', () => {
    expect(headerSessions(board, [session({ id: 'o', role: 'orchestrator', focusNodeId: 10 })])).toEqual([]);
  });
});

describe('ageShort', () => {
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  it('reads now, minutes, hours and days', () => {
    expect(ageShort(ago(20_000), NOW)).toBe('now');
    expect(ageShort(ago(5 * 60_000), NOW)).toBe('5m');
    expect(ageShort(ago(3 * 3_600_000), NOW)).toBe('3h');
    expect(ageShort(ago(49 * 3_600_000), NOW)).toBe('2d');
  });
});

describe('firstSentence', () => {
  it('takes the first sentence of the first line, without heading marks', () => {
    expect(firstSentence('# Where we are\n\nThe app builds. Signing is next.')).toBe('The app builds.');
    expect(firstSentence('\nSigning works. Store listing is next.\nMore.')).toBe('Signing works.');
  });
  it('keeps a line with no full stop whole, and an empty note empty', () => {
    expect(firstSentence('Waiting on the keystore')).toBe('Waiting on the keystore');
    expect(firstSentence('  \n ')).toBe('');
  });
});

describe('the hygiene tooltip', () => {
  it('names each marked step with its marks', () => {
    const row = (id: number, marks: string[]) => ({ node: { id }, marks }) as unknown as BoardRow;
    expect(hygieneTitle({ marked: [row(53, ['no_outcome']), row(173, ['ended_open'])] })).toBe('#53 no_outcome · #173 ended_open');
  });
});

describe('endedLine', () => {
  const past: PastSession[] = [
    { id: 'old', title: null, focusNodeId: 5, startedAt: '2026-10-13T01:00:00Z', endedAt: '2026-10-13T03:00:00Z' },
    { id: 'b', title: null, focusNodeId: 5, startedAt: '2026-10-13T06:00:00Z', endedAt: '2026-10-13T09:00:00Z' },
  ];
  const row = (marks: string[]) => ({ node: { id: 5 }, marks }) as unknown as BoardRow;
  it('says how long ago the newest past session ended without closing', () => {
    expect(endedLine(row(['ended_open']), past, NOW)).toBe('Its last session ended 3h ago without closing it');
  });
  it('is null for a row without the mark', () => {
    expect(endedLine(row(['deep']), past, NOW)).toBeNull();
  });
});
