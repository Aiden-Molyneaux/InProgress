import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The only code that runs the `t3` CLI (T3 Code's command line). Every failure to run it or to read what it printed is a
 * T3Unavailable; a TypeError means the caller passed an argument that is never run.
 */

export interface T3Thread {
  threadId: string;
  projectId: string;
  title: string;
  link: string;
  status: string;
  runtimeMode: string;
  settled: boolean;
  archived: boolean;
  pendingRequestCount: number;
  updatedAt: string;
  createdBy: string;
  creationSource: string;
}
export interface T3Message {
  role: string;
  text: string;
}
/** A command the runner killed at its time limit. */
export class T3Timeout extends Error {}
export class T3Unavailable extends Error {
  /**
   * True when a start or a send timed out: the thread, or the message, may exist, so a caller must not retry blindly.
   */
  readonly outcomeUnknown: boolean;
  constructor(message: string, outcomeUnknown = false) {
    super(message);
    this.outcomeUnknown = outcomeUnknown;
  }
}

/** Runs one command. Injected in tests. Rejects on a non-zero exit, a timeout or a missing file. */
export type T3Run = (file: string, args: string[], opts: { timeoutMs: number; input?: string; verbatim: boolean }) => Promise<string>;
export interface T3Options {
  run?: T3Run;
  cliPath?: string;
  platform?: NodeJS.Platform;
}

// Generous on purpose: the CLI is the desktop app run as Node, and on a loaded machine a list has taken 17 seconds.
// Nothing waits on these calls.
const LIST_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 60_000;
const TITLE_MAX = 120;
/**
 * What cmd.exe reads as syntax inside quotes, plus control characters. `&` is not here: inside the quotes it is literal in
 * both parses, and `C:\R&D\app` is a real folder.
 */
const UNSAFE = /["%^|<>!\u0000-\u001f\u007f]/;
const UNSAFE_EACH = /["%^|<>!\u0000-\u001f\u007f]/g;

const threadSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  title: z.string(),
  link: z.string(),
  status: z.string(),
  runtimeMode: z.string(),
  settled: z.boolean().default(false),
  archived: z.boolean().default(false),
  pendingRequestCount: z.number().default(0),
  updatedAt: z.string().default(''),
  createdBy: z.string().default(''),
  creationSource: z.string().default(''),
});
const showSchema = z.object({ thread: threadSchema, messages: z.array(z.object({ role: z.string(), text: z.string() })) });
const startSchema = z.object({ threadId: z.string().min(1) });

export function t3CliPath(env: Record<string, string | undefined> = process.env): string {
  if (env.T3CODE_CLI_PATH) return env.T3CODE_CLI_PATH;
  return join(homedir(), '.t3', 'bin', process.platform === 'win32' ? 't3.cmd' : 't3');
}

/**
 * How to run the CLI. `t3.cmd` is a batch file, which Node will not run without a shell, so on Windows it goes through
 * cmd.exe with every word quoted (and the runner passes the line verbatim). Elsewhere the CLI is run directly.
 */
export function t3CommandLine(cli: string, args: string[], platform: NodeJS.Platform): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== 'win32') return { file: cli, args, verbatim: false };
  const line = '"' + [cli, ...args].map((a) => '"' + a + '"').join(' ') + '"';
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', line], verbatim: true };
}

/** The child's environment: the server's own, without the thread it may have been started from inside. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.T3CODE_THREAD_ID;
  return env;
}

/**
 * The real runner: execFile, as `run` in sync.ts, with its own timer. On Windows the CLI is a grandchild of cmd.exe, so
 * killing cmd.exe would leave it running: taskkill takes the whole tree.
 */
export const execRun: T3Run = (file, args, { timeoutMs, input, verbatim }) =>
  new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const child = execFile(
      file,
      args,
      { windowsHide: true, windowsVerbatimArguments: verbatim, maxBuffer: 16 * 1024 * 1024, env: childEnv() },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (!err) return resolve(String(stdout));
        const e = err as NodeJS.ErrnoException;
        // Never e.message: for a failed exit it holds the whole command line.
        const reason = typeof e.code === 'number' ? `exit ${e.code}` : String(e.code ?? e.name);
        const text = String(stderr).trim().slice(0, 500);
        reject(new Error(text ? `${reason}: ${text}` : reason));
      },
    );
    timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid !== undefined) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (killErr) => {
          // The caller is told it timed out either way; a tree that could not be stopped is said in the server log.
          if (killErr) console.error(`InProgress: could not stop a timed-out t3 process (pid ${child.pid}): ${(killErr as NodeJS.ErrnoException).code ?? killErr.name}`);
        });
      else child.kill('SIGKILL');
      reject(new T3Timeout(`timed out after ${timeoutMs / 1000} s`));
    }, timeoutMs);
    // A child that exits before reading its input closes the pipe; the exit code already says what went wrong.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });

/** An argument that goes on the command line: refused when cmd.exe would read any of it as syntax. */
function safe(name: string, value: string): string {
  // A closing backslash would escape the quote that follows it when the CLI reads its own arguments.
  // A leading dash would be read as an option.
  if (!value || UNSAFE.test(value) || value.endsWith('\\') || value.startsWith('-')) throw new TypeError(`${name} is empty, starts with a dash, ends with a backslash, or holds a character that cannot go on the t3 command line`);
  return value;
}

async function call<S extends z.ZodTypeAny>(schema: S, args: string[], timeoutMs: number, o: T3Options, input?: string): Promise<z.infer<S>> {
  const run = o.run ?? execRun;
  const cli = o.cliPath ?? t3CliPath();
  if (UNSAFE.test(cli)) throw new T3Unavailable('the t3 CLI path holds a character that cannot go on a command line');
  const line = t3CommandLine(cli, args, o.platform ?? process.platform);
  let out: string;
  try {
    out = await run(line.file, line.args, { timeoutMs, verbatim: line.verbatim, ...(input !== undefined ? { input } : {}) });
  } catch (err) {
    const unknown = err instanceof T3Timeout && (args[1] === 'start' || args[1] === 'send');
    throw new T3Unavailable(`t3 ${args.slice(0, 2).join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`, unknown);
  }
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch (err) {
    throw new T3Unavailable(`t3 ${args.slice(0, 2).join(' ')} printed text that is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new T3Unavailable(`t3 ${args.slice(0, 2).join(' ')} printed JSON of an unexpected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data;
}

/** A project's threads. The project is always named: without it the CLI falls back to the folder the server runs in. */
export async function t3List(project: string, o: T3Options = {}): Promise<T3Thread[]> {
  const args = ['thread', 'list'];
  args.push('--project', safe('project', project));
  args.push('--json');
  return call(z.array(threadSchema), args, LIST_TIMEOUT_MS, o);
}

export async function t3Show(threadId: string, o: T3Options = {}): Promise<{ thread: T3Thread; messages: T3Message[] }> {
  return call(showSchema, ['thread', 'show', safe('threadId', threadId), '--json'], LIST_TIMEOUT_MS, o);
}

export async function t3Start(
  project: string,
  message: string,
  opts: { provider: string; model: string; title?: string; worktree?: string; branch?: string },
  o: T3Options = {},
): Promise<{ threadId: string }> {
  const args = ['thread', 'start', safe('project', project), '-', '--provider', safe('provider', opts.provider), '--model', safe('model', opts.model)];
  // A title is cleaned, not refused: unsafe characters become spaces, leading space and dashes and closing backslashes go,
  // it is cut to 120 code points, and a blank one is left out.
  const title = Array.from(opts.title?.replace(UNSAFE_EACH, ' ').replace(/^[\s-]+/, '') ?? '').slice(0, TITLE_MAX).join('').replace(/\\+$/, '');
  if (title.trim()) args.push('--title', title);
  if (opts.worktree !== undefined) args.push('--worktree', safe('worktree', opts.worktree));
  if (opts.branch !== undefined) args.push('--branch', safe('branch', opts.branch));
  args.push('--json');
  return call(startSchema, args, SEND_TIMEOUT_MS, o, message);
}

export async function t3Send(threadId: string, message: string, o: T3Options = {}): Promise<void> {
  await call(z.unknown(), ['thread', 'send', safe('threadId', threadId), '-', '--json'], SEND_TIMEOUT_MS, o, message);
}
