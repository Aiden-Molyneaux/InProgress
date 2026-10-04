import { describe, expect, it } from 'vitest';
import { formatTaskCounts, parseTasksArgs, TASKS_NOT_RUNNING_HINT, TASKS_TIMEOUT_HINT, TASKS_USAGE } from '../../src/cli/tasks';
import { isTaskAllowRule, repoCli, taskAllowRules, taskCommand, taskPrefix } from '../../src/lib/task-command';

describe('parseTasksArgs', () => {
  it('keeps list order across mixed flags and maps them to statuses', () => {
    expect(parseTasksArgs(['88', '--session', 'abc', '--done', 'Write tests', '--doing', 'Run them', '--todo', 'Report', '--done', 'Plan it'])).toEqual({
      session: 'abc',
      nodeId: 88,
      tasks: [
        { subject: 'Write tests', status: 'completed' },
        { subject: 'Run them', status: 'in_progress' },
        { subject: 'Report', status: 'pending' },
        { subject: 'Plan it', status: 'completed' },
      ],
    });
  });

  it('takes the step with or without #, anywhere among the flags, and leaves it out when absent', () => {
    expect(parseTasksArgs(['#88', '--session', 'abc'])).toEqual({ session: 'abc', nodeId: 88, tasks: [] });
    expect(parseTasksArgs(['--session', 'abc', '--todo', 'x', '88'])).toEqual({ session: 'abc', nodeId: 88, tasks: [{ subject: 'x', status: 'pending' }] });
    expect(parseTasksArgs(['--session', 'abc', '--doing', 'x'])).toEqual({ session: 'abc', tasks: [{ subject: 'x', status: 'in_progress' }] });
  });

  it('reads no task flags as an empty list, which clears it', () => {
    expect(parseTasksArgs(['--session', 'abc'])).toEqual({ session: 'abc', tasks: [] });
  });

  it('trims subjects and the session id', () => {
    expect(parseTasksArgs(['--session', ' abc ', '--done', '  Write tests '])).toEqual({ session: 'abc', tasks: [{ subject: 'Write tests', status: 'completed' }] });
  });

  it.each<[string, string[], RegExp]>([
    ['a missing --session', ['88', '--done', 'x'], /--session/],
    ['--session with no id', ['88', '--session'], /--session/],
    ['an empty --session', ['--session', '  '], /--session/],
    ['--session given twice', ['--session', 'a', '--session', 'b'], /twice/],
    ['a flag with no subject at the end', ['--session', 'abc', '--done'], /--done needs a subject/],
    ['a flag followed by another flag', ['--session', 'abc', '--doing', '--todo', 'x'], /--doing needs a subject/],
    ['a blank subject', ['--session', 'abc', '--todo', '   '], /--todo needs a subject/],
    ['an unknown flag', ['--session', 'abc', '--later', 'x'], /Unknown flag --later/],
    ['a step that is not a number', ['abc', '--session', 's'], /step id/],
    ['a step of zero', ['0', '--session', 's'], /step id/],
    ['two steps', ['88', '89', '--session', 's'], /one step/],
  ])('refuses %s', (_label, args, error) => {
    const parsed = parseTasksArgs(args);
    expect(parsed).toHaveProperty('error');
    expect((parsed as { error: string }).error).toMatch(error);
  });

  it('does not mistake a prototype key for a flag', () => {
    expect(parseTasksArgs(['--session', 'abc', 'toString', 'x'])).toEqual({ error: 'Not a step id: toString' });
  });

  it('takes a subject that starts with --, and reads only a known flag as a missing value', () => {
    expect(parseTasksArgs(['--session', 'abc', '--todo', '--dry-run support', '--done', '--verbose'])).toEqual({
      session: 'abc',
      tasks: [{ subject: '--dry-run support', status: 'pending' }, { subject: '--verbose', status: 'completed' }],
    });
    for (const flag of ['--session', '--done', '--doing', '--todo']) {
      expect(parseTasksArgs(['--session', 'abc', '--todo', flag, 'x']), flag).toEqual({ error: '--todo needs a subject' });
    }
    expect(parseTasksArgs(['--session', '--done', 'x'])).toEqual({ error: '--session needs the session id' });
  });
});

describe('formatTaskCounts', () => {
  it('counts done, in progress and pending, leaving out the zero parts', () => {
    const tasks = (['completed', 'completed', 'in_progress', 'pending'] as const).map((status) => ({ status }));
    expect(formatTaskCounts(88, tasks)).toBe('#88: 2 done · 1 in progress · 1 pending');
    expect(formatTaskCounts(88, [{ status: 'pending' }, { status: 'pending' }])).toBe('#88: 2 pending');
    expect(formatTaskCounts(88, [{ status: 'completed' }, { status: 'pending' }])).toBe('#88: 1 done · 1 pending');
  });

  it('says so when the list is empty', () => {
    expect(formatTaskCounts(88, [])).toBe('#88: no tasks');
  });
});

describe('the tasks command a session runs', () => {
  const cli = 'C:\\personal\\InProgress\\dist\\cli\\main.js';

  it('starts with bare node and the unquoted, forward-slash script path', () => {
    expect(taskPrefix(cli)).toBe('node C:/personal/InProgress/dist/cli/main.js tasks');
    expect(taskPrefix('c:/personal/InProgress/dist/cli/main.js')).toBe('node C:/personal/InProgress/dist/cli/main.js tasks');
  });

  it("prints the session's id, a step placeholder and the three flags", () => {
    expect(taskCommand('abc-123', { cli })).toBe('node C:/personal/InProgress/dist/cli/main.js tasks <step id> --session abc-123 --done "…" --doing "…" --todo "…"');
  });

  it('builds the allow rules from the same prefix, so the printed command matches them byte for byte', () => {
    const rules = taskAllowRules(repoCli('c:\\personal\\InProgress\\'));
    expect(rules).toEqual(['Bash(node C:/personal/InProgress/dist/cli/main.js tasks *)', 'PowerShell(node C:/personal/InProgress/dist/cli/main.js tasks *)']);
    const command = taskCommand('abc', { cli });
    for (const rule of rules) expect(command.startsWith(rule.replace(/^\w+\(/, '').replace(/ \*\)$/, ' '))).toBe(true);
  });

  it('quotes a path with a space so it still runs, and allows nothing for it', () => {
    expect(taskPrefix('C:/My Repos/InProgress/dist/cli/main.js')).toBe('node "C:/My Repos/InProgress/dist/cli/main.js" tasks');
    expect(taskAllowRules(repoCli('C:/My Repos/InProgress'))).toEqual([]);
  });

  it('recognises a tasks rule for any repo path, and nothing else', () => {
    for (const rule of [...taskAllowRules(repoCli('C:/personal/InProgress')), ...taskAllowRules(repoCli('D:/old/checkout'))]) expect(isTaskAllowRule(rule), rule).toBe(true);
    for (const rule of ['mcp__inprogress', 'Bash(git status)', 'Bash(node C:/tools/x.js tasks *)', 'Bash(node C:/x/dist/cli/main.js outline *)', 'Read(node C:/x/dist/cli/main.js tasks *)']) {
      expect(isTaskAllowRule(rule), rule).toBe(false);
    }
  });

  it('never prints "#" in the command, the usage or the hints: an unquoted # starts a comment in Bash and PowerShell', () => {
    expect(taskCommand('abc', { cli })).not.toContain('#');
    expect(TASKS_USAGE).not.toContain('#');
    expect(TASKS_NOT_RUNNING_HINT).not.toContain('#');
    expect(TASKS_TIMEOUT_HINT).not.toContain('#');
  });

  it('says how the server gets started, since this command never starts it, and that a retry after a timeout is safe', () => {
    expect(TASKS_NOT_RUNNING_HINT).toBe('InProgress is not running. A brief to the inprogress-scribe starts it; run this command again after that.');
    expect(TASKS_TIMEOUT_HINT).toMatch(/running this command again is safe, because the list is replaced whole/i);
  });
});
