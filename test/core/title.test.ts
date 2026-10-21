import { describe, expect, it } from 'vitest';
import { expectedPrefix, prefixReason, splitPrefix, withPrefix } from '../../src/core/title';
import type { Ask, CommandInfo, Session, SubagentInfo, TreeNode } from '../../src/core/types';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const T = '2026-10-20T11:00:00.000Z';
const MINS = (m: number) => new Date(NOW - m * 60_000).toISOString();

function n(id: number, o: Partial<TreeNode> = {}): TreeNode {
  return { id, projectId: 1, parentId: null, position: id, kind: 'task', title: `S${id}`, body: '', status: 'active', assignee: 'claude', outcome: '', label: null, createdAt: T, updatedAt: T, completedAt: null, driverSessionId: null, boardState: null, stateSince: null, hue: null, parkedReason: '', parkedWhere: '', parkedAt: null, ...o };
}
function s(o: Partial<Session> = {}): Session {
  return { id: 'sess', projectId: 1, title: null, cwd: null, branch: null, transcriptPath: null, state: 'idle', focusNodeId: 12, promptsSinceUpdate: 0, startedAt: T, lastSeenAt: T, lastPromptAt: null, endedAt: null, slot: 0, subagents: [], commands: [], role: 'worker', ...o } as Session;
}
function ask(id: number, o: Partial<Ask> = {}): Ask {
  return { id, projectId: 1, nodeId: 12, kind: 'question', text: 'Q', sessionId: 'sess', raisedAt: T, clearedAt: null, clearedBy: null, answer: '', answerDeliveredAt: null, ...o };
}
const agent = (o: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId: 'x1', agentType: 'general-purpose', startedAt: MINS(1), runStartedAt: MINS(1), description: null, model: null, nodeId: null,
  endedAt: null, ordinal: 1, purpose: null, endReason: null, lastActiveAt: null, ...o,
});
const command = (o: Partial<CommandInfo> = {}): CommandInfo => ({
  taskId: 'b1', kind: 'shell', agentId: '', persistent: false, description: null, commandHead: 'npm test', nodeId: null,
  startedAt: MINS(1), endedAt: null, outcome: null, exitCode: null, ...o,
});
const snap = (status: TreeNode['status'], asks: Ask[] = []) => ({ nodes: [n(1), n(12, { status })], asks });

describe('splitPrefix', () => {
  it('reads a leading prefix word', () => {
    expect(splitPrefix('DONE #455 Sigmund title status')).toEqual({ prefix: 'DONE', rest: '#455 Sigmund title status' });
    expect(splitPrefix('BLOCKED   #12 x')).toEqual({ prefix: 'BLOCKED', rest: '#12 x' });
    expect(splitPrefix('DONE')).toEqual({ prefix: 'DONE', rest: '' });
    expect(splitPrefix('PARKED #7 Later')).toEqual({ prefix: 'PARKED', rest: '#7 Later' });
  });
  it('leaves ordinary words alone', () => {
    expect(splitPrefix('Review and clean up staging')).toEqual({ prefix: null, rest: 'Review and clean up staging' });
    expect(splitPrefix('DONEish work')).toEqual({ prefix: null, rest: 'DONEish work' });
    expect(splitPrefix('done #12 x')).toEqual({ prefix: null, rest: 'done #12 x' });
    expect(splitPrefix('')).toEqual({ prefix: null, rest: '' });
  });
});

describe('withPrefix', () => {
  it('rebuilds a title', () => {
    expect(withPrefix('#12 x', 'REVIEW')).toBe('REVIEW #12 x');
    expect(withPrefix('#12 x', null)).toBe('#12 x');
    expect(withPrefix('', 'DONE')).toBe('DONE');
  });
});

describe('expectedPrefix', () => {
  it('is DONE when the focus step is done, whatever else is true', () => {
    const sess = s({ subagents: [agent()] });
    expect(expectedPrefix(sess, snap('done', [ask(1, { kind: 'review' }), ask(2)]), NOW)).toBe('DONE');
  });
  it('is PARKED when the focus step is parked, before its asks and its work', () => {
    expect(expectedPrefix(s({ subagents: [agent()] }), snap('parked', [ask(1, { kind: 'question' })]), NOW)).toBe('PARKED');
  });
  it('is BLOCKED before REVIEW when both asks are open', () => {
    expect(expectedPrefix(s(), snap('active', [ask(1, { kind: 'review' }), ask(2, { kind: 'permission' })]), NOW)).toBe('BLOCKED');
    expect(expectedPrefix(s(), snap('active', [ask(1, { kind: 'question' })]), NOW)).toBe('BLOCKED');
  });
  it('is REVIEW for an open review ask this session raised', () => {
    expect(expectedPrefix(s(), snap('active', [ask(1, { kind: 'review' })]), NOW)).toBe('REVIEW');
  });
  it('ignores asks another session raised, asks already cleared, and asks on another step', () => {
    const asks = [ask(1, { sessionId: 'other' }), ask(2, { sessionId: null }), ask(3, { clearedAt: T }), ask(4, { nodeId: 1 })];
    expect(expectedPrefix(s(), snap('active', asks), NOW)).toBeNull();
  });
  it('is RUNNING when a non-reader subagent or a counted command is live', () => {
    expect(expectedPrefix(s({ subagents: [agent()] }), snap('active'), NOW)).toBe('RUNNING');
    expect(expectedPrefix(s({ commands: [command()] }), snap('active'), NOW)).toBe('RUNNING');
  });
  it('does not count a reader subagent, a persistent monitor, a server, an ended or an old command', () => {
    expect(expectedPrefix(s({ subagents: [agent({ agentType: 'Explore' })] }), snap('active'), NOW)).toBeNull();
    expect(expectedPrefix(s({ subagents: [agent({ endedAt: MINS(1) })] }), snap('active'), NOW)).toBeNull();
    expect(expectedPrefix(s({ commands: [command({ kind: 'monitor', persistent: true })] }), snap('active'), NOW)).toBeNull();
    expect(expectedPrefix(s({ commands: [command({ commandHead: 'npm run dev' })] }), snap('active'), NOW)).toBeNull();
    expect(expectedPrefix(s({ commands: [command({ endedAt: MINS(1) })] }), snap('active'), NOW)).toBeNull();
    expect(expectedPrefix(s({ commands: [command({ startedAt: MINS(31) })] }), snap('active'), NOW)).toBeNull();
  });
  it('is not RUNNING while the session itself is working', () => {
    expect(expectedPrefix(s({ state: 'working', subagents: [agent()] }), snap('active'), NOW)).toBeNull();
  });
  it('is null for an idle session with no focus', () => {
    expect(expectedPrefix(s({ focusNodeId: null }), snap('active'), NOW)).toBeNull();
  });
  it('with no focus step, reads only running work, never asks', () => {
    const nodes = { nodes: [n(1)], asks: [ask(1, { nodeId: 1, kind: 'review' })] };
    expect(expectedPrefix(s({ focusNodeId: null }), nodes, NOW)).toBeNull();
    expect(expectedPrefix(s({ focusNodeId: null, subagents: [agent()] }), nodes, NOW)).toBe('RUNNING');
    expect(expectedPrefix(s({ focusNodeId: 99, subagents: [agent()] }), nodes, NOW)).toBe('RUNNING');
  });
});

describe('prefixReason', () => {
  it('names the step', () => {
    expect(prefixReason('DONE', 12)).toBe('#12 is done');
    expect(prefixReason('PARKED', 12)).toBe('#12 is parked');
    expect(prefixReason('BLOCKED', 12)).toBe('an ask on #12 waits on Aiden');
    expect(prefixReason('REVIEW', 12)).toBe('a review on #12 waits on Aiden');
    expect(prefixReason('RUNNING', 12)).toBe('background work is still running');
    expect(prefixReason(null, null)).toBe('nothing is running or waiting');
  });
});
