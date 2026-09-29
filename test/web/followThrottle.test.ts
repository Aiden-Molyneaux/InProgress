import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFollowThrottle } from '../../web/src/canvas/followThrottle';

const START = 1_000_000;

describe('createFollowThrottle', () => {
  let moves: string[];
  let lastMove: number;
  /** Targets whose snapshot hasn't landed yet, so the camera can't centre on them. */
  let notLaidOut: Set<number>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    moves = [];
    lastMove = 0;
    notLaidOut = new Set();
  });
  afterEach(() => vi.useRealTimers());

  const at = () => Date.now() - START;
  const make = () =>
    createFollowThrottle({
      move: (target) => {
        if (notLaidOut.has(target)) return false;
        moves.push(`${target}@${at()}`);
        lastMove = Date.now();
        return true;
      },
      lastMove: () => lastMove,
    });

  it('gives a new node time to be laid out, then moves once', () => {
    const follow = make();
    follow.push(5);
    vi.advanceTimersByTime(349);
    expect(moves).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual(['5@350']);
  });

  it('waits 1.5 s after the last camera move', () => {
    lastMove = START - 1000;
    const follow = make();
    follow.push(5);
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual(['5@500']);
  });

  it('keeps moving through a burst: one move per 1.5 s, to the newest target', () => {
    const follow = make();
    for (let i = 1; i <= 14; i++) {
      follow.push(i);
      vi.advanceTimersByTime(300);
    }
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual(['2@350', '7@1850', '12@3350', '14@4850']);
  });

  it('moves once for repeated events on the same node', () => {
    const follow = make();
    follow.push(5);
    vi.advanceTimersByTime(100);
    follow.push(5);
    follow.push(5);
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual(['5@350']);
  });

  it('retries a node until its snapshot lands', () => {
    notLaidOut.add(5);
    const follow = make();
    follow.push(5);
    vi.advanceTimersByTime(700);
    notLaidOut.delete(5);
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual(['5@950']);
  });

  it('gives up after four tries, and follows the next event normally', () => {
    notLaidOut.add(5);
    const follow = make();
    follow.push(5);
    vi.advanceTimersByTime(1300);
    notLaidOut.delete(5);
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual([]);
    follow.push(6);
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual(['6@6650']);
  });

  it('lets a newer target take over a retry that is still waiting', () => {
    notLaidOut.add(5);
    const follow = make();
    follow.push(5);
    vi.advanceTimersByTime(400);
    follow.push(6);
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual(['6@650']);
  });

  it('holds a waiting move back when the camera moves for another reason', () => {
    const follow = make();
    follow.push(5);
    vi.advanceTimersByTime(200);
    lastMove = Date.now(); // Home, N or a session chip moved the camera
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual(['5@1700']);
  });

  it('cancel drops the waiting move', () => {
    const follow = make();
    follow.push(5);
    vi.advanceTimersByTime(100);
    follow.cancel();
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual([]);
    follow.push(6);
    vi.advanceTimersByTime(5000);
    expect(moves).toEqual(['6@5450']);
  });
});
