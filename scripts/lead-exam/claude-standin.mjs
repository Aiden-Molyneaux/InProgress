// A stand-in for `claude -p` in the exam's dry run: reads the turn's message, prints the stream headlessWay reads, with one
// result line holding a four-line answer. It never runs a model and never calls out. STANDIN_VERDICT (AIDEN by default,
// DECIDE or CARD) picks the verdict; STANDIN_DELAY_MS waits before answering.
import { readFileSync } from 'node:fs';

const verdict = process.env.STANDIN_VERDICT ?? 'AIDEN';
const kinds = { AIDEN: 'TASTE', DECIDE: 'TECHNICAL', CARD: 'NONE' };
let message = '';
try {
  message = readFileSync(0, 'utf8');
} catch {
  // No stdin (a closed pipe): the answer does not depend on the message.
}
await new Promise((r) => setTimeout(r, Number(process.env.STANDIN_DELAY_MS ?? 200)));
const text = `${verdict}\nKIND: ${kinds[verdict] ?? 'TASTE'}\nANSWER: stand-in answer to a message of ${message.length} characters\nWHY: this is a stand-in, not a model`;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
out({ type: 'system', subtype: 'init', model: 'stand-in' });
out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1900000000 }, seven_day: { utilization: 0.2, resetsAt: 1900500000 } } } });
out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, duration_ms: 200, usage: { input_tokens: 10, output_tokens: 20 }, permission_denials: [] });
