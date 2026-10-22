import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => cp);

describe.runIf(process.platform === 'win32')('openInEditorOrReveal on Windows', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    // A fresh module per test: the Code.exe lookup is cached at module level.
    vi.resetModules();
    cp.spawn.mockReset();
    cp.spawnSync.mockReset();
    cp.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
    cp.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    vi.stubEnv('SystemRoot', 'D:\\Win');
    vi.stubEnv('LOCALAPPDATA', '');
    vi.stubEnv('ProgramFiles', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** A fake VS Code install under a temp LOCALAPPDATA; returns its Code.exe path. */
  function installVsCode(): string {
    const local = mkdtempSync(join(tmpdir(), 'ip-code-'));
    dirs.push(local);
    const dir = join(local, 'Programs', 'Microsoft VS Code');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Code.exe'), '');
    vi.stubEnv('LOCALAPPDATA', local);
    return join(dir, 'Code.exe');
  }

  const launched = () => cp.spawn.mock.calls.map(([file, args]) => [file, args]);

  it('runs system tools by absolute path, looks VS Code up once, and survives a failed spawn', async () => {
    const { openInEditorOrReveal } = await import('../../src/server/open-path');

    await openInEditorOrReveal('C:\\x\\a.md');
    await openInEditorOrReveal('C:\\x\\b.md');

    expect(cp.spawnSync).toHaveBeenCalledOnce();
    // A where.exe that hangs must not hold the event loop for long.
    expect(cp.spawnSync).toHaveBeenCalledWith('D:\\Win\\System32\\where.exe', ['code'], expect.objectContaining({ cwd: 'D:\\Win', timeout: 3000 }));
    expect(launched()).toEqual([
      ['D:\\Win\\explorer.exe', ['/select,C:\\x\\a.md']],
      ['D:\\Win\\explorer.exe', ['/select,C:\\x\\b.md']],
    ]);
    for (const { value: child } of cp.spawn.mock.results) expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow();
  });

  it('looks Code.exe up again after it fails to start', async () => {
    const code = installVsCode();
    const { openInEditorOrReveal } = await import('../../src/server/open-path');

    await openInEditorOrReveal('C:\\x\\a.md');
    cp.spawn.mock.results[0].value.emit('error', new Error('spawn EACCES'));
    await openInEditorOrReveal('C:\\x\\b.md');

    expect(cp.spawnSync).toHaveBeenCalledTimes(2);
    expect(launched()).toEqual([[code, ['C:\\x\\a.md']], [code, ['C:\\x\\b.md']]]);
  });

  it('falls back to Explorer at once when the cached Code.exe is gone', async () => {
    const code = installVsCode();
    const { openInEditorOrReveal } = await import('../../src/server/open-path');

    await openInEditorOrReveal('C:\\x\\a.md');
    rmSync(code);
    await openInEditorOrReveal('C:\\x\\b.md');

    expect(launched()).toEqual([
      [code, ['C:\\x\\a.md']],
      ['D:\\Win\\explorer.exe', ['/select,C:\\x\\b.md']],
    ]);
  });
});

describe.runIf(process.platform === 'win32')('openFolder on Windows', () => {
  beforeEach(() => {
    vi.resetModules();
    cp.spawn.mockReset();
    cp.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    vi.stubEnv('SystemRoot', 'D:\\Win');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('opens the folder in a visible Explorer window', async () => {
    const { openFolder } = await import('../../src/server/open-path');
    await openFolder('C:\\Users\\a\\.inprogress\\backups');
    expect(cp.spawn).toHaveBeenCalledOnce();
    const [file, args, options] = cp.spawn.mock.calls[0];
    expect([file, args]).toEqual(['D:\\Win\\explorer.exe', ['C:\\Users\\a\\.inprogress\\backups']]);
    // windowsHide passes SW_HIDE, and Explorer opens the folder window hidden (#556's walkthrough: nothing appeared).
    expect(options.windowsHide).toBe(false);
  });
});
