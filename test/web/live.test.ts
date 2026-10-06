import { describe, expect, it } from 'vitest';
import type { PastSession, Session, SubagentInfo, TrailAgent, WorkItem } from '../../src/core/types';
import { WORDS, agentLine, chipLabel, chipName, circled, elapsed, kinTitle, leadTitle, queueMark, runTime, taskFamily, taskOwner, trailAgentLine, trailLabel, waitsFor, withTag, withoutOwnId, workMark } from '../../web/src/live';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const agent = (extra: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId: 'a1', agentType: 'Explore', startedAt: ago(12 * MIN), description: 'Wire up RevenueCat', model: 'sonnet', nodeId: 57, endedAt: null, ordinal: 1, purpose: null, ...extra,
});
const session = (extra: Partial<Session> = {}): Session => ({
  id: 's1abcdef', projectId: 1, title: 'E2E session', cwd: null, branch: null, transcriptPath: null, state: 'working', focusNodeId: 57,
  promptsSinceUpdate: 0, startedAt: 't', lastSeenAt: 't', endedAt: null, slot: 0, subagents: [], ...extra,
});
const task = (id: number, extra: Partial<WorkItem> = {}): WorkItem => ({
  id, nodeId: 57, sessionId: 's1abcdef', agentId: '', subject: `Task ${id}`, status: 'pending', blocks: [], position: id, updatedAt: 't', endedAt: null, ...extra,
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

describe('queueMark', () => {
  it("leads an owned place with its session's letter, and leaves an unowned one a bare numeral", () => {
    expect(queueMark(1, { slot: 0 })).toBe('A①');
    expect(queueMark(2, { slot: 1 })).toBe('B②');
    expect(queueMark(1, null)).toBe('①');
  });

  it('prints ? for an owner whose slot is still empty', () => {
    expect(queueMark(1, { slot: null })).toBe('?①');
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

  it("names an ended session's task by that session's title, and a subagent's task by the trail once it has left the session's list", () => {
    const pastSessions: PastSession[] = [
      { id: 'old', title: 'Review actions', focusNodeId: 57, endedAt: ago(MIN) },
      { id: 'untitled', title: null, focusNodeId: null, endedAt: ago(MIN) },
    ];
    const trailAgents: TrailAgent[] = [
      { ...agent({ agentId: 'p2', agentType: 'general-purpose', description: '#57 P2 canvas implementer', endedAt: ago(MIN) }), sessionId: 'old' },
      { ...agent({ agentId: 'a9', agentType: 'general-purpose', description: 'Stopped an hour ago', endedAt: ago(60 * MIN) }), sessionId: 's1abcdef' },
    ];
    const owner = (extra: Partial<WorkItem>) => taskOwner(task(1, extra), sessions, pastSessions, trailAgents);
    expect(owner({ sessionId: 'old', endedAt: ago(MIN) })).toBe('Review actions');
    expect(owner({ sessionId: 'untitled', endedAt: ago(MIN) })).toBe('Session untitl');
    expect(owner({ sessionId: 'old', agentId: 'p2', endedAt: ago(MIN) })).toBe('P2 canvas implementer');
    expect(owner({ agentId: 'a9' })).toBe('Stopped an hour ago');
    expect(owner({ sessionId: 'old', agentId: 'gone', endedAt: ago(MIN) })).toBe('a subagent');
  });
});

describe('withTag', () => {
  it('leads a label with its letter or tag, or leaves it bare when there is none', () => {
    expect(withTag('a1', 'Wire up RevenueCat · sonnet · 12 min')).toBe('a1 · Wire up RevenueCat · sonnet · 12 min');
    expect(withTag('A', 'E2E session')).toBe('A · E2E session');
    expect(withTag('', 'E2E session')).toBe('E2E session');
  });
});

describe('taskFamily', () => {
  // Workers: a reader leaves no trail, so a trail number is always a worker's.
  const worker = (extra: Partial<SubagentInfo>) => agent({ agentType: 'general-purpose', ...extra });
  const sessions = [session({ slot: 1, subagents: [worker({ agentId: 'a1', ordinal: 2 }), worker({ agentId: 'old', ordinal: null })] })];

  it("is the live session's slot, with no tag on the session's own tasks", () => {
    expect(taskFamily(task(1), sessions)).toEqual({ slot: 1, tag: '' });
  });

  it("tags a subagent's task with the session's letter and the subagent's number", () => {
    expect(taskFamily(task(1, { agentId: 'a1' }), sessions)).toEqual({ slot: 1, tag: 'b2' });
  });

  it("takes the number from the trail once the subagent has left the session's list, and gives no tag when it is unknown", () => {
    const trailAgents: TrailAgent[] = [{ ...worker({ agentId: 'a9', ordinal: 4, endedAt: ago(60 * MIN) }), sessionId: 's1abcdef' }];
    expect(taskFamily(task(1, { agentId: 'a9' }), sessions, trailAgents)).toEqual({ slot: 1, tag: 'b4' });
    expect(taskFamily(task(1, { agentId: 'old' }), sessions, trailAgents)).toEqual({ slot: 1, tag: '' });
    expect(taskFamily(task(1, { agentId: 'gone' }), sessions, trailAgents)).toEqual({ slot: 1, tag: '' });
  });

  it("is null for an ended session's task: the trail stays neutral", () => {
    expect(taskFamily(task(1, { endedAt: ago(MIN) }), sessions)).toBeNull();
    expect(taskFamily(task(1, { sessionId: 'gone' }), sessions)).toBeNull();
  });
});

describe('workMark', () => {
  it("draws a task an ended session left open as a hollow ○, and keeps a completed one's ✓", () => {
    const statuses: WorkItem['status'][] = ['pending', 'in_progress', 'completed'];
    expect(statuses.map((s) => workMark(s, false))).toEqual(['○', '◐', '✓']);
    expect(statuses.map((s) => workMark(s, true))).toEqual(['○', '○', '✓']);
  });
});

describe('trailLabel', () => {
  it('names the done tasks, the unfinished ones and the agents, leaving out each part that is zero', () => {
    expect(trailLabel({ done: 5, unfinished: 2, agents: 2 })).toBe('✓ 5 done · 2 unfinished · 2 agents');
    expect(trailLabel({ done: 2, unfinished: 0, agents: 0 })).toBe('✓ 2 done');
    expect(trailLabel({ done: 2, unfinished: 1, agents: 0 })).toBe('✓ 2 done · 1 unfinished');
    expect(trailLabel({ done: 3, unfinished: 0, agents: 1 })).toBe('✓ 3 done · 1 agent');
    expect(trailLabel({ done: 0, unfinished: 1, agents: 1 })).toBe('✓ 1 unfinished · 1 agent');
    expect(trailLabel({ done: 0, unfinished: 0, agents: 3 })).toBe('✓ 3 agents');
  });
});

describe('trailAgentLine', () => {
  const stopped = (extra: Partial<SubagentInfo> = {}) => agent({ agentType: 'general-purpose', startedAt: ago(180 * MIN), endedAt: ago(140 * MIN), ...extra });

  it('reads description · model · how long it ran · when it stopped', () => {
    expect(trailAgentLine(stopped(), NOW)).toBe('Wire up RevenueCat · sonnet · ran 40 min · stopped 2 h ago');
    expect(trailAgentLine(stopped({ startedAt: ago(30 * MIN + 10_000), endedAt: ago(30 * MIN) }), NOW)).toBe('Wire up RevenueCat · sonnet · ran <1 min · stopped 30 min ago');
  });

  it("leaves out the #id of the node it is shown under and a model it does not know, and names an unpaired one by its type", () => {
    expect(trailAgentLine(stopped({ description: '#57 Wire up RevenueCat', model: null }), NOW, 57)).toBe('Wire up RevenueCat · ran 40 min · stopped 2 h ago');
    expect(trailAgentLine(stopped({ description: null }), NOW)).toBe('general-purpose · sonnet · ran 40 min · stopped 2 h ago');
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

describe('chipName', () => {
  it('leads the chip label with the session letter', () => {
    expect(chipName(session({ title: "#4 Implement Fable's Notes", state: 'permission' }))).toBe("A · #4 Implement Fable's Notes · needs permission");
    const three = [agent(), agent({ agentId: 'a2' }), agent({ agentId: 'a3' })];
    expect(chipName(session({ slot: 2, title: '#5 UI Session post-Fable', subagents: three }))).toBe('C · #5 UI Session post-Fable · 3 subagents');
    expect(chipName(session({ slot: 1, title: '#2 InProgress Dev Session', state: 'idle' }))).toBe('B · #2 InProgress Dev Session · idle');
  });

  it('is the bare chip label while the slot is empty', () => {
    expect(chipName(session({ slot: null, title: '#2 InProgress Dev Session', state: 'idle' }))).toBe('#2 InProgress Dev Session · idle');
  });
});

describe('leadTitle', () => {
  it('names the letter, the title and the state word, then the running subagents, readers included', () => {
    const three = [agent(), agent({ agentId: 'a2', agentType: 'general-purpose' }), agent({ agentId: 'a3', agentType: 'general-purpose' })];
    expect(leadTitle(session({ slot: 2, title: '#5 UI Session post-Fable', subagents: three }))).toBe('C · #5 UI Session post-Fable · working · 3 subagents');
    expect(leadTitle(session({ state: 'idle' }))).toBe('A · E2E session · idle');
    expect(leadTitle(session({ state: 'permission' }))).toBe('A · E2E session · needs permission');
  });

  it('counts only the subagents still running, and drops the letter while the slot is empty', () => {
    const subagents = [agent(), agent({ agentId: 'a2', endedAt: ago(MIN) })];
    expect(leadTitle(session({ slot: 1, title: 'Second session', subagents }))).toBe('B · Second session · working · 1 subagent');
    expect(leadTitle(session({ slot: null }))).toBe('E2E session · working');
  });

  it('takes its state words from WORDS', () => {
    expect(WORDS).toEqual({ working: 'working', idle: 'idle', permission: 'needs permission', ended: 'ended' });
  });
});

describe('the running subagent count', () => {
  it('reads the same in the chip label and in the lead title, whatever the state', () => {
    const count = (text: string) => / · \d+ subagents?/.exec(text)?.[0] ?? '';
    const cases: [number, string][] = [[0, ''], [1, ' · 1 subagent'], [2, ' · 2 subagents'], [7, ' · 7 subagents']];
    for (const [running, text] of cases) {
      for (const state of ['working', 'idle', 'permission', 'ended'] as const) {
        const subagents = [agent({ agentId: 'gone', endedAt: ago(MIN) }), ...Array.from({ length: running }, (_, i) => agent({ agentId: `r${i}` }))];
        const s = session({ state, subagents });
        expect(count(chipLabel(s))).toBe(text);
        expect(count(leadTitle(s))).toBe(text);
      }
    }
  });
});

describe('kinTitle', () => {
  const kin = (extra: Partial<SubagentInfo> = {}) =>
    agent({ agentType: 'general-purpose', ordinal: 10, description: 'Draft the whiteboard take', model: 'opus-5-5', startedAt: ago(18 * MIN), nodeId: null, ...extra });

  it('is the tagged agent line, then the purpose on a second line', () => {
    const purpose = 'You draft the whiteboard take of the InProgress window.';
    expect(kinTitle(kin({ purpose }), 2, NOW)).toBe(`c10 · Draft the whiteboard take · opus-5-5 · 18 min\n${purpose}`);
  });

  it('says when an ended kin finished, and leaves out a purpose it does not know', () => {
    expect(kinTitle(kin({ ordinal: 11, description: 'Draft the quiet take', endedAt: ago(3 * MIN) }), 2, NOW)).toBe('c11 · Draft the quiet take · opus-5-5 · done 3 min ago');
  });

  it('has no tag while the number is unknown, and drops the #id of the step it sits on', () => {
    expect(kinTitle(kin({ ordinal: null }), 2, NOW)).toBe('Draft the whiteboard take · opus-5-5 · 18 min');
    expect(kinTitle(agent({ description: '#57 Wire up RevenueCat' }), 0, NOW, 57)).toBe('a1 · Wire up RevenueCat · sonnet · 12 min');
  });
});

describe('runTime', () => {
  it('writes the minutes elapsed counts, compact: no spaces, at most five characters', () => {
    const at = [0.5, 18, 59, 60, 65, 165, 599, 600, 725].map((m) => runTime(ago(m * MIN), NOW));
    expect(at).toEqual(['<1m', '18m', '59m', '1h', '1h5m', '2h45m', '9h59m', '10h', '12h']);
    expect(at.every((s) => s.length <= 5 && !s.includes(' '))).toBe(true);
  });

  it('reads a start in the future (clock skew) as just started', () => {
    expect(runTime(ago(-5_000), NOW)).toBe('<1m');
  });

  it("counts the minutes elapsed counts: a kin's '18m' is its tooltip's '18 min'", () => {
    // Hours and minutes from either spelling: '12 h 5 min' (elapsed) and '12h5m' (runTime).
    const parts = (text: string) => (text.startsWith('<') ? { h: 0, m: 0 } : { h: Number(/(\d+) ?h/.exec(text)?.[1] ?? 0), m: Number(/(\d+) ?m/.exec(text)?.[1] ?? 0) });
    for (const minutes of [0.5, 18, 59, 60, 65, 599, 725]) {
      const long = parts(elapsed(ago(minutes * MIN), NOW));
      const short = parts(runTime(ago(minutes * MIN), NOW));
      expect(short.h, `${minutes} min: hours`).toBe(long.h);
      // From 10 h the five-character bound drops the minutes ('12h'); below that they agree to the minute.
      expect(short.m, `${minutes} min: minutes`).toBe(long.h >= 10 ? 0 : long.m);
    }
  });
});
