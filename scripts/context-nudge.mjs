#!/usr/bin/env node
// PostToolBatch hook, registered in .claude/settings.json. Claude cannot see its own context size, so this tells
// the main session when it crosses 150k and again at 160k, the points where Sigmund (Across the session) asks it to cut at the next
// clean point. It keeps the highest level it has announced for each session in a small file, so a level is said once
// and a turn that ended without a tool call cannot hide a crossing; a fall below 150k (a compaction) re-arms it. A
// session's first run writes that file too, which is how a pilot checks the hook runs. Silent otherwise, silent
// inside subagents, and it exits 0 whatever happens: a nudge must never block.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Highest level first: the first one the context has reached is the one due. */
const LINES = [
  [160_000, 'Context is about 160k tokens. Cut the session at the next clean point: write the handoff, offer the next session, and stop. On an unattended overnight run, write the handoff and carry on with the next queued item instead. (.claude/skills/sigmund/SKILL.md, Across the session)'],
  [150_000, "Context is about 150k tokens. Finish what you're on, then at the next clean point (a merge, or a finished plan task with everything committed) write the handoff and cut the session. On an unattended overnight run, write the handoff and carry on instead. (.claude/skills/sigmund/SKILL.md, Across the session)"],
];
const STATE_DIR = process.env.CONTEXT_NUDGE_STATE_DIR || path.join(os.tmpdir(), 'claude-context-nudge');
const TAIL = 512 * 1024;
const MAX_TAIL = 8 * 1024 * 1024;

/** The last `bytes` of a file, without a first line cut in half; `whole` says the window reached the file's start. */
function tail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return { text: start > 0 ? text.slice(text.indexOf('\n') + 1) : text, whole: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** Prompt size of the last assistant message in `text` that reports usage; undefined when none does. */
function lastContext(text) {
  let cur;
  for (const l of text.split('\n')) {
    if (!l.includes('"usage"')) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    const u = j.message?.usage;
    // A synthetic message (an API error, an interrupt) carries zero usage: counting it would look like a compaction.
    if (!u || j.message.model === '<synthetic>') continue;
    const writes = u.cache_creation_input_tokens ?? (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    cur = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + writes;
  }
  return cur;
}

/**
 * Prompt size of the newest assistant message in a transcript. A big tool result can push the last usage line out of
 * the tail, so the window doubles, up to MAX_TAIL, while none is in it.
 */
function newestContext(file) {
  for (let bytes = TAIL; ; bytes *= 2) {
    const { text, whole } = tail(file, bytes);
    const cur = lastContext(text);
    if (cur !== undefined || whole || bytes >= MAX_TAIL) return cur;
  }
}

/** The level last announced for a session (0, 150000 or 160000); undefined if its state file is missing or unreadable. */
function readLevel(file) {
  try {
    const { level } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isFinite(level) ? level : undefined;
  } catch {
    return undefined;
  }
}

function writeLevel(file, level) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ level }));
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  // The session id names the state file, so only letters, digits and hyphens survive: it cannot leave STATE_DIR.
  const key = String(input.session_id ?? '').replace(/[^A-Za-z0-9-]/g, '');
  if (!input.agent_id && key && input.transcript_path) {
    const cur = newestContext(input.transcript_path);
    const file = path.join(STATE_DIR, `${key}.json`);
    const level = readLevel(file);
    const due = cur === undefined ? undefined : LINES.find(([at]) => cur >= at);
    if (due) {
      if (due[0] > (level ?? 0)) {
        // Recorded before it is said: if the state cannot be written, say nothing rather than repeat it every batch.
        writeLevel(file, due[0]);
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? 'PostToolBatch', additionalContext: due[1] } }));
      }
    } else if (cur === undefined ? level === undefined : level !== 0) {
      // Below 150k: a level still set means a compaction, and a missing file is the session's first run. With no
      // usage line in reach (a huge tool result), keep what was announced: only a real reading can re-arm it.
      writeLevel(file, 0);
    }
  }
} catch {
  // Silence is the right answer to anything unexpected: the session carries on without a nudge.
}
process.exit(0);
