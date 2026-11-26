// Reads a `claude -p --output-format stream-json --verbose` stream (one JSON object a line) into the tool calls it made.

/** The text of a tool_result's content: a string, or a list of text blocks. */
const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';

/** What the hold hook's refusal says (src/hooks/hold.ts heldReason and unansweredReason). */
export const HELD_TEXT = 'Held for Aiden before it runs';

/**
 * The tool calls of a stream, in order: `{ id, tool, command, result, isError, denied }`. `result` is null when the stream
 * shows none; `denied` is whether the result carries the hold hook's reason. Lines that are not JSON are skipped.
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
        const call = { id: block.id, tool: block.name, command: typeof input.command === 'string' ? input.command : null, result: null, isError: false, denied: false };
        calls.push(call);
        byId.set(block.id, call);
      } else if (block?.type === 'tool_result') {
        const call = byId.get(block.tool_use_id);
        if (call === undefined) continue;
        call.result = textOf(block.content);
        call.isError = block.is_error === true;
        call.denied = call.result.includes(HELD_TEXT);
      }
    }
  }
  return calls;
}
