import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseVerdict } from '../../src/server/lead/verdict';

const recorder = join(__dirname, '../../scripts/lead-scenes/t3-recorder.mjs');
const claude = join(__dirname, '../../scripts/lead-scenes/claude-scenes.mjs');
const run = join(__dirname, '../../scripts/lead-scenes/run.mjs');
const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'lead-scenes-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const t3 = (work: string, args: string[], input = '') => spawnSync(process.execPath, [recorder, ...args], { env: { ...process.env, SCENES_WORK: work }, input, encoding: 'utf8' });

describe('the scenes recorder standing in for the t3 CLI', () => {
  it('starts a thread, lists it, shows it, takes a send, and records every call with its text', () => {
    const work = scratch();
    const started = t3(work, ['thread', 'start', 'C:/proj', '-', '--title', 'Lead day', '--json'], 'first message');
    const { threadId } = JSON.parse(started.stdout) as { threadId: string };
    expect(t3(work, ['thread', 'send', threadId, '-', '--json'], 'second message').status).toBe(0);
    const list = JSON.parse(t3(work, ['thread', 'list', '--project', 'C:/proj', '--json']).stdout) as { threadId: string; title: string }[];
    expect(list.map((t) => [t.threadId, t.title])).toEqual([[threadId, 'Lead day']]);
    const shown = JSON.parse(t3(work, ['thread', 'show', threadId, '--json']).stdout) as { messages: { text: string }[] };
    expect(shown.messages.map((m) => m.text)).toEqual(['first message', 'second message']);
    const calls = readFileSync(join(work, 't3-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; stdin: string; at: string });
    expect(calls.map((c) => [c.args[1], c.stdin])).toEqual([['start', 'first message'], ['send', 'second message'], ['list', ''], ['show', '']]);
    expect(calls.every((c) => !Number.isNaN(Date.parse(c.at)))).toBe(true);
  });

  it('refuses a send to a thread that does not exist, and a command it does not know', () => {
    const work = scratch();
    const send = t3(work, ['thread', 'send', 'nope', '-', '--json'], 'x');
    expect(send.status).toBe(1);
    expect(send.stderr).toContain('no such thread');
    expect(t3(work, ['project', 'list']).status).toBe(1);
  });
});

describe('the scenes stand-in claude', () => {
  const turn = (work: string, message: string) => {
    const r = spawnSync(process.execPath, [claude, '-p', '--system-prompt-file', join(work, 'prompt.md')], { env: { ...process.env, SCENES_WORK: work, STANDIN_DELAY_MS: '1' }, input: message, encoding: 'utf8' });
    const result = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; result?: string }).find((o) => o.type === 'result');
    return result?.result ?? '';
  };

  it('answers with the first rule whose match is in the message, in the four lines the runner reads, and records the turn with its prompt', () => {
    const work = scratch();
    writeFileSync(join(work, 'prompt.md'), 'the system prompt');
    writeFileSync(
      join(work, 'standin.json'),
      JSON.stringify({ rules: [{ match: 'stopped on its step', verdict: 'DECIDE', kind: 'TECHNICAL', answer: 'RESTART: handoff', why: 'it stopped' }], default: { verdict: 'AIDEN', kind: 'TASTE', answer: 'a', why: 'b' } }),
    );
    const stopped = parseVerdict(turn(work, 'A session stopped on its step and has not moved'));
    expect(stopped).toEqual({ ok: true, value: { verdict: 'DECIDE', kind: 'TECHNICAL', answer: 'RESTART: handoff', why: 'it stopped' } });
    const other = parseVerdict(turn(work, 'A session asks Aiden a question.'));
    expect(other).toMatchObject({ ok: true, value: { verdict: 'AIDEN' } });
    const files = readdirSync(join(work, 'turns')).sort();
    expect(files).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(work, 'turns', files[0]!), 'utf8'))).toMatchObject({ message: 'A session stopped on its step and has not moved', systemPrompt: 'the system prompt' });
  });
});

describe('the scenes harness', () => {
  it('refuses a work dir under the live InProgress home before it makes anything', () => {
    const work = join(homedir(), '.inprogress', 'scenes-test-never-made');
    const r = spawnSync(process.execPath, [run, join(tmpdir(), 'no-build'), work], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('under the live InProgress home');
    expect(existsSync(work)).toBe(false);
  });
});
