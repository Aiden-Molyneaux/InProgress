import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';

/** How long `claude --desktop --resume` may take before the window is told to show the command instead. */
export const OPEN_DESKTOP_TIMEOUT_MS = 10_000;

/** The command Aiden can run himself when the server could not. */
export const desktopCommand = (sessionId: string): string => `claude --desktop --resume ${sessionId}`;

export interface OpenDesktopOptions {
  /** child_process.spawn, replaceable so tests never run a real `claude`. */
  spawn?: (file: string, args: string[], options: { shell: false; windowsHide: true; stdio: 'ignore'; cwd: string }) => ChildProcess;
  timeoutMs?: number;
}

/**
 * Runs `claude --desktop --resume <id>` and answers whether it exited 0 within the timeout. A spawn error, a non-zero
 * exit and a timeout all answer false (the child is killed on a timeout). No shell is involved, so the id is one argument.
 * The caller has checked the id is a UUID. On Windows the program is claude.exe from PATH, and the working directory is
 * the home folder, since Windows looks a bare name up in the working directory first.
 */
export function openInDesktop(sessionId: string, o: OpenDesktopOptions = {}): Promise<boolean> {
  const run = o.spawn ?? nodeSpawn;
  const file = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = run(file, ['--desktop', '--resume', sessionId], { shell: false, windowsHide: true, stdio: 'ignore', cwd: homedir() });
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
