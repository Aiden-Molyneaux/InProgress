import { isAbsolute } from 'node:path';

/**
 * Normalize a filesystem path for storage and comparison: forward slashes, repeated separators
 * collapsed (a UNC path keeps its leading `//`), Git Bash `/c/x` converted to `C:/x`, upper-case
 * drive letter, no trailing slash.
 * Windows-first: a POSIX path whose first segment is one letter (`/x/data`) is read as a drive.
 */
export function normalizePath(input: string): string {
  let p = input.trim().replace(/\\/g, '/');
  const unc = p.startsWith('//');
  p = p.replace(/\/{2,}/g, '/');
  if (unc) p = `/${p}`;
  const gitBash = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (gitBash) p = `${gitBash[1]}:${gitBash[2] ?? '/'}`;
  p = p.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  while (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return p;
}

/**
 * A path on a local disk. UNC and device paths (\\host\share, //host/share, \\?\, \\.\) are refused
 * before anything touches them: Windows would open an SMB session with the user's credentials,
 * and a slow or unreachable host would stall the server.
 */
export function isLocalAbsolutePath(path: string): boolean {
  if (path.startsWith('\\\\') || path.startsWith('//')) return false;
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : isAbsolute(path);
}

/** True when `child` is `parent` or inside it. Case-insensitive (Windows). */
export function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}
