import { fstatSync, statSync } from 'node:fs';
import { connect } from 'node:net';
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

export type PortState = 'inprogress' | 'other' | 'free';

/** True unless a TCP connection to the URL's port is refused outright (or fails in some other way). */
function accepts(url: string, timeoutMs: number): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Who holds the server's port: an InProgress server, another program, or nobody. A port that refuses a plain TCP
 * connection is free, and is answered without fetch: loading fetch costs a cold start ~45 ms (#60).
 */
export async function portState(url: string): Promise<PortState> {
  if (!(await accepts(url, 800))) return 'free';
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = (await res.json().catch(() => null)) as { app?: string } | null;
    return body?.app === 'inprogress' ? 'inprogress' : 'other';
  } catch {
    return 'free';
  }
}
