// The program the scenes' server runs for a turn (INPROGRESS_LEAD_CLAUDE). It records every turn, then answers it.
// Recording: <SCENES_WORK>/turns/<time>-<pid>.json holds the arguments, the system prompt file the runner wrote (it is
// removed when the run ends, so it is copied here), the turn's message from stdin and what was answered.
// Answering: with SCENES_REAL_CLAUDE set, that program runs with the same arguments and stdin and its output is passed on
// unchanged. Without it (the dry run) the answer is a stand-in's, in the stream headlessWay reads: the first rule of
// <SCENES_WORK>/standin.json whose `match` (a regular expression) is found in the message gives the four lines, else its
// `default`; it never runs a model and never calls out. standin.json is { rules: [{ match, verdict, kind, answer, why }], default }.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const work = process.env.SCENES_WORK;
if (!work) {
  process.stderr.write('SCENES_WORK is not set\n');
  process.exit(2);
}
const args = process.argv.slice(2);
const argAfter = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
let message = '';
try {
  message = readFileSync(0, 'utf8');
} catch {
  // No stdin (a closed pipe): the answer does not depend on it.
}
let systemPrompt = '';
try {
  systemPrompt = readFileSync(argAfter('--system-prompt-file') ?? '', 'utf8');
} catch {
  // A run with no system prompt file (the usage probe may have none): recorded as empty.
}
mkdirSync(join(work, 'turns'), { recursive: true });
const record = (answered) =>
  writeFileSync(join(work, 'turns', `${Date.now()}-${process.pid}.json`), `${JSON.stringify({ at: new Date().toISOString(), args, message, systemPrompt, answered }, null, 2)}\n`);

const real = process.env.SCENES_REAL_CLAUDE;
if (real) {
  const child = spawn(real, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(real), windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    process.stdout.write(d);
  });
  child.on('close', (code) => {
    record(out.split('\n').filter((l) => l.includes('"type":"result"')).pop() ?? '');
    process.exit(code ?? 1);
  });
  child.stdin.end(message);
} else {
  const file = join(work, 'standin.json');
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const rule = (config.rules ?? []).find((r) => new RegExp(r.match, 'i').test(message)) ?? config.default ?? { verdict: 'AIDEN', kind: 'TASTE', answer: 'stand-in answer', why: 'this is a stand-in, not a model' };
  const text = `${rule.verdict}\nKIND: ${rule.kind}\nANSWER: ${rule.answer}\nWHY: ${rule.why}`;
  await new Promise((r) => setTimeout(r, Number(process.env.STANDIN_DELAY_MS ?? 300)));
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: 'system', subtype: 'init', model: 'stand-in' });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 }, seven_day: { utilization: 0.41, resetsAt: Math.floor(Date.now() / 1000) + 4 * 86400 } } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, duration_ms: 300, usage: { input_tokens: 10, output_tokens: 20 }, permission_denials: [] });
  record(text);
}
