import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Append a timestamped line. Never throws: logging must not break a hook. */
export function appendLog(file: string, message: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}
