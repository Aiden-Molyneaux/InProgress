import { describe, expect, it } from 'vitest';
import type { CommandInfo, Session, SubagentInfo } from '../../src/core/types';
import { characterState, phaseDelay } from '../../web/src/characterState';

const session = (extra: Partial<Session> = {}): Session => ({
  id: 's1abcdef', projectId: 1, title: '#5 UI Session post-Fable', cwd: null, branch: null, transcriptPath: null, state: 'working',
  focusNodeId: 127, promptsSinceUpdate: 0, startedAt: 't', lastSeenAt: 't', endedAt: null, slot: 2, role: 'worker', subagents: [], commands: [], ...extra,
});
const agent = (extra: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId: 'a1', agentType: 'general-purpose', startedAt: 't', runStartedAt: 't', description: 'Draft the whiteboard take', model: 'opus-5-5', nodeId: 127,
  endedAt: null, ordinal: 10, purpose: null, endReason: null, lastActiveAt: null, ...extra,
});

const NOW = Date.parse('2026-10-10T12:00:00Z');
const command = (extra: Partial<CommandInfo> = {}): CommandInfo => ({
  taskId: 'b1', kind: 'shell', agentId: '', persistent: false, description: null, commandHead: 'npm run test:e2e', nodeId: 127,
  startedAt: new Date(NOW - 60_000).toISOString(), endedAt: null, outcome: null, exitCode: null, ...extra,
});

describe('characterState', () => {
  it("gives a session's working, idle and permission as work, idle and wait, and an ended session ended", () => {
    expect(characterState(session({ state: 'working' }), NOW)).toBe('work');
    expect(characterState(session({ state: 'idle' }), NOW)).toBe('idle');
    expect(characterState(session({ state: 'permission' }), NOW)).toBe('wait');
    expect(characterState(session({ state: 'ended', endedAt: '2026-10-05T11:57:00Z' }), NOW)).toBe('ended');
  });

  it('reads a session by its state alone: a live session has no endedAt yet, and that never makes it a worker', () => {
    expect(characterState(session({ state: 'idle', endedAt: null }), NOW)).toBe('idle');
    expect(characterState({ state: 'permission', subagents: [], commands: [] }, NOW)).toBe('wait');
  });

  it('gives an idle session busy while a worker runs or a command counts as work', () => {
    expect(characterState(session({ state: 'idle', subagents: [agent()] }), NOW)).toBe('busy');
    expect(characterState(session({ state: 'idle', commands: [command()] }), NOW)).toBe('busy');
    // A working session stays work, and a waiting one wait, whatever else runs.
    expect(characterState(session({ state: 'working', commands: [command()] }), NOW)).toBe('work');
    expect(characterState(session({ state: 'permission', commands: [command()] }), NOW)).toBe('wait');
  });

  it('keeps an idle session idle for a reader, a serving command, a 30-minute-old one, a persistent monitor or an ended one', () => {
    expect(characterState(session({ state: 'idle', subagents: [agent({ agentType: 'Explore' })] }), NOW)).toBe('idle');
    expect(characterState(session({ state: 'idle', commands: [command({ commandHead: 'npm run dev' })] }), NOW)).toBe('idle');
    expect(characterState(session({ state: 'idle', commands: [command({ startedAt: new Date(NOW - 31 * 60_000).toISOString() })] }), NOW)).toBe('idle');
    expect(characterState(session({ state: 'idle', commands: [command({ persistent: true })] }), NOW)).toBe('idle');
    expect(characterState(session({ state: 'idle', commands: [command({ endedAt: new Date(NOW - 1000).toISOString(), outcome: 'completed' })] }), NOW)).toBe('idle');
  });

  it('gives a running subagent work and a stopped one ended', () => {
    expect(characterState(agent(), NOW)).toBe('work');
    expect(characterState(agent({ endedAt: '2026-10-05T11:57:00Z' }), NOW)).toBe('ended');
    expect(characterState({ endedAt: null }, NOW)).toBe('work');
    expect(characterState({ endedAt: '2026-10-05T11:57:00Z' }, NOW)).toBe('ended');
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
