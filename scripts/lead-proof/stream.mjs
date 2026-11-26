// Reads a `claude -p --output-format stream-json --verbose` stream (one JSON object a line) into the tool calls it made.

/** The text of a tool_result's content: a string, or a list of text blocks. */
const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';

/** What the hold hook's refusal says (src/hooks/hold.ts heldReason and unansweredReason). */
export const HELD_TEXT = 'Held for Aiden before it runs';
/** What the hold hook's split refusal says (src/server/lead/hold.ts ownCommandText). */
export const SPLIT_TEXT = 'as a command of its own: InProgress reads it before the commands in front of it have run';

/**
 * The tool calls of a stream, in order: `{ id, tool, command, result, isError, denied, split }`. `result` is null when the
 * stream shows none; `denied` is whether the result carries the hold hook's reason, held or split, and `split` whether it is
 * the split one. Lines that are not JSON are skipped.
 */
export function parseStream(text) {
  const calls = [];
  const byId = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // A line that is not JSON (a stray log line) is not an event.
      continue;
    }
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const input = block.input ?? {};
        const call = { id: block.id, tool: block.name, command: typeof input.command === 'string' ? input.command : null, result: null, isError: false, denied: false, split: false };
        calls.push(call);
        byId.set(block.id, call);
      } else if (block?.type === 'tool_result') {
        const call = byId.get(block.tool_use_id);
        if (call === undefined) continue;
        call.result = textOf(block.content);
        call.isError = block.is_error === true;
        call.split = call.result.includes(SPLIT_TEXT);
        call.denied = call.result.includes(HELD_TEXT) || call.split;
      }
    }
  }
  return calls;
}

/**
 * The commands an evidence.md of this harness marks "not asked", per shell (`Bash`, `PowerShell`), as written in its
 * "<Shell> run: what the stream showed" tables, plus the work dir the file names on its `work ` line (null if none).
 */
export function notAskedIn(evidence) {
  const out = { Bash: [], PowerShell: [] };
  let tool = null;
  for (const line of evidence.split(/\r?\n/)) {
    const head = /^## (Bash|PowerShell) run: what the stream showed/.exec(line);
    if (head) {
      tool = head[1];
      continue;
    }
    if (line.startsWith('## ')) tool = null;
    if (tool === null) continue;
    const row = /^\| `(.*)` \| .*? \| not asked \| .* \|$/.exec(line);
    if (row) out[tool].push(row[1].split('\\|').join('|'));
  }
  const work = /^work\s+(\S.*)$/m.exec(evidence)?.[1].trim() ?? null;
  return { work, commands: out };
}
