import { describe, expect, it } from 'vitest';
import type { Session, SubagentInfo } from '../../src/core/types';
import { characterState, phaseDelay } from '../../web/src/characterState';

const session = (extra: Partial<Session> = {}): Session => ({
  id: 's1abcdef', projectId: 1, title: '#5 UI Session post-Fable', cwd: null, branch: null, transcriptPath: null, state: 'working',
  focusNodeId: 127, promptsSinceUpdate: 0, startedAt: 't', lastSeenAt: 't', endedAt: null, slot: 2, subagents: [], ...extra,
});
const agent = (extra: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId: 'a1', agentType: 'general-purpose', startedAt: 't', description: 'Draft the whiteboard take', model: 'opus-5-5', nodeId: 127,
  endedAt: null, ordinal: 10, purpose: null, ...extra,
});

describe('characterState', () => {
  it("gives a session's working, idle and permission as work, idle and wait, and an ended session ended", () => {
    expect(characterState(session({ state: 'working' }))).toBe('work');
    expect(characterState(session({ state: 'idle' }))).toBe('idle');
    expect(characterState(session({ state: 'permission' }))).toBe('wait');
    expect(characterState(session({ state: 'ended', endedAt: '2026-10-05T11:57:00Z' }))).toBe('ended');
  });

  it('reads a session by its state alone: a live session has no endedAt yet, and that never makes it a worker', () => {
    expect(characterState(session({ state: 'idle', endedAt: null }))).toBe('idle');
    expect(characterState({ state: 'permission' })).toBe('wait');
  });

  it('gives a running subagent work and a stopped one ended', () => {
    expect(characterState(agent())).toBe('work');
    expect(characterState(agent({ endedAt: '2026-10-05T11:57:00Z' }))).toBe('ended');
    expect(characterState({ endedAt: null })).toBe('work');
    expect(characterState({ endedAt: '2026-10-05T11:57:00Z' })).toBe('ended');
  });
});

describe('phaseDelay', () => {
  it('hashes the seed to a fixed negative delay', () => {
    expect(phaseDelay('s1', 2400)).toBe(-1449);
    expect(phaseDelay('s2', 2400)).toBe(-1392);
    expect(phaseDelay('s1abcdef:a1', 2400)).toBe(-1210);
    expect(phaseDelay('s1abcdef', 4600)).toBe(-3270);
  });

  it('is stable: the same seed and period give the same delay every time', () => {
    expect(phaseDelay('s1abcdef', 2400)).toBe(phaseDelay('s1abcdef', 2400));
  });

  it('starts every seed at a whole millisecond inside one period, never at or past its length', () => {
    const seeds = ['', 'a', 's1', 's1abcdef', 's1abcdef:a1', 's1abcdef:a2', 'b7f0c2d9-0000-4e1a-9f3b-77aa00cc11ee'];
    for (const period of [1800, 2400, 3600, 5200]) {
      for (const seed of seeds) {
        const delay = phaseDelay(seed, period);
        expect(Number.isInteger(delay), `${seed} at ${period}`).toBe(true);
        expect(delay, `${seed} at ${period}`).toBeLessThanOrEqual(0);
        expect(delay, `${seed} at ${period}`).toBeGreaterThan(-period);
      }
    }
  });

  it('returns 0, not -0, when the hash is a whole number of periods', () => {
    // Every hash is a whole number of 1 ms periods, so -(h % 1) is -0 before the guard.
    expect(Object.is(phaseDelay('s1', 1), 0)).toBe(true);
  });

  it('puts a chip and its kin out of step', () => {
    const delays = ['s1abcdef', 's1abcdef:a1', 's1abcdef:a2', 's2'].map((seed) => phaseDelay(seed, 2400));
    expect(new Set(delays).size).toBe(delays.length);
  });
});
