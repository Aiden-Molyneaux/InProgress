import { describe, expect, it } from 'vitest';
import { driverOf } from '../../src/core/driver';

describe('driverOf', () => {
  it("is 't3' when T3CODE_THREAD_ID is set", () => {
    expect(driverOf({ T3CODE_THREAD_ID: 'mcp:abc' })).toBe('t3');
  });
  it("is 'desktop' for the desktop entrypoint", () => {
    expect(driverOf({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })).toBe('desktop');
  });
  it("is 'cli' with neither, or with an empty thread id", () => {
    expect(driverOf({})).toBe('cli');
    expect(driverOf({ T3CODE_THREAD_ID: '', CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('cli');
  });
  it("is 't3' when both variables are set", () => {
    expect(driverOf({ T3CODE_THREAD_ID: 'mcp:abc', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })).toBe('t3');
  });
});
