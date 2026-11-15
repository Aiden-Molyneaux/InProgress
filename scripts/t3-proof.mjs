#!/usr/bin/env node
// One-off proof for #720: can a process that is not a T3 Code thread start a thread, message it and read it back
// through the t3 CLI? Run from a plain shell: node scripts/t3-proof.mjs [project id or path]
// It starts one real thread (two short turns). The result is recorded in docs/superpowers/rulings/.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const win = process.platform === 'win32';
const cli = process.env.T3CODE_CLI_PATH || join(homedir(), '.t3', 'bin', win ? 't3.cmd' : 't3');
const project = process.argv[2] || join(homedir(), '.t3', 'scratch');
// A project with no default model refuses a start that names none, so the caller always names both.
const provider = process.argv[3] || 'claudeAgent';
const model = process.argv[4] || 'claude-haiku-5-5';
// The InProgress server is not a child of T3 Code, so the proof runs without T3's own variables.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^T3/i.test(k)));
// A .cmd needs a shell on Windows, and a shell needs its own quoting.
const q = (s) => (win ? `"${s}"` : s);

function t3(args, input) {
  const started = Date.now();
  const r = spawnSync(q(cli), args, { env, input, encoding: 'utf8', shell: win, timeout: 240_000 });
  return { exit: r.status, ms: Date.now() - started, out: (r.stdout || '').trim(), err: (r.stderr || '').trim().slice(0, 400) };
}
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const start = t3(
  ['thread', 'start', q(project), '-', '--title', 'InProgress-T3-proof', '--provider', provider, '--model', model, '--wait', '--json'],
  'Reply with the single word READY and stop.',
);
const startJson = parse(start.out);
const threadId = startJson?.threadId ?? startJson?.thread?.threadId ?? /"threadId"\s*:\s*"([^"]+)"/.exec(start.out)?.[1] ?? null;

const send = threadId ? t3(['thread', 'send', threadId, '-', '--wait', '--json'], 'Reply with the single word DONE and stop.') : null;
const show = threadId ? t3(['thread', 'show', threadId, '--json']) : null;
const shown = show ? parse(show.out) : null;

const summary = {
  cli,
  project,
  provider,
  model,
  t3VariablesPassed: Object.keys(env).filter((k) => /^T3/i.test(k)).length,
  start: { exit: start.exit, ms: start.ms, keys: startJson ? Object.keys(startJson) : null, err: start.err || undefined, raw: startJson ? undefined : start.out.slice(0, 400) },
  threadId,
  send: send && { exit: send.exit, ms: send.ms, keys: parse(send.out) ? Object.keys(parse(send.out)) : null, err: send.err || undefined },
  thread: shown?.thread && {
    runtimeMode: shown.thread.runtimeMode,
    status: shown.thread.status,
    createdBy: shown.thread.createdBy,
    creationSource: shown.thread.creationSource,
    title: shown.thread.title,
    link: shown.thread.link,
  },
  messages: shown?.messages?.map((m) => ({ role: m.role, text: String(m.text).slice(0, 80) })),
};
console.log(JSON.stringify(summary, null, 2));
const ok = start.exit === 0 && threadId && send?.exit === 0 && show?.exit === 0;
process.exit(ok ? 0 : 1);
