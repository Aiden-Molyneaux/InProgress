import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const MARKER = '"type":"custom-title"';

/**
 * The Claude desktop sidebar title, read from the newest `custom-title` line in the
 * tail of a transcript JSONL file. The format is undocumented, so every failure
 * returns undefined.
 */
export function readTranscriptTitle(file: string, maxBytes = 256 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(MARKER)) continue;
      try {
        const entry = JSON.parse(lines[i]) as { customTitle?: unknown };
        if (typeof entry.customTitle === 'string' && entry.customTitle.trim()) return entry.customTitle.trim();
      } catch {
        // partial first line of the window
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
