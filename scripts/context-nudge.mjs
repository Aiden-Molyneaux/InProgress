#!/usr/bin/env node
// PostToolBatch hook, registered in .claude/settings.json. Claude cannot see its own context size, so this tells
// the main session when it crosses 120k and again at 160k, the points where CLAUDE.md asks it to cut at the next
// clean point. Silent otherwise, silent inside subagents, and it exits 0 whatever happens: a nudge must never block.
import fs from 'node:fs';

const LINES = [
  [160_000, 'Context is about 160k tokens. Cut the session at the next clean point: write the handoff, offer the next session, and stop. On an unattended overnight run, write the handoff and carry on with the next queued item instead. (CLAUDE.md, Session rhythm)'],
  [120_000, "Context is about 120k tokens. Finish what you're on, then at the next clean point (a merge, or a finished plan task with everything committed) write the handoff and cut the session. On an unattended overnight run, write the handoff and carry on instead. (CLAUDE.md, Session rhythm)"],
];
const TAIL = 512 * 1024;

/** The last `TAIL` bytes of a file, without a first line cut in half. */
function tail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Prompt size of each assistant message, in transcript order; a message written as several lines counts once. */
function contexts(text) {
  const byId = new Map();
  for (const l of text.split('\n')) {
    if (!l.includes('"usage"')) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    const u = j.message?.usage;
    // A synthetic message (an API error, an interrupt) carries zero usage: counting it would hide a crossing or fake one.
    if (!u || !j.message.id || j.message.model === '<synthetic>') continue;
    const writes = u.cache_creation_input_tokens ?? (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    byId.set(j.message.id, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + writes);
  }
  return [...byId.values()];
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!input.agent_id && input.transcript_path) {
    const seen = contexts(tail(input.transcript_path));
    if (seen.length >= 2) {
      const [prev, cur] = seen.slice(-2);
      const hit = LINES.find(([at]) => prev < at && cur >= at);
      if (hit) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? 'PostToolBatch', additionalContext: hit[1] } }));
      }
    }
  }
} catch {
  // Silence is the right answer to anything unexpected: the session carries on without a nudge.
}
process.exit(0);
