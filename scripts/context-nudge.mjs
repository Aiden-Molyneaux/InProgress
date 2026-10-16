#!/usr/bin/env node
// PostToolBatch hook, registered in .claude/settings.json. Claude cannot see its own context size, so this tells
// the main session when it crosses 150k (ask Aiden for /compact at the next clean point) and again at 200k (carry on;
// the autocompact at 250k is the backstop). It keeps the highest level it has announced for each session in a small
// file, so a level is said once and a turn that ended without a tool call cannot hide a crossing. A fall below 150k
// with a level stored is a compaction: it says the post-compaction line once and re-arms. A session's first run writes
// that file too, which is how a pilot checks the hook runs. Silent otherwise, silent inside subagents, and it exits 0
// whatever happens: a nudge must never block.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Highest level first: the first one the context has reached is the one due. */
const LINES = [
  [200_000, 'Context is about 200k tokens. If Aiden has not compacted, carry on; the autocompact at 250k is the backstop.'],
  [150_000, "Context is about 150k tokens. Finish what you're on, commit, and at the next clean point ask Aiden to run /compact with a line naming your plan, branch and open findings. Do not cut the session. Unattended, carry on: the 250k autocompact is the reset."],
];
/** A reading this many tokens below the last one is a compaction: context only shrinks when it is compacted. */
const COMPACTION_DROP = 30_000;
const COMPACTED = 'Context was compacted. If you are running Sigmund, reload him (.claude/skills/sigmund/SKILL.md) and reread your plan file and the step block before you go on.';
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

/**
 * What the hook stored for a session: the level last announced (0, 150000 or 200000) and `last`, the last context
 * reading. `missing` is a first run. An unreadable or corrupt file counts as level 0 with no `last`.
 */
function readState(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { missing: true, level: 0 };
    return { level: 0 };
  }
  try {
    const { level, last } = JSON.parse(text);
    return { level: Number.isFinite(level) ? level : 0, last: Number.isFinite(last) ? last : undefined };
  } catch {
    // A corrupt file: start from level 0 with no `last`, and the next write replaces it.
    return { level: 0 };
  }
}

/** Written to a temp file in the same folder and renamed over the original, so a reader never sees half a file. */
function writeState(file, level, last) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(last === undefined ? { level } : { level, last }));
  fs.renameSync(tmp, file);
}

function say(input, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? 'PostToolBatch', additionalContext } }));
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  // The session id names the state file, so only letters, digits and hyphens survive: it cannot leave STATE_DIR.
  const key = String(input.session_id ?? '').replace(/[^A-Za-z0-9-]/g, '');
  if (!input.agent_id && key && input.transcript_path) {
    const cur = newestContext(input.transcript_path);
    const file = path.join(STATE_DIR, `${key}.json`);
    const state = readState(file);
    const due = cur === undefined ? undefined : LINES.find(([at]) => cur >= at);
    if (cur === undefined) {
      // No usage line in reach (a huge tool result): keep what was announced; only a first run writes a file.
      if (state.missing) writeState(file, 0, undefined);
    } else {
      const compacted = !state.missing && (state.last !== undefined ? cur <= state.last - COMPACTION_DROP : state.level > 0 && !due);
      if (compacted) {
        // Recorded before it is said. The new reading's own level counts as given, so only a later crossing speaks.
        writeState(file, due ? due[0] : 0, cur);
        say(input, COMPACTED);
      } else if (due && due[0] > state.level) {
        writeState(file, due[0], cur);
        say(input, due[1]);
      } else {
        // Below 150k with a level still set and no `last` to judge by is the old re-arm; otherwise just track the reading.
        const level = due ? state.level : 0;
        if (state.missing || level !== state.level || state.last !== cur) writeState(file, level, cur);
      }
    }
  }
} catch {
  // Silence is the right answer to anything unexpected: the session carries on without a nudge.
}
process.exit(0);
