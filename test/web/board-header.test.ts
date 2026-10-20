import { describe, expect, it } from 'vitest';
import type { BoardRow } from '../../src/core/board';
import type { PastSession, Session, WorkItem } from '../../src/core/types';
import { headerSessions } from '../../web/src/board/headerSessions';
import { taskProgress } from '../../web/src/board/nowTask';
import { ageShort, endedLine, firstSentence, hhmm, hygieneTitle, noteHasMore, splitRefs } from '../../web/src/board/text';

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

describe('splitRefs', () => {
  const has = (id: number) => id === 12 || id === 7;
  it('splits known #ids out of the text and gives the text back when joined', () => {
    const runs = splitRefs('See #12 and #7, not #99 or a#12.', has);
    expect(runs).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'ref', id: 12, text: '#12' },
      { kind: 'text', text: ' and ' },
      { kind: 'ref', id: 7, text: '#7' },
      { kind: 'text', text: ', not #99 or a#12.' },
    ]);
    expect(runs.map((r) => r.text).join('')).toBe('See #12 and #7, not #99 or a#12.');
  });
  it('treats a ref at the start and a hash with letters after it as text', () => {
    expect(splitRefs('#12', has)).toEqual([{ kind: 'ref', id: 12, text: '#12' }]);
    expect(splitRefs('#12abc', has)).toEqual([{ kind: 'text', text: '#12abc' }]);
    expect(splitRefs('', has)).toEqual([]);
  });
});

describe('noteHasMore', () => {
  it('is false for a note that is only its first sentence', () => {
    expect(noteHasMore('Signing is half done.')).toBe(false);
    expect(noteHasMore('Signing is half done.\n')).toBe(false);
  });
  it('is true when more follows the first sentence, or a heading comes before it', () => {
    expect(noteHasMore('Signing is half done. The tests come next.')).toBe(true);
    expect(noteHasMore('# Where we are\n\nSigning is half done.')).toBe(true);
    expect(noteHasMore('First line.\n\nSecond paragraph')).toBe(true);
  });
});

describe('hhmm', () => {
  it('reads a time as local 24-hour HH:MM, padded', () => {
    const at = new Date(2026, 9, 13, 9, 4);
    expect(hhmm(at.toISOString())).toBe('09:04');
    expect(hhmm(new Date(2026, 9, 13, 23, 59).toISOString())).toBe('23:59');
  });
  it('gives nothing for a time it cannot read', () => {
    expect(hhmm('not a time')).toBe('');
  });
});

describe('taskProgress', () => {
  const item = (over: Partial<WorkItem> & { id: number }): WorkItem => ({
    nodeId: 10, sessionId: 's1', agentId: '', subject: `T${over.id}`, status: 'pending', blocks: [], position: over.id, updatedAt: '', endedAt: null, ...over,
  });
  it('counts the session\'s own tasks with the focus step first, and names the first in progress', () => {
    const items = [
      item({ id: 1, nodeId: 20, status: 'in_progress' }),
      item({ id: 2, nodeId: 10, status: 'completed' }),
      item({ id: 3, nodeId: 10, status: 'in_progress' }),
      item({ id: 4, nodeId: 10, agentId: 'a1', status: 'in_progress' }),
      item({ id: 5, nodeId: 10, sessionId: 's2', status: 'in_progress' }),
    ];
    const got = taskProgress(items, 's1', 10);
    expect(got?.item.id).toBe(3);
    expect(got?.place).toBe(2);
    expect(got?.total).toBe(3);
  });
  it('is null when nothing is in progress', () => {
    expect(taskProgress([item({ id: 1 })], 's1', 10)).toBeNull();
  });
});
