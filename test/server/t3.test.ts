import { describe, expect, it, vi } from 'vitest';
import { T3Unavailable, t3CliPath, t3CommandLine, t3List, t3Send, t3Show, t3Start, type T3Run } from '../../src/server/t3';

const thread = (extra: Record<string, unknown> = {}) => ({
  threadId: 'mcp:abc',
  projectId: 'p1',
  title: 'A thread',
  link: 't3://thread/mcp:abc',
  status: 'idle',
  runtimeMode: 'full-access',
  ...extra,
});
const runs = (out: unknown): T3Run => vi.fn(async () => (typeof out === 'string' ? out : JSON.stringify(out)));
const opts = (run: T3Run) => ({ run, cliPath: '/bin/t3', platform: 'linux' as const });

describe('t3Show', () => {
  it('parses a thread and its messages', async () => {
    const run = runs({ thread: thread({ settled: true }), messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello', extra: 1 }] });
    const shown = await t3Show('mcp:abc', opts(run));
    expect(shown.thread).toMatchObject({ threadId: 'mcp:abc', settled: true, archived: false, pendingRequestCount: 0, updatedAt: '', createdBy: '', creationSource: '' });
    expect(shown.messages).toEqual([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }]);
    expect(run).toHaveBeenCalledWith('/bin/t3', ['thread', 'show', 'mcp:abc', '--json'], expect.objectContaining({ timeoutMs: 30_000, verbatim: false }));
  });
});

describe('t3List', () => {
  it('parses a list and fills the defaults', async () => {
    const run = runs([thread(), thread({ threadId: 'mcp:def', settled: true })]);
    const list = await t3List('proj', opts(run));
    expect(list.map((t) => t.threadId)).toEqual(['mcp:abc', 'mcp:def']);
    expect(list[0].settled).toBe(false);
    expect(list[1].settled).toBe(true);
    expect(run).toHaveBeenCalledWith('/bin/t3', ['thread', 'list', '--project', 'proj', '--json'], expect.anything());
  });
  it('refuses an empty project and runs nothing', async () => {
    const run = runs([]);
    await expect(t3List('', opts(run))).rejects.toThrow(TypeError);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('t3Start and t3Send', () => {
  it('returns the thread id, sends the message on stdin and names provider and model', async () => {
    const run = runs({ threadId: 'mcp:abc' });
    await expect(t3Start('proj', 'do the thing', { provider: 'claudeAgent', model: 'opus', title: 'T', worktree: 'w', branch: 'b' }, opts(run))).resolves.toEqual({ threadId: 'mcp:abc' });
    expect(run).toHaveBeenCalledWith(
      '/bin/t3',
      ['thread', 'start', 'proj', '-', '--provider', 'claudeAgent', '--model', 'opus', '--title', 'T', '--worktree', 'w', '--branch', 'b', '--json'],
      { timeoutMs: 60_000, input: 'do the thing', verbatim: false },
    );
  });
  it('sends to a thread with the message on stdin', async () => {
    const run = runs({});
    await t3Send('mcp:abc', 'more', opts(run));
    expect(run).toHaveBeenCalledWith('/bin/t3', ['thread', 'send', 'mcp:abc', '-', '--json'], { timeoutMs: 60_000, input: 'more', verbatim: false });
  });
  it('cleans a title: bad characters become spaces, cut to 120', async () => {
    const run = runs({ threadId: 'mcp:abc' });
    await t3Start('proj', 'm', { provider: 'p', model: 'm', title: 'Fix "it" & 100%' }, opts(run));
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('Fix  it    100 ');
    const long = runs({ threadId: 'mcp:abc' });
    await t3Start('proj', 'm', { provider: 'p', model: 'm', title: 'x'.repeat(200) }, opts(long));
    expect((long as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('x'.repeat(120));
    // A closing backslash would escape the quote after it; a title of nothing but bad characters is left out.
    const slash = runs({ threadId: 'mcp:abc' });
    await t3Start('proj', 'm', { provider: 'p', model: 'm', title: 'C:\\dir\\' }, opts(slash));
    expect((slash as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('C:\\dir');
    const blank = runs({ threadId: 'mcp:abc' });
    await t3Start('proj', 'm', { provider: 'p', model: 'm', title: '"""' }, opts(blank));
    expect((blank as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toContain('--title');
    await expect(t3Start('C:\\dir\\', 'm', { provider: 'p', model: 'm' }, opts(blank))).rejects.toThrow(TypeError);
  });
});

describe('failures', () => {
  it.each<[string, T3Run]>([
    ['a rejecting runner', async () => { throw new Error('ENOENT'); }],
    ['a timeout', async () => { throw new Error('timed out after 10 s'); }],
    ['bad JSON', async () => 'not json'],
    ['the wrong shape', async () => '{}'],
  ])('throws T3Unavailable on %s', async (_n, run) => {
    await expect(t3Show('mcp:abc', opts(run))).rejects.toBeInstanceOf(T3Unavailable);
    await expect(t3Start('p', 'm', { provider: 'a', model: 'b' }, opts(run))).rejects.toBeInstanceOf(T3Unavailable);
  });

  it('throws TypeError for an argument the shell would read, and runs nothing', async () => {
    const run = vi.fn(async () => '[]');
    await expect(t3List('C:\a"&calc', opts(run))).rejects.toBeInstanceOf(TypeError);
    await expect(t3Show('a\nb', opts(run))).rejects.toBeInstanceOf(TypeError);
    await expect(t3Start('p', 'm', { provider: 'a|b', model: 'm' }, opts(run))).rejects.toBeInstanceOf(TypeError);
    await expect(t3Send('a%b', 'm', opts(run))).rejects.toBeInstanceOf(TypeError);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('t3CommandLine', () => {
  it('wraps the batch file in cmd.exe on win32', () => {
    const line = t3CommandLine('C:\t3.cmd', ['thread', 'list'], 'win32');
    expect(line.verbatim).toBe(true);
    expect(line.args).toEqual(['/d', '/s', '/c', '""C:\t3.cmd" "thread" "list""']);
    expect(line.file.toLowerCase()).toMatch(/cmd(\.exe)?$/);
  });
  it('leaves the args alone elsewhere', () => {
    expect(t3CommandLine('/bin/t3', ['a'], 'linux')).toEqual({ file: '/bin/t3', args: ['a'], verbatim: false });
  });
});

describe('t3CliPath', () => {
  it('prefers T3CODE_CLI_PATH', () => {
    expect(t3CliPath({ T3CODE_CLI_PATH: '/x/t3' })).toBe('/x/t3');
    expect(t3CliPath({})).toMatch(/\.t3[\\/]bin[\\/]t3(\.cmd)?$/);
  });
});
