import { describe, expect, it, vi } from 'vitest';
import { LEAD_START_MODEL, LEAD_START_PROVIDER } from '../../src/core/lead';
import { defaultStart } from '../../src/server/lead-start';
import type { T3Run } from '../../src/server/t3';

const run = (): T3Run => vi.fn(async () => JSON.stringify({ threadId: 'mcp:abc' }));
const t3 = (r: T3Run) => ({ run: r, cliPath: '/bin/t3', platform: 'linux' as const });

describe('the default start', () => {
  it('names the proof provider and model', async () => {
    expect([LEAD_START_PROVIDER, LEAD_START_MODEL]).toEqual(['claudeAgent', 'claude-opus-5-5']);
    const r = run();
    await expect(defaultStart(t3(r), {})('C:/proj', 'go', { title: 'T' })).resolves.toEqual({ threadId: 'mcp:abc' });
    expect(r).toHaveBeenCalledWith('/bin/t3', ['thread', 'start', 'C:/proj', '-', '--provider', 'claudeAgent', '--model', 'claude-opus-5-5', '--title', 'T', '--json'], expect.anything());
  });

  it('takes INPROGRESS_LEAD_PROVIDER and INPROGRESS_LEAD_MODEL when set and not blank, each on its own', async () => {
    const both = run();
    await defaultStart(t3(both), { INPROGRESS_LEAD_PROVIDER: 'codex', INPROGRESS_LEAD_MODEL: 'gpt-x' })('C:/proj', 'go', {});
    expect((both as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(['thread', 'start', 'C:/proj', '-', '--provider', 'codex', '--model', 'gpt-x', '--json']);
    const blank = run();
    await defaultStart(t3(blank), { INPROGRESS_LEAD_PROVIDER: '  ', INPROGRESS_LEAD_MODEL: 'gpt-x' })('C:/proj', 'go', {});
    expect((blank as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(['thread', 'start', 'C:/proj', '-', '--provider', 'claudeAgent', '--model', 'gpt-x', '--json']);
  });
});
