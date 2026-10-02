import { describe, expect, it } from 'vitest';
import { HOOK_DEFS } from '../../src/cli/claude-config';
import { hookBudget } from '../../src/hooks/budget';
import { HOOK_NAMES } from '../../src/hooks/handlers';

describe('hookBudget', () => {
  it('gives session-start 5 s for a server it had to start and 2 s for the briefing POST', () => {
    // A cold start after a reboot took longer than the 2 s session-start used to wait, and the session went unbriefed.
    expect(hookBudget('session-start')).toEqual({ serverWaitMs: 5000, postTimeoutMs: 2000, limitMs: 7250 });
  });

  it('keeps every other hook to one 500 ms POST', () => {
    for (const name of HOOK_NAMES.filter((n) => n !== 'session-start')) {
      expect(hookBudget(name), name).toEqual({ serverWaitMs: 0, postTimeoutMs: 500, limitMs: 750 });
    }
  });

  it("gives up at least 2 s inside the timeout Claude gives each hook, for Node's own start", () => {
    for (const def of HOOK_DEFS) expect(hookBudget(def.name).limitMs + 2000, def.event).toBeLessThanOrEqual(def.timeout * 1000);
  });
});
