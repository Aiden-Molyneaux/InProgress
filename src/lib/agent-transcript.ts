import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A subagent's own transcript, as Claude Code writes it beside its session's: one JSON line per message, appended as it
 * works. The format is undocumented (read from Claude Code 2.1 and its files on disk), so every failure here returns
 * undefined and the watcher does nothing with it, as readTranscriptTitle does.
 */

/** How a transcript's last line says the subagent ended: interrupted, the usage limit, or another API error. */
export type TranscriptEnding = 'killed' | 'limit' | 'error';

export interface TranscriptTail {
  /** The timestamp of the newest complete line that has one; null when none in the window does. */
  lastAt: string | null;
  /** The ending its last complete line marks, or null for any other line. */
  ending: TranscriptEnding | null;
}

/** A plain agent id (`a665844722b3f6246`), never a path. */
const AGENT_ID = /^[A-Za-z0-9_-]+$/;

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Where subagent `agentId` of the session whose transcript is `sessionTranscript` keeps its own:
 * `<session transcript without .jsonl>/subagents/agent-<id>.jsonl` for an Agent-tool subagent, or the same name inside
 * one `subagents/workflows/wf_<run>/` folder for a workflow agent. Undefined when there is none, or on any failure.
 */
export function agentTranscriptPath(sessionTranscript: string, agentId: string): string | undefined {
  if (!AGENT_ID.test(agentId) || !sessionTranscript.endsWith('.jsonl')) return undefined;
  const subagents = join(sessionTranscript.slice(0, -'.jsonl'.length), 'subagents');
  const name = `agent-${agentId}.jsonl`;
  if (isFile(join(subagents, name))) return join(subagents, name);
  try {
    const workflows = join(subagents, 'workflows');
    for (const run of readdirSync(workflows)) {
      if (run.startsWith('wf_') && isFile(join(workflows, run, name))) return join(workflows, run, name);
    }
  } catch {
    // No workflows folder: not a workflow agent, or not there yet.
  }
  return undefined;
}

const INTERRUPTED = '[Request interrupted by user';

/** The text a message carries: a plain string, or its text blocks. */
function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? [(b as { text: string }).text] : []));
}

/** The ending a transcript line marks: the interrupt Claude Code writes when a subagent is stopped, or an API error. */
function endingOf(entry: Record<string, unknown>): TranscriptEnding | null {
  if (entry.isApiErrorMessage === true) return entry.error === 'rate_limit' ? 'limit' : 'error';
  if (entry.type === 'user') {
    const message = entry.message as { content?: unknown } | undefined;
    if (texts(message?.content).some((t) => t.startsWith(INTERRUPTED))) return 'killed';
  }
  return null;
}

const timeOf = (entry: Record<string, unknown>): string | null =>
  typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)) ? entry.timestamp : null;

/**
 * The last `maxBytes` of a subagent's transcript: the ending its last complete line marks, and the newest time a line
 * gives. A line that is not whole JSON yet (still being written) and the window's cut first line are not read.
 * Undefined for a missing or empty file, one with no complete line in the window, or on any failure.
 */
export function readAgentTail(file: string, maxBytes = 64 * 1024): TranscriptTail | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    if (len === 0) return undefined;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // A window that starts inside the file starts inside a line.
    if (len < size) lines.shift();
    let tail: TranscriptTail | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i].trim();
      if (!text) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(text);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      tail ??= { lastAt: null, ending: endingOf(record) };
      tail.lastAt = timeOf(record);
      if (tail.lastAt) return tail;
    }
    return tail;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
