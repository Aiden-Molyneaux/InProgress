import { describe, expect, it } from 'vitest';
import type { Session, SubagentInfo, WorkItem } from '../../src/core/types';
import { agentLine, chipLabel, circled, elapsed, taskOwner, waitsFor, withoutOwnId } from '../../web/src/live';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const agent = (extra: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId: 'a1', agentType: 'Explore', startedAt: ago(12 * MIN), description: 'Wire up RevenueCat', model: 'sonnet', nodeId: 57, endedAt: null, ...extra,
});
const session = (extra: Partial<Session> = {}): Session => ({
  id: 's1abcdef', projectId: 1, title: 'E2E session', cwd: null, branch: null, transcriptPath: null, state: 'working', focusNodeId: 57,
  promptsSinceUpdate: 0, startedAt: 't', lastSeenAt: 't', endedAt: null, subagents: [], ...extra,
});
const task = (id: number, extra: Partial<WorkItem> = {}): WorkItem => ({
  id, nodeId: 57, sessionId: 's1abcdef', agentId: '', subject: `Task ${id}`, status: 'pending', blocks: [], position: id, updatedAt: 't', ...extra,
});

describe('circled', () => {
  it('writes a queue place as one circled numeral, up to 50', () => {
    expect([1, 2, 3, 20].map(circled)).toEqual(['①', '②', '③', '⑳']);
    expect([21, 35, 36, 50].map(circled)).toEqual(['㉑', '㉟', '㊱', '㊿']);
  });

  it('falls back to brackets past 50', () => {
    expect(circled(51)).toBe('(51)');
  });
});

describe('elapsed', () => {
  it('counts whole minutes, then hours and minutes', () => {
    expect(elapsed(ago(20_000), NOW)).toBe('<1 min');
    expect(elapsed(ago(59_999), NOW)).toBe('<1 min');
    expect(elapsed(ago(MIN), NOW)).toBe('1 min');
    expect(elapsed(ago(12.5 * MIN), NOW)).toBe('12 min');
    expect(elapsed(ago(60 * MIN), NOW)).toBe('1 h');
    expect(elapsed(ago(125 * MIN), NOW)).toBe('2 h 5 min');
  });

  it('reads a start in the future (clock skew) as just started', () => {
    expect(elapsed(ago(-5_000), NOW)).toBe('<1 min');
  });
});

describe('withoutOwnId', () => {
  it('drops a leading #id that names the node the text sits under', () => {
    expect(withoutOwnId('#57 Write the note', 57)).toBe('Write the note');
    expect(withoutOwnId('  #57: Write the note', 57)).toBe('Write the note');
    expect(withoutOwnId('#57 — Write the note', 57)).toBe('Write the note');
  });

  it('keeps any other #id, an #id later on, and a text that is only the #id', () => {
    expect(withoutOwnId('#58 Write the note', 57)).toBe('#58 Write the note');
    expect(withoutOwnId('#570 Write the note', 57)).toBe('#570 Write the note');
    expect(withoutOwnId('Write #57 up', 57)).toBe('Write #57 up');
    expect(withoutOwnId('#57', 57)).toBe('#57');
    expect(withoutOwnId('#57 Write the note', null)).toBe('#57 Write the note');
  });
});

describe('agentLine', () => {
  it('reads description · model · time while it runs', () => {
    expect(agentLine(agent(), NOW)).toBe('Wire up RevenueCat · sonnet · 12 min');
    expect(agentLine(agent({ startedAt: ago(10_000) }), NOW)).toBe('Wire up RevenueCat · sonnet · <1 min');
  });

  it('leaves out a model it does not know, and names an unpaired subagent by its type', () => {
    expect(agentLine(agent({ model: null }), NOW)).toBe('Wire up RevenueCat · 12 min');
    expect(agentLine(agent({ description: null }), NOW)).toBe('Explore · sonnet · 12 min');
    expect(agentLine(agent({ description: '  ' }), NOW)).toBe('Explore · sonnet · 12 min');
  });

  it('says how long ago it finished once it ended', () => {
    expect(agentLine(agent({ endedAt: ago(2 * MIN) }), NOW)).toBe('Wire up RevenueCat · sonnet · done 2 min ago');
    expect(agentLine(agent({ endedAt: ago(10_000) }), NOW)).toBe('Wire up RevenueCat · sonnet · done just now');
  });

  it('drops the #id of the node it is shown under', () => {
    expect(agentLine(agent({ description: '#57 Wire up RevenueCat' }), NOW, 57)).toBe('Wire up RevenueCat · sonnet · 12 min');
    expect(agentLine(agent({ description: '#57 Wire up RevenueCat' }), NOW)).toBe('#57 Wire up RevenueCat · sonnet · 12 min');
  });
});

describe('chipLabel', () => {
  it('counts only the subagents still running', () => {
    expect(chipLabel(session({ subagents: [agent(), agent({ agentId: 'a2', endedAt: ago(MIN) })] }))).toBe('E2E session · 1 subagent');
    expect(chipLabel(session({ subagents: [agent(), agent({ agentId: 'a2' })] }))).toBe('E2E session · 2 subagents');
    expect(chipLabel(session({ subagents: [agent({ endedAt: ago(MIN) })] }))).toBe('E2E session');
  });

  it('adds the state when the session is not working', () => {
    expect(chipLabel(session({ state: 'idle', subagents: [agent()] }))).toBe('E2E session · 1 subagent · idle');
    expect(chipLabel(session({ state: 'permission', title: null }))).toBe('Session s1abcd · needs permission');
  });
});

describe('taskOwner', () => {
  const sessions = [session({ subagents: [agent({ agentId: 'a1', description: '#57 Draft the store notes' })] })];

  it("is the session's title for its own tasks", () => {
    expect(taskOwner(task(1), sessions)).toBe('E2E session');
  });

  it("is the subagent's description for a subagent's task, without its node's #id", () => {
    expect(taskOwner(task(1, { agentId: 'a1' }), sessions)).toBe('Draft the store notes');
    expect(taskOwner(task(1, { agentId: 'a1', nodeId: 58 }), sessions)).toBe('#57 Draft the store notes');
  });

  it('falls back to plain words when the subagent or the session is gone', () => {
    expect(taskOwner(task(1, { agentId: 'gone' }), sessions)).toBe('a subagent');
    expect(taskOwner(task(1, { sessionId: 'gone' }), sessions)).toBe('a session');
  });
});

describe('waitsFor', () => {
  it('lists the open tasks that block a task, in order', () => {
    const first = task(1, { subject: '#57 Upload the key', blocks: [3] });
    const second = task(2, { subject: 'Read the guide', blocks: [3], status: 'in_progress' });
    const third = task(3, { subject: 'Check the track' });
    const finished = task(4, { subject: 'Done already', blocks: [3], status: 'completed' });
    const items = [first, second, third, finished];
    expect(waitsFor(third, items)).toEqual(['Upload the key', 'Read the guide']);
    expect(waitsFor(first, items)).toEqual([]);
  });
});
