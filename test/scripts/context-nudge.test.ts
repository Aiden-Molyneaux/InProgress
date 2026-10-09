import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/context-nudge.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nudge-'));
/** Where the hook keeps its per-session state in these tests. Not created here: the hook makes it, parents included. */
const stateDir = join(dir, 'state', 'nested');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An assistant transcript line whose prompt totals `context` tokens. */
const line = (id: string, context: number) => JSON.stringify({
  type: 'assistant',
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: context - 1010, cache_creation_input_tokens: 1000, output_tokens: 5 } },
});
/** A synthetic message (an API error, an interrupt): it carries zero usage. */
const synthetic = (id: string) => JSON.stringify({
  type: 'assistant',
  message: { id, model: '<synthetic>', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
});
/** A transcript line with no usage in it, `bytes` long: a big tool result. */
const bulky = (bytes: number) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(bytes) } });
let n = 0;
function transcript(...lines: string[]): string {
  const file = join(dir, `t${n++}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
function run(input: unknown) {
  const r = spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CONTEXT_NUDGE_STATE_DIR: stateDir },
  });
  return { status: r.status, out: r.stdout.trim() };
}
/** A session id no other test uses: the hook keeps one state file per id. */
let sessions = 0;
const fresh = () => `session-${sessions++}`;
const hook = (file: string, session: string, extra: object = {}) => ({ hook_event_name: 'PostToolBatch', session_id: session, transcript_path: file, ...extra });
/** One hook run for `session` on a new transcript holding `lines`: what it printed. */
const batch = (session: string, ...lines: string[]) => run(hook(transcript(...lines), session)).out;
/** The line a hook run printed, or '' when it was silent. */
const said = (out: string): string => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : '');
/** The level stored for `session`, or null while the hook has written nothing for it. */
function stored(session: string): number | null {
  const file = join(stateDir, `${session}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).level : null;
}

describe('context-nudge', () => {
  it('nudges once when the context crosses 120k', () => {
    const session = fresh();
    const file = transcript(line('a', 110_000), line('b', 125_000));
    const first = run(hook(file, session));
    expect(first.status).toBe(0);
    const out = JSON.parse(first.out);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolBatch');
    expect(out.hookSpecificOutput.additionalContext).toContain('about 120k');
    expect(stored(session)).toBe(120_000);
    expect(run(hook(file, session))).toEqual({ status: 0, out: '' });
  });
  it('does not miss a crossing on a turn that ended without a tool call', () => {
    const session = fresh();
    expect(batch(session, line('a', 110_000))).toBe('');
    // 125k arrived on a turn with no tools, so no hook ran for it; the next batch sees 126k.
    expect(said(batch(session, line('a', 110_000), line('b', 125_000), line('c', 126_000)))).toContain('about 120k');
    expect(said(batch(fresh(), line('a', 110_000), line('b', 125_000), line('c', 126_000)))).toContain('about 120k');
  });
  it('adds the 160k line after the 120k one, or says it alone when a session jumps over both', () => {
    const session = fresh();
    expect(said(batch(session, line('a', 125_000)))).toContain('about 120k');
    expect(said(batch(session, line('a', 125_000), line('b', 165_000)))).toContain('about 160k');
    expect(stored(session)).toBe(160_000);
    // Falling back between the lines repeats neither.
    expect(batch(session, line('a', 125_000), line('b', 165_000), line('c', 130_000))).toBe('');
    const jump = said(batch(fresh(), line('a', 100_000), line('b', 170_000)));
    expect(jump).toContain('about 160k');
    expect(jump).not.toContain('120k');
  });
  it('re-arms after the context drops below 120k', () => {
    const session = fresh();
    expect(said(batch(session, line('a', 125_000)))).toContain('about 120k');
    expect(batch(session, line('a', 125_000), line('b', 40_000))).toBe('');
    expect(stored(session)).toBe(0);
    expect(said(batch(session, line('a', 125_000), line('b', 40_000), line('c', 125_000)))).toContain('about 120k');
  });
  it('ignores synthetic messages, which carry zero usage', () => {
    expect(said(batch(fresh(), line('a', 125_000), synthetic('s')))).toContain('about 120k');
    expect(batch(fresh(), line('a', 100_000), synthetic('s'))).toBe('');
    // A synthetic message is not a compaction: it neither re-arms the level nor repeats the line.
    const session = fresh();
    expect(said(batch(session, line('a', 125_000)))).toContain('about 120k');
    expect(batch(session, line('a', 125_000), synthetic('s'))).toBe('');
    expect(stored(session)).toBe(120_000);
    expect(batch(session, line('a', 125_000), synthetic('s'), line('b', 126_000))).toBe('');
  });
  it('ignores a partial last line', () => {
    const file = transcript(line('a', 100_000), line('b', 125_000));
    // Cut mid-write, past the usage key: it must not throw or stand in for the newest request.
    writeFileSync(file, '{"type":"assistant","message":{"id":"c","model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_read', { flag: 'a' });
    expect(said(run(hook(file, fresh())).out)).toContain('about 120k');
  });
  it('still finds a usage line that sits before a 600 KB line without one, and gives up past 8 MB', () => {
    expect(said(run(hook(transcript(line('a', 125_000), bulky(600 * 1024)), fresh())).out)).toContain('about 120k');
    expect(run(hook(transcript(line('a', 125_000), bulky(9 * 1024 * 1024)), fresh()))).toEqual({ status: 0, out: '' });
  });
  it('writes its state file on a session\'s first run, level 0 when nothing is due', () => {
    const session = fresh();
    expect(stored(session)).toBeNull();
    expect(batch(session, line('a', 40_000))).toBe('');
    expect(stored(session)).toBe(0);
    // A transcript with no usage line yet counts as nothing due.
    const early = fresh();
    expect(batch(early, bulky(100))).toBe('');
    expect(stored(early)).toBe(0);
  });
  it('keeps an announced level when a huge line hides every usage line', () => {
    const session = fresh();
    expect(said(batch(session, line('a', 125_000)))).toContain('about 120k');
    expect(batch(session, line('a', 125_000), bulky(9 * 1024 * 1024))).toBe('');
    expect(stored(session)).toBe(120_000);
    expect(batch(session, line('a', 125_000), line('b', 126_000))).toBe('');
  });
  it('stays silent inside a subagent and writes no state', () => {
    const session = fresh();
    const file = transcript(line('a', 110_000), line('b', 125_000));
    expect(run(hook(file, session, { agent_id: 'a1', agent_type: 'implementer' })).out).toBe('');
    expect(stored(session)).toBeNull();
    // The main session's own nudge was not used up by it.
    expect(said(run(hook(file, session)).out)).toContain('about 120k');
  });
  it('needs a session id, and keeps its state file inside its folder whatever the id holds', () => {
    const file = transcript(line('a', 125_000));
    const listing = () => (existsSync(stateDir) ? readdirSync(stateDir) : []).sort();
    const before = listing();
    expect(run({ hook_event_name: 'PostToolBatch', transcript_path: file })).toEqual({ status: 0, out: '' });
    expect(run(hook(file, '../..'))).toEqual({ status: 0, out: '' });
    expect(listing()).toEqual(before);
    // Everything but letters, digits and hyphens is dropped from the file name.
    expect(said(run(hook(file, '../../x.y/z')).out)).toContain('about 120k');
    expect(stored('xyz')).toBe(120_000);
  });
  it('exits 0 silently on a missing transcript or bad input', () => {
    expect(run(hook(join(dir, 'missing.jsonl'), fresh()))).toEqual({ status: 0, out: '' });
    expect(run('not json')).toEqual({ status: 0, out: '' });
  });
});
