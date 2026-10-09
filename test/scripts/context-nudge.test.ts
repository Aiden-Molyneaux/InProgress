import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/context-nudge.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nudge-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An assistant transcript line whose prompt totals `context` tokens. */
const line = (id: string, context: number) => JSON.stringify({
  type: 'assistant',
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: context - 1010, cache_creation_input_tokens: 1000, output_tokens: 5 } },
});
let n = 0;
function transcript(...lines: string[]): string {
  const file = join(dir, `t${n++}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
function run(input: unknown) {
  const r = spawnSync(process.execPath, [script], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim() };
}
const hook = (file: string, extra: object = {}) => ({ hook_event_name: 'PostToolBatch', session_id: 's', transcript_path: file, ...extra });

describe('context-nudge', () => {
  it('nudges once when the context crosses 120k', () => {
    const r = run(hook(transcript(line('a', 110_000), line('b', 125_000))));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolBatch');
    expect(out.hookSpecificOutput.additionalContext).toContain('about 120k');
  });
  it('nudges harder when it crosses 160k, including a jump over both lines', () => {
    expect(JSON.parse(run(hook(transcript(line('a', 150_000), line('b', 165_000)))).out).hookSpecificOutput.additionalContext).toContain('about 160k');
    expect(JSON.parse(run(hook(transcript(line('a', 100_000), line('b', 170_000)))).out).hookSpecificOutput.additionalContext).toContain('about 160k');
  });
  it('stays silent between lines, after a compaction drop, and with one request', () => {
    expect(run(hook(transcript(line('a', 125_000), line('b', 130_000)))).out).toBe('');
    expect(run(hook(transcript(line('a', 170_000), line('b', 40_000)))).out).toBe('');
    expect(run(hook(transcript(line('a', 125_000)))).out).toBe('');
  });
  it('counts repeated lines for one message id once', () => {
    expect(run(hook(transcript(line('a', 110_000), line('b', 125_000), line('b', 125_000)))).out).not.toBe('');
    expect(run(hook(transcript(line('a', 110_000), line('a', 110_000), line('b', 125_000)))).out).not.toBe('');
  });
  it('ignores synthetic messages, which carry zero usage', () => {
    const synthetic = (id: string) => JSON.stringify({
      type: 'assistant',
      message: { id, model: '<synthetic>', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
    });
    expect(run(hook(transcript(line('a', 110_000), line('b', 125_000), synthetic('s')))).out).toContain('about 120k');
    expect(run(hook(transcript(line('a', 125_000), synthetic('s'), line('b', 130_000)))).out).toBe('');
  });
  it('ignores a partial last line', () => {
    const file = transcript(line('a', 110_000), line('b', 125_000));
    writeFileSync(file, '{"type":"assistant","mess', { flag: 'a' });
    expect(run(hook(file)).out).toContain('about 120k');
  });
  it('stays silent inside a subagent', () => {
    expect(run(hook(transcript(line('a', 110_000), line('b', 125_000)), { agent_id: 'a1', agent_type: 'implementer' })).out).toBe('');
  });
  it('exits 0 silently on a missing transcript or bad input', () => {
    expect(run(hook(join(dir, 'missing.jsonl')))).toEqual({ status: 0, out: '' });
    expect(run('not json')).toEqual({ status: 0, out: '' });
  });
});
