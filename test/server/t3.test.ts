import { describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3Timeout, T3Unavailable, execRun, t3CliPath, t3CommandLine, t3List, t3Send, t3Show, t3Start, type T3Run } from '../../src/server/t3';

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
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('Fix  it  & 100 ');
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
    ['bad JSON', async () => 'not json'],
    ['the wrong shape', async () => '{}'],
  ])('throws T3Unavailable on %s', async (_n, run) => {
    await expect(t3Show('mcp:abc', opts(run))).rejects.toBeInstanceOf(T3Unavailable);
    await expect(t3Start('p', 'm', { provider: 'a', model: 'b' }, opts(run))).rejects.toBeInstanceOf(T3Unavailable);
  });

  it('marks a timed out start or send as outcome unknown, and a timed out read as not', async () => {
    const run: T3Run = async () => { throw new T3Timeout('timed out after 60 s'); };
    await expect(t3Start('p', 'm', { provider: 'a', model: 'b' }, opts(run))).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(t3Send('mcp:abc', 'm', opts(run))).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(t3Show('mcp:abc', opts(run))).rejects.toMatchObject({ outcomeUnknown: false });
    const plain: T3Run = async () => { throw new Error('exit 1'); };
    await expect(t3Start('p', 'm', { provider: 'a', model: 'b' }, opts(plain))).rejects.toMatchObject({ outcomeUnknown: false });
  });

  it('marks a start or send that exited 0 with unreadable output as outcome unknown, and a read as not', async () => {
    // The CLI ran to the end, so the thread or the message exists: only what it printed could not be read.
    const garbled: T3Run = async () => 'Sent.';
    await expect(t3Send('mcp:abc', 'm', opts(garbled))).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(t3Start('p', 'm', { provider: 'a', model: 'b' }, opts(garbled))).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(t3Start('p', 'm', { provider: 'a', model: 'b' }, opts(runs({})))).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(t3Show('mcp:abc', opts(garbled))).rejects.toMatchObject({ outcomeUnknown: false });
  });

  it('refuses a CLI path cmd.exe would read, and runs nothing', async () => {
    const run = vi.fn(async () => '[]');
    await expect(t3List('p', { run, cliPath: String.raw`C:\a"b\t3.cmd`, platform: 'win32' })).rejects.toBeInstanceOf(T3Unavailable);
    expect(run).not.toHaveBeenCalled();
  });

  const UNSAFE_CHARS = ['"', '%', '^', '|', '<', '>', '!', '\n', '\u0001'];
  const callers: [string, (v: string, run: T3Run) => Promise<unknown>][] = [
    ['project', (v, run) => t3List(v, opts(run))],
    ['thread id', (v, run) => t3Show(v, opts(run))],
    ['provider', (v, run) => t3Start('p', 'm', { provider: v, model: 'm' }, opts(run))],
    ['model', (v, run) => t3Start('p', 'm', { provider: 'a', model: v }, opts(run))],
    ['worktree', (v, run) => t3Start('p', 'm', { provider: 'a', model: 'm', worktree: v }, opts(run))],
    ['branch', (v, run) => t3Start('p', 'm', { provider: 'a', model: 'm', branch: v }, opts(run))],
  ];
  it.each(callers.flatMap(([name, fn]) => UNSAFE_CHARS.map((c) => [name, c, fn] as const)))('throws TypeError for %s holding %j, and runs nothing', async (_name, c, fn) => {
    const run = vi.fn(async () => '[]');
    await expect(fn('a' + c + 'b', run)).rejects.toBeInstanceOf(TypeError);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(callers)('refuses a leading dash and a closing backslash in %s', async (_name, fn) => {
    const run = vi.fn(async () => '[]');
    await expect(fn('--x', run)).rejects.toBeInstanceOf(TypeError);
    await expect(fn(String.raw`C:\dir` + '\\', run)).rejects.toBeInstanceOf(TypeError);
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts an ampersand in a project and keeps it in a title', async () => {
    const folder = String.raw`C:\R&D\app`;
    const run = runs([]);
    await t3List(folder, opts(run));
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain(folder);
    const start = runs({ threadId: 'mcp:abc' });
    await t3Start('p', 'm', { provider: 'a', model: 'm', title: 'R&D plan' }, opts(start));
    expect((start as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('R&D plan');
  });

  it('strips leading dashes and space from a title, and cuts it by code points', async () => {
    const dash = runs({ threadId: 'mcp:abc' });
    await t3Start('p', 'm', { provider: 'a', model: 'm', title: '--rm  plan' }, opts(dash));
    expect((dash as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('rm  plan');
    const emoji = runs({ threadId: 'mcp:abc' });
    await t3Start('p', 'm', { provider: 'a', model: 'm', title: 'x'.repeat(119) + '\u{1F600}\u{1F600}' }, opts(emoji));
    const argv = (emoji as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const title = argv[argv.indexOf('--title') + 1];
    expect(title).toBe('x'.repeat(119) + '\u{1F600}');
    expect(Array.from(title)).toHaveLength(120);
  });
});

describe('t3CommandLine', () => {
  it('wraps the batch file in cmd.exe on win32', () => {
    const line = t3CommandLine(String.raw`C:\t3.cmd`, ['thread', 'list'], 'win32');
    expect(line.verbatim).toBe(true);
    expect(line.args).toEqual(['/d', '/v:off', '/s', '/c', String.raw`""C:\t3.cmd" "thread" "list""`]);
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

describe('execRun', () => {
  it('rejects with T3Timeout when the time is up and stops the child', async () => {
    const pidFile = join(tmpdir(), `inprogress-t3-timeout-${process.pid}-${Date.now()}.pid`);
    const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
    try {
      await expect(execRun(process.execPath, ['-e', script], { timeoutMs: 5000, verbatim: false })).rejects.toBeInstanceOf(T3Timeout);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      // Signal 0 only asks whether the process exists: it throws once the child is gone.
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 8000, interval: 100 });
    } finally {
      rmSync(pidFile, { force: true });
    }
  }, 20_000);
});
