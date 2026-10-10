import { describe, expect, it } from 'vitest';
import { COMMAND_WORK_MS, commandLabel, countsAsWork, looksLikeServer, sessionActivity } from '../../src/core/activity';
import type { CommandInfo, SessionState, SubagentInfo } from '../../src/core/types';

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const command = (over: Partial<CommandInfo> = {}): CommandInfo => ({
  taskId: 'b1', kind: 'shell', agentId: '', persistent: false, description: null, commandHead: 'npm run build', nodeId: null,
  startedAt: ago(MIN), endedAt: null, outcome: null, exitCode: null, ...over,
});
const subagent = (over: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId: 'a1', agentType: 'general-purpose', startedAt: ago(MIN), runStartedAt: ago(MIN), description: null, model: null, nodeId: null,
  endedAt: null, ordinal: 1, purpose: null, endReason: null, lastActiveAt: null, ...over,
});
const session = (state: SessionState, subagents: SubagentInfo[] = [], commands: CommandInfo[] = []) => ({ state, subagents, commands });

describe('countsAsWork', () => {
  it('counts a running command', () => expect(countsAsWork(command(), NOW)).toBe(true));
  it('does not count an ended one', () => expect(countsAsWork(command({ endedAt: ago(1) }), NOW)).toBe(false));
  it('does not count a persistent Monitor', () => expect(countsAsWork(command({ kind: 'monitor', persistent: true }), NOW)).toBe(false));
  it('counts one 29:59 old and not one 30:00 old', () => {
    expect(COMMAND_WORK_MS).toBe(30 * MIN);
    expect(countsAsWork(command({ startedAt: ago(30 * MIN - 1000) }), NOW)).toBe(true);
    expect(countsAsWork(command({ startedAt: ago(30 * MIN) }), NOW)).toBe(false);
  });
  it.each(['dev', 'serve', 'preview', 'start', 'watch'])('does not count a head word %s', (word) => {
    expect(countsAsWork(command({ commandHead: `npm run ${word}` }), NOW)).toBe(false);
    expect(countsAsWork(command({ commandHead: word }), NOW)).toBe(false);
  });
  it('does not count test:watch, and counts npm run build and a missing head', () => {
    expect(countsAsWork(command({ commandHead: 'npm run test:watch' }), NOW)).toBe(false);
    expect(countsAsWork(command({ commandHead: 'npm run build' }), NOW)).toBe(true);
    expect(countsAsWork(command({ commandHead: null }), NOW)).toBe(true);
  });
});

describe('looksLikeServer', () => {
  it('matches a whole word or a colon part, not a substring', () => {
    expect(looksLikeServer('npm run dev')).toBe(true);
    expect(looksLikeServer('vite:preview')).toBe(true);
    expect(looksLikeServer('npm run devtools')).toBe(false);
    expect(looksLikeServer(undefined)).toBe(false);
  });
});

describe('sessionActivity', () => {
  it('passes the other stored states through', () => {
    for (const state of ['working', 'permission', 'ended'] as const) expect(sessionActivity(session(state, [subagent()], [command()]), NOW)).toBe(state);
  });
  it('is idle with nothing running', () => expect(sessionActivity(session('idle'), NOW)).toBe('idle'));
  it('is busy with a running subagent', () => expect(sessionActivity(session('idle', [subagent()]), NOW)).toBe('busy'));
  it('is idle with only a running reader', () => expect(sessionActivity(session('idle', [subagent({ agentType: 'Explore' })]), NOW)).toBe('idle'));
  it('is idle with a subagent that ended at the limit', () => {
    expect(sessionActivity(session('idle', [subagent({ endedAt: ago(1), endReason: 'limit' })]), NOW)).toBe('idle');
  });
  it('is busy with a counting command', () => expect(sessionActivity(session('idle', [], [command()]), NOW)).toBe('busy'));
  it('is idle with only a serving command', () => expect(sessionActivity(session('idle', [], [command({ commandHead: 'npm run dev' })]), NOW)).toBe('idle'));
});

describe('commandLabel', () => {
  it('prefers the head', () => expect(commandLabel({ commandHead: 'npm run build', description: 'Build it' })).toBe('npm run build'));
  it('falls back to the description without its leading #id', () => {
    expect(commandLabel({ commandHead: null, description: '#228 Run the e2e suite' })).toBe('Run the e2e suite');
  });
  it('falls back to a generic label', () => expect(commandLabel({ commandHead: null, description: null })).toBe('a background command'));
});
