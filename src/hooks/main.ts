import { join } from 'node:path';
import { createClient } from '../lib/client';
import { ensureServer } from '../lib/ensure-server';
import { baseUrl, homeDir, readToken } from '../lib/home';
import { appendLog } from '../lib/log';
import { hookBudget } from './budget';
import { captureHookInput } from './capture';
import { CONTEXT_EVENT_NAME, HOOK_NAMES, hookErrorLine, parseHookInput, runHandler, type HookName } from './handlers';

// Claude may stop reading before the briefing is written (say after a timeout): an EPIPE must not reach stderr.
process.stdout.on('error', () => undefined);

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

async function main(): Promise<void> {
  const name = process.argv[2] as HookName;
  const logFile = join(homeDir(), 'hooks.log');
  if (!(HOOK_NAMES as readonly string[]).includes(name)) {
    appendLog(logFile, `unknown hook "${String(name)}"`);
    return;
  }
  // session-start: up to 5 s for a server it had to start + 2 s for the POST; every other hook: one 500 ms POST.
  const budget = hookBudget(name);
  const work = (async () => {
    const input = parseHookInput(await readStdin(1000));
    // Task 0 capture (src/hooks/capture.ts): a redacted copy of this input, for the hooks the activity design reads.
    // Synchronous and silent; it never throws. Off with INPROGRESS_HOOK_CAPTURE=0 or a file ~/.inprogress/capture/off.
    captureHookInput(name, input);
    const url = baseUrl();
    const output = await runHandler(name, input, {
      ensureServer: () => ensureServer({ baseUrl: url, waitMs: budget.serverWaitMs }),
      // Read the token lazily: the first server start creates it.
      post: (path, body) => createClient({ baseUrl: url, token: readToken(), timeoutMs: budget.postTimeoutMs }).post(path, body),
    });
    const eventName = CONTEXT_EVENT_NAME[name];
    // A stop's block sends the session back for one more pass; Claude Code reads one JSON object, so never both.
    if (name === 'stop' && output?.block) await writeStdout(JSON.stringify({ decision: 'block', reason: output.block }));
    else if (output?.context && eventName) await writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: output.context } }));
  })();
  work.catch((err: unknown) => appendLog(logFile, hookErrorLine(name, err)));
  // We exit as soon as the limit passes, so the work's own error line never gets written: log the timeout instead.
  const limit = budget.limitMs;
  const timedOut = await Promise.race([work.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), limit))]);
  if (timedOut) appendLog(logFile, `${name}: timed out after ${limit} ms`);
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
