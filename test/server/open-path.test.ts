import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => cp);

describe.runIf(process.platform === 'win32')('openInEditorOrReveal on Windows', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('runs system tools by absolute path, looks VS Code up once, and survives a failed spawn', async () => {
    vi.stubEnv('SystemRoot', 'D:\\Win');
    vi.stubEnv('LOCALAPPDATA', '');
    vi.stubEnv('ProgramFiles', '');
    cp.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    cp.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
    const { openInEditorOrReveal } = await import('../../src/server/open-path');

    await openInEditorOrReveal('C:\\x\\a.md');
    await openInEditorOrReveal('C:\\x\\b.md');

    expect(cp.spawnSync).toHaveBeenCalledOnce();
    expect(cp.spawnSync).toHaveBeenCalledWith('D:\\Win\\System32\\where.exe', ['code'], expect.objectContaining({ cwd: 'D:\\Win' }));
    expect(cp.spawn.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['D:\\Win\\explorer.exe', ['/select,C:\\x\\a.md']],
      ['D:\\Win\\explorer.exe', ['/select,C:\\x\\b.md']],
    ]);
    for (const { value: child } of cp.spawn.mock.results) expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow();
  });
});
