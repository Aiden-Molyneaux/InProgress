import { describe, expect, it } from 'vitest';
import type { CommandInfo, PastSession, Session, SubagentInfo, TrailAgent, WorkItem } from '../../src/core/types';
import { END_WORDS, WORDS, agentLine, agentLineParts, chipLabel, circled, commandEnded, commandLineParts, commandMark, commandWhen, commandsSuffix, elapsed, leadTitle, runTime, taskOwner, trailAgentLine, trailAgentParts, trailLabel, waitsFor, withoutOwnId, workMark } from '../../web/src/live';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const agent = (extra: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId: 'a1', agentType: 'Explore', startedAt: ago(12 * MIN), runStartedAt: ago(12 * MIN), description: 'Wire up RevenueCat', model: 'sonnet', nodeId: 57, endedAt: null, ordinal: 1, purpose: null, endReason: null, lastActiveAt: null, ...extra,
});
const session = (extra: Partial<Session> = {}): Session => ({
  id: 's1abcdef', projectId: 1, title: 'E2E session', cwd: null, branch: null, transcriptPath: null, state: 'working', focusNodeId: 57,
  promptsSinceUpdate: 0, startedAt: 't', lastSeenAt: 't', lastPromptAt: null, endedAt: null, slot: 0, role: 'worker', subagents: [], commands: [], ...extra,
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
    expect(withoutOwnId('#57 \u2014 Write the note', 57)).toBe('Write the note');
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
    expect(agentLine(agent({ startedAt: ago(10_000), runStartedAt: ago(10_000) }), NOW)).toBe('Wire up RevenueCat · sonnet · <1 min');
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

  it('says why and how long ago it last showed life when it ended without a stop, and asks for a resume at the usage limit', () => {
    const dead = (endReason: SubagentInfo['endReason'], lastActive = 3 * MIN) => agent({ endedAt: ago(MIN), endReason, lastActiveAt: ago(lastActive) });
    expect(agentLine(dead('limit'), NOW)).toBe('Wire up RevenueCat · sonnet · hit the usage limit 3 min ago · resume after the reset');
    expect(agentLine(dead('error'), NOW)).toBe('Wire up RevenueCat · sonnet · hit an API error 3 min ago');
    expect(agentLine(dead('killed'), NOW)).toBe('Wire up RevenueCat · sonnet · was stopped 3 min ago');
    expect(agentLine(dead('silent', 21 * MIN), NOW)).toBe('Wire up RevenueCat · sonnet · stopped responding 21 min ago');
    // A session's end has no last sign of life of its own: it counts from the end.
    expect(agentLine(agent({ endedAt: ago(3 * MIN), endReason: 'session' }), NOW)).toBe('Wire up RevenueCat · sonnet · ended with its session 3 min ago');
  });

  it('splits into who it is and what it is doing, which agentLine joins with a dot', () => {
    expect(agentLineParts(agent(), NOW)).toEqual({ who: 'Wire up RevenueCat · sonnet', when: '12 min' });
    expect(agentLineParts(agent({ model: null, endedAt: ago(MIN), endReason: 'limit', lastActiveAt: ago(3 * MIN) }), NOW)).toEqual({
      who: 'Wire up RevenueCat',
      when: 'hit the usage limit 3 min ago · resume after the reset',
    });
  });

  it('drops the #id of the node it is shown under', () => {
    expect(agentLine(agent({ description: '#57 Wire up RevenueCat' }), NOW, 57)).toBe('Wire up RevenueCat · sonnet · 12 min');
    expect(agentLine(agent({ description: '#57 Wire up RevenueCat' }), NOW)).toBe('#57 Wire up RevenueCat · sonnet · 12 min');
  });
});

describe('chipLabel', () => {
  it('counts only the subagents still running', () => {
    expect(chipLabel(session({ subagents: [agent(), agent({ agentId: 'a2', endedAt: ago(MIN) })] }), NOW)).toBe('E2E session · 1 subagent');
    expect(chipLabel(session({ subagents: [agent(), agent({ agentId: 'a2' })] }), NOW)).toBe('E2E session · 2 subagents');
    expect(chipLabel(session({ subagents: [agent({ endedAt: ago(MIN) })] }), NOW)).toBe('E2E session');
  });

  it('adds the state when the session is not working', () => {
    expect(chipLabel(session({ state: 'idle', subagents: [agent()] }), NOW)).toBe('E2E session · 1 subagent · idle');
    expect(chipLabel(session({ state: 'permission', title: null }), NOW)).toBe('Session s1abcd · needs permission');
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
      { id: 'old', title: 'Review actions', focusNodeId: 57, startedAt: ago(2 * MIN), endedAt: ago(MIN) },
      { id: 'untitled', title: null, focusNodeId: null, startedAt: ago(2 * MIN), endedAt: ago(MIN) },
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

  it('says why it ended when it ended without a stop, and runs to its last sign of life, not to when that was noticed', () => {
    const dead = (endReason: SubagentInfo['endReason'], ranMin: number, lastActiveMin: number) =>
      stopped({ startedAt: ago((lastActiveMin + ranMin) * MIN), lastActiveAt: ago(lastActiveMin * MIN), endedAt: ago((lastActiveMin - 1) * MIN), endReason });
    expect(trailAgentLine(dead('limit', 22, 600), NOW)).toBe('Wire up RevenueCat · sonnet · ran 22 min · hit the usage limit 10 h ago');
    expect(trailAgentLine(dead('error', 22, 600), NOW)).toBe('Wire up RevenueCat · sonnet · ran 22 min · hit an API error 10 h ago');
    expect(trailAgentLine(dead('killed', 9, 23 * 60), NOW)).toBe('Wire up RevenueCat · sonnet · ran 9 min · was stopped 23 h ago');
    expect(trailAgentLine(dead('silent', 65, 120), NOW)).toBe('Wire up RevenueCat · sonnet · ran 1 h 5 min · stopped responding 2 h ago');
    expect(trailAgentLine(stopped({ startedAt: ago(240 * MIN), endedAt: ago(60 * MIN), endReason: 'session' }), NOW)).toBe('Wire up RevenueCat · sonnet · ran 3 h · ended with its session 1 h ago');
  });

  it('splits into who it is and how it ran, which trailAgentLine joins with a dot', () => {
    expect(trailAgentParts(stopped(), NOW)).toEqual({ who: 'Wire up RevenueCat · sonnet', when: 'ran 40 min · stopped 2 h ago' });
    expect(Object.keys(END_WORDS).sort()).toEqual(['error', 'killed', 'limit', 'session', 'silent']);
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

describe('leadTitle', () => {
  it('names the title and the state word, then the running subagents, readers included', () => {
    const three = [agent(), agent({ agentId: 'a2', agentType: 'general-purpose' }), agent({ agentId: 'a3', agentType: 'general-purpose' })];
    expect(leadTitle(session({ slot: 2, title: '#5 UI Session post-Fable', subagents: three }), NOW)).toBe('#5 UI Session post-Fable · working · 3 subagents');
    expect(leadTitle(session({ state: 'idle' }), NOW)).toBe('E2E session · idle');
    expect(leadTitle(session({ state: 'permission' }), NOW)).toBe('E2E session · needs permission');
  });

  it('counts only the subagents still running, and needs no slot', () => {
    const subagents = [agent(), agent({ agentId: 'a2', endedAt: ago(MIN) })];
    expect(leadTitle(session({ slot: 1, title: 'Second session', subagents }), NOW)).toBe('Second session · working · 1 subagent');
    expect(leadTitle(session({ slot: null }), NOW)).toBe('E2E session · working');
  });

  it('takes its state words from WORDS', () => {
    expect(WORDS).toEqual({ working: 'working', busy: 'busy', idle: 'idle', permission: 'needs permission', ended: 'ended' });
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
        expect(count(chipLabel(s, NOW))).toBe(text);
        expect(count(leadTitle(s, NOW))).toBe(text);
      }
    }
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

const command = (extra: Partial<CommandInfo> = {}): CommandInfo => ({
  taskId: 'b1', kind: 'shell', agentId: '', persistent: false, description: 'Run the e2e suite', commandHead: 'npm run test:e2e', nodeId: 57,
  startedAt: ago(12 * MIN), endedAt: null, outcome: null, exitCode: null, ...extra,
});
const ended = (extra: Partial<CommandInfo> = {}) => command({ endedAt: ago(2 * MIN), outcome: 'completed', exitCode: 0, ...extra });

describe('busy words', () => {
  const worker = agent({ agentType: 'general-purpose' });

  it('reads busy in the chip label and the lead title, after the counts', () => {
    const s = session({ state: 'idle', slot: 0, subagents: [worker], commands: [command(), command({ taskId: 'b2' })] });
    expect(chipLabel(s, NOW)).toBe('E2E session · 1 subagent · 2 commands · busy');
    expect(leadTitle(s, NOW)).toBe('E2E session · busy · 1 subagent · 2 commands');
  });

  it('says command in the singular for one, and names nothing when none counts', () => {
    expect(commandsSuffix(session({ state: 'idle', commands: [command()] }), NOW)).toBe(' · 1 command');
    expect(commandsSuffix(session({ commands: [] }), NOW)).toBe('');
  });

  it('does not count serving, persistent, 30-minute-old or ended commands', () => {
    const commands = [
      command({ commandHead: 'npm run dev' }),
      command({ taskId: 'b2', persistent: true }),
      command({ taskId: 'b3', startedAt: ago(31 * MIN) }),
      ended({ taskId: 'b4' }),
      command({ taskId: 'b5' }),
    ];
    expect(commandsSuffix(session({ state: 'idle', commands }), NOW)).toBe(' · 1 command');
    expect(chipLabel(session({ state: 'idle', commands: commands.slice(0, 4) }), NOW)).toBe('E2E session · idle');
    expect(leadTitle(session({ state: 'idle', commands: commands.slice(0, 4) }), NOW)).toBe('E2E session · idle');
  });

  it('keeps a working session working with its commands counted', () => {
    expect(chipLabel(session({ commands: [command()] }), NOW)).toBe('E2E session · 1 command');
  });
});

describe('a resumed subagent', () => {
  it('counts its run time from runStartedAt, in the line parts and the line', () => {
    const resumed = agent({ startedAt: ago(90 * MIN), runStartedAt: ago(3 * MIN) });
    expect(agentLineParts(resumed, NOW).when).toBe('3 min');
    expect(agentLine(resumed, NOW)).toBe('Wire up RevenueCat · sonnet · 3 min');
  });

  it('keeps the trail ran span from startedAt', () => {
    const resumed = agent({ startedAt: ago(90 * MIN), runStartedAt: ago(3 * MIN), endedAt: ago(MIN) });
    expect(trailAgentParts(resumed, NOW).when).toBe('ran 1 h 29 min · stopped 1 min ago');
  });
});

describe('commandEnded', () => {
  it('says how each outcome ended, with the exit code for completed and failed, then how long ago', () => {
    expect(commandEnded(ended(), NOW)).toBe('completed (exit 0) 2 min ago');
    expect(commandEnded(ended({ outcome: 'failed', exitCode: 2 }), NOW)).toBe('failed (exit 2) 2 min ago');
    expect(commandEnded(ended({ exitCode: null }), NOW)).toBe('completed 2 min ago');
    expect(commandEnded(ended({ outcome: 'killed', exitCode: 137 }), NOW)).toBe('was stopped 2 min ago');
    expect(commandEnded(ended({ outcome: 'session', exitCode: null }), NOW)).toBe('ended with its session 2 min ago');
    expect(commandEnded(ended({ outcome: 'unknown', exitCode: null }), NOW)).toBe('ended 2 min ago');
    expect(commandEnded(ended({ outcome: null, exitCode: null }), NOW)).toBe('ended 2 min ago');
  });
});

describe('commandWhen and commandMark', () => {
  it('reads the run time of a counting command, serving and the time of a server, and the end of an ended one', () => {
    expect(commandWhen(command(), NOW)).toBe('12m');
    expect(commandMark(command(), NOW)).toBe('▸');
    expect(commandWhen(command({ commandHead: 'npm run dev', startedAt: ago(180 * MIN) }), NOW)).toBe('serving 3h');
    expect(commandMark(command({ commandHead: 'npm run dev' }), NOW)).toBe('◦');
    expect(commandWhen(ended(), NOW)).toBe('completed (exit 0) 2 min ago');
    expect(commandMark(ended(), NOW)).toBe('✓');
    expect(commandMark(ended({ outcome: 'failed', exitCode: 1 }), NOW)).toBe('!');
  });
});

describe('commandLineParts', () => {
  it('reads one running command: mark, head and run time', () => {
    const parts = commandLineParts([command()], NOW);
    expect(parts).toMatchObject({ mark: '▸', label: 'npm run test:e2e', when: '12m', serving: false, ended: false });
    expect(parts.title).toBe('npm run test:e2e · Run the e2e suite · 12m');
  });

  it('adds +n for the other running commands and leads with the first one that counts', () => {
    const commands = [
      command({ taskId: 'b0', commandHead: 'npm run dev', startedAt: ago(180 * MIN) }),
      command({ taskId: 'b1', commandHead: 'tsc', description: null }),
      command({ taskId: 'b2', commandHead: 'vitest' }),
      ended({ taskId: 'b3' }),
    ];
    const parts = commandLineParts(commands, NOW);
    expect(parts).toMatchObject({ mark: '▸', label: 'tsc +2', when: '12m', serving: false, ended: false });
    expect(parts.title.split('\n')).toEqual([
      'npm run dev · Run the e2e suite · serving 3h',
      'tsc · 12m',
      'vitest · Run the e2e suite · 12m',
      'npm run test:e2e · Run the e2e suite · completed (exit 0) 2 min ago',
    ]);
  });

  it('leads with a serving command when nothing running counts: a hollow mark and serving', () => {
    const parts = commandLineParts([command({ commandHead: 'npm run dev', startedAt: ago(180 * MIN) })], NOW);
    expect(parts).toMatchObject({ mark: '◦', label: 'npm run dev', when: 'serving 3h', serving: true, ended: false });
  });

  it('reads a check when every command completed, a bang when any did not, and has no time', () => {
    const done = commandLineParts([ended(), ended({ taskId: 'b2', commandHead: 'tsc' })], NOW);
    expect(done).toMatchObject({ mark: '✓', label: 'npm run test:e2e +1', when: '', ended: true, serving: false });
    for (const outcome of ['failed', 'killed', 'unknown', 'session'] as const) {
      expect(commandLineParts([ended(), ended({ taskId: 'b2', outcome })], NOW).mark, outcome).toBe('!');
    }
  });

  it('names a head-less command by its description with a leading #id dropped, and does not repeat it in the title', () => {
    const parts = commandLineParts([command({ commandHead: null, description: '#57 Run the suite' })], NOW);
    expect(parts.label).toBe('Run the suite');
    expect(parts.title).toBe('Run the suite · 12m');
  });
});
