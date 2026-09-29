import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** A log past this size moves to `<name>.1` (replacing the previous one) and starts again. */
const MAX_LOG_BYTES = 1024 * 1024;

/** Append a timestamped line. Never throws: logging must not break a hook. */
export function appendLog(file: string, message: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // no log yet, or another process rotated it first: append anyway
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}
