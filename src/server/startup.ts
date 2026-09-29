import { fstatSync, statSync } from 'node:fs';
import { appendLog } from '../lib/log';

/** True when file descriptor `fd` writes to `file`. A server started by ensureServer has its stderr in server.log. */
function writesTo(fd: number, file: string): boolean {
  try {
    const out = fstatSync(fd, { bigint: true });
    const target = statSync(file, { bigint: true });
    return out.isFile() && out.ino === target.ino && out.dev === target.dev;
  } catch {
    return false;
  }
}

/**
 * The exit code for a start that threw. When another InProgress server answers, this start lost a race
 * (to migrate or to listen), which is not an error. Otherwise leave one clear line, not a stack trace,
 * in server.log and on stderr (once when stderr already goes to server.log).
 */
export async function reportStartupFailure(err: unknown, logFile: string, anotherServerAnswers: () => Promise<boolean>, stderrFd = 2): Promise<number> {
  if (await anotherServerAnswers()) return 0;
  const reason = (err instanceof Error ? err.message : String(err)).replace(/\s*\r?\n\s*/g, ' ');
  const line = `InProgress: the server did not start: ${reason}`;
  if (!writesTo(stderrFd, logFile)) appendLog(logFile, line);
  console.error(line);
  return 1;
}
