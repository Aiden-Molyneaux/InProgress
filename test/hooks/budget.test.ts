import { describe, expect, it } from 'vitest';
import { HOOK_DEFS } from '../../src/cli/claude-config';
import { hookBudget } from '../../src/hooks/budget';
import { HOOK_NAMES } from '../../src/hooks/handlers';

describe('hookBudget', () => {
  it('gives session-start 5 s for a server it had to start and 2 s for the briefing POST', () => {
    // A cold start after a reboot took longer than the 2 s session-start used to wait, and the session went unbriefed.
    expect(hookBudget('session-start')).toEqual({ serverWaitMs: 5000, postTimeoutMs: 2000, limitMs: 7250 });
  });

  it('gives the hold hook 10 s per POST and the permission hook 175 s, each with its own timeout firing before the limit', () => {
    expect(hookBudget('hold')).toEqual({ serverWaitMs: 0, postTimeoutMs: 10_000, limitMs: 21_000 });
    expect(hookBudget('permission')).toEqual({ serverWaitMs: 0, postTimeoutMs: 175_000, limitMs: 176_000 });
  });

  it('keeps every other hook to one 500 ms POST', () => {
    for (const name of HOOK_NAMES.filter((n) => n !== 'session-start' && n !== 'hold' && n !== 'permission')) {
      expect(hookBudget(name), name).toEqual({ serverWaitMs: 0, postTimeoutMs: 500, limitMs: 750 });
    }
  });

  it("gives up at least 2 s inside the timeout Claude gives each hook, for Node's own start", () => {
    for (const def of HOOK_DEFS) expect(hookBudget(def.name).limitMs + 2000, def.event).toBeLessThanOrEqual(def.timeout * 1000);
  });
});
