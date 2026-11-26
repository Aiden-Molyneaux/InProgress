import { describe, expect, it } from 'vitest';
import { parseStream } from '../../scripts/lead-proof/stream.mjs';

const line = (o: unknown): string => JSON.stringify(o);

describe('the hook proof stream reader', () => {
  it('pairs each tool call with its result and marks the hold hook\'s refusal', () => {
    const text = [
      'not json',
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'git push origin main' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Held for Aiden before it runs: a push to origin. It waits for his word.' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'rm doomed.txt' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'done' }] }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'ls' } }] } }),
    ].join('\n');
    const calls = parseStream(text);
    expect(calls.map((c) => [c.command, c.denied, c.isError, c.result])).toEqual([
      ['git push origin main', true, true, expect.stringContaining('Held for Aiden')],
      ['rm doomed.txt', false, false, 'done'],
      ['ls', false, false, null],
    ]);
  });
});

describe('the commands a previous evidence file marks not asked', () => {
  it('reads each shell\'s table and the work dir', async () => {
    const { notAskedIn } = await import('../../scripts/lead-proof/stream.mjs');
    const evidence = [
      '# Hook proof',
      'work  C:/old/work',
      '',
      '## Bash run: what the stream showed',
      '| command | ran | deny shown | result |',
      '|---|---|---|---|',
      '| `git push origin main` | no | yes | Held |',
      '| `git -C C:/old/work/repo push origin main` | no | not asked | - |',
      '',
      '## PowerShell run: what the stream showed',
      '| `npm run deploy` | no | not asked | - |',
      '| `rm doomed.txt` | no | no | ok |',
      '',
      '## Permission run',
      '| `x` | no | not asked | - |',
    ].join('\n');
    expect(notAskedIn(evidence)).toEqual({ work: 'C:/old/work', commands: { Bash: ['git -C C:/old/work/repo push origin main'], PowerShell: ['npm run deploy'] } });
  });
});
