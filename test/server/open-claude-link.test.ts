import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { findClaudeHandler, forgetClaudeHandler, openClaudeLink, parseHandlerCommand } from '../../src/server/open-path';

const LINK = 'claude://claude.ai/epitaxy/local_83cd7f8d-e5cb-414e-a3c9-a6e6e9fd1213';
const EXE = 'C:\\Program Files\\WindowsApps\\Claude_2.42304.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe';

const DIR = mkdtempSync(join(tmpdir(), 'ip-claude-link-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(forgetClaudeHandler);

/** `reg query <key> /ve` as Windows prints it. */
const regOutput = (type: string, command: string, label = '(Default)') => `\r\nHKEY_CURRENT_USER\\Software\\Classes\\claude\\shell\\open\\command\r\n    ${label}    ${type}    ${command}\r\n\r\n`;

describe('parseHandlerCommand', () => {
  it('reads the program and its arguments from the default value, whatever the label is called', () => {
    expect(parseHandlerCommand(regOutput('REG_SZ', `"${EXE}" "%1"`))).toEqual({ file: EXE, args: ['%1'] });
    expect(parseHandlerCommand(regOutput('REG_SZ', `"${EXE}" --protocol-launcher "%1"`, '(Standard)'))).toEqual({ file: EXE, args: ['--protocol-launcher', '%1'] });
    expect(parseHandlerCommand(regOutput('REG_EXPAND_SZ', 'C:\\Apps\\Claude.exe %1'))).toEqual({ file: 'C:\\Apps\\Claude.exe', args: ['%1'] });
  });

  it('refuses a command it cannot run as it stands: no value, a relative or non-.exe program, or one with %VARS% to expand', () => {
    expect(parseHandlerCommand('')).toBeUndefined();
    expect(parseHandlerCommand('ERROR: The system was unable to find the specified registry key or value.')).toBeUndefined();
    expect(parseHandlerCommand(regOutput('REG_SZ', '"Claude.exe" "%1"'))).toBeUndefined();
    expect(parseHandlerCommand(regOutput('REG_SZ', '"C:\\Apps\\claude.cmd" "%1"'))).toBeUndefined();
    expect(parseHandlerCommand(regOutput('REG_EXPAND_SZ', '"%LOCALAPPDATA%\\AnthropicClaude\\Claude.exe" "%1"'))).toBeUndefined();
  });
});

describe('openClaudeLink', () => {
  // #473: explorer.exe took 4.0 to 6.9 s to switch the session; the handler's own Claude.exe, started directly, 1.8 to 3.5 s.
  it("starts the claude: handler's program directly with the link in place of %1, without explorer.exe", async () => {
    const start = vi.fn(async () => {});
    const fallback = vi.fn(async () => {});
    await openClaudeLink(LINK, { findHandler: () => ({ file: EXE, args: ['--protocol-launcher', '%1'] }), start, fallback });
    expect(start).toHaveBeenCalledWith(EXE, ['--protocol-launcher', LINK]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('adds the link at the end when the command has no %1', async () => {
    const start = vi.fn(async () => {});
    await openClaudeLink(LINK, { findHandler: () => ({ file: EXE, args: [] }), start, fallback: vi.fn() });
    expect(start).toHaveBeenCalledWith(EXE, [LINK]);
  });

  it('hands the link to the system opener when there is no handler to start, or it will not start, and forgets a handler that failed', async () => {
    const fallback = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    await openClaudeLink(LINK, { findHandler: () => undefined, start, fallback });
    expect(start).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(LINK);

    const exe = join(DIR, 'Claude.exe');
    writeFileSync(exe, '');
    const lookup = vi.fn(() => ({ file: exe, args: ['%1'] }));
    expect(findClaudeHandler(lookup)).toEqual({ file: exe, args: ['%1'] });
    const failing = vi.fn(async () => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    });
    await openClaudeLink(LINK, { findHandler: () => findClaudeHandler(lookup), start: failing, fallback });
    expect(fallback).toHaveBeenCalledTimes(2);
    findClaudeHandler(lookup);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe('findClaudeHandler', () => {
  it('keeps a handler while its program exists, looks again once it is gone (an app update moves it), and never keeps a miss', () => {
    const exe = join(DIR, 'Claude-old.exe');
    writeFileSync(exe, '');
    const missing = vi.fn(() => undefined);
    expect(findClaudeHandler(missing)).toBeUndefined();
    expect(findClaudeHandler(missing)).toBeUndefined();
    expect(missing).toHaveBeenCalledTimes(2);
    const found = vi.fn(() => ({ file: exe, args: ['%1'] }));
    findClaudeHandler(found);
    findClaudeHandler(found);
    expect(found).toHaveBeenCalledTimes(1);
    rmSync(exe);
    findClaudeHandler(found);
    expect(found).toHaveBeenCalledTimes(2);
  });
});
