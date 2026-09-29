import { join } from 'node:path';
import { createClient } from '../lib/client';
import { ensureServer } from '../lib/ensure-server';
import { baseUrl, homeDir, readToken } from '../lib/home';
import { appendLog } from '../lib/log';
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
  // Total budget: session-start 3 s (up to 2 s spawning the server + 1 s for the POST), others 500 ms.
  const budget = name === 'session-start' ? 3000 : 500;
  const postTimeout = name === 'session-start' ? 1000 : 500;
  const work = (async () => {
    const input = parseHookInput(await readStdin(1000));
    const url = baseUrl();
    const context = await runHandler(name, input, {
      ensureServer: () => ensureServer({ baseUrl: url, waitMs: 2000 }),
      // Read the token lazily: the first server start creates it.
      post: (path, body) => createClient({ baseUrl: url, token: readToken(), timeoutMs: postTimeout }).post(path, body),
    });
    const eventName = CONTEXT_EVENT_NAME[name];
    if (context && eventName) await writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } }));
  })();
  work.catch((err: unknown) => appendLog(logFile, hookErrorLine(name, err)));
  // We exit as soon as the limit passes, so the work's own error line never gets written: log the timeout instead.
  const limit = budget + 250;
  const timedOut = await Promise.race([work.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), limit))]);
  if (timedOut) appendLog(logFile, `${name}: timed out after ${limit} ms`);
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
