import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { systemRoot } from './open-path';

/** How long `claude --desktop --resume` may take before the window is told to show the command instead. */
export const OPEN_DESKTOP_TIMEOUT_MS = 10_000;

/** How long the where.exe lookup of claude.exe may block before it gives up. */
const LOOKUP_TIMEOUT_MS = 3000;

/** What the launch needs of a session: its id, and the folder it runs in (resume is scoped to that folder). */
export interface DesktopSession {
  id: string;
  cwd: string | null;
}

/** The session's folder when it is an absolute path to a folder that exists here; null otherwise. */
export function usableCwd(cwd: string | null): string | null {
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) return null;
  try {
    return statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    // Gone or unreadable between the two checks: not a folder to run in.
    return null;
  }
}

/**
 * Whether `cd "<cwd>"` in PowerShell goes exactly there. An allow-list, since PowerShell ends a double-quoted string at
 * curly quotes too and expands `$` and backticks: letters, digits, spaces and `_ . - \ / : ( ) + , @ ~` only. That
 * also keeps out `[ ]` (Set-Location reads them as wildcards) and `!` (bash history expansion). No trailing backslash
 * (it would escape the closing quote where a shell reads backslash escapes) and no leading `\\` (a UNC path).
 */
const quotable = (cwd: string): boolean => /^[\p{L}\p{N} _.\-\\/:()+,@~]+$/u.test(cwd) && !cwd.endsWith('\\') && !cwd.startsWith('\\\\');

/**
 * The command Aiden can run himself when the server could not: a cd into the session's folder first when it is known,
 * else the bare command. The `cd "<folder>"; claude ...` form is for PowerShell (5.1 and 7); bash runs it too for a plain
 * path. A folder `quotable` refuses gets the bare command.
 */
export function desktopCommand(sessionId: string, cwd: string | null): string {
  const bare = `claude --desktop --resume ${sessionId}`;
  return cwd && quotable(cwd) ? `cd "${cwd}"; ${bare}` : bare;
}

/** The first line of where.exe's output that ends in claude.exe, ignoring case. */
export function firstClaudeExe(whereOutput: string): string | undefined {
  return whereOutput.split(/\r?\n/).map((l) => l.trim()).find((l) => /claude\.exe$/i.test(l));
}

/**
 * The program to run. On Windows an absolute path to claude.exe from where.exe (run by absolute path, in SystemRoot, as
 * open-path.ts does), since the launch runs in the session's folder and Windows looks a bare name up in the working
 * directory first; undefined when there is none. Elsewhere `claude`, which exec looks up on PATH only.
 */
export function lookUpClaude(): string | undefined {
  if (process.platform !== 'win32') return 'claude';
  const where = spawnSync(join(systemRoot(), 'System32', 'where.exe'), ['claude'], { cwd: systemRoot(), encoding: 'utf8', windowsHide: true, timeout: LOOKUP_TIMEOUT_MS });
  return where.status === 0 ? firstClaudeExe(where.stdout) : undefined;
}

/** The program lookUpClaude found, kept for the process lifetime as open-path.ts keeps VS Code's. */
let claude: string | undefined;

/**
 * lookUpClaude, once per process while what it found exists. A miss is not kept, so a claude installed later is found;
 * an absolute path that no longer exists (a `claude update` moved it) is looked up again.
 */
export function findClaude(lookup: () => string | undefined = lookUpClaude): string | undefined {
  if (claude && isAbsolute(claude) && !existsSync(claude)) claude = undefined;
  claude ??= lookup();
  return claude;
}

/** Forgets the kept program: for tests. */
export const forgetClaude = (): void => {
  claude = undefined;
};

export interface OpenDesktopOptions {
  /** child_process.spawn, replaceable so tests never run a real `claude`. */
  spawn?: (file: string, args: string[], options: { shell: false; windowsHide: true; stdio: 'ignore'; cwd: string }) => ChildProcess;
  /** findClaude, replaceable so tests never run where.exe. */
  findClaude?: () => string | undefined;
  timeoutMs?: number;
}

/** Launches in flight by session id: a second click while one runs gets the same answer instead of a second launch. */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Runs `claude --desktop --resume <id>` in the session's folder (the home folder when that is not a folder here) and
 * answers whether it exited 0 within the timeout. No claude found, a spawn error, a non-zero exit and a timeout all
 * answer false (the child is killed on a timeout). No shell is involved, so the id is one argument. The caller has
 * checked the id is a UUID.
 */
export function openInDesktop(session: DesktopSession, o: OpenDesktopOptions = {}): Promise<boolean> {
  const pending = inFlight.get(session.id);
  if (pending) return pending;
  const launch = run(session, o).finally(() => inFlight.delete(session.id));
  inFlight.set(session.id, launch);
  return launch;
}

function run(session: DesktopSession, o: OpenDesktopOptions): Promise<boolean> {
  const spawn = o.spawn ?? nodeSpawn;
  const file = (o.findClaude ?? findClaude)();
  if (!file) return Promise.resolve(false);
  const cwd = usableCwd(session.cwd) ?? homedir();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, ['--desktop', '--resume', session.id], { shell: false, windowsHide: true, stdio: 'ignore', cwd });
    } catch {
      // A synchronous spawn failure is the same answer as an asynchronous one: the window shows the command.
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, o.timeoutMs ?? OPEN_DESKTOP_TIMEOUT_MS);
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
}
