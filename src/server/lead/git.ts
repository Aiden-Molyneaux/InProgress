import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Written to git's stdin. */
  input?: string;
  /** The most output kept (default 4 MB); more is a rejection. */
  maxBuffer?: number;
  timeoutMs?: number;
}

/**
 * Runs git without a shell, as `git -C <folder>` and with no cwd option: Windows looks in the working directory for git.exe
 * before PATH, so a git.exe inside the repository's tree must never be found. Resolves with the exit code and output: a
 * non-zero exit is an answer, not a throw. A git that did not finish (a timeout, too much output, no git) rejects.
 */
export function runGit(folder: string, args: string[], o: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', folder, ...args],
      { timeout: o.timeoutMs ?? 10_000, maxBuffer: o.maxBuffer ?? 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'number') return resolve({ code, stdout, stderr });
        reject(new Error(`git ${args[0]} did not finish: ${err.message}`));
      },
    );
    if (o.input !== undefined) {
      // A git that exits before reading its input closes the pipe: the exit code above is the answer, so the write error is not.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(o.input);
    }
  });
}
