import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentTranscriptPath, readAgentTail } from '../../src/lib/agent-transcript';

const line = (o: object) => JSON.stringify(o);
const user = (text: string, timestamp: string) => line({ type: 'user', agentId: 'a1', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp });
const assistant = (timestamp: string, extra: object = {}) =>
  line({ type: 'assistant', agentId: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, timestamp, ...extra });
/** As Claude Code writes an API error that ended a subagent's turn. */
const apiError = (error: string, timestamp: string) =>
  assistant(timestamp, { message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] }, error, isApiErrorMessage: true, apiErrorStatus: 429 });

/** A session transcript and its folder, as Claude Code lays them out: `<id>.jsonl` beside `<id>/`. */
function sessionDir(): { transcript: string; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'ip-agent-tr-'));
  const transcript = join(root, 'session-1.jsonl');
  writeFileSync(transcript, `${line({ type: 'user' })}\n`);
  return { transcript, folder: join(root, 'session-1') };
}

function write(file: string, lines: string[], end = '\n'): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, lines.join('\n') + end);
  return file;
}

describe('agentTranscriptPath', () => {
  it("finds an Agent-tool subagent's transcript in the session's subagents folder", () => {
    const { transcript, folder } = sessionDir();
    const file = write(join(folder, 'subagents', 'agent-a1.jsonl'), [assistant('2026-10-06T03:00:00.000Z')]);
    expect(agentTranscriptPath(transcript, 'a1')).toBe(file);
  });

  it("finds a workflow agent's transcript under one workflow run's folder", () => {
    const { transcript, folder } = sessionDir();
    mkdirSync(join(folder, 'subagents', 'workflows', 'wf_aaaa-111'), { recursive: true });
    const file = write(join(folder, 'subagents', 'workflows', 'wf_bbbb-222', 'agent-a2.jsonl'), [assistant('2026-10-06T03:00:00.000Z')]);
    expect(agentTranscriptPath(transcript, 'a2')).toBe(file);
  });

  it('finds nothing for an agent with no transcript, a session transcript of another shape, or an id that is not a plain name', () => {
    const { transcript, folder } = sessionDir();
    write(join(folder, 'subagents', 'agent-a1.jsonl'), [assistant('2026-10-06T03:00:00.000Z')]);
    expect(agentTranscriptPath(transcript, 'a9')).toBeUndefined();
    expect(agentTranscriptPath(transcript.replace(/\.jsonl$/, '.txt'), 'a1')).toBeUndefined();
    expect(agentTranscriptPath(join(tmpdir(), 'no-such-dir', 'x.jsonl'), 'a1')).toBeUndefined();
    expect(agentTranscriptPath(transcript, '../agent-a1')).toBeUndefined();
    expect(agentTranscriptPath(transcript, '')).toBeUndefined();
  });
});

describe('readAgentTail', () => {
  const file = (lines: string[], end = '\n') => write(join(mkdtempSync(join(tmpdir(), 'ip-agent-tail-')), 'agent-a1.jsonl'), lines, end);

  it('reads a normal last line: its time, and no ending', () => {
    expect(readAgentTail(file([user('Go', '2026-10-06T03:00:00.000Z'), assistant('2026-10-06T03:05:00.000Z')]))).toEqual({ lastAt: '2026-10-06T03:05:00.000Z', ending: null });
  });

  it('reads the interrupt marker as killed, in both of its forms', () => {
    expect(readAgentTail(file([assistant('2026-10-05T14:10:00.000Z'), user('[Request interrupted by user]', '2026-10-05T14:11:00.812Z')]))).toEqual({ lastAt: '2026-10-05T14:11:00.812Z', ending: 'killed' });
    expect(readAgentTail(file([user('[Request interrupted by user for tool use]', '2026-10-05T14:11:00.000Z')]))).toEqual({ lastAt: '2026-10-05T14:11:00.000Z', ending: 'killed' });
    const plain = line({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' }, timestamp: '2026-10-05T14:12:00.000Z' });
    expect(readAgentTail(file([plain]))).toEqual({ lastAt: '2026-10-05T14:12:00.000Z', ending: 'killed' });
  });

  it('reads an API error as the usage limit for rate_limit, and as an error for anything else', () => {
    expect(readAgentTail(file([apiError('rate_limit', '2026-10-06T03:18:47.170Z')]))).toEqual({ lastAt: '2026-10-06T03:18:47.170Z', ending: 'limit' });
    expect(readAgentTail(file([apiError('server_error', '2026-10-06T03:18:47.170Z')]))).toEqual({ lastAt: '2026-10-06T03:18:47.170Z', ending: 'error' });
    expect(readAgentTail(file([assistant('2026-10-06T03:18:47.170Z', { isApiErrorMessage: true })]))).toEqual({ lastAt: '2026-10-06T03:18:47.170Z', ending: 'error' });
  });

  it('reads only the last complete line: a marker earlier on, or a line still being written, is not the ending', () => {
    expect(readAgentTail(file([user('[Request interrupted by user]', '2026-10-05T14:11:00.000Z'), assistant('2026-10-05T14:20:00.000Z')]))).toEqual({ lastAt: '2026-10-05T14:20:00.000Z', ending: null });
    expect(readAgentTail(file([apiError('rate_limit', '2026-10-06T03:18:47.170Z'), '{"type":"assistant","timest'], ''))).toEqual({ lastAt: '2026-10-06T03:18:47.170Z', ending: 'limit' });
  });

  it('takes the time from the newest line that has one', () => {
    expect(readAgentTail(file([assistant('2026-10-06T03:05:00.000Z'), line({ type: 'summary', summary: 'x' })]))).toEqual({ lastAt: '2026-10-06T03:05:00.000Z', ending: null });
  });

  it('skips the partial first line of its window', () => {
    // The window starts inside the line, where its end alone reads as the interrupt marker.
    const marker = user('[Request interrupted by user]', '2026-10-05T14:11:00.000Z');
    const cut = `${'x'.repeat(200)}${marker}`;
    expect(readAgentTail(file([cut]), marker.length + 1)).toBeUndefined();
    const summary = line({ type: 'summary', summary: 'x' });
    expect(readAgentTail(file([cut, summary]), marker.length + summary.length + 2)).toEqual({ lastAt: null, ending: null });
    // Read whole, the cut line is garbled.
    expect(readAgentTail(file([cut]))).toBeUndefined();
  });

  it('returns nothing for a missing, empty or garbled file', () => {
    expect(readAgentTail(join(tmpdir(), 'no-such-agent.jsonl'))).toBeUndefined();
    expect(readAgentTail(file([], ''))).toBeUndefined();
    expect(readAgentTail(file(['not json at all', '{"broken":'], ''))).toBeUndefined();
    expect(readAgentTail(file(['[1, 2, 3]', '"a string"']))).toBeUndefined();
  });
});
